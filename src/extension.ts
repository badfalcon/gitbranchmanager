import * as vscode from 'vscode';

import { pickRepository } from './app';
import { openManagerPanel } from './webview/panel';

export async function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('gitbranchcleaner.openCleaner', async () => {
    const repo = await pickRepository();
    if (!repo) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('No Git repository found. Open a folder or initialize Git.')
      );
      return;
    }

    await openManagerPanel(context, repo);
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
