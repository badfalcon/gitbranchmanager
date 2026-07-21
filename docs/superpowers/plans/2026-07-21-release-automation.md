# Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** タグ push を唯一のトリガーとして、テスト・パッケージング・VS Code Marketplace / Open VSX への公開・GitHub Release 作成を GitHub Actions で自動化し、ローカルにはリリース準備スクリプトだけを残す。

**Architecture:** リリース準備（バージョン確定・CHANGELOG 確定・コミット・タグ）は `scripts/release.mjs` がローカルで実行する。CHANGELOG の書き換えと抽出は純粋関数として `scripts/lib/changelog.mjs` に切り出し、`node --test` で単体テストする。この抽出関数は GitHub Release の本文生成でも再利用する。公開は `.github/workflows/release.yml` が `v*` タグ push を検知して実行する。

**Tech Stack:** Node.js 22（`node:test` 組み込みテストランナー）、GitHub Actions（ubuntu-latest）、`@vscode/vsce` 3.x、`ovsx` 1.x、`softprops/action-gh-release@v2`

**Spec:** `docs/superpowers/specs/2026-07-21-release-automation-design.md`

## Global Constraints

- 拡張機能のランタイムコード（`src/**`、`media/**`）は一切変更しない。この作業はリリース基盤のみを対象とする
- Node.js のバージョンは 22（ローカル環境は v22.18.0、CI も 22 で揃える）
- 対象リポジトリは `https://github.com/badfalcon/gitbranchmanager`、publisher は `badfalcon`、拡張機能名は `gitsouji`
- リリースブランチは `master`
- `CHANGELOG.md` の見出し階層は既存を踏襲する — リリースが `#`（例: `# [1.6.1] - 2026-05-26`）、`Added` / `Changed` / `Fixed` が `##`
- 新規スクリプトは ES モジュール（`.mjs`）で書く。`package.json` に `"type"` フィールドは追加しない
- Secrets 名は `VSCE_PAT`（VS Code Marketplace）と `OVSX_PAT`（Open VSX）
- git push は自動化しない。`scripts/release.mjs` はコミットとタグを作るところまでで終了する

## File Structure

| ファイル | 種別 | 責務 |
| --- | --- | --- |
| `package.json` | 変更 | リポジトリ URL 修正、`@vscode/vsce` / `ovsx` 追加、`release` / `package:vsix` / `test:scripts` スクリプト追加 |
| `.vscodeignore` | 変更 | 新規に増える開発用ディレクトリを .vsix から除外 |
| `scripts/lib/changelog.mjs` | 新規 | CHANGELOG の解析・書き換え・セクション抽出（純粋関数 + 小さな CLI） |
| `scripts/lib/changelog.test.mjs` | 新規 | 上記の単体テスト（`node:test`） |
| `scripts/release.mjs` | 新規 | リリース準備のオーケストレーション（前提チェック、テスト、バージョン更新、コミット、タグ） |
| `.github/workflows/ci.yml` | 新規 | push / PR でのテスト |
| `.github/workflows/release.yml` | 新規 | `v*` タグ push での公開 |
| `RELEASE.md` | 新規 | リリース手順書と初回セットアップ |
| `CLAUDE.md` | 変更 | リリース手順への参照を追加 |

`changelog.mjs` を `release.mjs` から分離するのは、CHANGELOG の文字列処理だけが純粋で単体テスト可能であり、かつ GitHub Release の本文生成でも同じ抽出処理が必要になるため。git 操作を含む `release.mjs` は副作用の塊なので、テスト対象から切り離す。

---

### Task 1: リリース用ツールの固定とリポジトリ URL の修正

**Files:**
- Modify: `package.json:10-17`（`repository` / `homepage` / `bugs`）、`package.json:281-291`（`scripts`）、`package.json:292-306`（`devDependencies`）
- Modify: `.vscodeignore`
- Delete: ルートに残っている `gitsouji-*.vsix`（git 追跡外のビルド成果物）

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces: `npx vsce` / `npx ovsx` がローカルで解決可能になる。`npm run package:vsix` で .vsix を生成できる

