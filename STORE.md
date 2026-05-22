<!--
  Marketplace description for Git Souji.
  Image placeholders below are commented out so the page never renders a broken
  image. Drop the real assets into images/ and uncomment the matching line.
  Suggested captures:
    images/hero.png            - the branch cleaner webview with status badges
    images/cleanup.gif         - clicking Merged/Stale/Gone -> preview modal
    images/queue.png           - Deletion Queue view in the Activity Bar mid-run
    images/select-mode.png     - select mode with the header select-all checkbox
-->

# Git Souji — clean up your Git branches

**Souji (掃除) means "cleaning" in Japanese.** Git Souji finds the branches you forgot to delete — merged, stale, and gone — and clears them out from one panel inside VS Code. No more `git branch | grep`, no more guessing which branches are safe to remove.

<!-- ![Git Souji branch cleaner](images/hero.png) -->

## Why Git Souji?

Branches pile up. After every merged PR, every abandoned experiment, every deleted remote, your branch list gets a little noisier — until `git branch` scrolls off the screen. Cleaning it up by hand is tedious and easy to get wrong.

Git Souji does the detection for you and keeps deletion safe:

- **See what's cleanable at a glance** — merged, stale, and gone branches are flagged with status badges.
- **Stage before you delete** — nothing is removed until you review it in the Deletion Queue and hit Execute.
- **Protect what matters** — `main`, release branches, and any glob pattern you configure are off-limits to destructive actions.

## What it does

### 🔍 Find the branches that should go

<!-- ![Cleanup detection](images/cleanup.gif) -->

One-click detection across local and remote branches:

- **Merged** — already merged into your base branch
- **Stale** — no commits for N days (you set the threshold)
- **Gone** — local branches whose upstream was deleted on the remote
- **Cleanup All** — run every check at once and review the combined result

### 🗑️ Stage, review, then delete

<!-- ![Deletion Queue](images/queue.png) -->

Detected branches don't disappear on you. They land in the **Deletion Queue** — a dedicated view in the Activity Bar — where you can:

- Review every branch before anything is removed
- Watch per-item progress (pending / running / ✓ / ✗) as the batch runs
- Remove individual entries, or **Clear** the whole queue
- Get a confirmation prompt before force-deleting unmerged branches

### ✋ Pick branches by hand

<!-- ![Select mode](images/select-mode.png) -->

Need surgical control? Turn on **Select Mode**, check the branches you want — local and remote together — and add them to the queue. The header **select-all** checkbox toggles every visible row, so you can search-filter first and bulk-select the matches.

### 🌿 Full branch management, too

Git Souji isn't only a cleaner. From the same panel you can **Checkout**, **Create**, **Rename**, and **Merge** branches, view a branch's log, and search the whole list by name (with case-sensitive and regex toggles).

### 🗂️ Multi-folder workspaces

Working across several repos? **Switch Repository** changes the active repo, and Git Souji remembers your last choice per workspace.

## Get started

1. Open a Git repository in VS Code.
2. Run **Git Souji: Open** from the Command Palette (`Ctrl/Cmd+Shift+P`) — or click the branch icon in the Source Control title bar, or the **Git Souji** icon in the Activity Bar.
3. Detect branches, stage them into the Deletion Queue, and click **Execute**.

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `gitSouji.baseBranch` | Base branch for merged detection (`auto` resolves it for you) | `auto` |
| `gitSouji.staleDays` | Days without commits before a branch is "stale" | `30` |
| `gitSouji.autoFetchPrune` | Run `git fetch --prune` before detecting gone branches | `false` |
| `gitSouji.protectedBranches` | Branch patterns that can't be deleted/renamed/merged (glob supported) | `["main", "master", "develop"]` |
| `gitSouji.confirmBeforeDelete` | Show confirmation dialogs before destructive actions | `true` |
| `gitSouji.forceDeleteLocal` | Use force delete (`-D`) instead of safe delete (`-d`) | `false` |
| `gitSouji.allowRemoteBranchDeletion` | Enable the remote branch deletion UI | `false` |
| `gitSouji.includeRemoteInDeadCleanup` | Also delete the remote when cleaning a merged local branch | `false` |
| `gitSouji.showStatusBadges` | Show merged/stale/gone badges in the branch list | `true` |

## Requirements

- Git must be installed and available on your `PATH`.

---

<!--
  Git Souji のマーケットプレイス説明文（日本語）。
  画像プレースホルダーは壊れた画像が表示されないようコメントアウトしています。
  images/ に実際のアセットを置き、該当行のコメントを外してください。
