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

- 前提チェック — master にいる / working tree が clean / origin と同期済み / タグが未存在 / `CHANGELOG.md` の `[Unreleased]` が空でない
- `npm test`（lint・コンパイル・テスト）
- `package.json` と `package-lock.json` のバージョン更新
- `CHANGELOG.md` の `# [Unreleased]` を `# [1.7.0] - YYYY-MM-DD` に確定し、新しい空の `[Unreleased]` を先頭に追加
- `chore(release): 1.7.0` コミットと `v1.7.0` 注釈付きタグの作成

push は自動化していない。コミットとタグを目視確認してから公開する余地を残すためである。

事前に何が起きるか確認したいときは dry-run を使う。ファイルも git の状態も変更しない。

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

Marketplace は同一バージョンの再公開を受け付けない。**バージョンを上げてやり直す**のが唯一の正攻法である。

```bash
git push --delete origin v1.7.0   # ワークフローが publish に到達する前なら間に合う
git tag -d v1.7.0
git reset --hard HEAD~1
# 修正してから npm run release 1.7.1
```

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

同じ artifact は、GitHub Release の作成ステップだけが失敗した場合の手動リカバリにも使える。ダウンロードした `.vsix` を該当タグの GitHub Release にアセットとして手動でアップロードすればよい。

### タグと package.json のバージョンが一致しないと言われた

ワークフローの最初のステップで停止しており、publish には到達していない。タグを打ち直せば安全に復旧できる。

```bash
git push --delete origin v1.7.0
git tag -d v1.7.0
# package.json を正しいバージョンに直してから npm run release をやり直す
```

## 関連ファイル

| ファイル | 役割 |
| --- | --- |
| `scripts/release.mjs` | リリース準備（前提チェック、バージョン更新、コミット、タグ） |
| `scripts/lib/changelog.mjs` | CHANGELOG の確定とセクション抽出 |
| `.github/workflows/ci.yml` | push / PR でのテスト |
| `.github/workflows/release.yml` | タグ push での公開 |
| `STORE.md` | Marketplace 上の説明文（`package.json` の `readme` で指定） |
| `.vscodeignore` | `.vsix` に含めないファイルの指定 |
