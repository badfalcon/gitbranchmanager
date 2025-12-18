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
    vscode.l10n.t('panel.title'),
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
              prompt: vscode.l10n.t('panel.prompt.newBranchName'),
              validateInput: simpleBranchNameValidator,
            });
            if (!name) {
              break;
            }

            const base = await vscode.window.showInputBox({
              prompt: vscode.l10n.t('panel.prompt.baseBranchOptional'),
            });

            await createBranch(repo.repoRoot, name, base || undefined, true);
            await refresh();
            break;
          }

          case 'rename': {
            const newName = await vscode.window.showInputBox({
              prompt: vscode.l10n.t('panel.prompt.renameBranch', msg.oldName),
              validateInput: simpleBranchNameValidator,
              value: msg.oldName,
            });
            if (!newName || newName === msg.oldName) {
              break;
            }

            const cfg = getCfg();
            if (isProtectedBranch(msg.oldName, cfg.protected)) {
              vscode.window.showWarningMessage(vscode.l10n.t('panel.warn.protectedCannotRename'));
              break;
            }

            await renameBranch(repo.repoRoot, msg.oldName, newName);
            await refresh();
            break;
          }

          case 'deleteLocal': {
            const cfg = getCfg();
            if (isProtectedBranch(msg.name, cfg.protected)) {
              vscode.window.showWarningMessage(vscode.l10n.t('panel.warn.protectedCannotDelete'));
              break;
            }

            const proceed =
              !cfg.confirmBeforeDelete ||
              (await confirm(vscode.l10n.t('panel.confirm.deleteLocal', msg.name)));
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
              vscode.window.showInformationMessage(vscode.l10n.t('panel.info.mergeSelfInvalid'));
              break;
            }

            const cfg = getCfg();
            if (isProtectedBranch(msg.source, cfg.protected)) {
              vscode.window.showWarningMessage(vscode.l10n.t('panel.warn.protectedCannotMergeSource'));
              break;
            }

            const proceed = await confirm(vscode.l10n.t('panel.confirm.mergeIntoCurrent', msg.source));
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
              vscode.window.showWarningMessage(vscode.l10n.t('panel.warn.protectedCannotDeleteRemote'));
              break;
            }

            const proceed = await confirm(vscode.l10n.t('panel.confirm.deleteRemote', msg.remote, msg.name));
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
              vscode.window.showInformationMessage(vscode.l10n.t('panel.info.noDeadBranches', base));
              break;
            }

            const pick = await vscode.window.showQuickPick(
              dead.map((d) => ({ label: d, picked: true })),
              {
                canPickMany: true,
                title: vscode.l10n.t('panel.pickDeadBranches.title', base),
              }
            );

            if (!pick || pick.length === 0) {
              break;
            }

            const cfg = getCfg();
            const names = pick.map((p) => p.label);

            const proceed =
              !cfg.confirmBeforeDelete ||
              (await confirm(vscode.l10n.t('panel.confirm.deleteDeadCount', names.length)));
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
    vscode.window.showWarningMessage(vscode.l10n.t('errors.noGitRepo'));
    return;
  }

  await openManagerPanel(context, repo);
}

function openLogInTerminal(cwd: string, ref: string) {
  const term = vscode.window.createTerminal({ cwd, name: vscode.l10n.t('terminal.gitLog.name') });
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
    errorFallback: vscode.l10n.t('webview.error.fallback'),

    refresh: vscode.l10n.t('webview.toolbar.refresh'),
    create: vscode.l10n.t('webview.toolbar.create'),
    detectDead: vscode.l10n.t('webview.toolbar.detectDead'),

    localBranches: vscode.l10n.t('webview.section.local'),
    remoteBranches: vscode.l10n.t('webview.section.remote'),

    localHeaderCurrent: vscode.l10n.t('webview.table.local.current'),
    localHeaderName: vscode.l10n.t('webview.table.local.name'),
    localHeaderUpstream: vscode.l10n.t('webview.table.local.upstream'),
    localHeaderAhead: vscode.l10n.t('webview.table.local.ahead'),
    localHeaderBehind: vscode.l10n.t('webview.table.local.behind'),
    localHeaderActions: vscode.l10n.t('webview.table.local.actions'),

    remoteHeaderRemote: vscode.l10n.t('webview.table.remote.remote'),
    remoteHeaderName: vscode.l10n.t('webview.table.remote.name'),
    remoteHeaderActions: vscode.l10n.t('webview.table.remote.actions'),

    actionCheckout: vscode.l10n.t('webview.action.checkout'),
    actionLog: vscode.l10n.t('webview.action.log'),
    actionRename: vscode.l10n.t('webview.action.rename'),
    actionDelete: vscode.l10n.t('webview.action.delete'),
    actionMergeIntoCurrent: vscode.l10n.t('webview.action.mergeIntoCurrent'),
    actionDeleteRemote: vscode.l10n.t('webview.action.deleteRemote'),

    badgeHead: vscode.l10n.t('webview.badge.head'),
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
