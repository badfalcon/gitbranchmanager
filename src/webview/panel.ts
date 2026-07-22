import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import {
  checkoutBranch,
  classifyDeletionCause,
  confirm,
  confirmSwitchAwayTarget,
  createBranch,
  deleteLocalBranch,
  deleteRemoteBranch,
  deletionCauseMessage,
  fetchWithPrune,
  getCfg,
  getCurrentBranch,
  isProtectedBranch,
  listLocalBranchesWithStatus,
  listRemoteBranchesWithStatus,
  mergeIntoCurrent,
  renameBranch,
  resolveBaseBranch,
  resolveDeletionCause,
  simpleBranchNameValidator,
  type RepoContext,
  type WebviewMessage,
} from '../app';
import type { QueueTreeProvider } from '../queue/queueTreeProvider';

type State = {
  locals: Awaited<ReturnType<typeof listLocalBranchesWithStatus>>;
  remotes: Awaited<ReturnType<typeof listRemoteBranchesWithStatus>>;
  repoRoot: string;
  current?: string;
  baseBranch?: string;
  staleDays?: number;
  showStatusBadges?: boolean;
  allowRemoteBranchDeletion?: boolean;
  queued?: { name: string; kind: 'local' | 'remote' }[];
};

async function getState(repoRoot: string, queueProvider: QueueTreeProvider): Promise<State> {
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
    listLocalBranchesWithStatus(repoRoot, baseBranch, cfg.staleDays, cfg.detectParentMerges),
    listRemoteBranchesWithStatus(repoRoot, baseBranch, cfg.staleDays),
  ]);

  return {
    locals,
    remotes,
    repoRoot,
    current,
    baseBranch,
    staleDays: cfg.staleDays,
    showStatusBadges: cfg.showStatusBadges,
    allowRemoteBranchDeletion: cfg.allowRemoteBranchDeletion,
    queued: queueProvider.getQueuedBranches(),
  };
}

let activePanel: vscode.WebviewPanel | undefined;
let activeRepoRoot: string | undefined;

export async function openManagerPanel(
  context: vscode.ExtensionContext,
  repo: RepoContext,
  queueProvider: QueueTreeProvider
) {
  // Reuse existing panel when the repo hasn't changed; recreate on switch
  if (activePanel) {
    if (activeRepoRoot === repo.repoRoot) {
      activePanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const stale = activePanel;
    activePanel = undefined;
    activeRepoRoot = undefined;
    stale.dispose();
  }

  const panel = vscode.window.createWebviewPanel(
    'gitBranchCleaner',
    'Git Sohji',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );
  activePanel = panel;
  activeRepoRoot = repo.repoRoot;
  panel.onDidDispose(() => {
    activePanel = undefined;
    activeRepoRoot = undefined;
  }, undefined, context.subscriptions);

  const nonce = randomBytes(16).toString('base64url');
  panel.webview.html = await getHtmlFromFile(context, nonce);

  const refresh = async () => {
    panel.webview.postMessage({ type: 'loading' });
    try {
      const state = await getState(repo.repoRoot, queueProvider);
      panel.webview.postMessage({ type: 'state', state });
    } catch (err: any) {
      panel.webview.postMessage({ type: 'error', message: err?.message ?? String(err) });
    }
  };

  queueProvider.setPostExecuteHook(refresh);

  // Reflect setting changes (e.g. allowRemoteBranchDeletion, staleDays,
  // showStatusBadges) in the open panel without requiring a manual refresh.
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('gitSouji')) {
      void refresh();
    }
  });
  panel.onDidDispose(() => configListener.dispose(), undefined, context.subscriptions);

  // Serialize git-touching operations so a double-click (or an action fired
  // while a refresh is in flight) can't run two git commands concurrently and
  // race the resulting state messages.
  const SERIALIZED: ReadonlySet<WebviewMessage['type']> = new Set([
    'ready',
    'refresh',
    'checkout',
    'create',
    'rename',
    'deleteLocal',
    'mergeIntoCurrent',
    'deleteRemote',
  ]);
  let busy = false;

  panel.webview.onDidReceiveMessage(
    async (raw: unknown) => {
      const msg = raw as WebviewMessage;

      const guarded = SERIALIZED.has(msg.type);
      if (guarded) {
        if (busy) {
          return;
        }
        busy = true;
      }

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
            await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:badfalcon.gitsouji');
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

            try {
              await deleteLocalBranch(repo.repoRoot, msg.name, cfg.forceDeleteLocal);
            } catch (err) {
              await handleLocalDeleteFailure(repo.repoRoot, msg.name, err, cfg.forceDeleteLocal);
            }
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
            // Parity with the queue (queueTreeProvider's retry/execute paths):
            // the webview hides the button when the setting is off, but a
            // message can still arrive from a table rendered before the setting
            // changed — the refresh that re-renders it is async.
            if (!cfg.allowRemoteBranchDeletion) {
              vscode.window.showWarningMessage(
                vscode.l10n.t('Remote branch deletion is disabled in settings.')
              );
              break;
            }
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

            try {
              await deleteRemoteBranch(repo.repoRoot, msg.remote, msg.name);
            } catch (err) {
              await handleRemoteDeleteFailure(repo.repoRoot, msg.remote, msg.name, err);
            }
            await refresh();
            break;
          }

          case 'addToQueue': {
            const added = queueProvider.add(msg.items);
            panel.webview.postMessage({
              type: 'queueAdded',
              count: added,
              queued: queueProvider.getQueuedBranches(),
            });
            break;
          }
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
      } finally {
        if (guarded) {
          busy = false;
        }
      }
    },
    undefined,
    context.subscriptions
  );

  await refresh();
}

