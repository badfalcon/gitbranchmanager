import * as assert from 'assert';
import * as sinon from 'sinon';

import { escapeHtml, isProtectedBranch, parseTrackShort, simpleBranchNameValidator } from '../app';
import * as gitRunner from '../git/gitRunner';

suite('Unit functions', () => {
  // ========================================
  // isProtectedBranch tests
  // ========================================
  test('isProtectedBranch: exact', () => {
    assert.strictEqual(isProtectedBranch('main', ['main']), true);
    assert.strictEqual(isProtectedBranch('dev', ['main']), false);
  });

  test('isProtectedBranch: prefix', () => {
    assert.strictEqual(isProtectedBranch('release/1.0', ['release/*']), true);
    assert.strictEqual(isProtectedBranch('feature/x', ['release/*']), false);
  });

  test('isProtectedBranch: glob', () => {
    assert.strictEqual(isProtectedBranch('hotfix/a/wip', ['hotfix/*/wip']), true);
    assert.strictEqual(isProtectedBranch('hotfix/a/done', ['hotfix/*/wip']), false);
  });

  test('isProtectedBranch: empty list', () => {
    assert.strictEqual(isProtectedBranch('main', []), false);
    assert.strictEqual(isProtectedBranch('anything', []), false);
  });

  test('isProtectedBranch: multiple patterns', () => {
    const list = ['main', 'develop', 'release/*'];
    assert.strictEqual(isProtectedBranch('main', list), true);
    assert.strictEqual(isProtectedBranch('develop', list), true);
    assert.strictEqual(isProtectedBranch('release/v1.0', list), true);
    assert.strictEqual(isProtectedBranch('feature/test', list), false);
  });

  test('isProtectedBranch: case sensitivity', () => {
    assert.strictEqual(isProtectedBranch('Main', ['main']), false);
    assert.strictEqual(isProtectedBranch('MAIN', ['main']), false);
    assert.strictEqual(isProtectedBranch('main', ['Main']), false);
  });

  test('isProtectedBranch: special regex chars in pattern', () => {
    // Dots in pattern should be escaped (not treated as regex "any char")
    assert.strictEqual(isProtectedBranch('feature.test', ['feature.test']), true);
    assert.strictEqual(isProtectedBranch('featureXtest', ['feature.test']), false);
    // Parentheses should be escaped
    assert.strictEqual(isProtectedBranch('fix(core)', ['fix(core)']), true);
    assert.strictEqual(isProtectedBranch('fixXcoreX', ['fix(core)']), false);
  });

  // ========================================
  // parseTrackShort tests
  // ========================================
  test('parseTrackShort', () => {
    assert.deepStrictEqual(parseTrackShort('+1 -2'), { ahead: 1, behind: 2 });
    assert.deepStrictEqual(parseTrackShort('+3'), { ahead: 3 });
    assert.deepStrictEqual(parseTrackShort('-4'), { behind: 4 });
    assert.deepStrictEqual(parseTrackShort('<>'), {});
    assert.deepStrictEqual(parseTrackShort(undefined), {});
  });

  test('parseTrackShort: edge cases', () => {
    assert.deepStrictEqual(parseTrackShort(''), {});
    assert.deepStrictEqual(parseTrackShort('+0 -0'), { ahead: 0, behind: 0 });
    assert.deepStrictEqual(parseTrackShort('+999'), { ahead: 999 });
    assert.deepStrictEqual(parseTrackShort('-999'), { behind: 999 });
  });

  // ========================================
  // escapeHtml tests
  // ========================================
  test('escapeHtml', () => {
    // Avoid putting literal "<" etc. here because some tooling may de-entity it.
    const LT = '&' + 'lt;';
    const GT = '&' + 'gt;';
    const AMP = '&' + 'amp;';
    const QUOT = '&' + 'quot;';
    const APOS = '&' + '#39;';
    assert.strictEqual(escapeHtml('<>&"\''), `${LT}${GT}${AMP}${QUOT}${APOS}`);
  });

  test('escapeHtml: edge cases', () => {
    const LT = '&' + 'lt;';
    const GT = '&' + 'gt;';
    const QUOT = '&' + 'quot;';
    assert.strictEqual(escapeHtml(''), '');
    assert.strictEqual(escapeHtml('hello world'), 'hello world');
    assert.strictEqual(escapeHtml(123), '123');
    // XSS prevention test
    assert.strictEqual(
      escapeHtml('<script>alert("xss")</script>'),
      `${LT}script${GT}alert(${QUOT}xss${QUOT})${LT}/script${GT}`
    );
  });

  // ========================================
  // simpleBranchNameValidator tests
  // ========================================
  test('simpleBranchNameValidator: empty', () => {
    // Empty string should return an error message (truthy)
    assert.ok(simpleBranchNameValidator(''));
  });

  test('simpleBranchNameValidator: whitespace', () => {
    assert.ok(simpleBranchNameValidator('feature branch'));
    assert.ok(simpleBranchNameValidator('feature\tbranch'));
    assert.ok(simpleBranchNameValidator(' feature'));
  });

  test('simpleBranchNameValidator: invalid chars', () => {
    assert.ok(simpleBranchNameValidator('feature~1'));
    assert.ok(simpleBranchNameValidator('feature^2'));
    assert.ok(simpleBranchNameValidator('feature:test'));
    assert.ok(simpleBranchNameValidator('feature?test'));
    assert.ok(simpleBranchNameValidator('feature*test'));
    assert.ok(simpleBranchNameValidator('feature[test]'));
    assert.ok(simpleBranchNameValidator('feature\\test'));
  });

  test('simpleBranchNameValidator: invalid ending', () => {
    assert.ok(simpleBranchNameValidator('feature.'));
    assert.ok(simpleBranchNameValidator('feature/'));
  });

  test('simpleBranchNameValidator: invalid patterns', () => {
    assert.ok(simpleBranchNameValidator('feature..test'));
    assert.ok(simpleBranchNameValidator('feature//test'));
  });

  test('simpleBranchNameValidator: valid names', () => {
    assert.strictEqual(simpleBranchNameValidator('feature/new-feature'), undefined);
    assert.strictEqual(simpleBranchNameValidator('bugfix-123'), undefined);
    assert.strictEqual(simpleBranchNameValidator('release/v1.0.0'), undefined);
    assert.strictEqual(simpleBranchNameValidator('hotfix/issue-456'), undefined);
    assert.strictEqual(simpleBranchNameValidator('my-branch'), undefined);
    assert.strictEqual(simpleBranchNameValidator('feature/nested/path'), undefined);
  });

  test('simpleBranchNameValidator: edge cases', () => {
    // Single character
    assert.strictEqual(simpleBranchNameValidator('a'), undefined);
    assert.strictEqual(simpleBranchNameValidator('1'), undefined);
    // Numbers only
    assert.strictEqual(simpleBranchNameValidator('123'), undefined);
    // Hyphen at start/end (valid in git)
    assert.strictEqual(simpleBranchNameValidator('-feature'), undefined);
    assert.strictEqual(simpleBranchNameValidator('feature-'), undefined);
    // Underscore
    assert.strictEqual(simpleBranchNameValidator('feature_branch'), undefined);
    // Leading dot (not checked by this validator, git may reject)
    assert.strictEqual(simpleBranchNameValidator('.hidden'), undefined);
  });
});