- [ ] **Step 1: 誤ったリポジトリ URL を修正**

`package.json` の 3 箇所は `gitbranchcleaner` を指しているが、実際のリポジトリは `gitbranchmanager`。次のように置き換える。

```json
  "repository": {
    "type": "git",
    "url": "https://github.com/badfalcon/gitbranchmanager.git"
  },
  "homepage": "https://github.com/badfalcon/gitbranchmanager#readme",
  "bugs": {
    "url": "https://github.com/badfalcon/gitbranchmanager/issues"
  },
```

- [ ] **Step 2: 修正を確認**

Run: `node -p "const p=require('./package.json'); [p.repository.url, p.homepage, p.bugs.url].join('\n')"`

Expected: 3 行すべてに `gitbranchmanager` が含まれ、`gitbranchcleaner` が 1 つも残っていないこと。

- [ ] **Step 3: パブリッシュ用ツールを devDependencies に追加**

Run: `npm install --save-dev @vscode/vsce@^3.9.2 ovsx@^1.0.2`

Expected: `package.json` の `devDependencies` に 2 つのエントリが追加され、`package-lock.json` が更新される。

- [ ] **Step 4: ローカルで解決されるバージョンを確認**

Run: `npx vsce --version && npx ovsx --version`

Expected: `3.9.2` と `1.0.2`（グローバルの古い 2.15.0 ではないこと）。

- [ ] **Step 5: npm scripts を追加**

`package.json` の `scripts` を次のようにする（既存エントリはそのまま、3 行追加）。

```json
  "scripts": {
    "vscode:prepublish": "npm run package",
    "compile": "webpack",
    "watch": "webpack --watch",
    "package": "webpack --mode production --devtool hidden-source-map",
    "package:vsix": "vsce package",
    "compile-tests": "tsc -p . --outDir out",
    "watch-tests": "tsc -p . -w --outDir out",
    "pretest": "npm run compile-tests && npm run compile && npm run lint",
    "lint": "eslint src",
    "test": "vscode-test",
    "test:scripts": "node --test \"scripts/lib/*.test.mjs\"",
    "release": "node scripts/release.mjs"
  },
```

- [ ] **Step 6: .vsix に開発用ファイルが混入しないよう除外設定を追加**

現状の `.vscodeignore` は `scripts/` を除外していないため、`scripts/setup-test-repo.sh` が配布物に含まれている。ファイル末尾に次を追記する。

```
.github/**
docs/**
scripts/**
.test/**
RELEASE.md
*.vsix
```

- [ ] **Step 7: パッケージ内容を確認**

`vsce ls` はビルド成果物を生成しないため、先にコンパイルしておく。

Run: `npm run compile && npx vsce ls`

Expected: 出力に `dist/extension.js`、`media/branchManager.html`、`l10n/`、`images/icon.png`、`STORE.md`、`CHANGELOG.md`、`LICENSE`、`package.json` が含まれ、`scripts/`、`docs/`、`.github/`、`RELEASE.md`、`src/` が **含まれない** こと。

- [ ] **Step 8: 過去のビルド成果物を削除**

ルートに `gitsouji-1.1.0.vsix` から `gitsouji-1.6.1.vsix` まで 8 個の .vsix が残っている。`.gitignore` 済みで git 追跡もされておらず、保持する理由がない。

Run: `rm -f gitsouji-*.vsix && ls gitsouji-*.vsix 2>/dev/null; echo "remaining: $?"`

Expected: `remaining: ` の後に 0 以外（＝該当ファイルなし）が表示される。

- [ ] **Step 9: パッケージングが通ることを確認**

Run: `npm run package:vsix`

Expected: `gitsouji-1.6.1.vsix` が生成され、エラーで終了しないこと。確認後 `rm -f gitsouji-1.6.1.vsix` で削除する。

- [ ] **Step 10: コミット**

```bash
git add package.json package-lock.json .vscodeignore
git commit -m "chore: pin release tooling and fix repository URLs"
```

---

### Task 2: CHANGELOG 操作モジュール

**Files:**
- Create: `scripts/lib/changelog.mjs`
- Test: `scripts/lib/changelog.test.mjs`