-->

# Git Souji — Git ブランチを掃除する

**「掃除（Souji）」は cleaning の意味です。** Git Souji は、消し忘れたブランチ（マージ済み・古い・上流が消えたもの）を見つけ出し、VS Code のひとつのパネルからまとめて片付けます。`git branch | grep` も、「どれを消していいか」の勘も、もう要りません。

<!-- ![Git Souji ブランチクリーナー](images/hero.png) -->

## なぜ Git Souji か

ブランチは溜まります。マージ済みの PR、放置した実験、削除されたリモート — そのたびにブランチ一覧は少しずつ散らかり、やがて `git branch` が画面からあふれます。手作業の掃除は面倒で、間違えやすい作業です。

Git Souji は検出を肩代わりし、削除を安全に保ちます:

- **片付けるべきブランチが一目でわかる** — マージ済み・古い・上流消失をステータスバッジで表示。
- **削除前に必ずステージング** — 削除キューで確認して **Execute** を押すまで、何も消えません。
- **大事なものは保護** — `main`、リリースブランチ、設定した glob パターンは破壊的操作の対象外。

## できること

### 🔍 消すべきブランチを見つける

<!-- ![クリーンアップ検出](images/cleanup.gif) -->

ローカル・リモート両方をワンクリックで検出:

- **Merged** — ベースブランチにマージ済み
- **Stale** — N日間コミットがない（閾値は設定可能）
- **Gone** — リモートで上流が削除されたローカルブランチ
- **Cleanup All** — すべての検出をまとめて実行し、結果を一括レビュー

### 🗑️ ステージング → レビュー → 削除

<!-- ![削除キュー](images/queue.png) -->

検出したブランチが勝手に消えることはありません。すべてアクティビティバーの専用ビュー **削除キュー** に集まり、そこで:

- 削除前にすべてのブランチをレビュー
- 実行中は項目ごとの状態（待機 / 実行中 / ✓ / ✗）を確認
- 個別の項目を削除、またはキュー全体を **Clear**
- 未マージブランチの強制削除前には確認ダイアログを表示

### ✋ 手動で選ぶ

<!-- ![選択モード](images/select-mode.png) -->

細かく選びたいときは **選択モード** をオン。残したいブランチをローカル・リモートまとめてチェックし、キューに追加できます。ヘッダーの **全選択** チェックボックスは表示中の行をまとめて切り替えるので、検索で絞り込んでから一括選択もできます。

### 🌿 ブランチ管理も一通り

Git Souji はクリーナーだけではありません。同じパネルから **Checkout**・**Create**・**Rename**・**Merge** を実行でき、ブランチのログ表示や、名前での検索（大文字小文字区別・正規表現の切替対応）も使えます。

### 🗂️ マルチフォルダワークスペース

複数リポジトリを扱う場合も、**Switch Repository** で対象リポジトリを切り替え。最後に選んだリポジトリはワークスペースごとに記憶されます。

## 使い方

1. VS Code で Git リポジトリを開く。
2. コマンドパレット（`Ctrl/Cmd+Shift+P`）から **Git Souji: 開く** を実行 — または Source Control タイトルバーのブランチアイコン、もしくはアクティビティバーの **Git Souji** アイコンから起動。
3. ブランチを検出し、削除キューに積んで **Execute** をクリック。

## 設定

| 設定 | 説明 | デフォルト |
|------|------|-----------|
| `gitSouji.baseBranch` | マージ検出の基準ブランチ（`auto` で自動解決） | `auto` |
| `gitSouji.staleDays` | 「古い」と判定するまでのコミットなし日数 | `30` |
| `gitSouji.autoFetchPrune` | gone 検出前に `git fetch --prune` を実行 | `false` |
| `gitSouji.protectedBranches` | 削除・改名・マージを禁止するブランチパターン（glob 対応） | `["main", "master", "develop"]` |
| `gitSouji.confirmBeforeDelete` | 破壊的操作の前に確認ダイアログを表示 | `true` |
| `gitSouji.forceDeleteLocal` | 安全削除（`-d`）の代わりに強制削除（`-D`）を使用 | `false` |
| `gitSouji.allowRemoteBranchDeletion` | リモートブランチ削除 UI を有効化 | `false` |
| `gitSouji.includeRemoteInDeadCleanup` | マージ済みローカルの掃除時にリモートも削除 | `false` |
| `gitSouji.showStatusBadges` | ブランチ一覧に merged/stale/gone バッジを表示 | `true` |

## 要件

- Git がインストールされ、`PATH` で利用可能であること。
