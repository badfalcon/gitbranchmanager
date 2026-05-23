# Git Souji

A VS Code extension for cleaning up Git branches. "Souji" means "cleaning" in Japanese.

## Features

### Branch Management
- View **Local** and **Remote** branches with status badges (merged/stale/gone)
- **Search** branches by name (case sensitivity and regex support)
- **Checkout**, **Rename**, **Delete**, **Merge** operations
- **Protected branches** support with glob patterns

### Cleanup Tools
- **Merged**: Find branches already merged into the base branch
- **Stale**: Find branches with no commits for N days
- **Gone**: Find branches whose upstream was deleted
- **Cleanup All**: Combine all detections for bulk preview

### Deletion Queue
- Dedicated **Activity Bar view** for staging deletions
- Stage branches from cleanup previews or row selection, review them, then execute the batch
- Per-item status icons (pending / spinning / ✓ / ✗) and inline remove action
- View title actions: **Execute**, **Clear**, **Switch Repository**

### Branch Selection
- Selection checkboxes are always available — manually pick branches and add them to the Deletion Queue
- Works for both local and remote branches simultaneously
- Header **select-all checkbox** toggles all currently visible (filtered) rows — combine with search to bulk-select matching branches

### Multi-folder Workspaces
- **Switch Repository** command to switch the active repo
- Last-used repo is remembered per workspace

## Usage

1. Open a Git repository in VS Code
2. Run **Git Souji: Open** from the Command Palette (`Ctrl+Shift+P`)
3. Or click the branch icon in the SCM view title bar, or the **Git Souji** icon in the Activity Bar
4. Stage branches into the Deletion Queue, then click **Execute** in the queue view

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `gitSouji.baseBranch` | Base branch for merged detection | `auto` |
| `gitSouji.staleDays` | Days threshold for stale branches | `30` |
| `gitSouji.protectedBranches` | Protected branch patterns | `["main", "master", "develop"]` |
| `gitSouji.confirmBeforeDelete` | Show confirmation dialogs | `true` |
| `gitSouji.forceDeleteLocal` | Use force delete (`-D`) | `false` |
| `gitSouji.allowRemoteBranchDeletion` | Enable remote branch deletion | `false` |

## Requirements

- Git must be installed and available in PATH

---

# Git Souji (日本語)

Git ブランチの整理（掃除）に特化した VS Code 拡張機能です。

## 機能

### ブランチ管理
- **ローカル**と**リモート**ブランチをステータスバッジ付きで表示
- ブランチ名で**検索**（大文字小文字区別・正規表現対応）
- **Checkout**、**Rename**、**Delete**、**Merge** 操作
- glob パターン対応の**保護ブランチ**設定

### 整理ツール
- **Merged**: ベースブランチにマージ済みのブランチを検出
- **Stale**: N日間コミットがないブランチを検出
- **Gone**: 上流が削除されたブランチを検出
- **Cleanup All**: 3種類すべてをまとめてプレビュー

### 削除キュー
- 専用の **アクティビティバービュー** で削除対象をステージング
- クリーンアッププレビューや選択モードからブランチを積み、まとめて実行
- 各項目の状態アイコン（待機 / 実行中 / ✓ / ✗）とインライン削除アクション
- ビュータイトルアクション: **Execute**、**Clear**、**Switch Repository**

### 選択モード
- 削除するブランチを手動で選択して削除キューに追加
- ローカル・リモート両方で同時に使用可能
- ヘッダーの **全選択チェックボックス** で現在表示中（フィルタ後）の行をまとめて切替可能。検索と組み合わせて該当ブランチだけを一括選択できます

### マルチフォルダワークスペース
- **Switch Repository** コマンドで対象リポジトリを切り替え
- 最後に使ったリポジトリはワークスペースごとに記憶

## 使い方

1. VS Code で Git リポジトリを開く
2. コマンドパレット（`Ctrl+Shift+P`）から **Git Souji: 開く** を実行
3. または SCM ビューのタイトルバーにあるブランチアイコン、もしくはアクティビティバーの **Git Souji** アイコンから起動
4. ブランチを削除キューに積み、キュービューの **Execute** で実行

## 設定

| 設定 | 説明 | デフォルト |
|------|------|-----------|
| `gitSouji.baseBranch` | マージ検出の基準ブランチ | `auto` |
| `gitSouji.staleDays` | 古いブランチの日数閾値 | `30` |
| `gitSouji.protectedBranches` | 保護ブランチのパターン | `["main", "master", "develop"]` |
| `gitSouji.confirmBeforeDelete` | 削除前に確認ダイアログを表示 | `true` |
| `gitSouji.forceDeleteLocal` | 強制削除（`-D`）を使用 | `false` |
| `gitSouji.allowRemoteBranchDeletion` | リモートブランチ削除を有効化 | `false` |

## 要件

- Git がインストールされ、PATH で利用可能であること