**Interfaces:**
- Consumes: Task 1 の `test:scripts` npm script
- Produces:
  - `unreleasedBody(text: string): string` — `# [Unreleased]` セクションの本文を trim して返す。セクションが無い／空なら `''`
  - `finalizeChangelog(text: string, version: string, date: string): string` — `# [Unreleased]` 見出しを `# [<version>] - <date>` に置換し、先頭に空の `# [Unreleased]` セクションを挿入した全文を返す。Unreleased が空、または既に同バージョンのセクションが存在する場合は `Error` を投げる
  - `extractSection(text: string, version: string): string` — `# [<version>] ...` 見出し配下の本文を trim して返す。見つからなければ `Error` を投げる
  - CLI: `node scripts/lib/changelog.mjs extract <version>` — カレントディレクトリの `CHANGELOG.md` から該当セクションを標準出力へ

- [ ] **Step 1: 失敗するテストを書く**

Create `scripts/lib/changelog.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractSection, finalizeChangelog, unreleasedBody } from './changelog.mjs';

const SAMPLE = [
	'# [Unreleased]',
	'',
	'## Added',
	'',
	'- New thing',
	'',
	'# [1.6.1] - 2026-05-26',
	'',
	'## Fixed',
	'',
	'- Old bug',
	'',
	'# [1.6.0] - 2026-05-25',
	'',
	'## Added',
	'',
	'- Older thing',
	''
].join('\n');

const EMPTY_UNRELEASED = ['# [Unreleased]', '', '# [1.6.1] - 2026-05-26', '', '- Old bug', ''].join('\n');

test('unreleasedBody returns the trimmed body of the Unreleased section', () => {
	assert.equal(unreleasedBody(SAMPLE), '## Added\n\n- New thing');
});

test('unreleasedBody returns an empty string when the section has no content', () => {
	assert.equal(unreleasedBody(EMPTY_UNRELEASED), '');
});

test('unreleasedBody returns an empty string when there is no Unreleased section', () => {
	assert.equal(unreleasedBody('# [1.6.1] - 2026-05-26\n\n- Old bug\n'), '');
});

test('finalizeChangelog dates the Unreleased heading and prepends a fresh one', () => {
	const result = finalizeChangelog(SAMPLE, '1.7.0', '2026-07-21');
	assert.equal(result.startsWith('# [Unreleased]\n\n# [1.7.0] - 2026-07-21\n'), true);
	assert.equal(result.includes('# [Unreleased]\n\n## Added'), false);
	assert.equal(unreleasedBody(result), '');
	assert.equal(extractSection(result, '1.7.0'), '## Added\n\n- New thing');
	assert.equal(extractSection(result, '1.6.1'), '## Fixed\n\n- Old bug');
});

test('finalizeChangelog preserves CRLF line endings', () => {
	const result = finalizeChangelog(SAMPLE.replace(/\n/g, '\r\n'), '1.7.0', '2026-07-21');
	assert.equal(result.startsWith('# [Unreleased]\r\n\r\n# [1.7.0] - 2026-07-21\r\n'), true);
	assert.equal(result.includes('\n\n'), false);
});

test('finalizeChangelog rejects an empty Unreleased section', () => {
	assert.throws(() => finalizeChangelog(EMPTY_UNRELEASED, '1.7.0', '2026-07-21'), /empty/);
});

test('finalizeChangelog rejects a version that already has a section', () => {
	assert.throws(() => finalizeChangelog(SAMPLE, '1.6.1', '2026-07-21'), /already/);
});

test('extractSection stops at the next release heading', () => {
	assert.equal(extractSection(SAMPLE, '1.6.0'), '## Added\n\n- Older thing');
});

test('extractSection throws for a missing version', () => {
	assert.throws(() => extractSection(SAMPLE, '9.9.9'), /9\.9\.9/);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:scripts`

Expected: FAIL。`Cannot find module` 相当のエラー（`scripts/lib/changelog.mjs` が存在しないため）。

- [ ] **Step 3: 実装を書く**

Create `scripts/lib/changelog.mjs`:

