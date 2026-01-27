import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';

import {
  checkoutBranch,
  confirm,
  createBranch,
  deleteLocalBranch,
  deleteRemoteBranch,
  fetchWithPrune,
  getCfg,
  getCurrentBranch,
  getUpstreamMap,
  isProtectedBranch,
  listLocalBranchesWithStatus,
  listRemoteBranchesWithStatus,
  mergeIntoCurrent,
  pickRepository,
  renameBranch,
  resolveBaseBranch,
  simpleBranchNameValidator,
  type RepoContext,
  type WebviewMessage,
} from '../app';

type State = {
  locals: Awaited<ReturnType<typeof listLocalBranchesWithStatus>>;
  remotes: Awaited<ReturnType<typeof listRemoteBranchesWithStatus>>;
  repoRoot: string;
  current?: string;
  baseBranch?: string;
  staleDays?: number;
  showStatusBadges?: boolean;
  allowRemoteBranchDeletion?: boolean;
};

async function getState(repoRoot: string): Promise<State> {
  const cfg = getCfg();

  // Auto fetch with prune if enabled (updates remote tracking refs before detection)
  if (cfg.autoFetchPrune) {
    try {
      await fetchWithPrune(repoRoot);
    } catch {
      // Ignore fetch errors (e.g., no network)
    }
  }

  const [baseBranch, current] = await Promise.all([
    resolveBaseBranch(repoRoot),
    getCurrentBranch(repoRoot),
  ]);

  // Get locals and remotes with status information
  const [locals, remotes] = await Promise.all([
    listLocalBranchesWithStatus(repoRoot, baseBranch, cfg.staleDays),
    listRemoteBranchesWithStatus(repoRoot, baseBranch, cfg.staleDays),
  ]);

  for (const b of locals) {
    b.isCurrent = b.short === current;
  }

  return {
    locals,
    remotes,
    repoRoot,
    current,
    baseBranch,
    staleDays: cfg.staleDays,
    showStatusBadges: cfg.showStatusBadges,
    allowRemoteBranchDeletion: cfg.allowRemoteBranchDeletion,
  };
}

