# Git Branch Manager

## English

A VS Code extension for managing Git branches from a single UI (checkout/create/rename/delete/merge/detect dead branches).

- Command: **Git Branch Manager: Open** (`gitbranchmanager.openManager`)
- You can also launch it from the SCM (Source Control) view title bar.

### Features

#### Branch Manager Webview
- Shows **Local Branches / Remote Branches**
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

#### Detect Dead
- Finds local branches that are already merged into the base branch (from settings or auto-detected)
- Bulk delete (optionally also tries to delete corresponding remote branches)

### Requirements
- Git must be available (`git` command executable)

### Usage
1. Open a folder containing a Git repository in VS Code
2. Run **Git Branch Manager: Open** from the Command Palette
   - Or run it from the SCM view menu
3. Use the buttons in the webview

### Extension Settings

Example `settings.json`:

```json
{
  "gitBranchManager.baseBranch": "auto",
  "gitBranchManager.protectedBranches": ["main", "master", "develop", "release/*"],
  "gitBranchManager.confirmBeforeDelete": true,
  "gitBranchManager.forceDeleteLocal": false,
  "gitBranchManager.includeRemoteInDeadCleanup": false
}
```

- `gitBranchManager.baseBranch`: Base branch used for dead-branch detection. If `auto`, it prefers `origin/HEAD`, then tries `main/master/develop`.
- `gitBranchManager.protectedBranches`: Protected branches excluded from delete/detect/rename/merge-source actions. Simple glob (`*`) is supported.
- `gitBranchManager.confirmBeforeDelete`: Show confirmation dialog before destructive actions.
- `gitBranchManager.forceDeleteLocal`: Force delete local branches (`git branch -D`).
- `gitBranchManager.includeRemoteInDeadCleanup`: When bulk deleting dead branches, also try to delete corresponding remote branches.

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

VS Code 上で Git のブランチ操作（チェックアウト/作成/リネーム/削除/マージ/デッドブランチ検出）をまとめて行うための拡張です。

- コマンド: **ブランチ管理: 開く (Branch Manager)** (`gitbranchmanager.openManager`)
- SCMビュー（Source Control）のタイトルバーからも起動できます

### Features

#### Branch Manager Webview
- **Local Branches / Remote Branches** を一覧表示
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

#### Detect Dead（デッドブランチ検出）
- ベースブランチ（設定 or 自動検出）に **merge済み** のローカルブランチを抽出
- 一括削除（オプションで対応するリモート削除も試行）

### Requirements
- Git が利用可能であること（`git` コマンドが実行できる）

### Usage
1. Gitリポジトリを含むフォルダをVS Codeで開く
2. コマンドパレットで **ブランチ管理: 開く (Branch Manager)** を実行
   - または SCM ビュー上部のメニューから実行
3. Webview上のボタンで操作

### Extension Settings

`settings.json` 例：

```json
{
  "gitBranchManager.baseBranch": "auto",
  "gitBranchManager.protectedBranches": ["main", "master", "develop", "release/*"],
  "gitBranchManager.confirmBeforeDelete": true,
  "gitBranchManager.forceDeleteLocal": false,
  "gitBranchManager.includeRemoteInDeadCleanup": false
}
```

- `gitBranchManager.baseBranch`: デッドブランチ検出の基準ブランチ。`auto` の場合は `origin/HEAD` を優先し、無ければ `main/master/develop` を順に探索します。
- `gitBranchManager.protectedBranches`: 保護ブランチ。**削除/検出/リネーム/マージ元指定** の対象外になります。`release/*` のような簡易glob（`*`）に対応。
- `gitBranchManager.confirmBeforeDelete`: 削除など破壊的操作前に確認ダイアログを表示。
- `gitBranchManager.forceDeleteLocal`: ローカル削除を強制（`git branch -D`）。
- `gitBranchManager.includeRemoteInDeadCleanup`: デッドブランチ一括削除時に、対応する追跡リモートがある場合はリモート削除も試行。

### Implementation Notes
- WebviewのHTMLは `media/branchManager.html` に置いてあり、起動時にCSP/nonceを差し込んで読み込みます。
- TypeScript側のメインロジックは `src/app.ts` に集約しています（小さく保つ方針）。

### Known Issues
- テスト実行ログに `Error mutex already exists` が出る場合がありますが、`vscode-test` 自体は Exit code 0 で完了します（環境上の既存VS Codeプロセス競合の可能性）。

### Development

```bash
npm install
npm test
```

---

If you find a bug or have a feature request, please open an issue.