```js
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const RELEASE_HEADING = /^# \[([^\]]+)\](?:\s+-\s+(\S+))?\s*$/;

function splitSections(text) {
	const sections = [];
	let current = null;
	for (const line of text.split(/\r?\n/)) {
		const match = RELEASE_HEADING.exec(line);
		if (match) {
			current = { version: match[1], body: [] };
			sections.push(current);
		} else if (current) {
			current.body.push(line);
		}
	}
	return sections;
}

function sectionBody(sections, version) {
	const section = sections.find((s) => s.version === version);
	return section ? section.body.join('\n').trim() : undefined;
}

export function unreleasedBody(text) {
	return sectionBody(splitSections(text), 'Unreleased') ?? '';
}

export function extractSection(text, version) {
	const body = sectionBody(splitSections(text), version);
	if (body === undefined) {
		throw new Error(`CHANGELOG.md has no section for version ${version}`);
	}
	return body;
}

export function finalizeChangelog(text, version, date) {
	if (!unreleasedBody(text)) {
		throw new Error('CHANGELOG.md [Unreleased] section is empty — nothing to release');
	}
	if (sectionBody(splitSections(text), version) !== undefined) {
		throw new Error(`CHANGELOG.md already has a section for ${version}`);
	}
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const dated = text.replace(/^# \[Unreleased\][^\r\n]*/m, `# [${version}] - ${date}`);
	return `# [Unreleased]${eol}${eol}${dated}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, version] = process.argv.slice(2);
	if (command !== 'extract' || !version) {
		console.error('usage: node scripts/lib/changelog.mjs extract <version>');
		process.exit(1);
	}
	const text = await readFile('CHANGELOG.md', 'utf8');
	process.stdout.write(`${extractSection(text, version)}\n`);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:scripts`

Expected: PASS。`# pass 9` / `# fail 0`。

- [ ] **Step 5: CLI が実リポジトリの CHANGELOG で動くことを確認**

Run: `node scripts/lib/changelog.mjs extract 1.6.1`

Expected: `## Fixed` で始まる 1.6.1 のセクション本文が表示され、`# [1.6.0]` 以降の内容を含まないこと。

- [ ] **Step 6: コミット**

```bash
git add scripts/lib/changelog.mjs scripts/lib/changelog.test.mjs
git commit -m "feat: add changelog parsing helpers for release automation"
```

---

### Task 3: リリース準備スクリプト

**Files:**
- Create: `scripts/release.mjs`

**Interfaces:**
- Consumes: `scripts/lib/changelog.mjs` の `finalizeChangelog(text, version, date)` と `unreleasedBody(text)`
- Produces:
  - `npm run release <X.Y.Z> [-- --dry-run]` — 前提チェック → `npm test` → バージョン更新 → CHANGELOG 確定 → `chore(release): X.Y.Z` コミット → `vX.Y.Z` 注釈付きタグ
  - 環境変数 `RELEASE_BRANCH` でリリース元ブランチを上書きできる（既定 `master`）。検証用の逃げ道であり、通常の運用では設定しない

- [ ] **Step 1: スクリプトを書く**

Create `scripts/release.mjs`:

