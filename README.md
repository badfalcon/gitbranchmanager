# Git Souji

## English

A VS Code extension for cleaning up Git branches (detect and delete dead/stale/gone branches, with full branch management). "Souji" means "cleaning" in Japanese.

- Command: **Git Souji: Open** (`gitsouji.openCleaner`)
- You can also launch it from the SCM (Source Control) view title bar.

### Features

#### Branch Cleaner Webview
- Shows **Local Branches / Remote Branches** with status badges (merged/stale/gone)
- Local:
  - Checkout
  - Log (opens `git log --oneline --graph --decorate` in a terminal)
  - Rename (not allowed for protected branches)
  - Delete (not allowed for protected branches; confirmation/force are configurable)
  - Merge into current (merge into current branch; protected branches cannot be selected)
- Remote:
  - Checkout (creates a local tracking branch if it doesn't exist)
  - Log
  - Delete Remote (not allowed for protected branches)

#### Cleanup Toolbar
- **Merged**: Find and delete branches already merged into the base branch
- **Stale**: Find and delete branches with no commits for N days (configurable)
- **Gone**: Find and delete branches whose upstream was deleted
- **Cleanup All**: Combine all three detections for bulk cleanup

#### Select Mode
- Toggle select mode to manually pick branches for deletion
- Works for both local and remote branches
- Shows selected count and allows bulk deletion

#### Force Delete Confirmation
- When deleting unmerged branches (e.g., stale), shows confirmation dialog to force delete
- Also confirms when deleting remote branches with the same name as local (untracked)

### Requirements
- Git must be available (`git` command executable)

### Usage
1. Open a folder containing a Git repository in VS Code
2. Run **Git Souji: Open** from the Command Palette
   - Or run it from the SCM view menu
3. Use the buttons in the webview

### Extension Settings

Example `settings.json`:

```json
{
  "gitSouji.baseBranch": "auto",
  "gitSouji.protectedBranches": ["main", "master", "develop", "release/*"],
  "gitSouji.confirmBeforeDelete": true,
  "gitSouji.forceDeleteLocal": false,
  "gitSouji.includeRemoteInDeadCleanup": false,
  "gitSouji.staleDays": 30,
  "gitSouji.autoFetchPrune": false,
  "gitSouji.showStatusBadges": true
}
```

- `gitSouji.baseBranch`: Base branch used for dead-branch detection. If `auto`, it prefers `origin/HEAD`, then tries `main/master/develop`.
- `gitSouji.protectedBranches`: Protected branches excluded from delete/detect/rename/merge-source actions. Simple glob (`*`) is supported.
- `gitSouji.confirmBeforeDelete`: Show confirmation dialog before destructive actions.
- `gitSouji.forceDeleteLocal`: Force delete local branches (`git branch -D`).
- `gitSouji.includeRemoteInDeadCleanup`: When bulk deleting dead branches, also try to delete corresponding remote branches.
- `gitSouji.staleDays`: Number of days since last commit to consider a branch as stale (default: 30).
- `gitSouji.autoFetchPrune`: Automatically run `git fetch --prune` before detecting gone branches.
- `gitSouji.showStatusBadges`: Show status badges (merged/stale/gone) in the branch list.

### Implementation Notes
- The webview HTML is at `media/branchManager.html`. CSP/nonce are injected at runtime.
- The core TypeScript logic is in `src/app.ts`.

### Known Issues
- You may see `Error mutex already exists` in test logs; `vscode-test` can still exit with code 0 (possible VS Code process contention on the machine).

### Development

```bash
npm install
npm test
```

---

## 日本語

Git ブランチの整理（掃除）に特化した VS Code 拡張です（デッド/古い/削除済みリモートのブランチ検出・削除、その他ブランチ管理機能）。

- コマンド: **Git Souji: 開く** (`gitsouji.openCleaner`)
- SCMビュー（Source Control）のタイトルバーからも起動できます

### Features

#### Branch Cleaner Webview
- **Local Branches / Remote Branches** をステータスバッジ（マージ済み/古い/削除済み）付きで一覧表示
- Local:
  - Checkout
  - Log（ターミナルで `git log --oneline --graph --decorate` を開く）
  - Rename（保護ブランチは不可）
  - Delete（保護ブランチは不可・設定で確認/force制御）
  - Merge into current（現在ブランチへマージ。保護ブランチは不可）
- Remote:
  - Checkout（追跡ローカルが無ければ作成してcheckout）
  - Log
  - Delete Remote（保護ブランチは不可）

#### 整理ツールバー
- **Merged**: ベースブランチにマージ済みのブランチを検出・削除
- **Stale**: N日間コミットがないブランチを検出・削除（日数は設定可能）
- **Gone**: 上流が削除されたブランチを検出・削除
- **Cleanup All**: 3種類すべての検出をまとめて実行

#### 選択モード
- 選択モードをオンにして、削除するブランチを手動で選択
- ローカル・リモート両方で使用可能
- 選択件数を表示し、一括削除が可能

#### 強制削除確認
- マージされていないブランチ（例: 古いブランチ）を削除する際、強制削除の確認ダイアログを表示
- 同名のリモートブランチ（未追跡）を削除する際も確認を表示

### Requirements
- Git が利用可能であること（`git` コマンドが実行できる）

### Usage
1. Gitリポジトリを含むフォルダをVS Codeで開く
2. コマンドパレットで **Git Souji: 開く** を実行
   - または SCM ビュー上部のメニューから実行
3. Webview上のボタンで操作

### Extension Settings

`settings.json` 例：

```json
{
  "gitSouji.baseBranch": "auto",
  "gitSouji.protectedBranches": ["main", "master", "develop", "release/*"],
  "gitSouji.confirmBeforeDelete": true,
  "gitSouji.forceDeleteLocal": false,
  "gitSouji.includeRemoteInDeadCleanup": false,
  "gitSouji.staleDays": 30,
  "gitSouji.autoFetchPrune": false,
  "gitSouji.showStatusBadges": true
}
```

- `gitSouji.baseBranch`: デッドブランチ検出の基準ブランチ。`auto` の場合は `origin/HEAD` を優先し、無ければ `main/master/develop` を順に探索します。
- `gitSouji.protectedBranches`: 保護ブランチ。**削除/検出/リネーム/マージ元指定** の対象外になります。`release/*` のような簡易glob（`*`）に対応。
- `gitSouji.confirmBeforeDelete`: 削除など破壊的操作前に確認ダイアログを表示。
- `gitSouji.forceDeleteLocal`: ローカル削除を強制（`git branch -D`）。
- `gitSouji.includeRemoteInDeadCleanup`: デッドブランチ一括削除時に、対応する追跡リモートがある場合はリモート削除も試行。
- `gitSouji.staleDays`: 最終コミットから何日経過したブランチを「古い」と見なすか（デフォルト: 30）。
- `gitSouji.autoFetchPrune`: Gone ブランチ検出前に自動で `git fetch --prune` を実行。
- `gitSouji.showStatusBadges`: ブランチ一覧にステータスバッジ（マージ済み/古い/削除済み）を表示。

### Implementation Notes
- WebviewのHTMLは `media/branchManager.html` に置いてあり、起動時にCSP/nonceを差し込んで読み込みます。
- TypeScript側のメインロジックは `src/app.ts` に集約しています。

### Known Issues
- テスト実行ログに `Error mutex already exists` が出る場合がありますが、`vscode-test` 自体は Exit code 0 で完了します（環境上の既存VS Codeプロセス競合の可能性）。

### Development

```bash
npm install
npm test
```

---

If you find a bug or have a feature request, please open an issue.
