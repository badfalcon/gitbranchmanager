# リリース手順

Git Sohji のリリースは、ローカルでの準備と GitHub Actions による公開の二段構えになっている。
`v*` タグの push が公開のトリガーであり、それ以外の経路で Marketplace に publish することはない。

## 通常のリリース

```bash
# 1. master を最新にする
git checkout master
git pull

# 2. リリース準備（前提チェック → npm test → バージョン更新 → コミット → タグ）
npm run release 1.7.0

# 3. 内容を確認する
git show v1.7.0

# 4. push すると公開が始まる
git push --follow-tags
```

`npm run release` は次を自動で行う。

- 前提チェック — 指定バージョンが現在のバージョンより新しいこと / master にいる / working tree が clean / origin と同期済み / タグが未存在 / `CHANGELOG.md` の `[Unreleased]` が空でない
- `npm test`（テスト用コードのコンパイル → 本体のコンパイル → lint → テスト実行）
- `package.json` と `package-lock.json` のバージョン更新
- `CHANGELOG.md` の `# [Unreleased]` を `# [1.7.0] - YYYY-MM-DD` に確定し、新しい空の `[Unreleased]` を先頭に追加
- `chore(release): 1.7.0` コミットと `v1.7.0` 注釈付きタグの作成

push は自動化していない。コミットとタグを目視確認してから公開する余地を残すためである。

事前に何が起きるか確認したいときは dry-run を使う。`npm test` は実行されるため `dist/` や `out/` にビルド成果物は書き込まれるが、`package.json` / `package-lock.json` / `CHANGELOG.md` は変更されず、コミットもタグも作成されない。

```bash
npm run release 1.7.0 -- --dry-run
```

途中で失敗した場合、`release: <エラー内容>` という形式でメッセージが表示される。ファイルを書き換えた後やコミットを作った後の失敗であれば、続けてクリーンな状態に戻すための具体的なコマンド（`git checkout -- .` または `git reset --hard HEAD~1`）も表示される。表示された通りに実行すればよく、自己判断で復旧しようとする必要はない。

タグ push 後は GitHub Actions の `Release` ワークフローが以下を実行する。

1. タグ名と `package.json` のバージョン一致を検証
2. テスト
3. `.vsix` のパッケージング
4. `.vsix` をワークフローの成果物（artifact）としてアップロード
5. VS Code Marketplace へ publish
6. Open VSX へ publish
7. GitHub Release を作成し、`.vsix` を添付、`CHANGELOG.md` の該当セクションを本文に転記

進捗は https://github.com/badfalcon/gitbranchmanager/actions で確認する。

## 初回セットアップ

GitHub リポジトリの Settings → Secrets and variables → Actions に、次の 2 つを登録する。

### `VSCE_PAT` — VS Code Marketplace

1. https://dev.azure.com にサインインする（publisher `badfalcon` を作成したアカウント）
2. User settings → Personal access tokens → New Token
3. Organization に **All accessible organizations** を選ぶ
4. Scopes で **Custom defined** を選び、**Marketplace → Manage** にチェックを入れる
5. 生成されたトークンを Secret `VSCE_PAT` として登録する

PAT には有効期限がある。期限切れの場合、publish ステップが 401 で失敗するので再発行する。

### `OVSX_PAT` — Open VSX

1. https://open-vsx.org に GitHub アカウントでサインインする
2. Settings → Access Tokens でトークンを生成する
3. 生成されたトークンを Secret `OVSX_PAT` として登録する
4. 初回公開時は publisher agreement への同意を求められる場合がある。その場合はサイト上で同意してからワークフローを再実行する

## トラブルシューティング

### タグを間違えた（まだ push していない）

```bash
git tag -d v1.7.0
git reset --hard HEAD~1
```

### タグを push した後で誤りに気づいた

まずワークフローの実行そのものを止められないか確認する。**`git push --delete` でタグを origin から消してもワークフローは止まらない。** 実行はタグの指す SHA を checkout 済みで動いているため、`release.yml` の検証ステップは `$GITHUB_REF_NAME` と `package.json` を比較するだけで、タグが origin にまだ存在するかどうかは一切見ていない。タグを消しても test・package・publish は最後まで進んでしまう。

```bash
gh run list --workflow=Release --limit 3
gh run cancel <run-id>
```