```js
#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

import { finalizeChangelog, unreleasedBody } from './lib/changelog.mjs';

// 検証用に上書きできる。通常のリリースでは常に master から切る。
const RELEASE_BRANCH = process.env.RELEASE_BRANCH ?? 'master';

function fail(message) {
	console.error(`release: ${message}`);
	process.exit(1);
}

function git(...args) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function run(command, args) {
	execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
}

function today() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function compareVersions(a, b) {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) {
			return left[i] - right[i];
		}
	}
	return 0;
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const version = argv.find((arg) => !arg.startsWith('--'));

if (!version) {
	fail('usage: npm run release <X.Y.Z> [-- --dry-run]');
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
	fail(`invalid version "${version}" (expected X.Y.Z)`);
}

const tag = `v${version}`;
const pkg = JSON.parse(await readFile('package.json', 'utf8'));

if (compareVersions(version, pkg.version) <= 0) {
	fail(`version ${version} is not newer than the current version ${pkg.version}`);
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== RELEASE_BRANCH) {
	fail(`releases must be cut from ${RELEASE_BRANCH} (currently on ${branch})`);
}
if (git('status', '--porcelain')) {
	fail('working tree is not clean — commit or stash first');
}
if (git('tag', '--list', tag)) {
	fail(`tag ${tag} already exists`);
}

git('fetch', 'origin', RELEASE_BRANCH);
const [behind, ahead] = git('rev-list', '--left-right', '--count', `origin/${RELEASE_BRANCH}...HEAD`).split(/\s+/);
if (behind !== '0') {
	fail(`local ${RELEASE_BRANCH} is ${behind} commit(s) behind origin — pull first`);
}
if (ahead !== '0') {
	fail(`local ${RELEASE_BRANCH} is ${ahead} commit(s) ahead of origin — push first`);
}

const changelog = await readFile('CHANGELOG.md', 'utf8');
if (!unreleasedBody(changelog)) {
	fail('CHANGELOG.md [Unreleased] section is empty — nothing to release');
}

const date = today();
const nextChangelog = finalizeChangelog(changelog, version, date);

console.log(`release: preparing ${tag} (${date})`);
console.log('release: running npm test');
run('npm', ['test']);

if (dryRun) {
	console.log('release: [dry-run] all preflight checks passed');
	console.log(`release: [dry-run] would set the version to ${version} in package.json and package-lock.json`);
	console.log(`release: [dry-run] would rewrite the CHANGELOG heading as "# [${version}] - ${date}"`);
	console.log(`release: [dry-run] would commit "chore(release): ${version}" and create tag ${tag}`);
	process.exit(0);
}

run('npm', ['version', version, '--no-git-tag-version']);
await writeFile('CHANGELOG.md', nextChangelog);

git('commit', '-am', `chore(release): ${version}`);
git('tag', '-a', tag, '-m', `Release ${version}`);

console.log(`
release: created commit and tag ${tag}

  review:  git show ${tag}
  publish: git push --follow-tags
  undo:    git tag -d ${tag} && git reset --hard HEAD~1
`);
```

- [ ] **Step 2: 引数バリデーションを確認**

Run: `node scripts/release.mjs 1.7`

Expected: `release: invalid version "1.7" (expected X.Y.Z)` と表示され、終了コード 1。`git status` が clean のままであること。

- [ ] **Step 3: 古いバージョンを拒否することを確認**

Run: `node scripts/release.mjs 1.0.0`

Expected: `release: version 1.0.0 is not newer than the current version 1.6.1`。終了コード 1。

- [ ] **Step 4: リリースブランチのチェックを確認**

この時点では作業ブランチ `chore/release-automation` にいるはずなので、ブランチチェックで止まる。

Run: `node scripts/release.mjs 1.7.0 --dry-run`

Expected: `release: releases must be cut from master (currently on chore/release-automation)`。終了コード 1。

**注意:** ここで `npm test` は実行されない（前提チェックはテストより先）。これが意図した順序である。

- [ ] **Step 5: コミット**

```bash
git add scripts/release.mjs
git commit -m "feat: add release preparation script"
```

- [ ] **Step 6: ブランチを push**

次のステップの dry-run は「origin と同期している」チェックを通る必要があるため、先に push しておく。

```bash
git push -u origin chore/release-automation
```

- [ ] **Step 7: 成功経路の dry-run を確認**

`RELEASE_BRANCH` を上書きして、作業ブランチ上で成功経路をそのまま実行する。master に移動せずに済み、`node_modules` もそのまま使えるので `npm test` が実際に走る。

Run: `RELEASE_BRANCH=chore/release-automation node scripts/release.mjs 1.7.0 --dry-run`

（PowerShell の場合は `$env:RELEASE_BRANCH='chore/release-automation'; node scripts/release.mjs 1.7.0 --dry-run`）

Expected: 前提チェックをすべて通過し、`release: running npm test` の後にテストが完走。最後に `[dry-run]` の 4 行が出力され、終了コード 0。

- [ ] **Step 8: dry-run が何も変更していないことを確認**

