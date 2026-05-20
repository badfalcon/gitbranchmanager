import * as vscode from 'vscode';

import {
  isGitRepository,
  pickRepository,
  type DeletionQueueItem,
  type RepoContext,
} from './app';
import { QueueTreeProvider } from './queue/queueTreeProvider';
import { openManagerPanel } from './webview/panel';

const ACTIVITY_BAR_VIEW_COMMAND = 'workbench.view.extension.gitsouji';
const LAST_REPO_KEY = 'gitsouji.lastRepoRoot';

export async function activate(context: vscode.ExtensionContext) {
  const queueProvider = new QueueTreeProvider();

  const treeView = vscode.window.createTreeView('gitsouji.deletionQueue', {
    treeDataProvider: queueProvider,
  });
  context.subscriptions.push(treeView);

  let opening = false;

  async function getCachedRepo(): Promise<RepoContext | undefined> {
    const cached = context.workspaceState.get<string>(LAST_REPO_KEY);
    if (cached && (await isGitRepository(cached))) {
      return { repoRoot: cached };
    }
    return undefined;
  }

  async function rememberRepo(repo: RepoContext): Promise<void> {
    await context.workspaceState.update(LAST_REPO_KEY, repo.repoRoot);
  }

  async function resolveRepo(forcePrompt: boolean): Promise<RepoContext | undefined> {
    if (!forcePrompt) {
      const cached = await getCachedRepo();
      if (cached) {
        return cached;
      }
    }
    const picked = await pickRepository({ forcePrompt });
    if (picked) {
      await rememberRepo(picked);
    }
    return picked;
  }

  const openCleaner = async (forcePrompt = false) => {
    if (opening) {
      return;
    }
    opening = true;
    try {
      const repo = await resolveRepo(forcePrompt);
      if (!repo) {
        vscode.window.showWarningMessage(
          vscode.l10n.t('No Git repository found. Open a folder or initialize Git.')
        );
        return;
      }
      queueProvider.setRepo(repo);
      await openManagerPanel(context, repo, queueProvider);
      await vscode.commands.executeCommand(ACTIVITY_BAR_VIEW_COMMAND);
    } finally {
      opening = false;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('gitsouji.openCleaner', () => openCleaner(false)),
    vscode.commands.registerCommand('gitsouji.switchRepository', () => openCleaner(true)),
    vscode.commands.registerCommand('gitsouji.queue.execute', () => queueProvider.execute()),
    vscode.commands.registerCommand('gitsouji.queue.clear', () => queueProvider.clear()),
    vscode.commands.registerCommand(
      'gitsouji.queue.removeItem',
      (item: DeletionQueueItem) => {
        if (item) {
          queueProvider.removeItem(item);
        }
      }
    ),
  );
}

export function deactivate() {}
