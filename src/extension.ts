import * as vscode from 'vscode';

import { pickRepository } from './app';
import { openManagerPanel } from './webview/panel';

export async function activate(context: vscode.ExtensionContext) {
  console.log('git-branch-manager activated');

  const disposable = vscode.commands.registerCommand('gitbranchmanager.openManager', async () => {
    const repo = await pickRepository();
    if (!repo) {
      vscode.window.showWarningMessage('Git リポジトリが見つかりません。フォルダを開くか Git を初期化してください。');
      return;
    }

    await openManagerPanel(context, repo);
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