Run: `git status --porcelain`

Expected: 出力なし（`package.json`、`package-lock.json`、`CHANGELOG.md` のいずれも変更されておらず、タグも作られていないこと）。

Run: `git tag --list v1.7.0`

Expected: 出力なし。

---

### Task 4: CI ワークフロー

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 1 の `test:scripts` npm script、Task 2 のテストファイル
- Produces: push / PR ごとにテストが走る。Task 5 のワークフローは同じテスト手順（`npm ci` → `node --test` → `xvfb-run -a npm test`）を踏襲する

- [ ] **Step 1: ワークフローを書く**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: ['**']
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Test release scripts
        run: npm run test:scripts

      - name: Test extension
        run: xvfb-run -a npm test
```

`npm test` の `pretest` が `compile-tests` / `compile` / `lint` を実行するため、lint とビルドを別ステップにする必要はない。VS Code の拡張機能テストは Electron を起動するので、ヘッドレスな ubuntu ランナーでは `xvfb-run` が必須。

- [ ] **Step 2: YAML が妥当であることを確認**

Run: `node -e "const fs=require('fs'); const s=fs.readFileSync('.github/workflows/ci.yml','utf8'); if(s.includes('\t')) throw new Error('YAML must not contain tabs'); console.log('ok')"`

Expected: `ok`。（YAML はタブを禁止しており、このリポジトリの他のファイルはタブインデントなので混入しやすい）

- [ ] **Step 3: コミットして push し、実際に走らせる**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run tests on push and pull request"
git push
```

- [ ] **Step 4: CI が緑になることを確認**

Run: `gh run list --branch chore/release-automation --limit 3`

Expected: `CI` ワークフローが `completed` / `success`。`gh` が使えない場合は https://github.com/badfalcon/gitbranchmanager/actions を開いて確認する。

失敗した場合は `gh run view --log-failed` でログを確認し、修正してから次のタスクに進む。ここで CI が通らないまま Task 5 に進んではいけない — release ワークフローは同じテスト手順を使うため、同じ理由で必ず失敗する。

---

### Task 5: リリースワークフロー

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: Task 1 の `@vscode/vsce` / `ovsx` と `package:vsix`、Task 2 の CLI `node scripts/lib/changelog.mjs extract <version>`、Task 4 で検証済みのテスト手順
- Produces: `v*` タグ push で Marketplace / Open VSX / GitHub Release への公開が走る

- [ ] **Step 1: ワークフローを書く**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Verify the tag matches package.json
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          PKG_VERSION="$(node -p "require('./package.json').version")"
          if [ "$TAG_VERSION" != "$PKG_VERSION" ]; then
            echo "tag $GITHUB_REF_NAME does not match package.json version $PKG_VERSION" >&2
            exit 1
          fi
          echo "VERSION=$PKG_VERSION" >> "$GITHUB_ENV"

      - name: Install dependencies
        run: npm ci

      - name: Test release scripts
        run: npm run test:scripts

      - name: Test extension
        run: xvfb-run -a npm test

      - name: Package extension
        run: npx vsce package --out "gitsouji-${VERSION}.vsix"

      - name: Extract release notes
        run: node scripts/lib/changelog.mjs extract "${VERSION}" > release-notes.md

      - name: Publish to the VS Code Marketplace
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
        run: npx vsce publish --packagePath "gitsouji-${VERSION}.vsix"

      - name: Publish to Open VSX
        env:
          OVSX_PAT: ${{ secrets.OVSX_PAT }}
        run: npx ovsx publish "gitsouji-${VERSION}.vsix" -p "${OVSX_PAT}"

      - name: Create the GitHub release
        uses: softprops/action-gh-release@v2
        with:
          name: ${{ github.ref_name }}
          body_path: release-notes.md
          files: gitsouji-${{ env.VERSION }}.vsix
