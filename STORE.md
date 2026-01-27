# Git Souji

A VS Code extension for cleaning up Git branches. "Souji" means "cleaning" in Japanese.

## Features

### Branch Management
- View **Local** and **Remote** branches with status badges (merged/stale/gone)
- **Search** branches by name (case sensitivity and regex support)
- **Checkout**, **Rename**, **Delete**, **Merge** operations
- **Protected branches** support with glob patterns

### Cleanup Tools
- **Merged**: Delete branches already merged into the base branch
- **Stale**: Delete branches with no commits for N days
- **Gone**: Delete branches whose upstream was deleted
- **Cleanup All**: Combine all detections for bulk cleanup

### Select Mode
- Manually pick branches for bulk deletion
- Works for both local and remote branches

## Usage

1. Open a Git repository in VS Code
2. Run **Git Souji: Open** from the Command Palette (`Ctrl+Shift+P`)
3. Or click the branch icon in the SCM view title bar

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
- **Merged**: ベースブランチにマージ済みのブランチを削除
- **Stale**: N日間コミットがないブランチを削除
- **Gone**: 上流が削除されたブランチを削除
- **Cleanup All**: 3種類すべてをまとめて実行

### 選択モード
- 削除するブランチを手動で選択
- ローカル・リモート両方で使用可能

## 使い方

1. VS Code で Git リポジトリを開く
2. コマンドパレット（`Ctrl+Shift+P`）から **Git Souji: 開く** を実行
3. または SCM ビューのタイトルバーにあるブランチアイコンをクリック

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
