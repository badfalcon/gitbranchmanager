# リリース自動化 設計書

作成日: 2026-07-21

## 背景

現在のリリースは手順書が存在せず、ローカルでの手作業に依存している。git 履歴から復元した実際の手順は次の通り:

1. `npm test`
2. `CHANGELOG.md` の `# [Unreleased]` を `# [X.Y.Z] - YYYY-MM-DD` に書き換え
3. `package.json` の `version` を更新
4. `chore(release): X.Y.Z` でコミット
5. `git tag -a vX.Y.Z -m "Release X.Y.Z"`
6. `npx vsce package` / `npx vsce publish`
7. `git push && git push --tags`

この運用には次の問題がある:

- **タグ抜け** — `v1.5.1` と `v1.6.0` はリリースコミットが存在するのにタグが打たれていない。手順が人の記憶に依存している証拠
- **ツールが固定されていない** — `vsce` は devDependencies になく、`npx` が解決するグローバルの 2.15.0（現行は 3.x）が使われている。マシンを変えると挙動が変わる
- **CI が存在しない** — テストはローカルでしか回らず、リリース直前の検証が実行者頼み
- **公開先が VS Code Marketplace のみ** — Cursor / Windsurf / VSCodium 利用者に届かない
- **`package.json` の `repository.url` が誤っている** — `gitbranchcleaner.git` を指しているが実体は `gitbranchmanager`。Marketplace 上のリポジトリリンクが壊れている

## ゴール

タグ push を唯一のトリガーとし、公開作業を GitHub Actions に委譲する。ローカルに残すのは「リリース内容を確定してタグを打つ」までとし、その工程もスクリプト化して手順の記憶を不要にする。

## 全体像

```
ローカル                          GitHub Actions
─────────────────────────        ──────────────────────────────
npm run release 1.7.0
  ├ 前提チェック
  ├ npm test
  ├ package.json version 更新
  ├ CHANGELOG 見出し確定
  ├ commit  chore(release): 1.7.0
  └ tag     v1.7.0
                                  ci.yml     (push / PR)
git push --follow-tags  ────────▶ lint + compile + test

                                  release.yml (タグ v* push)
                                  ├ バージョン整合性検証
                                  ├ test
                                  ├ vsce package → .vsix
                                  ├ vsce publish   (VSCE_PAT)
                                  ├ ovsx publish   (OVSX_PAT)
                                  └ GitHub Release 作成 + .vsix 添付
```

push を自動化しないのは意図的な設計判断である。コミットとタグを作った後に内容を目視確認する機会を残し、誤ったリリースを push 前に取り消せるようにする。

## コンポーネント

### 1. 固定するツール（`package.json`）

`@vscode/vsce`（3.x 系）と `ovsx` を devDependencies に追加する。ローカルと CI が同一バージョンを使うことを保証する。

追加する npm scripts:

| script | 内容 |
| --- | --- |
| `release` | `node scripts/release.mjs` — リリース準備 |
| `package:vsix` | `vsce package` — .vsix 生成（CI とローカル検証で共用） |

`vscode:prepublish` は既存のまま（`vsce package` が内部で呼ぶ）。

あわせて `repository.url` を `https://github.com/badfalcon/gitbranchmanager.git` に修正する。

### 2. `scripts/release.mjs`

引数: `<version>`（`X.Y.Z` 形式）、オプション `--dry-run`。

処理順序:

1. **前提チェック** — いずれか一つでも満たさなければ何もせず異常終了する
   - 引数のバージョンが `X.Y.Z` 形式である
   - 現在のブランチが `master` である
   - working tree が clean である
   - `origin/master` と同期している（fetch 後、ローカルが ahead / behind でない）
   - 指定バージョンが `package.json` の現在値より新しい
   - タグ `vX.Y.Z` が未存在である
   - `CHANGELOG.md` の `# [Unreleased]` セクションに本文がある（空リリース防止）
2. **`npm test`** — 失敗したら中断（`--dry-run` でも実行する）
3. **`package.json` の `version` を更新**
4. **`CHANGELOG.md` の書き換え** — `# [Unreleased]` を `# [X.Y.Z] - YYYY-MM-DD` に置換し、ファイル先頭に空の `# [Unreleased]` セクションを新規挿入する。既存の見出し階層（リリースが `#`、`Added` / `Changed` / `Fixed` が `##`）を踏襲する
5. **コミットとタグ** — `git commit -am "chore(release): X.Y.Z"` と `git tag -a vX.Y.Z -m "Release X.Y.Z"`
6. **次の操作を表示して終了** — `git push --follow-tags` を促す

`--dry-run` では 1・2 を実行し、3 以降は「何をするか」を出力するだけでファイルも git 状態も変更しない。

日付は実行時のローカル日付（`YYYY-MM-DD`）を使う。

