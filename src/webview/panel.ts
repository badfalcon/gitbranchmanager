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
  const panel = vscode.window.createWebviewPanel(
    'gitBranchManager',
    vscode.l10n.t('Branch Manager'),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

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
              prompt: vscode.l10n.t('New branch name'),
              validateInput: simpleBranchNameValidator,
            });
            if (!name) {
              break;
            }

            const base = await vscode.window.showInputBox({
              prompt: vscode.l10n.t('Base branch (optional, e.g. main)'),
            });

            await createBranch(repo.repoRoot, name, base || undefined, true);
            await refresh();
            break;
          }

          case 'rename': {
            const newName = await vscode.window.showInputBox({
              prompt: vscode.l10n.t('New branch name ({0} → ?)', msg.oldName),
              validateInput: simpleBranchNameValidator,
              value: msg.oldName,
            });
            if (!newName || newName === msg.oldName) {
              break;
            }

            const cfg = getCfg();
            if (isProtectedBranch(msg.oldName, cfg.protected)) {
              vscode.window.showWarningMessage(vscode.l10n.t('Protected branches cannot be renamed.'));
              break;
            }

            await renameBranch(repo.repoRoot, msg.oldName, newName);
            await refresh();
            break;
          }

          case 'deleteLocal': {
            const cfg = getCfg();
            if (isProtectedBranch(msg.name, cfg.protected)) {
              vscode.window.showWarningMessage(vscode.l10n.t('Protected branches cannot be deleted.'));
              break;
            }

            const proceed =
              !cfg.confirmBeforeDelete ||
              (await confirm(vscode.l10n.t('Delete local branch {0}?', msg.name)));
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
              vscode.window.showInformationMessage(
                vscode.l10n.t('Merging a branch into itself is not allowed.')
              );
              break;
            }

            const cfg = getCfg();
            if (isProtectedBranch(msg.source, cfg.protected)) {
              vscode.window.showWarningMessage(
                vscode.l10n.t('Protected branches cannot be selected as the merge source.')
              );
              break;
            }

            const proceed = await confirm(
              vscode.l10n.t('Merge {0} into the current branch?', msg.source)
            );
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
              vscode.window.showWarningMessage(
                vscode.l10n.t('Protected branches cannot be deleted remotely.')
              );
              break;
            }

            const proceed = await confirm(
              vscode.l10n.t('Delete remote branch {0}/{1}?', msg.remote, msg.name)
            );
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
              vscode.window.showInformationMessage(
                vscode.l10n.t('No dead branches found (base: {0}).', base)
              );
              break;
            }

            const pick = await vscode.window.showQuickPick(
              dead.map((d) => ({ label: d, picked: true })),
              {
                canPickMany: true,
                title: vscode.l10n.t('Select dead branches to delete (base: {0})', base),
              }
            );

            if (!pick || pick.length === 0) {
              break;
            }

            const cfg = getCfg();
            const names = pick.map((p) => p.label);

            const proceed =
              !cfg.confirmBeforeDelete ||
              (await confirm(vscode.l10n.t('Delete {0} selected local branches?', names.length)));
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
    vscode.window.showWarningMessage(
      vscode.l10n.t('No Git repository found. Open a folder or initialize Git.')
    );
    return;
  }

  await openManagerPanel(context, repo);
}

function openLogInTerminal(cwd: string, ref: string) {
  const term = vscode.window.createTerminal({ cwd, name: vscode.l10n.t('Git Log') });
  term.show();
  term.sendText(`git log --oneline --graph --decorate ${ref}`);
}

type WebviewI18n = {
  errorFallback: string;

  refresh: string;
  create: string;
  detectDead: string;

  localBranches: string;
  remoteBranches: string;

  localHeaderCurrent: string;
  localHeaderName: string;
  localHeaderUpstream: string;
  localHeaderAhead: string;
  localHeaderBehind: string;
  localHeaderActions: string;

  remoteHeaderRemote: string;
  remoteHeaderName: string;
  remoteHeaderActions: string;

  actionCheckout: string;
  actionLog: string;
  actionRename: string;
  actionDelete: string;
  actionMergeIntoCurrent: string;
  actionDeleteRemote: string;

  badgeHead: string;
};

function getWebviewI18n(): WebviewI18n {
  return {
    errorFallback: vscode.l10n.t('Error'),

    refresh: vscode.l10n.t('Refresh'),
    create: vscode.l10n.t('Create'),
    detectDead: vscode.l10n.t('Detect Dead'),

    localBranches: vscode.l10n.t('Local Branches'),
    remoteBranches: vscode.l10n.t('Remote Branches'),

    localHeaderCurrent: vscode.l10n.t('Current'),
    localHeaderName: vscode.l10n.t('Name'),
    localHeaderUpstream: vscode.l10n.t('Upstream'),
    localHeaderAhead: vscode.l10n.t('Ahead'),
    localHeaderBehind: vscode.l10n.t('Behind'),
    localHeaderActions: vscode.l10n.t('Actions'),

    remoteHeaderRemote: vscode.l10n.t('Remote'),
    remoteHeaderName: vscode.l10n.t('Name'),
    remoteHeaderActions: vscode.l10n.t('Actions'),

    actionCheckout: vscode.l10n.t('Checkout'),
    actionLog: vscode.l10n.t('Log'),
    actionRename: vscode.l10n.t('Rename'),
    actionDelete: vscode.l10n.t('Delete'),
    actionMergeIntoCurrent: vscode.l10n.t('Merge into current'),
    actionDeleteRemote: vscode.l10n.t('Delete Remote'),

    badgeHead: vscode.l10n.t('HEAD'),
  };
}

function toBase64UnicodeJson(value: unknown): string {
  // Embed i18n payload as base64 to keep the HTML template valid JavaScript
  // before runtime placeholder substitution.
  const json = JSON.stringify(value);
  return Buffer.from(json, 'utf8').toString('base64');
}

async function getHtmlFromFile(context: vscode.ExtensionContext, nonce: string): Promise<string> {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'branchManager.html');
  const html = await readFile(htmlPath.fsPath, 'utf8');

  const i18n = getWebviewI18n();

  return html
    .replaceAll('{{CSP}}', csp)
    .replaceAll('{{NONCE}}', nonce)
    .replaceAll('{{I18N_B64}}', toBase64UnicodeJson(i18n));
}
