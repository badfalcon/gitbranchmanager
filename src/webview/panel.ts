import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';

import {
  checkoutBranch,
  confirm,
  createBranch,
  deleteLocalBranch,
  deleteRemoteBranch,
  detectDeadBranches,
  getCfg,
  getCurrentBranch,
  getUpstreamMap,
  isProtectedBranch,
  listLocalBranches,
  listRemoteBranches,
  mergeIntoCurrent,
  pickRepository,
  renameBranch,
  resolveBaseBranch,
  simpleBranchNameValidator,
  type RepoContext,
  type WebviewMessage,
} from '../app';

type State = {
  locals: Awaited<ReturnType<typeof listLocalBranches>>;
  remotes: Awaited<ReturnType<typeof listRemoteBranches>>;
  repoRoot: string;
  current?: string;
};

async function getState(repoRoot: string): Promise<State> {
  const [locals, remotes, current] = await Promise.all([
    listLocalBranches(repoRoot),
    listRemoteBranches(repoRoot),
    getCurrentBranch(repoRoot),
  ]);

  for (const b of locals) {
    b.isCurrent = b.short === current;
  }

  return { locals, remotes, repoRoot, current };
}

export async function openManagerPanel(context: vscode.ExtensionContext, repo: RepoContext) {
  const panel = vscode.window.createWebviewPanel('gitBranchManager', 'Branch Manager', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  const nonce = String(Math.random()).slice(2);
  panel.webview.html = await getHtmlFromFile(context, nonce);

  const refresh = async () => {
    try {
      const state = await getState(repo.repoRoot);
      panel.webview.postMessage({ type: 'state', state });
    } catch (err: any) {
      panel.webview.postMessage({ type: 'error', message: err?.message ?? String(err) });
    }
  };

  panel.webview.onDidReceiveMessage(
    async (raw: unknown) => {
      const msg = raw as WebviewMessage;

      try {
        switch (msg.type) {
          case 'ready':
          case 'refresh':
            await refresh();
            break;

          case 'openLogTerminal':
            await openLogInTerminal(repo.repoRoot, msg.ref);
            break;

          case 'checkout':
            await checkoutBranch(repo.repoRoot, msg.name);
            await refresh();
            break;

          case 'create': {
            const name = await vscode.window.showInputBox({
              prompt: '新しいブランチ名',
              validateInput: simpleBranchNameValidator,
            });
            if (!name) {
              break;
            }

            const base = await vscode.window.showInputBox({ prompt: 'ベースブランチ（省略可。例: main）' });

            await createBranch(repo.repoRoot, name, base || undefined, true);
            await refresh();
            break;
          }

          case 'rename': {
            const newName = await vscode.window.showInputBox({
              prompt: `新しいブランチ名（${msg.oldName} → ?）`,
              validateInput: simpleBranchNameValidator,
              value: msg.oldName,
            });
            if (!newName || newName === msg.oldName) {
              break;
            }

            const cfg = getCfg();
            if (isProtectedBranch(msg.oldName, cfg.protected)) {
              vscode.window.showWarningMessage('保護ブランチはリネームできません');
              break;
            }

            await renameBranch(repo.repoRoot, msg.oldName, newName);
            await refresh();
            break;
          }

          case 'deleteLocal': {
            const cfg = getCfg();
            if (isProtectedBranch(msg.name, cfg.protected)) {
              vscode.window.showWarningMessage('保護ブランチは削除できません');
              break;
            }

            const proceed = !cfg.confirmBeforeDelete || (await confirm(`ローカルブランチ ${msg.name} を削除しますか？`));
            if (!proceed) {
              break;
            }

            await deleteLocalBranch(repo.repoRoot, msg.name, cfg.forceDeleteLocal);
            await refresh();
            break;
          }

          case 'mergeIntoCurrent': {
            const current = await getCurrentBranch(repo.repoRoot);
            if (current && msg.source === current) {
              vscode.window.showInformationMessage('現在のブランチに対して自身をマージする操作は無効です');
              break;
            }

            const cfg = getCfg();
            if (isProtectedBranch(msg.source, cfg.protected)) {
              vscode.window.showWarningMessage('保護ブランチはマージ元に指定できません');
              break;
            }

            const proceed = await confirm(`現在のブランチに ${msg.source} をマージしますか？`);
            if (!proceed) {
              break;
            }

            await mergeIntoCurrent(repo.repoRoot, msg.source);
            await refresh();
            break;
          }

          case 'deleteRemote': {
            const cfg = getCfg();
            if (isProtectedBranch(msg.name, cfg.protected)) {
              vscode.window.showWarningMessage('保護ブランチはリモート削除できません');
              break;
            }

            const proceed = await confirm(`リモートブランチ ${msg.remote}/${msg.name} を削除しますか？`);
            if (!proceed) {
              break;
            }

            await deleteRemoteBranch(repo.repoRoot, msg.remote, msg.name);
            await refresh();
            break;
          }

          case 'detectDead': {
            const base = await resolveBaseBranch(repo.repoRoot);
            const dead = await detectDeadBranches(repo.repoRoot, base);
            if (dead.length === 0) {
              vscode.window.showInformationMessage(`デッドブランチはありません（基準: ${base}）`);
              break;
            }

            const pick = await vscode.window.showQuickPick(
              dead.map((d) => ({ label: d, picked: true })),
              {
                canPickMany: true,
                title: `削除するデッドブランチを選択（基準: ${base}）`,
              }
            );

            if (!pick || pick.length === 0) {
              break;
            }

            const cfg = getCfg();
            const names = pick.map((p) => p.label);

            const proceed = !cfg.confirmBeforeDelete || (await confirm(`選択した ${names.length} 件のローカルブランチを削除しますか？`));
            if (!proceed) {
              break;
            }

            for (const n of names) {
              await deleteLocalBranch(repo.repoRoot, n, cfg.forceDeleteLocal);
            }

            if (cfg.includeRemoteInDeadCleanup) {
              const upstreams = await getUpstreamMap(repo.repoRoot);
              for (const n of names) {
                const up = upstreams.get(n);
                if (up && up.includes('/')) {
                  const [remote, ...rest] = up.split('/');
                  const rName = rest.join('/');
                  if (!isProtectedBranch(rName, cfg.protected)) {
                    try {
                      await deleteRemoteBranch(repo.repoRoot, remote, rName);
                    } catch {
                      // ignore
                    }
                  }
                }
              }
            }

            await refresh();
            break;
          }
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
      }
    },
    undefined,
    context.subscriptions
  );

  await refresh();
}

/**
 * Convenience command that opens manager for the selected repo.
 * (Used only if you want to keep extension.ts thinner.)
 */
export async function openManagerCommand(context: vscode.ExtensionContext) {
  const repo = await pickRepository();
  if (!repo) {
    vscode.window.showWarningMessage('Git リポジトリが見つかりません。フォルダを開くか Git を初期化してください。');
    return;
  }

  await openManagerPanel(context, repo);
}

function openLogInTerminal(cwd: string, ref: string) {
  const term = vscode.window.createTerminal({ cwd, name: 'Git Log' });
  term.show();
  term.sendText(`git log --oneline --graph --decorate ${ref}`);
}

async function getHtmlFromFile(context: vscode.ExtensionContext, nonce: string): Promise<string> {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  // Read bundled html template
  const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'branchManager.html');
  const filePath = htmlPath.fsPath;

  const html = await readFile(filePath, 'utf8');

  return html
    .replaceAll('{{CSP}}', csp)
    .replaceAll('{{NONCE}}', nonce);
}