### 3. `.github/workflows/ci.yml`

- トリガー: `push`（全ブランチ）と `pull_request`
- ランナー: `ubuntu-latest`、Node.js 22（`actions/setup-node` の `cache: npm`）
- 手順: `npm ci` → `xvfb-run -a npm test`

`npm test` の `pretest` が compile-tests / compile / lint を含むため、lint とビルドは別ステップにしない。VS Code の拡張テストは Electron を起動するため `xvfb-run` が必須。

### 4. `.github/workflows/release.yml`

- トリガー: `push` の `tags: ['v*']`
- `permissions: contents: write`（GitHub Release 作成のため）
- ランナー: `ubuntu-latest`、Node.js 22

手順:

1. **バージョン整合性検証** — タグ名から `v` を除いた文字列と `package.json` の `version` が一致しない場合は即座に失敗させる
2. `npm ci`
3. `xvfb-run -a npm test`
4. `npx vsce package` — `gitsouji-X.Y.Z.vsix` を生成
5. `npx vsce publish --packagePath <vsix>` — 認証は環境変数 `VSCE_PAT`
6. `npx ovsx publish <vsix> -p $OVSX_PAT`
7. **GitHub Release 作成** — `softprops/action-gh-release` を使用。タグ名をリリース名とし、本文には `CHANGELOG.md` から当該バージョンのセクション（`# [X.Y.Z]` 見出しから次の `# [` 見出しの直前まで）を抽出して転記。`.vsix` をアセットとして添付

`vsce publish` と `ovsx publish` は既にビルド済みの `.vsix` を渡す形にする。同一成果物が Marketplace・Open VSX・GitHub Release の三箇所に配布されることを保証するため。

### 5. `RELEASE.md`

リポジトリルートに配置する。内容:

- 通常のリリース手順（`npm run release X.Y.Z` → 確認 → `git push --follow-tags` → Actions を見守る）
- 初回セットアップ手順（PAT の取得と GitHub Secrets への登録）
- 失敗時の対処（タグを打ち直す場合、publish だけ失敗した場合の手動リカバリ）

### 6. 後片付け

リポジトリルートに残っている過去のビルド成果物 `gitsouji-*.vsix`（8 ファイル）を削除する。`.gitignore` 済みで git 追跡もされておらず、保持する理由がない。

## 手作業が必要な前提条件

自動化の対象外。ユーザーが実施する。

1. Azure DevOps で Marketplace 向け PAT を発行し、GitHub リポジトリの Secret `VSCE_PAT` に登録する
2. open-vsx.org で publisher `badfalcon` を作成し、アクセストークンを Secret `OVSX_PAT` に登録する
3. Open VSX は初回公開時に publisher agreement への同意を求める場合がある

これらが未設定のままタグを push すると、`release.yml` の publish ステップで失敗する。テストとパッケージングは成功しているため、Secrets を登録してから同じワークフローを再実行すれば復旧できる。

## エラー処理

| 状況 | 挙動 |
| --- | --- |
| `release.mjs` の前提チェック失敗 | 何も変更せず、理由を表示して異常終了 |
| `release.mjs` 実行中の `npm test` 失敗 | ファイルを書き換える前に中断 |
| タグと `package.json` の version 不一致 | `release.yml` の最初のステップで失敗。publish には到達しない |
| CI のテスト失敗 | publish 前に停止 |
| `vsce publish` 失敗 | ワークフロー失敗。`.vsix` はアーティファクトとして残る |
| `ovsx publish` 失敗 | ワークフロー失敗。Marketplace への公開は既に完了しているため、Open VSX のみ手動で再実行する |

Marketplace への公開後に Open VSX が失敗した場合、ワークフローの再実行は Marketplace 側で「同一バージョンは公開済み」エラーになる。この対処は `RELEASE.md` に記載する。

## テスト方針

- `scripts/release.mjs` — `--dry-run` を実行し、前提チェックが正しく通る／落ちることを手元で確認する。本体は git 操作とファイル書き換えのみで、拡張機能のロジックには関与しないため、既存の Mocha テストスイートには追加しない
- ワークフロー — 実行可能性は実際に走らせて確認するしかない。次のリリース（1.7.0）を最初の検証対象とする。CI ワークフローは push した時点で即座に動作確認できる

## スコープ外

- 既存のタグ抜け（`v1.5.1`、`v1.6.0`）を遡って補完すること
- CHANGELOG の自動生成（コミットメッセージからの生成）。現在の CHANGELOG は人が読むために丁寧に書かれており、機械生成に置き換える価値がない
- Windows / macOS でのマトリックス CI。拡張機能のロジックに OS 依存がなく、実行時間とのつり合いが取れない
- pre-release チャネル（`vsce publish --pre-release`）への対応
