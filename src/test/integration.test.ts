import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import {
  detectDeadBranches,
  detectGoneBranches,
  detectMergedRemoteBranches,
  getBranchLastCommitDates,
  getCurrentBranch,
  getRemoteBranchLastCommitDates,
  getUpstreamMap,
  listLocalBranches,
  listRemoteBranches,
  resolveBaseBranch,
} from '../app';

/**
 * Integration tests that run against REAL git repositories — nothing here stubs
 * `runGit`.
 *
 * Why this suite exists: every other test mocks git's output, so a parsing bug
 * and its mock can agree with each other and the suite still passes. That is
 * exactly what happened with gone-detection — a test literally named "detects
 * gone branch checked out in another worktree" passed while the real thing was
 * broken, because the mock omitted the worktree path that real `git branch -vv`
 * prints. Assertions here are only ever compared against output git actually
 * produced on this machine.
 *
 * The fixture deliberately includes the setups where bugs were found: a linked
 * worktree, a second remote, and a configured `origin/HEAD`.
 *
 * Note: these functions read the live VS Code configuration via getCfg(), and
 * app-internal calls bypass any sinon stub, so the fixture is designed around
 * the packaged defaults — protectedBranches = ["main", "master", "develop"].
 */
suite('Integration (real git)', () => {
  let root: string;
  let repo: string;
  let worktree: string;

  // Async on purpose: a synchronous spawn per git call blocks the extension
  // host long enough for VS Code to declare it unresponsive and start profiling.
  async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, ...env },
    });
    return stdout.toString();
  }

  async function commit(cwd: string, file: string, message: string, daysAgo = 0): Promise<void> {
    fs.writeFileSync(path.join(cwd, file), `${message}\n`);
    await git(cwd, ['add', '-A']);
    const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    await git(cwd, ['commit', '-q', '-m', message], {
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    });
  }

  suiteSetup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsouji-it-'));
    repo = path.join(root, 'work');
    worktree = path.join(root, 'wt-gone');

    // -b main on the bare remotes too, not just the work repo: without it their
    // HEAD follows the ambient init.defaultBranch, which is unset on CI. HEAD
    // then points at refs/heads/master, a branch this fixture never creates, and
    // `git remote set-head origin -a` below fails with "Cannot determine remote
    // HEAD". Nothing here may depend on the machine's git configuration.
    await git(root, ['init', '-q', '--bare', '-b', 'main', 'remote.git']);
    await git(root, ['init', '-q', '--bare', '-b', 'main', 'fork.git']);
    await git(root, ['init', '-q', '-b', 'main', 'work']);

    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test User']);
    // A contributor with commit signing enabled globally would otherwise fail
    // every commit here (setup-test-repo.sh does the same).
    await git(repo, ['config', 'commit.gpgsign', 'false']);
    await git(repo, ['remote', 'add', 'origin', path.join(root, 'remote.git')]);
    await git(repo, ['remote', 'add', 'fork', path.join(root, 'fork.git')]);

    await commit(repo, 'README.md', 'initial');
    await git(repo, ['push', '-q', '-u', 'origin', 'main']);

    // feat-merged: merged into main with a merge commit, still on origin
    await git(repo, ['checkout', '-q', '-b', 'feat-merged']);
    await commit(repo, 'merged.txt', 'merged work');
    await git(repo, ['push', '-q', '-u', 'origin', 'feat-merged']);
    await git(repo, ['checkout', '-q', 'main']);
    await git(repo, ['merge', '-q', '--no-ff', 'feat-merged', '-m', 'merge feat-merged']);
    await git(repo, ['push', '-q', 'origin', 'main']);

    // feat-unmerged: real work not in main
    await git(repo, ['checkout', '-q', '-b', 'feat-unmerged', 'main']);
    await commit(repo, 'unmerged.txt', 'unmerged work');
    await git(repo, ['push', '-q', '-u', 'origin', 'feat-unmerged']);
    await git(repo, ['checkout', '-q', 'main']);

    // feat-local-only: no upstream at all
    await git(repo, ['branch', 'feat-local-only', 'main']);

    // feat-old: 60-day-old commit, for staleness
    await git(repo, ['checkout', '-q', '-b', 'feat-old', 'main']);
    await commit(repo, 'old.txt', 'old work', 60);
    await git(repo, ['checkout', '-q', 'main']);

    // feat-gone: upstream deleted on the remote AND checked out in a linked
    // worktree — the exact shape that defeated the old `branch -vv` parsing.
    await git(repo, ['checkout', '-q', '-b', 'feat-gone', 'main']);
    await commit(repo, 'gone.txt', 'gone work');
    await git(repo, ['push', '-q', '-u', 'origin', 'feat-gone']);
    await git(repo, ['checkout', '-q', 'main']);
    await git(repo, ['push', '-q', 'origin', '--delete', 'feat-gone']);
    await git(repo, ['worktree', 'add', '-q', worktree, 'feat-gone']);
    await git(repo, ['fetch', '-q', '--prune', 'origin']);

    // A second remote that also carries the base branch name
    await git(repo, ['push', '-q', 'fork', 'main:refs/heads/main']);
    await git(repo, ['push', '-q', 'fork', 'main:refs/heads/feat-shared']);
    await git(repo, ['fetch', '-q', 'fork']);

    // origin/HEAD -> origin/main, the normal post-clone state
    await git(repo, ['remote', 'set-head', 'origin', '-a']);
  });

  suiteTeardown(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows can hold locks on worktree files; the OS reclaims tmp anyway.
    }
  });

  test('sanity: the fixture really has a linked worktree and origin/HEAD', async () => {
    const worktrees = await git(repo, ['worktree', 'list']);
    assert.ok(worktrees.includes('wt-gone'), `worktree missing:\n${worktrees}`);
    const vv = await git(repo, ['branch', '-vv']);
    // Documents the layout that broke the old parser: a (path) before the bracket
    assert.ok(
      /\+\s+feat-gone\s+\S+\s+\(/.test(vv),
      `expected a worktree path in branch -vv output:\n${vv}`
    );
    assert.ok((await git(repo, ['branch', '-r'])).includes('origin/HEAD -> origin/main'));
  });

  test('detectGoneBranches finds a gone branch checked out in a linked worktree', async () => {
    const gone = await detectGoneBranches(repo);
    assert.deepStrictEqual(gone, ['feat-gone']);
  });

  test('detectGoneBranches excludes branches that merely have no upstream', async () => {
    const gone = await detectGoneBranches(repo);
    assert.ok(!gone.includes('feat-local-only'), 'no upstream is not the same as gone');
    assert.ok(!gone.includes('feat-unmerged'), 'a live upstream is not gone');
    assert.ok(!gone.includes('main'));
  });

  test('listRemoteBranches excludes the origin/HEAD pointer', async () => {
    const remotes = await listRemoteBranches(repo);
    const shorts = remotes.map(r => r.short).sort();
    assert.ok(!shorts.includes('origin/HEAD'), `origin/HEAD leaked: ${shorts.join(', ')}`);
    assert.ok(!shorts.includes('origin'), `bare "origin" leaked: ${shorts.join(', ')}`);
    assert.ok(shorts.includes('origin/main'));
    assert.ok(shorts.includes('fork/main'));
    assert.ok(!shorts.includes('origin/feat-gone'), 'pruned ref should be gone');
  });

  test('getRemoteBranchLastCommitDates keys only real remote branches', async () => {
    const dates = await getRemoteBranchLastCommitDates(repo);
    const keys = [...dates.keys()].sort();
    // %(refname:short) renders refs/remotes/origin/HEAD as bare "origin"
    assert.ok(!keys.includes('origin'), `HEAD pointer leaked as "origin": ${keys.join(', ')}`);
    assert.ok(!keys.includes('origin/HEAD'), `HEAD pointer leaked: ${keys.join(', ')}`);
    assert.ok(keys.includes('origin/main'));
    const info = dates.get('origin/main');
    assert.ok(info);
    assert.strictEqual(info.author, 'Test User');
    assert.ok(info.ageInDays >= 0, `age must not be negative: ${info.ageInDays}`);
  });

  test('detectMergedRemoteBranches never returns the symbolic-ref line', async () => {
    const merged = await detectMergedRemoteBranches(repo, 'main');
    const names = [...merged];
    assert.ok(
      !names.some(n => n.includes('->')),
      `symbolic-ref line leaked into the merged set: ${names.join(', ')}`
    );
    assert.ok(merged.has('origin/feat-merged'));
    assert.ok(!merged.has('origin/main'), 'the base branch is not a cleanup candidate');
    assert.ok(!merged.has('fork/main'), "another remote's base branch is withheld too");
    assert.ok(!merged.has('origin/feat-unmerged'), 'unmerged work must never be offered');
  });

  test('detectDeadBranches offers merged work but never the base or protected branches', async () => {
    const dead = await detectDeadBranches(repo, 'main');
    assert.ok(dead.includes('feat-merged'), `expected feat-merged in: ${dead.join(', ')}`);
    assert.ok(!dead.includes('main'), 'base branch must never be a candidate');
    assert.ok(!dead.includes('feat-unmerged'), 'unmerged work must never be a candidate');
  });

  test('listLocalBranches reports the current branch, upstreams and protection', async () => {
    const locals = await listLocalBranches(repo);
    const byName = new Map(locals.map(b => [b.short, b]));

    const main = byName.get('main');
    assert.ok(main);
    assert.strictEqual(main.isCurrent, true);
    assert.strictEqual(main.protected, true, 'main is protected by the packaged defaults');
    assert.strictEqual(main.upstream, 'origin/main');

    // Checked out in a LINKED worktree — that is not "current" for this repo
    const goneBranch = byName.get('feat-gone');
    assert.ok(goneBranch);
    assert.notStrictEqual(goneBranch.isCurrent, true);

    const localOnly = byName.get('feat-local-only');
    assert.ok(localOnly);
    assert.strictEqual(localOnly.upstream, undefined);
    assert.strictEqual(localOnly.protected, false);
  });

  test('resolveBaseBranch follows origin/HEAD', async () => {
    assert.strictEqual(await resolveBaseBranch(repo), 'main');
  });

  test('getUpstreamMap maps only branches that track something', async () => {
    const map = await getUpstreamMap(repo);
    assert.strictEqual(map.get('main'), 'origin/main');
    assert.strictEqual(map.get('feat-unmerged'), 'origin/feat-unmerged');
    assert.ok(!map.has('feat-local-only'));
  });

  test('getBranchLastCommitDates reports real ages and authors', async () => {
    const dates = await getBranchLastCommitDates(repo);
    const old = dates.get('feat-old');
    assert.ok(old, 'feat-old missing');
    assert.ok(old.ageInDays >= 59 && old.ageInDays <= 61, `expected ~60 days, got ${old.ageInDays}`);
    assert.strictEqual(old.author, 'Test User');

    const main = dates.get('main');
    assert.ok(main);
    assert.ok(main.ageInDays >= 0 && main.ageInDays <= 1, `expected ~0 days, got ${main.ageInDays}`);
  });

  test('getCurrentBranch returns undefined on a detached HEAD', async () => {
    const detached = path.join(root, 'detached');
    await git(root, ['clone', '-q', path.join(root, 'remote.git'), 'detached']);
    const sha = (await git(detached, ['rev-parse', 'HEAD'])).trim();
    await git(detached, ['checkout', '-q', sha]);

    assert.strictEqual(await getCurrentBranch(detached), undefined);
  });

  test('a repository with no commits yet degrades to empty, not an error', async () => {
    const fresh = path.join(root, 'fresh');
    await git(root, ['init', '-q', '-b', 'main', 'fresh']);

    assert.deepStrictEqual(await detectDeadBranches(fresh, 'main'), []);
    assert.deepStrictEqual(await listLocalBranches(fresh), []);
    assert.deepStrictEqual(await detectGoneBranches(fresh), []);
    assert.deepStrictEqual(
      await detectMergedRemoteBranches(fresh, 'main'),
      new Set<string>()
    );
  });
});