/**
 * Cause-aware handling for a failed single local-branch delete. Shows the
 * classified reason and, where a recovery exists, offers it as a modal action.
 * Modal is required: this runs while the panel's `busy` flag is held, and a
 * non-modal notification left unanswered would freeze the webview forever.
 * Never rethrows — all outcomes are surfaced here.
 *
 * A retry that fails again is fed back through this handler so the new
 * failure is reclassified (e.g. current branch turns out to also be unmerged
 * after switching — the user still gets the Force Delete offer).
 * `isRecoveryRetry` breaks the recursion for the switch-away path.
 */
async function handleLocalDeleteFailure(
  cwd: string,
  name: string,
  err: unknown,
  alreadyForced: boolean,
  isRecoveryRetry = false
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const cause = await resolveDeletionCause(cwd, name, message);
  const display = cause ? deletionCauseMessage(cause) : message;

  if (cause === 'unmerged' && !alreadyForced) {
    const forceAction = vscode.l10n.t('Force Delete');
    const pick = await vscode.window.showWarningMessage(display, { modal: true }, forceAction);
    if (pick === forceAction) {
      try {
        await deleteLocalBranch(cwd, name, true);
      } catch (e2) {
        await handleLocalDeleteFailure(cwd, name, e2, true, true);
      }
    }
    return;
  }

  if (cause === 'checkedOutCurrent' && !isRecoveryRetry) {
    const base = await confirmSwitchAwayTarget(cwd, name);
    if (!base) {
      return;
    }
    try {
      await checkoutBranch(cwd, base);
    } catch (e2) {
      // e.g. dirty working tree — the delete was never retried
      vscode.window.showErrorMessage(e2 instanceof Error ? e2.message : String(e2));
      return;
    }
    try {
      await deleteLocalBranch(cwd, name, alreadyForced);
    } catch (e2) {
      // Reclassify the second failure (commonly 'unmerged') instead of
      // dumping the raw git error without a recovery action.
      await handleLocalDeleteFailure(cwd, name, e2, alreadyForced, true);
    }
    return;
  }

  vscode.window.showErrorMessage(display);
}

/**
 * Cause-aware handling for a failed single remote-branch delete.
 * Never rethrows — all outcomes are surfaced here.
 */
async function handleRemoteDeleteFailure(
  cwd: string,
  remote: string,
  name: string,
  err: unknown
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  // Remote failures never resolve to a checkedOut* cause, so the sync
  // classifier is enough here.
  const cause = classifyDeletionCause(message);
  const display = cause ? deletionCauseMessage(cause) : message;

  if (cause === 'remoteGone') {
    const pruneAction = vscode.l10n.t('Update Tracking Refs');
    const pick = await vscode.window.showWarningMessage(display, { modal: true }, pruneAction);
    if (pick === pruneAction) {
      try {
        await fetchWithPrune(cwd, remote);
      } catch (e2) {
        vscode.window.showWarningMessage(e2 instanceof Error ? e2.message : String(e2));
      }
    }
    return;
  }

  vscode.window.showErrorMessage(display);
}

