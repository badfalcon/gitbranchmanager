import * as assert from 'assert';

import { escapeHtml, isProtectedBranch, parseTrackShort, simpleBranchNameValidator } from '../app';

suite('Unit functions', () => {
  // ========================================
  // isProtectedBranch tests
  // ========================================
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

  test('isProtectedBranch: empty list', () => {
    assert.strictEqual(isProtectedBranch('main', []), false);
    assert.strictEqual(isProtectedBranch('anything', []), false);
  });

  test('isProtectedBranch: multiple patterns', () => {
    const list = ['main', 'develop', 'release/*'];
    assert.strictEqual(isProtectedBranch('main', list), true);
    assert.strictEqual(isProtectedBranch('develop', list), true);
    assert.strictEqual(isProtectedBranch('release/v1.0', list), true);
    assert.strictEqual(isProtectedBranch('feature/test', list), false);
  });

  test('isProtectedBranch: case sensitivity', () => {
    assert.strictEqual(isProtectedBranch('Main', ['main']), false);
    assert.strictEqual(isProtectedBranch('MAIN', ['main']), false);
    assert.strictEqual(isProtectedBranch('main', ['Main']), false);
  });

  test('isProtectedBranch: special regex chars in pattern', () => {
    // Dots in pattern should be escaped (not treated as regex "any char")
    assert.strictEqual(isProtectedBranch('feature.test', ['feature.test']), true);
    assert.strictEqual(isProtectedBranch('featureXtest', ['feature.test']), false);
    // Parentheses should be escaped
    assert.strictEqual(isProtectedBranch('fix(core)', ['fix(core)']), true);
    assert.strictEqual(isProtectedBranch('fixXcoreX', ['fix(core)']), false);
  });

  // ========================================
  // parseTrackShort tests
  // ========================================
  test('parseTrackShort', () => {
    assert.deepStrictEqual(parseTrackShort('+1 -2'), { ahead: 1, behind: 2 });
    assert.deepStrictEqual(parseTrackShort('+3'), { ahead: 3 });
    assert.deepStrictEqual(parseTrackShort('-4'), { behind: 4 });
    assert.deepStrictEqual(parseTrackShort('<>'), {});
    assert.deepStrictEqual(parseTrackShort(undefined), {});
  });

  test('parseTrackShort: edge cases', () => {
    assert.deepStrictEqual(parseTrackShort(''), {});
    assert.deepStrictEqual(parseTrackShort('+0 -0'), { ahead: 0, behind: 0 });
    assert.deepStrictEqual(parseTrackShort('+999'), { ahead: 999 });
    assert.deepStrictEqual(parseTrackShort('-999'), { behind: 999 });
  });

  // ========================================
  // escapeHtml tests
  // ========================================
  test('escapeHtml', () => {
    // Avoid putting literal "<" etc. here because some tooling may de-entity it.
    const LT = '&' + 'lt;';
    const GT = '&' + 'gt;';
    const AMP = '&' + 'amp;';
    const QUOT = '&' + 'quot;';
    const APOS = '&' + '#39;';
    assert.strictEqual(escapeHtml('<>&"\''), `${LT}${GT}${AMP}${QUOT}${APOS}`);
  });

  test('escapeHtml: edge cases', () => {
    const LT = '&' + 'lt;';
    const GT = '&' + 'gt;';
    const QUOT = '&' + 'quot;';
    assert.strictEqual(escapeHtml(''), '');
    assert.strictEqual(escapeHtml('hello world'), 'hello world');
    assert.strictEqual(escapeHtml(123), '123');
    // XSS prevention test
    assert.strictEqual(
      escapeHtml('<script>alert("xss")</script>'),
      `${LT}script${GT}alert(${QUOT}xss${QUOT})${LT}/script${GT}`
    );
  });

  // ========================================
  // simpleBranchNameValidator tests
  // ========================================
  test('simpleBranchNameValidator: empty', () => {
    // Empty string should return an error message (truthy)
    assert.ok(simpleBranchNameValidator(''));
  });

  test('simpleBranchNameValidator: whitespace', () => {
    assert.ok(simpleBranchNameValidator('feature branch'));
    assert.ok(simpleBranchNameValidator('feature\tbranch'));
    assert.ok(simpleBranchNameValidator(' feature'));
  });

  test('simpleBranchNameValidator: invalid chars', () => {
    assert.ok(simpleBranchNameValidator('feature~1'));
    assert.ok(simpleBranchNameValidator('feature^2'));
    assert.ok(simpleBranchNameValidator('feature:test'));
    assert.ok(simpleBranchNameValidator('feature?test'));
    assert.ok(simpleBranchNameValidator('feature*test'));
    assert.ok(simpleBranchNameValidator('feature[test]'));
    assert.ok(simpleBranchNameValidator('feature\\test'));
  });

  test('simpleBranchNameValidator: invalid ending', () => {
    assert.ok(simpleBranchNameValidator('feature.'));
    assert.ok(simpleBranchNameValidator('feature/'));
  });

  test('simpleBranchNameValidator: invalid patterns', () => {
    assert.ok(simpleBranchNameValidator('feature..test'));
    assert.ok(simpleBranchNameValidator('feature//test'));
  });

  test('simpleBranchNameValidator: valid names', () => {
    assert.strictEqual(simpleBranchNameValidator('feature/new-feature'), undefined);
    assert.strictEqual(simpleBranchNameValidator('bugfix-123'), undefined);
    assert.strictEqual(simpleBranchNameValidator('release/v1.0.0'), undefined);
    assert.strictEqual(simpleBranchNameValidator('hotfix/issue-456'), undefined);
    assert.strictEqual(simpleBranchNameValidator('my-branch'), undefined);
    assert.strictEqual(simpleBranchNameValidator('feature/nested/path'), undefined);
  });

  test('simpleBranchNameValidator: edge cases', () => {
    // Single character
    assert.strictEqual(simpleBranchNameValidator('a'), undefined);
    assert.strictEqual(simpleBranchNameValidator('1'), undefined);
    // Numbers only
    assert.strictEqual(simpleBranchNameValidator('123'), undefined);
    // Hyphen at start/end (valid in git)
    assert.strictEqual(simpleBranchNameValidator('-feature'), undefined);
    assert.strictEqual(simpleBranchNameValidator('feature-'), undefined);
    // Underscore
    assert.strictEqual(simpleBranchNameValidator('feature_branch'), undefined);
    // Leading dot (not checked by this validator, git may reject)
    assert.strictEqual(simpleBranchNameValidator('.hidden'), undefined);
  });
});
