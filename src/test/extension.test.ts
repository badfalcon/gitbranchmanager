import * as assert from 'assert';

import { escapeHtml, isProtectedBranch, parseTrackShort } from '../app';

suite('Unit functions', () => {
  test('isProtectedBranch: exact', () => {
    assert.strictEqual(isProtectedBranch('main', ['main']), true);
    assert.strictEqual(isProtectedBranch('dev', ['main']), false);
  });

  test('isProtectedBranch: prefix', () => {
    assert.strictEqual(isProtectedBranch('release/1.0', ['release/*']), true);
    assert.strictEqual(isProtectedBranch('feature/x', ['release/*']), false);
  });

  test('isProtectedBranch: glob', () => {
    assert.strictEqual(isProtectedBranch('hotfix/a/wip', ['hotfix/*/wip']), true);
    assert.strictEqual(isProtectedBranch('hotfix/a/done', ['hotfix/*/wip']), false);
  });

  test('parseTrackShort', () => {
    assert.deepStrictEqual(parseTrackShort('+1 -2'), { ahead: 1, behind: 2 });
    assert.deepStrictEqual(parseTrackShort('+3'), { ahead: 3 });
    assert.deepStrictEqual(parseTrackShort('-4'), { behind: 4 });
    assert.deepStrictEqual(parseTrackShort('<>'), {});
    assert.deepStrictEqual(parseTrackShort(undefined), {});
  });

  test('escapeHtml', () => {
    // Avoid putting literal "<" etc. here because some tooling may de-entity it.
    const LT = '&' + 'lt;';
    const GT = '&' + 'gt;';
    const AMP = '&' + 'amp;';
    const QUOT = '&' + 'quot;';
    const APOS = '&' + '#39;';
    assert.strictEqual(escapeHtml('<>&"\''), `${LT}${GT}${AMP}${QUOT}${APOS}`);
  });
});
