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