Actions の実行ページの Cancel ボタンからでもよい。ただし、これで取り消せるのは実行がまだ publish ステップに到達していない場合だけである。すでに Marketplace への publish が終わっていれば、そのバージョンは公開済みであり、Marketplace は同一バージョンの再公開を受け付けないため、後から取り消す手段はない。

ワークフローを止められたかどうかに関わらず、その後の対応は 2 つある。

**推奨: バージョンを上げてやり直す** — publish が実行された、またはされた可能性がある場合はこちらしかない。push 済みのコミットとタグはそのままにして、修正してから新しいバージョンでリリースし直す。

```bash
# 修正してから
npm run release 1.7.1
git push --follow-tags
```

**履歴を書き換える** — 何も publish されておらず、誰も pull していないと確信できる場合に限る。この場合は origin/master への push 自体を取り消す必要がある。

```bash
git push --delete origin v1.7.0
git tag -d v1.7.0
git reset --hard HEAD~1
git push --force-with-lease origin master
```

`push --force-with-lease` は origin/master の履歴を書き換える操作である。他の人が pull していれば混乱を招くが、ここでは単一メンテナのリポジトリであることを前提に許容している。

### Marketplace は成功したが Open VSX で失敗した

ワークフロー全体の再実行はできない（Marketplace 側が「同一バージョンは公開済み」で失敗するため）。ただし失敗した実行の Artifacts に、実際に Marketplace へ publish された `.vsix` がそのまま残っているので、それをダウンロードして Open VSX に publish する。ローカルで再ビルドすると、公開済みのものと異なるバイナリを Open VSX にだけ配ってしまう恐れがあるため、artifact の再利用を優先する。

```bash
gh run download <run-id> -n gitsouji-1.7.0.vsix
npx ovsx publish gitsouji-1.7.0.vsix -p <OVSX_PAT>
```

GitHub Actions の実行ページの Artifacts セクションからブラウザで直接ダウンロードしてもよい。

artifact が取得できない場合に限り、ローカルで再ビルドする。

```bash
npm run package:vsix
npx ovsx publish gitsouji-1.7.0.vsix -p <OVSX_PAT>
```

同じ artifact は、GitHub Release の作成ステップだけが失敗した場合の手動リカバリにも使える。ダウンロードした `.vsix` を該当タグの GitHub Release にアセットとして手動でアップロードすればよい。リリース本文（`release-notes.md`）はワークフロー内で生成される一時ファイルで、失敗した実行には残っていない。本文には `CHANGELOG.md` の該当バージョンのセクションをそのまま使うか、`node scripts/lib/changelog.mjs extract <version>` で再生成して貼り付ける。

### タグと package.json のバージョンが一致しないと言われた

ワークフローの最初のステップ（タグと package.json の一致検証）で停止しており、テストや publish には到達していない。ただし `git push --follow-tags` でコミットは origin/master に push 済みなので、ローカルを `git reset --hard` で巻き戻すだけでは古いコミットが origin に残ってしまい、次の `npm run release` が「origin より N コミット遅れている」という前提チェックで失敗する。対応は 2 つ。

**推奨: バージョンを上げてやり直す** — push 済みのコミットとタグはそのままにして、正しいバージョンで新たにリリースし直す。

```bash
git push --delete origin v1.7.0
git tag -d v1.7.0
npm run release 1.7.1
git push --follow-tags
```

**履歴を書き換える** — この失敗はワークフローの最初のステップで止まるため何も publish されていない。誰も origin/master を pull していないと確信できるなら、書き換えても実害はない。

```bash
git push --delete origin v1.7.0
git tag -d v1.7.0
git reset --hard HEAD~1
git push --force-with-lease origin master
# package.json を正しいバージョンに直してから npm run release をやり直す
```

`push --force-with-lease` は origin/master の履歴を書き換える操作である。単一メンテナのリポジトリであることを前提に許容している。

## 関連ファイル

| ファイル | 役割 |
| --- | --- |
| `scripts/release.mjs` | リリース準備（前提チェック、バージョン更新、コミット、タグ） |
| `scripts/lib/changelog.mjs` | CHANGELOG の確定とセクション抽出 |
| `.github/workflows/ci.yml` | push でのテスト（全ブランチ、PR トリガーなし） |
| `.github/workflows/release.yml` | タグ push での公開 |
| `STORE.md` | Marketplace 上の説明文（`package.json` の `readme` で指定） |
| `.vscodeignore` | `.vsix` に含めないファイルの指定 |
