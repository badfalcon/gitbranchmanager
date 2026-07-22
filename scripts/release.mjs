#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

import { extractSection, finalizeChangelog, unreleasedBody } from './lib/changelog.mjs';

// 検証用に上書きできる。通常のリリースでは常に master から切る。
const RELEASE_BRANCH = process.env.RELEASE_BRANCH ?? 'master';

function fail(message) {
	console.error(`release: ${message}`);
	process.exit(1);
}

function git(...args) {
	try {
		// stdio is fully piped (not inherited) so a failure's stderr is only ever shown once,
		// folded into the release: message below — Node forwards it live to the terminal too
		// if stdio is left at its execFileSync default, which would duplicate it.
		return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (err) {
		const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
		throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
	}
}

function run(command, args) {
	try {
		execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
	} catch {
		// stderr was already inherited straight to the terminal; re-printing it would duplicate it.
		throw new Error(`${command} ${args.join(' ')} failed`);
	}
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

// Tracks how far the mutation sequence (npm version -> changelog write -> commit -> tag) got,
// so a failure partway through can tell the user exactly how to get back to a clean state.
let mutationStage = 'none';

try {
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

	if (dryRun) {
		// Read back from the finalized text rather than from the [Unreleased] body, so this shows
		// what the release really produced — the same text the Marketplace changelog tab and the
		// GitHub release body will carry. Printed before the tests so a wrong changelog can be
		// caught without waiting several minutes for them.
		console.log(`
--- CHANGELOG (this release) ---
# [${version}] - ${date}

${extractSection(nextChangelog, version)}
--------------------------------
`);
	}

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
	mutationStage = 'files-modified';
	await writeFile('CHANGELOG.md', nextChangelog);

	git('commit', '-am', `chore(release): ${version}`);
	mutationStage = 'committed';
	git('tag', '-a', tag, '-m', `Release ${version}`);
} catch (err) {
	if (mutationStage === 'committed') {
		fail(`${err.message} — a commit was created but the tag was not; to get back to a clean state, run: git reset --hard HEAD~1`);
	}
	if (mutationStage === 'files-modified') {
		fail(`${err.message} — package.json/package-lock.json/CHANGELOG.md were modified but not committed; to get back to a clean state, run: git checkout -- .`);
	}
	fail(err.message);
}

console.log(`
release: created commit and tag ${tag}

  review:  git show ${tag}
  publish: git push --follow-tags
  undo:    git tag -d ${tag} && git reset --hard HEAD~1
`);