let logTerminal: vscode.Terminal | undefined;

/**
 * Show `git log` for a ref in a terminal.
 *
 * SECURITY: the ref is passed as an argv entry — never interpolated into a
 * command string for a shell to parse. Git permits `$`, backtick, `;`, `&` and
 * quotes in branch names (only space, `~ ^ : ? * [ \` and control characters
 * are rejected), so a branch fetched from an untrusted remote can carry a shell
 * payload. The previous implementation built a string with JSON.stringify —
 * which escapes for JSON, not for any shell — and handed it to
 * `Terminal.sendText`, which also submits it. Under PowerShell (the Windows
 * default) `"x$(whoami)y"` performs command substitution, so merely clicking
 * **Log** on a branch named `x$(...)y` executed its contents.
 *
 * `shellPath`/`shellArgs` launches git directly with an argument vector, so no
 * shell ever parses the ref. The trade-off is that a terminal started this way
 * cannot be fed a second command, so the previous one is disposed rather than
 * reused — the user still sees a single "Git Log" terminal at a time.
 */
function openLogInTerminal(cwd: string, ref: string) {
  logTerminal?.dispose();
  logTerminal = vscode.window.createTerminal({
    cwd,
    name: vscode.l10n.t('Git Log'),
    shellPath: 'git',
    // The ref must come before `--`; `git log -- <ref>` would treat <ref> as a
    // pathspec and show the wrong (usually empty) history.
    shellArgs: ['log', '--oneline', '--graph', '--decorate', ref, '--'],
  });
  logTerminal.show();
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

  headerAuthor: string;

  actionCheckout: string;
  actionLog: string;
  actionRename: string;
  actionDelete: string;
  actionMergeIntoCurrent: string;
  actionDeleteRemote: string;

  badgeHead: string;
  badgeMerged: string;
  badgeMergedParent: string;
  badgeMergedParentTitle: string;
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
  previewCancel: string;
  previewExecute: string;
  previewSelectAll: string;
  previewReasons: string;
  previewNoCandidates: string;

  // Age display
  daysAgo: string;

  // Branch selection
  selectedCount: string;

  // Search
  searchPlaceholder: string;
  searchCaseSensitive: string;
  searchUseRegex: string;

  // Settings
  openSettings: string;

  // Loading
  loading: string;

  // Queue staging (extension side owns the queue/progress UI)
  queueAddedCount: string;
  previewAddToQueue: string;
  queueIncludeRemote: string;
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

    headerAuthor: vscode.l10n.t('Author'),

    actionCheckout: vscode.l10n.t('Checkout'),
    actionLog: vscode.l10n.t('Log'),
    actionRename: vscode.l10n.t('Rename'),
    actionDelete: vscode.l10n.t('Delete'),
    actionMergeIntoCurrent: vscode.l10n.t('Merge into current'),
    actionDeleteRemote: vscode.l10n.t('Delete Remote'),

    badgeHead: vscode.l10n.t('HEAD'),
    badgeMerged: vscode.l10n.t('merged'),
    badgeMergedParent: vscode.l10n.t('merged (parent)'),
    badgeMergedParentTitle: vscode.l10n.t(
      'Merged into a parent branch but not the base branch. Excluded from cleanup because git cannot safely delete it yet.'
    ),
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
    previewCancel: vscode.l10n.t('Cancel'),
    previewExecute: vscode.l10n.t('Delete Selected'),
    previewSelectAll: vscode.l10n.t('Select All'),
    previewReasons: vscode.l10n.t('Reasons'),
    previewNoCandidates: vscode.l10n.t('No cleanup candidates found.'),

    // Age display
    daysAgo: vscode.l10n.t('{0}d ago'),

    // Branch selection
    selectedCount: vscode.l10n.t('{0} selected'),

    // Search
    searchPlaceholder: vscode.l10n.t('Search branches...'),
    searchCaseSensitive: vscode.l10n.t('Match Case'),
    searchUseRegex: vscode.l10n.t('Use Regular Expression'),

    // Settings
    openSettings: vscode.l10n.t('Settings'),

    // Loading
    loading: vscode.l10n.t('Loading...'),

    // Queue staging
    queueAddedCount: vscode.l10n.t('{0} branches added to queue'),
    previewAddToQueue: vscode.l10n.t('Add to Queue'),
    queueIncludeRemote: vscode.l10n.t('Also delete corresponding remote branches'),
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
