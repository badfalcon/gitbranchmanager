import * as vscode from 'vscode';

import { pickRepository } from './app';
import { openManagerPanel } from './webview/panel';

export async function activate(context: vscode.ExtensionContext) {
  console.log(vscode.l10n.t('gitBranchManager.activated'));

  const disposable = vscode.commands.registerCommand('gitbranchmanager.openManager', async () => {
    const repo = await pickRepository();
    if (!repo) {
      vscode.window.showWarningMessage(vscode.l10n.t('errors.noGitRepo'));
      return;
    }

    await openManagerPanel(context, repo);
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
