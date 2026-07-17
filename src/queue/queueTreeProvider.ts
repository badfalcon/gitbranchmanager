import * as vscode from 'vscode';

import {
  checkoutBranch,
  classifyDeletionCause,
  confirm,
  deleteLocalBranch,
  deleteRemoteBranch,
  deletionCauseMessage,
  fetchWithPrune,
  getCfg,
  getUpstreamMap,
  isProtectedBranch,
  resolveBaseBranch,
  resolveDeletionCause,
  splitRemoteRef,
  type DeletionQueueItem,
  type RepoContext,
} from '../app';

const QUEUE_HAS_ITEMS_CONTEXT = 'gitsouji.queueHasItems';
const QUEUE_EXECUTING_CONTEXT = 'gitsouji.queueExecuting';
const QUEUE_VIEW_FOCUS_COMMAND = 'gitsouji.deletionQueue.focus';

type QueueAddItem = { name: string; kind: 'local' | 'remote'; includeRemote?: boolean };

export class QueueTreeProvider implements vscode.TreeDataProvider<DeletionQueueItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private queue: DeletionQueueItem[] = [];
  private repo?: RepoContext;
  private executing = false;
  private onAfterExecute?: () => Promise<void> | void;

  setRepo(repo: RepoContext): void {
    // Don't drop the queue mid-execution: runExecution mutates and reads
    // this.queue, so replacing it with [] would corrupt an in-flight batch.
    if (
      !this.executing &&
      this.repo &&
      this.repo.repoRoot !== repo.repoRoot &&
      this.queue.length > 0
    ) {
      this.queue = [];
    }
    this.repo = repo;
    this.fireChange();
  }

  setPostExecuteHook(hook: () => Promise<void> | void): void {
    this.onAfterExecute = hook;
  }

  add(items: QueueAddItem[]): number {
    let added = 0;
    for (const item of items) {
      const existing = this.queue.find(q => q.name === item.name && q.kind === item.kind);
      if (existing) {
        // Re-adding a finished entry (succeeded earlier, or failed) makes it
        // actionable again instead of silently doing nothing — e.g. retrying a
        // failed delete, or re-deleting a branch recreated under the same name.
        // Active entries (pending/deleting) are left untouched.
        if (existing.status === 'deleted' || existing.status === 'failed') {
          existing.status = 'pending';
          existing.error = undefined;
          existing.errorCause = undefined;
          existing.includeRemote = !!item.includeRemote;
          added++;
        }
        continue;
      }
      this.queue.push({
        name: item.name,
        kind: item.kind,
        includeRemote: !!item.includeRemote,
        status: 'pending',
      });
      added++;
    }
    if (added > 0) {
      this.fireChange();
      void vscode.commands.executeCommand(QUEUE_VIEW_FOCUS_COMMAND);
    }
    return added;
  }

  removeItem(item: DeletionQueueItem): void {
    if (this.executing) {
      return;
    }
    this.queue = this.queue.filter(q => !(q.name === item.name && q.kind === item.kind));
    this.fireChange();
  }

  clear(): void {
    if (this.executing) {
      return;
    }
    this.queue = [];
    this.fireChange();
  }

  hasPending(): boolean {
    return this.queue.some(q => q.status === 'pending');
  }

  /** Branch name+kind pairs currently in the queue (for webview display).
   * Excludes already-deleted entries so a branch recreated under the same name
   * isn't shown as still-queued/checked. */
  getQueuedBranches(): { name: string; kind: 'local' | 'remote' }[] {
    return this.queue
      .filter(q => q.status !== 'deleted')
      .map(q => ({ name: q.name, kind: q.kind }));
  }

  async execute(): Promise<void> {
    if (this.executing) {
      return;
    }
    if (!this.repo) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('Open Git Sohji first to set the repository.')
      );
      return;
    }
    const pending = this.queue.filter(q => q.status === 'pending');
    if (pending.length === 0) {
      return;
    }

    const cfg = getCfg();
    if (cfg.confirmBeforeDelete) {
      const proceed = await confirm(
        vscode.l10n.t('Delete {0} branches? This cannot be undone.', pending.length)
      );
      if (!proceed) {
        return;
      }
    }

    this.executing = true;
    void vscode.commands.executeCommand('setContext', QUEUE_EXECUTING_CONTEXT, true);
    const repo = this.repo;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Deleting branches...'),
          cancellable: false,
        },
        (progress) => this.runExecution(repo, cfg, progress)
      );
    } finally {
      this.executing = false;
      void vscode.commands.executeCommand('setContext', QUEUE_EXECUTING_CONTEXT, false);
      this.fireChange();
      if (this.onAfterExecute) {
        try {
          await this.onAfterExecute();
        } catch {
          // ignore refresh errors
        }
      }
    }
  }

  async retryItem(item: DeletionQueueItem, force: boolean): Promise<void> {
    if (this.executing) {
      return;
    }
    if (!this.repo) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('Open Git Sohji first to set the repository.')
      );
      return;
    }
    if (item.status !== 'failed' || !this.queue.includes(item)) {
      return;
    }

    const cfg = getCfg();
    if (item.kind === 'remote' && !cfg.allowRemoteBranchDeletion) {
      return;
    }

    const willForce = item.kind === 'local' && (force || cfg.forceDeleteLocal);
    if (willForce && cfg.confirmBeforeDelete) {
      const ok = await confirm(
        vscode.l10n.t('Force delete {0}? Unmerged commits will be lost.', item.name)
      );
      if (!ok) {
        return;
      }
    }

    const repo = this.repo;
    this.executing = true;
    void vscode.commands.executeCommand('setContext', QUEUE_EXECUTING_CONTEXT, true);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: vscode.l10n.t('Retrying...'),
          cancellable: false,
        },
        async (progress) => {
          if (item.kind === 'local') {
            if (isProtectedBranch(item.name, cfg.protected)) {
              item.status = 'failed';
              item.error = vscode.l10n.t('Protected branches cannot be deleted.');
              item.errorCause = undefined;
              this.fireChange();
              return;
            }
            await this.runDeletion(
              item,
              () => deleteLocalBranch(repo.repoRoot, item.name, force || cfg.forceDeleteLocal),
              progress
            );
            return;
          }
          const parsed = splitRemoteRef(item.name);
          if (!parsed) {
            item.status = 'failed';
            item.error = vscode.l10n.t('Invalid remote ref: {0}', item.name);
            item.errorCause = undefined;
            this.fireChange();
            return;
          }
          const { remote, name } = parsed;
          if (isProtectedBranch(name, cfg.protected)) {
            item.status = 'failed';
            item.error = vscode.l10n.t('Protected branches cannot be deleted remotely.');
            item.errorCause = undefined;
            this.fireChange();
            return;
          }
          await this.runDeletion(
            item,
            () => deleteRemoteBranch(repo.repoRoot, remote, name),
            progress
          );
        }
      );
    } finally {
      this.executing = false;
      void vscode.commands.executeCommand('setContext', QUEUE_EXECUTING_CONTEXT, false);
      this.fireChange();
      if (this.onAfterExecute) {
        try {
          await this.onAfterExecute();
        } catch {
          // ignore refresh errors
        }
      }
    }
  }

  /**
   * Recovery for a local item that failed because it is the current branch:
   * switch to the base branch, then retry the deletion.
   */
  async switchAndRetryItem(item: DeletionQueueItem): Promise<void> {
    if (this.executing) {
      return;
    }
    if (!this.repo) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('Open Git Sohji first to set the repository.')
      );
      return;
    }
    if (
      item.status !== 'failed' ||
      item.kind !== 'local' ||
      item.errorCause !== 'checkedOutCurrent' ||
      !this.queue.includes(item)
    ) {
      return;
    }

    const cfg = getCfg();
    if (isProtectedBranch(item.name, cfg.protected)) {
      vscode.window.showWarningMessage(vscode.l10n.t('Protected branches cannot be deleted.'));
      return;
    }

    const repo = this.repo;
    const base = await resolveBaseBranch(repo.repoRoot);
    // resolveBaseBranch falls back to the current branch when no canonical
    // base exists — which here IS the branch being deleted. Bail out instead
    // of offering a nonsensical "switch to X and delete X".
    if (base === item.name) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('No other branch to switch to. Configure a base branch in settings.')
      );
      return;
    }

    // Always confirm regardless of confirmBeforeDelete: this changes the
    // user's checked-out branch as a side effect, not just deletes one.
    const ok = await confirm(vscode.l10n.t('Switch to {0} and delete {1}?', base, item.name));
    if (!ok) {
      return;
    }

    this.executing = true;
    void vscode.commands.executeCommand('setContext', QUEUE_EXECUTING_CONTEXT, true);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: vscode.l10n.t('Switching branch...'),
          cancellable: false,
        },
        async (progress) => {
          try {
            await checkoutBranch(repo.repoRoot, base);
          } catch (err) {
            // e.g. dirty working tree; surface it instead of silently failing
            vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
            return;
          }
          await this.runDeletion(
            item,
            () => deleteLocalBranch(repo.repoRoot, item.name, cfg.forceDeleteLocal),
            progress
          );
        }
      );
    } finally {
      this.executing = false;
      void vscode.commands.executeCommand('setContext', QUEUE_EXECUTING_CONTEXT, false);
      this.fireChange();
      if (this.onAfterExecute) {
        try {
          await this.onAfterExecute();
        } catch {
          // ignore refresh errors
        }
      }
    }
  }

  /**
   * Recovery for a remote item that failed because the branch is already gone
   * on the remote: run `fetch --prune` to drop the stale tracking ref. The
   * item intentionally stays 'failed' — the deletion itself did not succeed.
   */
  async pruneRetryItem(item: DeletionQueueItem): Promise<void> {
    if (this.executing) {
      return;
    }
    if (!this.repo) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('Open Git Sohji first to set the repository.')
      );
      return;
    }
    if (
      item.status !== 'failed' ||
      item.kind !== 'remote' ||
      item.errorCause !== 'remoteGone' ||
      !this.queue.includes(item)
    ) {
      return;
    }

    const repo = this.repo;
    const remote = splitRemoteRef(item.name)?.remote ?? 'origin';
    this.executing = true;
    void vscode.commands.executeCommand('setContext', QUEUE_EXECUTING_CONTEXT, true);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: vscode.l10n.t('Updating tracking refs...'),
          cancellable: false,
        },
        async () => {
          await fetchWithPrune(repo.repoRoot, remote);
        }
      );
      vscode.window.showInformationMessage(
        vscode.l10n.t('Tracking refs updated. {0} was already removed on the remote.', item.name)
      );
    } catch (err) {
      vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
    } finally {
      this.executing = false;
      void vscode.commands.executeCommand('setContext', QUEUE_EXECUTING_CONTEXT, false);
      this.fireChange();
      if (this.onAfterExecute) {
        try {
          await this.onAfterExecute();
        } catch {
          // ignore refresh errors
        }
      }
    }
  }

  private async runExecution(
    repo: RepoContext,
    cfg: ReturnType<typeof getCfg>,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    const pendingLocals = this.queue.filter(q => q.status === 'pending' && q.kind === 'local');
    const pendingRemotes = this.queue.filter(q => q.status === 'pending' && q.kind === 'remote');
    const includeRemoteLocals = pendingLocals.filter(q => q.includeRemote);

    // Fetch upstream map before any deletion (git removes tracking config on delete)
    const upstreams = includeRemoteLocals.length > 0
      ? await getUpstreamMap(repo.repoRoot)
      : new Map<string, string>();

    // Delete locals with per-item progress
    const failedLocals: DeletionQueueItem[] = [];
    for (const item of pendingLocals) {
      await this.runDeletion(
        item,
        () => deleteLocalBranch(repo.repoRoot, item.name, cfg.forceDeleteLocal),
        progress
      );
      if (item.status === 'failed') {
        failedLocals.push(item);
      }
    }

    // Offer force-delete only for locals that actually failed as unmerged —
    // other causes (checked out, locked ref, ...) would just fail again
    // under -D and deserve their own classified message instead.
    const unmergedFailedLocals = failedLocals.filter(i => i.errorCause === 'unmerged');
    if (unmergedFailedLocals.length > 0 && !cfg.forceDeleteLocal) {
      const forceDelete = await confirm(
        vscode.l10n.t(
          '{0} branches are not fully merged. Force delete them?',
          unmergedFailedLocals.length
        )
      );
      if (forceDelete) {
        for (const item of unmergedFailedLocals) {
          item.status = 'pending';
          item.error = undefined;
          item.errorCause = undefined;
          this.fireChange();
          await this.runDeletion(
            item,
            () => deleteLocalBranch(repo.repoRoot, item.name, true),
            progress
          );
        }
      }
    }

    // Expand includeRemote into remote items based on upstream info
    const trackedRemoteItems: { item: DeletionQueueItem; remote: string; name: string }[] = [];
    const untrackedRemoteItems: { item: DeletionQueueItem; remote: string; name: string }[] = [];

    for (const local of includeRemoteLocals) {
      if (local.status !== 'deleted') {
        continue;
      }
      const up = upstreams.get(local.name);
      if (up && up.includes('/')) {
        const [remote, ...rest] = up.split('/');
        const rName = rest.join('/');
        if (isProtectedBranch(rName, cfg.protected)) {
          continue;
        }
        // Skip if already queued explicitly as remote (ignore finished entries
        // so a recreated remote can be re-queued).
        if (this.queue.some(q => q.kind === 'remote' && q.name === up && q.status !== 'deleted')) {
          continue;
        }
        const newItem: DeletionQueueItem = { name: up, kind: 'remote', status: 'pending' };
        this.queue.push(newItem);
        trackedRemoteItems.push({ item: newItem, remote, name: rName });
      } else {
        if (isProtectedBranch(local.name, cfg.protected)) {
          continue;
        }
        const fullName = `origin/${local.name}`;
        if (this.queue.some(q => q.kind === 'remote' && q.name === fullName && q.status !== 'deleted')) {
          continue;
        }
        // Stage as untracked; add to queue only after user confirms
        untrackedRemoteItems.push({
          item: { name: fullName, kind: 'remote', status: 'pending' },
          remote: 'origin',
          name: local.name,
        });
      }
    }

    if (trackedRemoteItems.length > 0) {
      this.fireChange();
    }

    // Ask for untracked remotes
    const confirmedUntracked: typeof untrackedRemoteItems = [];
    if (untrackedRemoteItems.length > 0) {
      const ok = await confirm(
        vscode.l10n.t(
          'Also delete {0} remote branches with same name (not tracked)?',
          untrackedRemoteItems.length
        )
      );
      if (ok) {
        for (const entry of untrackedRemoteItems) {
          this.queue.push(entry.item);
          confirmedUntracked.push(entry);
        }
        this.fireChange();
      }
    }

    // Delete remote branches: tracked expansions, confirmed untracked, and explicit pendings
    const remoteDeletions: { item: DeletionQueueItem; remote: string; name: string }[] = [
      ...trackedRemoteItems,
      ...confirmedUntracked,
    ];

    for (const explicit of pendingRemotes) {
      const parsed = splitRemoteRef(explicit.name);
      if (!parsed) {
        explicit.status = 'failed';
        explicit.error = vscode.l10n.t('Invalid remote ref: {0}', explicit.name);
        explicit.errorCause = undefined;
        this.fireChange();
        continue;
      }
      const { remote, name } = parsed;
      if (isProtectedBranch(name, cfg.protected)) {
        explicit.status = 'failed';
        explicit.error = vscode.l10n.t('Protected branches cannot be deleted remotely.');
        explicit.errorCause = undefined;
        this.fireChange();
        continue;
      }
      remoteDeletions.push({ item: explicit, remote, name });
    }

    for (const { item, remote, name } of remoteDeletions) {
      await this.runDeletion(
        item,
        () => deleteRemoteBranch(repo.repoRoot, remote, name),
        progress
      );
    }

    // Summary notification for failures
    const failed = this.queue.filter(q => q.status === 'failed');
    if (failed.length > 0) {
      const localFailed = failed.filter(q => q.kind === 'local').map(q => q.name);
      const remoteFailed = failed.filter(q => q.kind === 'remote').map(q => q.name);
      const parts: string[] = [];
      if (localFailed.length > 0) {
        parts.push(vscode.l10n.t('Local: {0}', localFailed.join(', ')));
      }
      if (remoteFailed.length > 0) {
        parts.push(vscode.l10n.t('Remote: {0}', remoteFailed.join(', ')));
      }
      vscode.window.showWarningMessage(
        vscode.l10n.t('Failed to delete some branches: {0}', parts.join('; '))
      );
    }
  }

  private async runDeletion(
    item: DeletionQueueItem,
    deleteFn: () => Promise<void>,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    item.status = 'deleting';
    item.error = undefined;
    item.errorCause = undefined;
    this.fireChange();
    progress.report({ message: item.name });
    try {
      await deleteFn();
      item.status = 'deleted';
      this.fireChange();
    } catch (err) {
      item.status = 'failed';
      const message = err instanceof Error ? err.message : String(err);
      item.error = message;
      // Local failures may need a rev-parse to tell "current branch" apart
      // from "checked out in another worktree"; remote failures never do.
      item.errorCause = item.kind === 'local' && this.repo
        ? await resolveDeletionCause(this.repo.repoRoot, item.name, message)
        : classifyDeletionCause(message);
      this.fireChange();
    }
  }

  // ===== TreeDataProvider =====

  getTreeItem(element: DeletionQueueItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(element.name);

    // Icon varies by status, falling back to kind
    if (element.status === 'deleting') {
      treeItem.iconPath = new vscode.ThemeIcon('sync~spin');
    } else if (element.status === 'deleted') {
      treeItem.iconPath = new vscode.ThemeIcon(
        'check',
        new vscode.ThemeColor('testing.iconPassed')
      );
    } else if (element.status === 'failed') {
      treeItem.iconPath = new vscode.ThemeIcon(
        'error',
        new vscode.ThemeColor('errorForeground')
      );
    } else {
      treeItem.iconPath = new vscode.ThemeIcon(
        element.kind === 'local' ? 'git-branch' : 'cloud'
      );
    }

    let desc = element.kind === 'local'
      ? vscode.l10n.t('local')
      : vscode.l10n.t('remote');
    if (element.kind === 'local' && element.includeRemote) {
      desc += ' + ' + vscode.l10n.t('remote');
    }
    const reason = element.status === 'failed' && element.errorCause
      ? deletionCauseMessage(element.errorCause)
      : undefined;

    if (element.status === 'failed') {
      desc += ' — ' + (reason ?? vscode.l10n.t('failed (hover for details)'));
    }
    treeItem.description = desc;

    if (element.status === 'failed' && element.error) {
      const md = new vscode.MarkdownString();
      md.appendText(element.name);
      md.appendMarkdown(`\n\n**${reason ?? vscode.l10n.t('Deletion failed')}**\n\n`);
      md.appendCodeblock(element.error, 'text');
      treeItem.tooltip = md;
    } else {
      treeItem.tooltip = element.name;
    }

    switch (element.status) {
      case 'pending':
        treeItem.contextValue = 'queueItemPending';
        break;
      case 'deleting':
        treeItem.contextValue = 'queueItemDeleting';
        break;
      case 'deleted':
        treeItem.contextValue = 'queueItemDeleted';
        break;
      case 'failed': {
        // Cause-aware suffix lets package.json `when` clauses show only the
        // recovery actions that fit this failure (forceRetry ⇒ :unmerged,
        // switchAndRetry ⇒ :checkedOutCurrent, pruneRetry ⇒ :remoteGone).
        const base = element.kind === 'local'
          ? 'queueItemFailedLocal'
          : 'queueItemFailedRemote';
        treeItem.contextValue = `${base}:${element.errorCause ?? 'unknown'}`;
        break;
      }
    }

    return treeItem;
  }

  getChildren(): DeletionQueueItem[] {
    return this.queue;
  }

  private fireChange(): void {
    vscode.commands.executeCommand(
      'setContext',
      QUEUE_HAS_ITEMS_CONTEXT,
      this.queue.length > 0
    );
    this._onDidChangeTreeData.fire();
  }
}