```

設計上の要点:

- **バージョン整合性検証を最初に置く** — タグと `package.json` がずれた状態で公開されることを構造的に防ぐ
- **`vsce package` を先に、`release-notes.md` の生成を後に実行する** — 順序を逆にすると `release-notes.md` が .vsix に混入する（`.vscodeignore` には登録していない一時ファイルのため）
- **publish は既にビルド済みの .vsix を渡す** — Marketplace・Open VSX・GitHub Release の三箇所に同一のバイナリが配布されることを保証する

- [ ] **Step 2: YAML が妥当であることを確認**

Run: `node -e "const fs=require('fs'); const s=fs.readFileSync('.github/workflows/release.yml','utf8'); if(s.includes('\t')) throw new Error('YAML must not contain tabs'); console.log('ok')"`

Expected: `ok`

- [ ] **Step 3: パッケージング前後の順序が意図通りか目視確認**

`Package extension` ステップが `Extract release notes` ステップより **前** にあることを確認する。

Run: `grep -n "name: Package extension\|name: Extract release notes" .github/workflows/release.yml`

Expected: `Package extension` の行番号が `Extract release notes` より小さいこと。

- [ ] **Step 4: コミット**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish to Marketplace and Open VSX on tag push"
```

**このワークフローは実際にタグを push するまで検証できない。** 最初の本番実行は最初のリリース（1.7.0）になる。Secrets 未登録の状態でタグを push すると publish ステップで失敗するが、テストとパッケージングは成功しているため、Secrets を登録してからワークフローを再実行すれば復旧できる。

---

### Task 6: リリース手順書

**Files:**
- Create: `RELEASE.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1〜5 のすべて
- Produces: なし（最終タスク）

- [ ] **Step 1: RELEASE.md を書く**

Create `RELEASE.md`:

````markdown
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

タグ push 後は GitHub Actions の `Release` ワークフローが以下を実行する。

1. タグ名と `package.json` のバージョン一致を検証
2. テスト
3. `.vsix` のパッケージング
4. VS Code Marketplace へ publish
5. Open VSX へ publish
6. GitHub Release を作成し、`.vsix` を添付、`CHANGELOG.md` の該当セクションを本文に転記

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

ワークフロー全体の再実行はできない（Marketplace 側が「同一バージョンは公開済み」で失敗するため）。Open VSX だけをローカルから手動で公開する。

```bash
npm run package:vsix
npx ovsx publish gitsouji-1.7.0.vsix -p <OVSX_PAT>
```

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
````

- [ ] **Step 2: CLAUDE.md にリリース手順への参照を追加**

`CLAUDE.md` の `## Documentation` セクションの一覧に、次の 1 行を `CHANGELOG.md` の行の下に追加する。

```markdown
- **RELEASE.md** - Release procedure (`npm run release <version>` → `git push --follow-tags` → GitHub Actions publishes)
```

- [ ] **Step 3: 手順書のコマンドが実在することを確認**

Run: `node -p "Object.keys(require('./package.json').scripts).filter(s => ['release','package:vsix','test:scripts'].includes(s)).join(',')"`

Expected: `package:vsix,test:scripts,release`（順不同で 3 つすべて）

- [ ] **Step 4: RELEASE.md が .vsix に含まれないことを確認**

Run: `npx vsce ls | grep -c "RELEASE.md\|scripts/\|docs/" || true`

Expected: `0`（`|| true` を付けているのは、`grep -c` がマッチ 0 件のとき終了コード 1 を返すため）

- [ ] **Step 5: 全体のテストを最終確認**

Run: `npm run test:scripts && npm test`

Expected: どちらも PASS。

- [ ] **Step 6: コミット**

```bash
git add RELEASE.md CLAUDE.md
git commit -m "docs: add release procedure"
```

- [ ] **Step 7: push して CI の最終確認**

```bash
git push
```

Run: `gh run list --branch chore/release-automation --limit 3`

Expected: 最新の `CI` ワークフローが `success`。

---

## 完了後の手作業（自動化対象外）

実装完了後、ユーザーが実施する。

1. `RELEASE.md` の「初回セットアップ」に従って `VSCE_PAT` と `OVSX_PAT` を GitHub Secrets に登録する
2. `chore/release-automation` ブランチを master にマージする
3. 最初のリリース（1.7.0）を `npm run release 1.7.0` で実行し、`release.yml` が実際に動作することを確認する
