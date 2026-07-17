import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import * as app from '../app';
import * as gitRunner from '../git/gitRunner';
import { QueueTreeProvider } from '../queue/queueTreeProvider';

// Regression tests for the batch force-delete prompt: it must be visually
// distinct from the generic batch confirm (explicit "Force Delete" button +
// data-loss detail listing the branches), so it can't be reflexively Yes'd
// as a perceived duplicate of the "Delete N branches?" dialog.
suite('QueueTreeProvider batch force-delete prompt', () => {
  let runGitStub: sinon.SinonStub;
  let confirmStub: sinon.SinonStub;
  let warningStub: sinon.SinonStub;
  const confirmCalls: string[] = [];

  setup(() => {
    confirmCalls.length = 0;
    runGitStub = sinon.stub(gitRunner, 'runGit');
    // Generic batch confirm ("Delete N branches?") auto-answers Yes
    confirmStub = sinon.stub(app, 'confirm').callsFake(async (msg: string) => {
      confirmCalls.push(msg);
      return true;
    });
    warningStub = sinon.stub(vscode.window, 'showWarningMessage');
  });

  teardown(() => {
    runGitStub.restore();
    confirmStub.restore();
    warningStub.restore();
  });

  function productionShapedUnmergedError(branch: string): gitRunner.GitError {
    // Exact shape thrown by runGit: our wrapper + Node's execFile echo + stderr
    return new gitRunner.GitError(
      `git branch -d -- ${branch} failed: Command failed: git branch -d -- ${branch}\n` +
        `error: The branch '${branch}' is not fully merged.\n` +
        `hint: If you are sure you want to delete it, run 'git branch -D ${branch}'.`,
      ['branch', '-d', '--', branch],
      '/fake/repo'
    );
  }

  function stubGit(): void {
    runGitStub.callsFake(async (_cwd: string, args: string[]) => {
      if (args[0] === 'branch' && args[1] === '-d' && args[3] === 'feat-a') {
        throw productionShapedUnmergedError('feat-a');
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'main\n' };
      }
      return { stdout: '' };
    });
  }

  function makeProvider(): QueueTreeProvider {
    const provider = new QueueTreeProvider();
    provider.setRepo({ repoRoot: '/fake/repo' });
    provider.add([
      { name: 'feat-a', kind: 'local' },
      { name: 'feat-b', kind: 'local' },
    ]);
    return provider;
  }

  test('force prompt is a distinct modal: Force Delete button + branch names in detail', async () => {
    stubGit();
    // User clicks the explicit "Force Delete" action
    warningStub.resolves('Force Delete');

    const provider = makeProvider();
    await provider.execute();

    // The generic confirm() must NOT have been used for the force prompt
    assert.ok(
      !confirmCalls.some(c => c.includes('not fully merged')),
      'force prompt must not go through the generic Yes confirm'
    );

    // The distinct modal was shown with the explicit button and data-loss detail
    assert.ok(warningStub.calledOnce, 'expected exactly one force warning dialog');
    const [message, options, ...actions] = warningStub.firstCall.args;
    assert.ok(String(message).includes('not fully merged'), `message: ${message}`);
    assert.strictEqual(options?.modal, true);
    assert.ok(String(options?.detail).includes('feat-a'), `detail: ${options?.detail}`);
    assert.deepStrictEqual(actions, ['Force Delete']);

    // Accepting it force-deletes the unmerged branch
    const feat = provider.getChildren().find(i => i.name === 'feat-a');
    assert.strictEqual(feat?.status, 'deleted');
    assert.ok(
      runGitStub.getCalls().some(c => c.args[1][0] === 'branch' && c.args[1][1] === '-D'),
      'expected a git branch -D retry'
    );
  });

  test('dismissing the force prompt leaves the item failed (no silent force delete)', async () => {
    stubGit();
    // Esc / closing the dialog resolves undefined
    warningStub.resolves(undefined);

    const provider = makeProvider();
    await provider.execute();

    const feat = provider.getChildren().find(i => i.name === 'feat-a');
    assert.strictEqual(feat?.status, 'failed');
    assert.strictEqual(feat?.errorCause, 'unmerged');
    assert.ok(
      !runGitStub.getCalls().some(c => c.args[1][0] === 'branch' && c.args[1][1] === '-D'),
      'must not force delete without explicit consent'
    );
  });
});
