import * as vscode from 'vscode';

import {
  classifyDeletionError,
  confirm,
  deleteLocalBranch,
  deleteRemoteBranch,
  getCfg,
  getUpstreamMap,
  isProtectedBranch,
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
    if (this.repo && this.repo.repoRoot !== repo.repoRoot && this.queue.length > 0) {
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
      const exists = this.queue.some(q => q.name === item.name && q.kind === item.kind);
      if (exists) {
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

  /** Branch name+kind pairs currently in the queue (for webview display). */
  getQueuedBranches(): { name: string; kind: 'local' | 'remote' }[] {
    return this.queue.map(q => ({ name: q.name, kind: q.kind }));
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

    // Offer force-delete for unmerged locals
    if (failedLocals.length > 0 && !cfg.forceDeleteLocal) {
      const forceDelete = await confirm(
        vscode.l10n.t(
          '{0} branches are not fully merged. Force delete them?',
          failedLocals.length
        )
      );
      if (forceDelete) {
        for (const item of failedLocals) {
          item.status = 'pending';
          item.error = undefined;
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
        // Skip if already queued explicitly as remote
        if (this.queue.some(q => q.kind === 'remote' && q.name === up)) {
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
        if (this.queue.some(q => q.kind === 'remote' && q.name === fullName)) {
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
      const parts = explicit.name.split('/');
      const remote = parts.shift();
      const name = parts.join('/');
      if (!remote || !name) {
        explicit.status = 'failed';
        explicit.error = vscode.l10n.t('Invalid remote ref: {0}', explicit.name);
        this.fireChange();
        continue;
      }
      if (isProtectedBranch(name, cfg.protected)) {
        explicit.status = 'failed';
        explicit.error = vscode.l10n.t('Protected branches cannot be deleted remotely.');
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
    this.fireChange();
    progress.report({ message: item.name });
    try {
      await deleteFn();
      item.status = 'deleted';
      this.fireChange();
    } catch (err) {
      item.status = 'failed';
      item.error = err instanceof Error ? err.message : String(err);
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
    const reason = element.status === 'failed'
      ? classifyDeletionError(element.error)
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

    treeItem.contextValue = element.status === 'pending'
      ? 'queueItemPending'
      : 'queueItemDone';

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
