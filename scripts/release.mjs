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