// ========================================
// Git functions with mocking
// ========================================
import {
  listLocalBranches,
  listRemoteBranches,
  getCurrentBranch,
  detectDeadBranches,
  detectGoneBranches,
  detectStaleBranches,
  getBranchLastCommitDates,
  getRemoteBranchLastCommitDates,
  detectMergedRemoteBranches,
  checkoutBranch,
  createBranch,
  renameBranch,
  deleteLocalBranch,
  deleteRemoteBranch,
  mergeIntoCurrent,
  fetchWithPrune,
  resolveBaseBranch,
  getUpstreamMap,
  listLocalBranchesWithStatus,
  listRemoteBranchesWithStatus,
} from '../app';

suite('Git functions (mocked)', () => {
  let runGitStub: sinon.SinonStub;

  setup(() => {
    runGitStub = sinon.stub(gitRunner, 'runGit');
  });

  teardown(() => {
    runGitStub.restore();
  });

  // ========================================
  // listLocalBranches tests
  // ========================================
  test('listLocalBranches: parses branches correctly', async () => {
    runGitStub.resolves({
      stdout: [
        'refs/heads/main\tmain\torigin/main\t+1 -2\t*',
        'refs/heads/feature/test\tfeature/test\t\t\t',
        'refs/heads/develop\tdevelop\torigin/develop\t\t',
      ].join('\n'),
    });

    const branches = await listLocalBranches('/fake/repo');

    assert.strictEqual(branches.length, 3);

    // main branch
    assert.strictEqual(branches[0].short, 'main');
    assert.strictEqual(branches[0].kind, 'local');
    assert.strictEqual(branches[0].isCurrent, true);
    assert.strictEqual(branches[0].upstream, 'origin/main');
    assert.strictEqual(branches[0].ahead, 1);
    assert.strictEqual(branches[0].behind, 2);

    // feature/test branch (no upstream)
    assert.strictEqual(branches[1].short, 'feature/test');
    assert.strictEqual(branches[1].upstream, undefined);
    assert.strictEqual(branches[1].isCurrent, undefined);

    // develop branch
    assert.strictEqual(branches[2].short, 'develop');
    assert.strictEqual(branches[2].upstream, 'origin/develop');
  });

  test('listLocalBranches: empty repo', async () => {
    runGitStub.resolves({ stdout: '' });

    const branches = await listLocalBranches('/fake/repo');
    assert.strictEqual(branches.length, 0);
  });

  // ========================================
  // listRemoteBranches tests
  // ========================================
  test('listRemoteBranches: parses branches correctly', async () => {
    runGitStub.resolves({
      stdout: [
        'refs/remotes/origin/main\torigin/main',
        'refs/remotes/origin/feature/x\torigin/feature/x',
        'refs/remotes/origin/HEAD\torigin/HEAD',
      ].join('\n'),
    });

    const branches = await listRemoteBranches('/fake/repo');

    // HEAD should be filtered out
    assert.strictEqual(branches.length, 2);
    assert.strictEqual(branches[0].short, 'origin/main');
    assert.strictEqual(branches[0].kind, 'remote');
    assert.strictEqual(branches[1].short, 'origin/feature/x');
  });

  // ========================================
  // getCurrentBranch tests
  // ========================================
  test('getCurrentBranch: returns branch name', async () => {
    runGitStub.resolves({ stdout: 'feature/my-branch\n' });

    const current = await getCurrentBranch('/fake/repo');
    assert.strictEqual(current, 'feature/my-branch');
  });

  test('getCurrentBranch: detached HEAD returns undefined', async () => {
    runGitStub.resolves({ stdout: 'HEAD\n' });

    const current = await getCurrentBranch('/fake/repo');
    assert.strictEqual(current, undefined);
  });

  test('getCurrentBranch: error returns undefined', async () => {
    runGitStub.rejects(new Error('not a git repo'));

    const current = await getCurrentBranch('/fake/repo');
    assert.strictEqual(current, undefined);
  });

  // ========================================
  // detectDeadBranches tests
  // ========================================
  test('detectDeadBranches: filters merged branches', async () => {
    // First call: git branch --merged
    runGitStub.onFirstCall().resolves({
      stdout: '  main\n* feature/done\n  bugfix-123\n  develop\n',
    });
    // Second call: getCurrentBranch
    runGitStub.onSecondCall().resolves({ stdout: 'feature/done\n' });

    const dead = await detectDeadBranches('/fake/repo', 'main');

    // Should exclude: main (protected), feature/done (current), develop (protected)
    assert.strictEqual(dead.length, 1);
    assert.strictEqual(dead[0], 'bugfix-123');
  });

  // ========================================
  // detectGoneBranches tests
  // ========================================
  test('detectGoneBranches: detects gone upstream', async () => {
    // First call: git branch -vv
    runGitStub.onFirstCall().resolves({
      stdout: [
        '* main           abc1234 [origin/main] latest commit',
        '  old-feature    def5678 [origin/old-feature: gone] old commit',
        '  another        ghi9012 [origin/another: gone] another old',
        '  local-only     jkl3456 local branch no upstream',
      ].join('\n'),
    });
    // Second call: getCurrentBranch
    runGitStub.onSecondCall().resolves({ stdout: 'main\n' });

    const gone = await detectGoneBranches('/fake/repo');

    assert.strictEqual(gone.length, 2);
    assert.ok(gone.includes('old-feature'));
    assert.ok(gone.includes('another'));
  });

  // ========================================
  // getBranchLastCommitDates tests
  // ========================================
  test('getBranchLastCommitDates: parses dates correctly', async () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    runGitStub.resolves({
      stdout: [
        `main\t${now.toISOString()}`,
        `old-branch\t${thirtyDaysAgo.toISOString()}`,
      ].join('\n'),
    });

    const dates = await getBranchLastCommitDates('/fake/repo');

    assert.strictEqual(dates.size, 2);

    const mainInfo = dates.get('main');
    assert.ok(mainInfo);
    assert.ok(mainInfo.ageInDays <= 1);

    const oldInfo = dates.get('old-branch');
    assert.ok(oldInfo);
    assert.ok(oldInfo.ageInDays >= 29 && oldInfo.ageInDays <= 31);
  });

  // ========================================
  // getRemoteBranchLastCommitDates tests
  // ========================================
  test('getRemoteBranchLastCommitDates: filters HEAD', async () => {
    const now = new Date();

    runGitStub.resolves({
      stdout: [
        `origin/main\t${now.toISOString()}`,
        `origin/HEAD\t${now.toISOString()}`,
        `origin/feature\t${now.toISOString()}`,
      ].join('\n'),
    });

    const dates = await getRemoteBranchLastCommitDates('/fake/repo');

    // HEAD should be filtered out
    assert.strictEqual(dates.size, 2);
    assert.ok(dates.has('origin/main'));
    assert.ok(dates.has('origin/feature'));
    assert.ok(!dates.has('origin/HEAD'));
  });

  // ========================================
  // detectStaleBranches tests
  // ========================================
  test('detectStaleBranches: detects old branches', async () => {
    const now = new Date();
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

    // First call: getBranchLastCommitDates (for-each-ref)
    runGitStub.onFirstCall().resolves({
      stdout: [
        `main\t${now.toISOString()}`,
        `old-feature\t${fortyDaysAgo.toISOString()}`,
        `recent-feature\t${tenDaysAgo.toISOString()}`,
      ].join('\n'),
    });
    // Second call: getCurrentBranch
    runGitStub.onSecondCall().resolves({ stdout: 'main\n' });

    const stale = await detectStaleBranches('/fake/repo', 30);

    // Only old-feature is stale (40 days > 30 threshold)
    // main is protected, recent-feature is only 10 days old
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0], 'old-feature');
  });

  // ========================================
  // detectMergedRemoteBranches tests
  // ========================================
  test('detectMergedRemoteBranches: detects merged remotes', async () => {
    runGitStub.resolves({
      stdout: [
        '  origin/main',
        '  origin/feature-merged',
        '  origin/HEAD',
        '  origin/another-merged',
      ].join('\n'),
    });

    const merged = await detectMergedRemoteBranches('/fake/repo', 'origin/main');

    // Should exclude HEAD and the base branch itself
    assert.strictEqual(merged.size, 2);
    assert.ok(merged.has('origin/feature-merged'));
    assert.ok(merged.has('origin/another-merged'));
    assert.ok(!merged.has('origin/HEAD'));
    assert.ok(!merged.has('origin/main'));
  });

  // ========================================
  // checkoutBranch tests
  // ========================================
  test('checkoutBranch: checkout existing local branch', async () => {
    // First call: show-ref --verify refs/heads/feature
    runGitStub.onFirstCall().resolves({ stdout: 'abc123\n' });
    // Second call: git checkout feature
    runGitStub.onSecondCall().resolves({ stdout: '' });

    await checkoutBranch('/fake/repo', 'feature');

    assert.ok(runGitStub.calledTwice);
    assert.deepStrictEqual(runGitStub.secondCall.args[1], ['checkout', 'feature']);
  });

  test('checkoutBranch: checkout remote creates tracking branch', async () => {
    // First call: show-ref --verify refs/heads/origin/feature (fails - no local)
    runGitStub.onFirstCall().rejects(new Error('not found'));
    // Second call: show-ref --verify refs/remotes/origin/feature (success)
    runGitStub.onSecondCall().resolves({ stdout: 'abc123\n' });
    // Third call: git checkout -b feature --track origin/feature
    runGitStub.onThirdCall().resolves({ stdout: '' });

    await checkoutBranch('/fake/repo', 'origin/feature');

    assert.ok(runGitStub.calledThrice);
    assert.deepStrictEqual(runGitStub.thirdCall.args[1], [
      'checkout',
      '-b',
      'feature',
      '--track',
      'origin/feature',
    ]);
  });

  // ========================================
  // createBranch tests
  // ========================================
  test('createBranch: creates and checks out new branch', async () => {
    runGitStub.resolves({ stdout: '' });

    await createBranch('/fake/repo', 'new-feature');

    assert.ok(runGitStub.calledOnce);
    assert.deepStrictEqual(runGitStub.firstCall.args[1], ['checkout', '-b', 'new-feature']);
  });

  test('createBranch: creates branch from base', async () => {
    runGitStub.resolves({ stdout: '' });

    await createBranch('/fake/repo', 'new-feature', 'main');

    assert.deepStrictEqual(runGitStub.firstCall.args[1], ['checkout', '-b', 'new-feature', 'main']);
  });

  test('createBranch: creates without checkout', async () => {
    runGitStub.resolves({ stdout: '' });

    await createBranch('/fake/repo', 'new-feature', undefined, false);

    assert.deepStrictEqual(runGitStub.firstCall.args[1], ['branch', 'new-feature']);
  });

  // ========================================
  // renameBranch tests
  // ========================================
  test('renameBranch: renames branch', async () => {
    runGitStub.resolves({ stdout: '' });

    await renameBranch('/fake/repo', 'old-name', 'new-name');

    assert.deepStrictEqual(runGitStub.firstCall.args[1], ['branch', '-m', 'old-name', 'new-name']);
  });

  // ========================================
  // deleteLocalBranch tests
  // ========================================
  test('deleteLocalBranch: soft delete', async () => {
    runGitStub.resolves({ stdout: '' });

    await deleteLocalBranch('/fake/repo', 'feature-to-delete');

    assert.deepStrictEqual(runGitStub.firstCall.args[1], ['branch', '-d', 'feature-to-delete']);
  });

  test('deleteLocalBranch: force delete', async () => {
    runGitStub.resolves({ stdout: '' });

    await deleteLocalBranch('/fake/repo', 'feature-to-delete', true);

    assert.deepStrictEqual(runGitStub.firstCall.args[1], ['branch', '-D', 'feature-to-delete']);
  });

  // ========================================
  // deleteRemoteBranch tests
  // ========================================
  test('deleteRemoteBranch: pushes delete', async () => {
    runGitStub.resolves({ stdout: '' });

    await deleteRemoteBranch('/fake/repo', 'origin', 'feature-to-delete');

    assert.deepStrictEqual(runGitStub.firstCall.args[1], [
      'push',
      'origin',
      '--delete',
      'feature-to-delete',
    ]);
  });

  // ========================================
  // mergeIntoCurrent tests
  // ========================================
  test('mergeIntoCurrent: merges branch', async () => {
    runGitStub.resolves({ stdout: '' });

    await mergeIntoCurrent('/fake/repo', 'feature-to-merge');

    assert.deepStrictEqual(runGitStub.firstCall.args[1], ['merge', 'feature-to-merge']);
  });

  // ========================================
  // fetchWithPrune tests
  // ========================================
  test('fetchWithPrune: fetches with prune flag', async () => {
    runGitStub.resolves({ stdout: '' });

    await fetchWithPrune('/fake/repo');

    assert.deepStrictEqual(runGitStub.firstCall.args[1], ['fetch', 'origin', '--prune']);
  });

  test('fetchWithPrune: custom remote', async () => {
    runGitStub.resolves({ stdout: '' });

    await fetchWithPrune('/fake/repo', 'upstream');

    assert.deepStrictEqual(runGitStub.firstCall.args[1], ['fetch', 'upstream', '--prune']);
  });

  // ========================================
  // resolveBaseBranch tests
  // ========================================
  test('resolveBaseBranch: uses origin/HEAD', async () => {
    // symbolic-ref returns origin/HEAD pointing to main
    runGitStub.resolves({ stdout: 'refs/remotes/origin/main\n' });

    const base = await resolveBaseBranch('/fake/repo');

    assert.strictEqual(base, 'main');
  });

  test('resolveBaseBranch: falls back to main', async () => {
    // First call: symbolic-ref fails (no origin/HEAD)
    runGitStub.onFirstCall().rejects(new Error('no origin/HEAD'));
    // Second call: show-ref for main succeeds
    runGitStub.onSecondCall().resolves({ stdout: 'abc123 refs/heads/main\n' });

    const base = await resolveBaseBranch('/fake/repo');

    assert.strictEqual(base, 'main');
  });

  test('resolveBaseBranch: falls back to master', async () => {
    // First call: symbolic-ref fails
    runGitStub.onFirstCall().rejects(new Error('no origin/HEAD'));
    // Second call: show-ref for main fails
    runGitStub.onSecondCall().rejects(new Error('no main'));
    // Third call: show-ref for master succeeds
    runGitStub.onThirdCall().resolves({ stdout: 'abc123 refs/heads/master\n' });

    const base = await resolveBaseBranch('/fake/repo');

    assert.strictEqual(base, 'master');
  });

  // ========================================
  // getUpstreamMap tests
  // ========================================
  test('getUpstreamMap: builds upstream mapping', async () => {
    runGitStub.resolves({
      stdout: [
        'refs/heads/main\tmain\torigin/main\t\t*',
        'refs/heads/feature\tfeature\torigin/feature\t+1\t',
        'refs/heads/local-only\tlocal-only\t\t\t',
      ].join('\n'),
    });

    const map = await getUpstreamMap('/fake/repo');

    assert.strictEqual(map.size, 2);
    assert.strictEqual(map.get('main'), 'origin/main');
    assert.strictEqual(map.get('feature'), 'origin/feature');
    assert.strictEqual(map.get('local-only'), undefined);
  });

  // ========================================
  // listLocalBranchesWithStatus tests
  // ========================================
  test('listLocalBranchesWithStatus: combines all status info', async () => {
    const now = new Date();
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

    // This function calls multiple git commands in parallel
    runGitStub.callsFake((_cwd: string, args: string[]) => {
      // listLocalBranches: for-each-ref --format FMT refs/heads
      if (args[0] === 'for-each-ref' && args[3] === 'refs/heads') {
        // Check if it's for commit dates (has committerdate format)
        if (args[2].includes('committerdate')) {
          return Promise.resolve({
            stdout: [
              `main\t${now.toISOString()}`,
              `feature\t${fortyDaysAgo.toISOString()}`,
              `gone-branch\t${now.toISOString()}`,
            ].join('\n'),
          });
        }
        // Regular branch listing
        return Promise.resolve({
          stdout: [
            'refs/heads/main\tmain\torigin/main\t\t*',
            'refs/heads/feature\tfeature\t\t\t',
            'refs/heads/gone-branch\tgone-branch\torigin/gone-branch\t\t',
          ].join('\n'),
        });
      }
      // detectDeadBranches: branch --merged
      if (args[0] === 'branch' && args[1] === '--merged') {
        return Promise.resolve({ stdout: '  main\n  feature\n' });
      }
      // detectGoneBranches: branch -vv
      if (args[0] === 'branch' && args[1] === '-vv') {
        return Promise.resolve({
          stdout: [
            '* main         abc123 [origin/main] commit',
            '  feature      def456 no upstream',
            '  gone-branch  ghi789 [origin/gone-branch: gone] old commit',
          ].join('\n'),
        });
      }
      // getCurrentBranch: rev-parse --abbrev-ref HEAD
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'main\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const branches = await listLocalBranchesWithStatus('/fake/repo', 'main', 30);

    assert.strictEqual(branches.length, 3);

    // main: current, protected, merged (into itself)
    const main = branches.find((b) => b.short === 'main');
    assert.ok(main);
    assert.strictEqual(main.isCurrent, true);
    assert.strictEqual(main.protected, true);

    // feature: merged, stale (40 days old)
    const feature = branches.find((b) => b.short === 'feature');
    assert.ok(feature);
    assert.strictEqual(feature.isMerged, true);
    assert.strictEqual(feature.isStale, true);
    assert.strictEqual(feature.isGone, false);

    // gone-branch: gone upstream
    const goneBranch = branches.find((b) => b.short === 'gone-branch');
    assert.ok(goneBranch);
    assert.strictEqual(goneBranch.isGone, true);
  });

  // ========================================
  // listRemoteBranchesWithStatus tests
  // ========================================
  test('listRemoteBranchesWithStatus: combines all status info', async () => {
    const now = new Date();
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

    runGitStub.callsFake((_cwd: string, args: string[]) => {
      // listRemoteBranches: for-each-ref --format FMT refs/remotes
      if (args[0] === 'for-each-ref' && args[3] === 'refs/remotes') {
        // Check if it's for commit dates
        if (args[2].includes('committerdate')) {
          return Promise.resolve({
            stdout: [
              `origin/main\t${now.toISOString()}`,
              `origin/feature\t${fortyDaysAgo.toISOString()}`,
              `origin/recent\t${now.toISOString()}`,
            ].join('\n'),
          });
        }
        // Regular branch listing
        return Promise.resolve({
          stdout: [
            'refs/remotes/origin/main\torigin/main',
            'refs/remotes/origin/feature\torigin/feature',
            'refs/remotes/origin/recent\torigin/recent',
            'refs/remotes/origin/HEAD\torigin/HEAD',
          ].join('\n'),
        });
      }
      // detectMergedRemoteBranches: branch -r --merged
      if (args[0] === 'branch' && args[1] === '-r') {
        return Promise.resolve({
          stdout: '  origin/main\n  origin/feature\n',
        });
      }
      return Promise.resolve({ stdout: '' });
    });

    const branches = await listRemoteBranchesWithStatus('/fake/repo', 'origin/main', 30);

    // HEAD should be filtered out
    assert.strictEqual(branches.length, 3);

    // origin/main: protected, NOT merged (base branch is excluded from merged set)
    const main = branches.find((b) => b.short === 'origin/main');
    assert.ok(main);
    assert.strictEqual(main.protected, true);
    assert.strictEqual(main.isMerged, false);

    // origin/feature: merged, stale (40 days old)
    const feature = branches.find((b) => b.short === 'origin/feature');
    assert.ok(feature);
    assert.strictEqual(feature.isMerged, true);
    assert.strictEqual(feature.isStale, true);

    // origin/recent: not merged, not stale
    const recent = branches.find((b) => b.short === 'origin/recent');
    assert.ok(recent);
    assert.strictEqual(recent.isMerged, false);
    assert.strictEqual(recent.isStale, false);
  });
});