export async function openManagerPanel(context: vscode.ExtensionContext, repo: RepoContext) {
  const panel = vscode.window.createWebviewPanel(
    'gitBranchCleaner',
    'Git Souji',
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

          case 'openSettings':
            await vscode.commands.executeCommand('workbench.action.openSettings', 'gitSouji');
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

          case 'executeCleanup': {
            const cfg = getCfg();
            const branches = msg.branches;

            if (branches.length === 0) {
              break;
            }

            const proceed =
              !cfg.confirmBeforeDelete ||
              (await confirm(vscode.l10n.t('Delete {0} selected local branches?', branches.length)));
            if (!proceed) {
              break;
            }

            const failedLocal: string[] = [];
            const failedRemote: string[] = [];
            const deletedBranches: string[] = [];

            for (const name of branches) {
              try {
                await deleteLocalBranch(repo.repoRoot, name, cfg.forceDeleteLocal);
                deletedBranches.push(name);
              } catch {
                failedLocal.push(name);
              }
            }

            // If some branches failed (likely unmerged), offer to force delete
            if (failedLocal.length > 0 && !cfg.forceDeleteLocal) {
              const forceDelete = await confirm(
                vscode.l10n.t(
                  '{0} branches are not fully merged. Force delete them?',
                  failedLocal.length
                )
              );
              if (forceDelete) {
                const stillFailed: string[] = [];
                for (const name of failedLocal) {
                  try {
                    await deleteLocalBranch(repo.repoRoot, name, true);
                    deletedBranches.push(name);
                  } catch {
                    stillFailed.push(name);
                  }
                }
                failedLocal.length = 0;
                failedLocal.push(...stillFailed);
              }
            }

            if (msg.includeRemote) {
              const upstreams = await getUpstreamMap(repo.repoRoot);

              // Separate tracked and untracked branches
              const trackedRemotes: { remote: string; name: string; full: string }[] = [];
              const untrackedRemotes: { remote: string; name: string; full: string }[] = [];

              for (const name of deletedBranches) {
                const up = upstreams.get(name);
                if (up && up.includes('/')) {
                  const [remote, ...rest] = up.split('/');
                  const rName = rest.join('/');
                  if (!isProtectedBranch(rName, cfg.protected)) {
                    trackedRemotes.push({ remote, name: rName, full: up });
                  }
                } else {
                  // No tracking - check if origin/<name> exists
                  if (!isProtectedBranch(name, cfg.protected)) {
                    untrackedRemotes.push({ remote: 'origin', name, full: `origin/${name}` });
                  }
                }
              }

              // Delete tracked remotes directly
              for (const { remote, name, full } of trackedRemotes) {
                try {
                  await deleteRemoteBranch(repo.repoRoot, remote, name);
                } catch {
                  failedRemote.push(full);
                }
              }

              // Ask confirmation for untracked remotes with same name
              if (untrackedRemotes.length > 0) {
                const deleteUntracked = await confirm(
                  vscode.l10n.t(
                    'Also delete {0} remote branches with same name (not tracked)?',
                    untrackedRemotes.length
                  )
                );
                if (deleteUntracked) {
                  for (const { remote, name } of untrackedRemotes) {
                    try {
                      await deleteRemoteBranch(repo.repoRoot, remote, name);
                    } catch {
                      // Ignore - might not exist on remote
                    }
                  }
                }
              }
            }

            // Report any failures to the user
            if (failedLocal.length > 0 || failedRemote.length > 0) {
              const parts: string[] = [];
              if (failedLocal.length > 0) {
                parts.push(vscode.l10n.t('Local: {0}', failedLocal.join(', ')));
              }
              if (failedRemote.length > 0) {
                parts.push(vscode.l10n.t('Remote: {0}', failedRemote.join(', ')));
              }
              vscode.window.showWarningMessage(
                vscode.l10n.t('Failed to delete some branches: {0}', parts.join('; '))
              );
            }

            await refresh();
            break;
          }

          case 'executeRemoteCleanup': {
            const cfg = getCfg();
            const branches = msg.branches; // Format: "origin/branch-name"

            if (branches.length === 0) {
              break;
            }

            const proceed =
              !cfg.confirmBeforeDelete ||
              (await confirm(vscode.l10n.t('Delete {0} selected remote branches?', branches.length)));
            if (!proceed) {
              break;
            }

            const failed: string[] = [];
            for (const fullName of branches) {
              // Parse "origin/branch-name" into remote and name
              const parts = fullName.split('/');
              const remote = parts.shift()!;
              const name = parts.join('/');

              if (isProtectedBranch(name, cfg.protected)) {
                failed.push(fullName);
                continue;
              }

              try {
                await deleteRemoteBranch(repo.repoRoot, remote, name);
              } catch {
                failed.push(fullName);
              }
            }

            if (failed.length > 0) {
              vscode.window.showWarningMessage(
                vscode.l10n.t('Failed to delete some branches: {0}', failed.join(', '))
              );
            }

            await refresh();
            break;
          }

          case 'deleteSelectedBranches': {
            const cfg = getCfg();
            const { localBranches, remoteBranches } = msg;
            const total = localBranches.length + remoteBranches.length;

            if (total === 0) {
              break;
            }

            const proceed =
              !cfg.confirmBeforeDelete ||
              (await confirm(vscode.l10n.t('Delete {0} selected branches?', total)));
            if (!proceed) {
              break;
            }

            const failedLocal: string[] = [];
            const failedRemote: string[] = [];

            // Delete local branches
            for (const name of localBranches) {
              try {
                await deleteLocalBranch(repo.repoRoot, name, cfg.forceDeleteLocal);
              } catch {
                failedLocal.push(name);
              }
            }

            // Offer force delete for unmerged local branches
            if (failedLocal.length > 0 && !cfg.forceDeleteLocal) {
              const forceDelete = await confirm(
                vscode.l10n.t(
                  '{0} branches are not fully merged. Force delete them?',
                  failedLocal.length
                )
              );
              if (forceDelete) {
                const stillFailed: string[] = [];
                for (const name of failedLocal) {
                  try {
                    await deleteLocalBranch(repo.repoRoot, name, true);
                  } catch {
                    stillFailed.push(name);
                  }
                }
                failedLocal.length = 0;
                failedLocal.push(...stillFailed);
              }
            }

            // Delete remote branches
            for (const fullName of remoteBranches) {
              const parts = fullName.split('/');
              const remote = parts.shift()!;
              const name = parts.join('/');

              if (isProtectedBranch(name, cfg.protected)) {
                failedRemote.push(fullName);
                continue;
              }

              try {
                await deleteRemoteBranch(repo.repoRoot, remote, name);
              } catch {
                failedRemote.push(fullName);
              }
            }

            // Report failures
            if (failedLocal.length > 0 || failedRemote.length > 0) {
              const parts: string[] = [];
              if (failedLocal.length > 0) {
                parts.push(vscode.l10n.t('Local: {0}', failedLocal.join(', ')));
              }
              if (failedRemote.length > 0) {
                parts.push(vscode.l10n.t('Remote: {0}', failedRemote.join(', ')));
              }
              vscode.window.showWarningMessage(
                vscode.l10n.t('Failed to delete some branches: {0}', parts.join('; '))
              );
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

  localBranches: string;
  remoteBranches: string;

  localHeaderCurrent: string;
  localHeaderName: string;
  localHeaderStatus: string;
  localHeaderUpstream: string;
  localHeaderAhead: string;
  localHeaderBehind: string;
  localHeaderLastCommit: string;
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
  badgeMerged: string;
  badgeStale: string;
  badgeGone: string;

  // Cleanup toolbar
  cleanupLabel: string;
  cleanupMerged: string;
  cleanupStale: string;
  cleanupGone: string;
  cleanupAll: string;

  // Preview panel
  previewTitle: string;
  previewIncludeRemote: string;
  previewCancel: string;
  previewExecute: string;
  previewSelectAll: string;
  previewReasons: string;
  previewNoCandidates: string;

  // Age display
  daysAgo: string;

  // Select mode
  selectMode: string;
  deleteSelected: string;
  selectedCount: string;

  // Search
  searchPlaceholder: string;
  searchCaseSensitive: string;
  searchUseRegex: string;

  // Settings
  openSettings: string;
};

function getWebviewI18n(): WebviewI18n {
  return {
    errorFallback: vscode.l10n.t('Error'),

    refresh: vscode.l10n.t('Refresh'),
    create: vscode.l10n.t('Create'),

    localBranches: vscode.l10n.t('Local Branches'),
    remoteBranches: vscode.l10n.t('Remote Branches'),

    localHeaderCurrent: vscode.l10n.t('Current'),
    localHeaderName: vscode.l10n.t('Name'),
    localHeaderStatus: vscode.l10n.t('Status'),
    localHeaderUpstream: vscode.l10n.t('Upstream'),
    localHeaderAhead: vscode.l10n.t('Ahead'),
    localHeaderBehind: vscode.l10n.t('Behind'),
    localHeaderLastCommit: vscode.l10n.t('Last Commit'),
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
    badgeMerged: vscode.l10n.t('merged'),
    badgeStale: vscode.l10n.t('stale'),
    badgeGone: vscode.l10n.t('gone'),

    // Cleanup toolbar
    cleanupLabel: vscode.l10n.t('Cleanup:'),
    cleanupMerged: vscode.l10n.t('Merged'),
    cleanupStale: vscode.l10n.t('Stale'),
    cleanupGone: vscode.l10n.t('Gone'),
    cleanupAll: vscode.l10n.t('Cleanup All'),

    // Preview panel
    previewTitle: vscode.l10n.t('Cleanup Preview'),
    previewIncludeRemote: vscode.l10n.t('Also delete corresponding remote branches'),
    previewCancel: vscode.l10n.t('Cancel'),
    previewExecute: vscode.l10n.t('Delete Selected'),
    previewSelectAll: vscode.l10n.t('Select All'),
    previewReasons: vscode.l10n.t('Reasons'),
    previewNoCandidates: vscode.l10n.t('No cleanup candidates found.'),

    // Age display
    daysAgo: vscode.l10n.t('{0}d ago'),

    // Select mode
    selectMode: vscode.l10n.t('Select'),
    deleteSelected: vscode.l10n.t('Delete Selected'),
    selectedCount: vscode.l10n.t('{0} selected'),

    // Search
    searchPlaceholder: vscode.l10n.t('Search branches...'),
    searchCaseSensitive: vscode.l10n.t('Match Case'),
    searchUseRegex: vscode.l10n.t('Use Regular Expression'),

    // Settings
    openSettings: vscode.l10n.t('Settings'),
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
