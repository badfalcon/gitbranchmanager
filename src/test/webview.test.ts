import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { JSDOM } from 'jsdom';

import type { BranchRow } from '../app';
import { renderWebviewHtml } from '../webview/panel';

/**
 * Tests for the webview's client-side logic, run against the SHIPPED
 * media/branchManager.html in jsdom.
 *
 * The invariant these exist to protect: what the user sees selected must equal
 * what actually gets sent to the extension as `addToQueue`. In a tool that
 * deletes branches, a gap between those two is the most dangerous bug class —
 * and one has already occurred (re-sorting the cleanup preview redrew a
 * partially-checked "select all" as unchecked, so one click to re-check
 * everything silently restored branches the user had deliberately excluded).
 *
 * Deliberately NOT reached into: the inline script's own variables
 * (`selectedKeys`, `previewSelected`, ...). Everything is asserted through the
 * DOM and through the postMessage payloads, so these tests pin user-visible
 * behavior rather than the current implementation.
 *
 * Limits: jsdom does not enforce CSP and does no layout, so CSP violations and
 * rendering/z-index problems still need manual verification.
 */
suite('Webview (jsdom)', () => {
  let rawHtml: string;

  type Posted = { type: string; [key: string]: unknown };

  let dom: JSDOM;
  let win: import('jsdom').DOMWindow;
  let doc: Document;
  let posted: Posted[];

  suiteSetup(() => {
    rawHtml = readFileSync(
      path.resolve(__dirname, '..', '..', 'media', 'branchManager.html'),
      'utf8'
    );
  });

  setup(() => {
    posted = [];
    const html = renderWebviewHtml(rawHtml, 'test-nonce');
    dom = new JSDOM(html, {
      runScripts: 'dangerously',
      // Must be beforeParse: the inline script's first statement is
      // `const vscode = acquireVsCodeApi()`, which runs as the body is parsed.
      beforeParse(window) {
        (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
          postMessage: (msg: Posted) => posted.push(msg),
          getState: () => undefined,
          setState: () => undefined,
        });
      },
    });
    win = dom.window;
    doc = win.document;
  });

  teardown(() => {
    // Closes pending timers (showToast schedules one) so they can't leak
    win.close();
  });

  // ===== helpers =====

  function $(id: string): HTMLElement {
    const el = doc.getElementById(id);
    assert.ok(el, `#${id} not found`);
    return el as HTMLElement;
  }

  function all(selector: string): HTMLElement[] {
    return [...doc.querySelectorAll(selector)] as HTMLElement[];
  }

  function boxes(kind: 'local' | 'remote'): HTMLInputElement[] {
    return all(`input[data-${kind}]`) as unknown as HTMLInputElement[];
  }

  // Looked up by dataset rather than an attribute selector: branch names may
  // contain quotes, which would break a CSS selector string.
  function box(kind: 'local' | 'remote', name: string): HTMLInputElement {
    const el = boxes(kind).find(b => b.dataset[kind] === name);
    assert.ok(el, `checkbox for ${kind} ${name} not found`);
    return el;
  }

  function rowFor(table: 'local' | 'remote', name: string): HTMLElement {
    const row = all(`#${table} tr`).find(
      tr => tr.querySelector('code')?.textContent === name
    );
    assert.ok(row, `row for ${name} not found in #${table}`);
    return row;
  }

  function actionButtons(table: 'local' | 'remote', name: string): HTMLElement[] {
    return [...rowFor(table, name).querySelectorAll('.actions button')] as HTMLElement[];
  }

  function setSearch(query: string): void {
    const input = $('searchInput') as HTMLInputElement;
    input.value = query;
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
  }

  function previewRows(): HTMLInputElement[] {
    return all('#previewTable input[data-branch]') as unknown as HTMLInputElement[];
  }

  function previewBox(name: string): HTMLInputElement {
    const el = previewRows().find(b => b.dataset.branch === name);
    assert.ok(el, `preview checkbox for ${name} not found`);
    return el;
  }

  function sortPreviewByName(): void {
    const th = doc.querySelector('#previewTable th[data-table="preview"][data-sort="name"]');
    assert.ok(th, 'preview name header not found');
    (th as HTMLElement).click();
  }

  function local(short: string, extra: Partial<BranchRow> = {}): BranchRow {
    return { fullRef: `refs/heads/${short}`, short, kind: 'local', ...extra };
  }

  function remote(short: string, extra: Partial<BranchRow> = {}): BranchRow {
    return { fullRef: `refs/remotes/${short}`, short, kind: 'remote', ...extra };
  }

  type State = {
    locals: BranchRow[];
    remotes: BranchRow[];
    repoRoot: string;
    current?: string;
    showStatusBadges?: boolean;
    allowRemoteBranchDeletion?: boolean;
    queued?: { name: string; kind: 'local' | 'remote' }[];
  };

  function sendState(overrides: Partial<State> = {}): void {
    const state: State = {
      locals: [],
      remotes: [],
      repoRoot: '/fake/repo',
      current: 'main',
      showStatusBadges: true,
      allowRemoteBranchDeletion: false,
      queued: [],
      ...overrides,
    };
    // dispatchEvent, not window.postMessage: this delivers synchronously, so
    // the DOM is fully rendered by the time the next line asserts on it.
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'state', state } }));
  }

  /**
   * Objects posted by the inline script are built inside jsdom's realm, so
   * their prototypes differ from this realm's and assert.deepStrictEqual fails
   * on identity even when the contents match. Round-trip through JSON to
   * compare values rather than realms.
   */
  function plain<T>(value: unknown): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  /** The most recently posted message, normalized into this realm. */
  function lastPosted(): Posted {
    const last = posted.at(-1);
    assert.ok(last, 'nothing was posted');
    return plain<Posted>(last);
  }

  /** The items of the most recent addToQueue message. */
  function staged(): { name: string; kind: string; includeRemote?: boolean }[] {
    const last = [...posted].reverse().find(m => m.type === 'addToQueue');
    assert.ok(last, `no addToQueue was sent; posted: ${JSON.stringify(posted)}`);
    return plain(last.items);
  }

  function stagedNames(): string[] {
    return staged().map(i => i.name).sort();
  }

  // ===== smoke =====

  test('the webview boots and announces itself', () => {
    assert.ok(
      posted.some(m => m.type === 'ready'),
      `expected a ready message, got: ${JSON.stringify(posted)}`
    );
  });

  test('a state message renders a row per branch, sorted by name', () => {
    sendState({ locals: [local('main', { isCurrent: true }), local('feat-b'), local('feat-a')] });

    const names = all('#local td code').map(el => el.textContent);
    assert.deepStrictEqual(names, ['feat-a', 'feat-b', 'main']);
  });

  // ===== A. selection must equal what gets staged =====

  suite('selection ↔ staging', () => {
    test('checked branches are the ones sent to the queue', () => {
      sendState({ locals: [local('main', { isCurrent: true }), local('feat-a'), local('feat-b')] });

      box('local', 'feat-a').click();
      $('deleteSelected').click();

      assert.deepStrictEqual(stagedNames(), ['feat-a']);
      assert.strictEqual(staged()[0].kind, 'local');
    });

    test('a selection hidden by the search filter is still staged', () => {
      sendState({ locals: [local('feat-a'), local('other')] });

      box('local', 'feat-a').click();
      setSearch('other'); // feat-a is no longer rendered
      assert.strictEqual(boxes('local').length, 1);

      $('deleteSelected').click();

      // Intentional: the count and staging read the persisted selection, so a
      // filtered-away branch is never silently dropped from the user's intent.
      assert.deepStrictEqual(stagedNames(), ['feat-a']);
    });

    test('the current and protected branches have no checkbox at all', () => {
      sendState({
        locals: [
          local('main', { isCurrent: true, protected: true }),
          local('develop', { protected: true }),
          local('feat-a'),
        ],
      });

      assert.deepStrictEqual(
        boxes('local').map(b => b.dataset.local),
        ['feat-a']
      );
    });

    test('select-all only covers the rows the filter is currently showing', () => {
      sendState({ locals: [local('feat-a'), local('feat-b'), local('other')] });

      setSearch('feat');
      ($('selectAllLocal') as HTMLInputElement).click();
      setSearch(''); // reveal everything again
      $('deleteSelected').click();

      assert.deepStrictEqual(stagedNames(), ['feat-a', 'feat-b']);
    });

    test('select-all reflects partial selection as indeterminate', () => {
      sendState({ locals: [local('feat-a'), local('feat-b')] });
      const selectAll = $('selectAllLocal') as HTMLInputElement;

      assert.strictEqual(selectAll.checked, false);
      assert.strictEqual(selectAll.indeterminate, false);

      box('local', 'feat-a').click();
      assert.strictEqual(selectAll.indeterminate, true, 'one of two selected');

      box('local', 'feat-b').click();
      assert.strictEqual(selectAll.checked, true, 'both selected');
      assert.strictEqual(selectAll.indeterminate, false);
    });
  });

  // ===== B. cleanup preview =====

  suite('cleanup preview', () => {
    const cleanupState = {
      locals: [
        local('main', { isCurrent: true, protected: true }),
        local('feat-a', { isMerged: true }),
        local('feat-b', { isMerged: true }),
        local('feat-c', { isMerged: true }),
        local('stale-1', { isStale: true }),
        local('gone-1', { isGone: true }),
      ],
    };

    test('re-sorting keeps a partially-checked select-all visibly partial', () => {
      // Regression: `indeterminate` is a JS property, so the generated markup
      // can only ever render checked/unchecked. Re-sorting rebuilds the header,
      // and without restoring the tri-state it redrew as plain unchecked.
      sendState(cleanupState);
      $('cleanupMerged').click();

      previewBox('feat-b').click();
      assert.strictEqual(($('selectAll') as HTMLInputElement).indeterminate, true);

      sortPreviewByName();

      assert.strictEqual(
        ($('selectAll') as HTMLInputElement).indeterminate,
        true,
        'select-all must still show a partial selection after a re-sort'
      );
      assert.strictEqual(($('selectAll') as HTMLInputElement).checked, false);
    });

    test('a deselected branch stays deselected across a re-sort', () => {
      // Separate invariant from the tri-state one above: the underlying
      // selection set survives a rebuild. Verified to pass even with the
      // tri-state fix removed, so it is not a regression test for that bug —
      // it guards the persistence the display bug sat on top of.
      sendState(cleanupState);
      $('cleanupMerged').click();

      previewBox('feat-b').click(); // explicitly keep feat-b
      sortPreviewByName();
      $('previewExecute').click();

      assert.deepStrictEqual(stagedNames(), ['feat-a', 'feat-c']);
    });

    test('candidates exclude protected and current branches', () => {
      sendState({
        locals: [
          local('main', { isCurrent: true, protected: true, isMerged: true }),
          local('develop', { protected: true, isMerged: true }),
          local('feat-a', { isMerged: true }),
        ],
      });
      $('cleanupMerged').click();

      assert.deepStrictEqual(
        previewRows().map(b => b.dataset.branch),
        ['feat-a']
      );
    });

    test('each cleanup filter selects its own candidates', () => {
      sendState(cleanupState);

      $('cleanupStale').click();
      assert.deepStrictEqual(previewRows().map(b => b.dataset.branch), ['stale-1']);
      $('previewCancel').click();

      $('cleanupGone').click();
      assert.deepStrictEqual(previewRows().map(b => b.dataset.branch), ['gone-1']);
      $('previewCancel').click();

      $('cleanupAll').click();
      assert.deepStrictEqual(
        previewRows().map(b => b.dataset.branch).sort(),
        ['feat-a', 'feat-b', 'feat-c', 'gone-1', 'stale-1']
      );
    });

    test('"also delete remote" is hidden and cleared when remote deletion is off', () => {
      // Regression: the checkbox is never reset between openings, so a tick left
      // from an earlier session must not survive into a run that cannot honor it.
      sendState({ ...cleanupState, allowRemoteBranchDeletion: true });
      $('cleanupMerged').click();
      const includeRemote = $('includeRemote') as HTMLInputElement;
      includeRemote.click();
      assert.strictEqual(includeRemote.checked, true);
      $('previewCancel').click();

      sendState({ ...cleanupState, allowRemoteBranchDeletion: false });
      $('cleanupMerged').click();

      assert.strictEqual(includeRemote.checked, false, 'stale tick must be cleared');
      assert.strictEqual(includeRemote.parentElement?.style.display, 'none');
    });

    test('"also delete remote" tags every staged item when enabled', () => {
      sendState({ ...cleanupState, allowRemoteBranchDeletion: true });
      $('cleanupMerged').click();
      ($('includeRemote') as HTMLInputElement).click();
      $('previewExecute').click();

      assert.ok(staged().length > 0);
      assert.ok(
        staged().every(i => i.includeRemote === true),
        `expected includeRemote on every item: ${JSON.stringify(staged())}`
      );
    });
  });

  // ===== C. remote deletion disabled =====

  suite('remote deletion disabled', () => {
    const remoteState = {
      locals: [local('main', { isCurrent: true, protected: true })],
      remotes: [remote('origin/feat-a'), remote('origin/feat-b')],
    };

    test('remote rows get no checkboxes', () => {
      sendState({ ...remoteState, allowRemoteBranchDeletion: false });
      assert.deepStrictEqual(boxes('remote'), []);
    });

    test('remote rows get no Delete Remote button', () => {
      sendState({ ...remoteState, allowRemoteBranchDeletion: false });
      // Checkout + Log only; the delete action must not be rendered
      assert.strictEqual(actionButtons('remote', 'feat-a').length, 2);

      sendState({ ...remoteState, allowRemoteBranchDeletion: true });
      assert.strictEqual(actionButtons('remote', 'feat-a').length, 3);
    });

    test('the remote cleanup toolbar is hidden', () => {
      sendState({ ...remoteState, allowRemoteBranchDeletion: false });
      assert.strictEqual($('remoteCleanupToolbar').style.display, 'none');

      sendState({ ...remoteState, allowRemoteBranchDeletion: true });
      assert.notStrictEqual($('remoteCleanupToolbar').style.display, 'none');
    });
  });

  // ===== D. filtering and sorting =====

  suite('filter and sort', () => {
    test('case sensitivity and regex toggles apply', () => {
      sendState({ locals: [local('Feat-A'), local('feat-b')] });

      setSearch('feat');
      assert.strictEqual(all('#local td code').length, 2, 'case-insensitive by default');

      ($('caseCheckbox') as HTMLInputElement).click();
      assert.deepStrictEqual(all('#local td code').map(e => e.textContent), ['feat-b']);

      ($('caseCheckbox') as HTMLInputElement).click();
      ($('regexCheckbox') as HTMLInputElement).click();
      setSearch('^feat-b$');
      assert.deepStrictEqual(all('#local td code').map(e => e.textContent), ['feat-b']);
    });

    test('an invalid regex flags the input and leaves the rows alone', () => {
      sendState({ locals: [local('feat-a'), local('other')] });
      ($('regexCheckbox') as HTMLInputElement).click();

      setSearch('feat');
      assert.deepStrictEqual(all('#local td code').map(e => e.textContent), ['feat-a']);

      setSearch('[');

      assert.ok($('searchInput').classList.contains('error'), 'input should be flagged');
      // Must not re-render: showing the wrong rows here could mislead a deletion
      assert.deepStrictEqual(all('#local td code').map(e => e.textContent), ['feat-a']);
    });

    test('remote filtering and sorting ignore the remote prefix', () => {
      sendState({
        remotes: [remote('origin/zebra'), remote('origin/apple')],
        allowRemoteBranchDeletion: true,
      });

      // Sorted by branch name, not by the "origin/..." short ref
      assert.deepStrictEqual(all('#remote td code').map(e => e.textContent), ['apple', 'zebra']);

      setSearch('apple');
      assert.deepStrictEqual(all('#remote td code').map(e => e.textContent), ['apple']);

      // "origin" matches the prefix only, which is not part of the searched name
      setSearch('origin');
      assert.deepStrictEqual(all('#remote td code').map(e => e.textContent), []);
    });
  });

  // ===== E. escaping =====

  suite('escaping', () => {
    // Space-free so it is a name git would actually accept
    const HOSTILE = '"><img/src=x/onerror=alert(1)>';

    test('a hostile branch name renders as text, not as markup', () => {
      sendState({ locals: [local(HOSTILE)] });

      assert.strictEqual(doc.querySelector('#local img'), null, 'no element may be created');
      const code = all('#local td code').map(e => e.textContent);
      assert.deepStrictEqual(code, [HOSTILE]);
    });

    test('a hostile branch name round-trips through the checkbox and stages exactly', () => {
      sendState({ locals: [local(HOSTILE)] });

      box('local', HOSTILE).click();
      $('deleteSelected').click();

      assert.deepStrictEqual(stagedNames(), [HOSTILE]);
    });
  });

  // ===== F. row actions =====

  suite('row actions', () => {
    test('local row buttons post the right message', () => {
      sendState({ locals: [local('main', { isCurrent: true }), local('feat-a')] });
      const [checkout, log, rename, del, merge] = actionButtons('local', 'feat-a');

      checkout.click();
      assert.deepStrictEqual(lastPosted(), { type: 'checkout', name: 'feat-a' });
      log.click();
      assert.deepStrictEqual(lastPosted(), { type: 'openLogTerminal', ref: 'feat-a' });
      rename.click();
      assert.deepStrictEqual(lastPosted(), { type: 'rename', oldName: 'feat-a' });
      del.click();
      assert.deepStrictEqual(lastPosted(), { type: 'deleteLocal', name: 'feat-a' });
      merge.click();
      assert.deepStrictEqual(lastPosted(), { type: 'mergeIntoCurrent', source: 'feat-a' });
    });

    test('the current branch offers no merge-into-itself action', () => {
      sendState({ locals: [local('main', { isCurrent: true })] });
      // checkout, log, rename, delete — but no merge
      assert.strictEqual(actionButtons('local', 'main').length, 4);
    });

    test('a protected branch offers no rename, delete or merge', () => {
      sendState({ locals: [local('main', { isCurrent: true, protected: true })] });
      assert.strictEqual(actionButtons('local', 'main').length, 2);
    });

    test('remote delete posts the remote and branch name separately', () => {
      sendState({
        remotes: [remote('origin/feat/nested')],
        allowRemoteBranchDeletion: true,
      });
      const buttons = actionButtons('remote', 'feat/nested');

      buttons[2].click();
      assert.deepStrictEqual(lastPosted(), {
        type: 'deleteRemote',
        remote: 'origin',
        name: 'feat/nested',
      });
    });
  });
});
