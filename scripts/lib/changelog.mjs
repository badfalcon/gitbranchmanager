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
