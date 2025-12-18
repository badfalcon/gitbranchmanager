import * as vscode from 'vscode';

import { runGit } from './git/gitRunner';

// =====================
// Types
// =====================

export type BranchKind = 'local' | 'remote';

export type BranchRow = {
  /** e.g. refs/heads/feature/x or refs/remotes/origin/main */
  fullRef: string;
  /** e.g. feature/x or origin/main */
  short: string;
  kind: BranchKind;
  isCurrent?: boolean;
  /** e.g. origin/main */
  upstream?: string;
  ahead?: number;
  behind?: number;
  protected?: boolean;
};

export type RepoContext = {
  repoRoot: string;
};

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openLogTerminal'; ref: string }
  | { type: 'checkout'; name: string }
  | { type: 'create' }
  | { type: 'rename'; oldName: string }
  | { type: 'deleteLocal'; name: string }
  | { type: 'mergeIntoCurrent'; source: string }
  | { type: 'deleteRemote'; remote: string; name: string }
  | { type: 'detectDead' };

// =====================
// Config
// =====================

export type ExtensionConfig = {
  baseBranch: string;
  protected: string[];
  confirmBeforeDelete: boolean;
  forceDeleteLocal: boolean;
  includeRemoteInDeadCleanup: boolean;
};

export function getCfg(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('gitBranchManager');
  return {
    baseBranch: cfg.get<string>('baseBranch', 'auto'),
    protected: cfg.get<string[]>('protectedBranches', ['main', 'master', 'develop']),
    confirmBeforeDelete: cfg.get<boolean>('confirmBeforeDelete', true),
    forceDeleteLocal: cfg.get<boolean>('forceDeleteLocal', false),
    includeRemoteInDeadCleanup: cfg.get<boolean>('includeRemoteInDeadCleanup', false),
  };
}

// =====================
// UI helpers (non-webview)
// =====================

export function simpleBranchNameValidator(input?: string) {
  if (!input) {
    return vscode.l10n.t('Please enter a branch name.');
  }
  if (/\s/.test(input)) {
    return vscode.l10n.t('Whitespace is not allowed.');
  }
  if (/[~^:\\?*\[\]]/.test(input)) {
    return vscode.l10n.t('Contains invalid characters (~ ^ : \\ ? * [ ]).');
  }
  if (input.endsWith('.') || input.endsWith('/')) {
    return vscode.l10n.t("A branch name cannot end with '.' or '/'.");
  }
  if (input.includes('..') || input.includes('//')) {
    return vscode.l10n.t("'..' and consecutive '/' are not allowed.");
  }
  return undefined;
}

export async function confirm(message: string) {
  const yes = vscode.l10n.t('Yes');
  const pick = await vscode.window.showWarningMessage(message, { modal: true }, yes);
  return pick === yes;
}

async function isGitRepository(folderPath: string): Promise<boolean> {
  try {
    await runGit(folderPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export async function pickRepository(): Promise<RepoContext | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  if (folders.length === 1) {
    const repoRoot = folders[0].uri.fsPath;
    if (!(await isGitRepository(repoRoot))) {
      return undefined;
    }
    return { repoRoot };
  }

  const picks = await Promise.all(
    folders.map(async (f) => {
      const repoRoot = f.uri.fsPath;
      const ok = await isGitRepository(repoRoot);
      return {
        label: f.name,
        description: repoRoot,
        repoRoot,
        ok,
      };
    })
  );

  const okPicks = picks.filter((p) => p.ok);
  if (okPicks.length === 0) {
    return undefined;
  }

  const chosen = await vscode.window.showQuickPick(
    okPicks.map((p) => ({ label: p.label, description: p.description, repoRoot: p.repoRoot })),
    { title: vscode.l10n.t('Select a Git repository') }
  );

  if (!chosen) {
    return undefined;
  }
  return { repoRoot: chosen.repoRoot };
}

// =====================
// Pure helpers (testable)
// =====================

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (r) => `\\${r}`);
}

/**
 * Returns true if the given branch name is considered protected.
 * Supports:
 * - exact match: "main"
 * - prefix: "release/*" or "release/" + "*" at end
 * - simple glob with *: "hotfix/*\\/wip"
 */
export function isProtectedBranch(name: string, protectedList: string[]): boolean {
  for (const p of protectedList) {
    if (p.endsWith('*')) {
      const prefix = p.slice(0, -1);
      if (name.startsWith(prefix)) {
        return true;
      }
      continue;
    }

    if (p.includes('*')) {
      const re = new RegExp('^' + p.split('*').map(escapeRegExp).join('.*') + '$');
      if (re.test(name)) {
        return true;
      }
      continue;
    }

    if (name === p) {
      return true;
    }
  }
  return false;
}

export type AheadBehind = { ahead?: number; behind?: number };

/**
 * Parse `%(upstream:trackshort)` output.
 * Examples:
 * - "+1 -2"
 * - "+3"
 * - "-4"
 * - "<>" (diverged but counts omitted)
 */
export function parseTrackShort(track: string | undefined): AheadBehind {
  if (!track) {
    return {};
  }

  const t = track.trim();
  if (!t || t === '<>') {
    return {};
  }

  const res: AheadBehind = {};
  const plus = t.match(/\+(\d+)/);
  const minus = t.match(/-(\d+)/);

  if (plus) {
    res.ahead = Number(plus[1]);
  }
  if (minus) {
    res.behind = Number(minus[1]);
  }

  return res;
}

/**
 * HTML escape for tests / non-webview usage.
 * (Use concat to avoid toolchains that might de-entity literal "&".)
 */
export function escapeHtml(s: unknown): string {
  const AMP = '&' + 'amp;';
  const LT = '&' + 'lt;';
  const GT = '&' + 'gt;';
  const QUOT = '&' + 'quot;';
  const APOS = '&' + '#39;';

  return String(s)
    .replace(/&/g, AMP)
    .replace(/</g, LT)
    .replace(/>/g, GT)
    .replace(/"/g, QUOT)
    .replace(/'/g, APOS);
}

// =====================
// Git queries
// =====================

export async function listLocalBranches(cwd: string): Promise<BranchRow[]> {
  const fmt = '%(refname)\t%(refname:short)\t%(upstream:short)\t%(upstream:trackshort)\t%(HEAD)';
  const { stdout } = await runGit(cwd, ['for-each-ref', '--format', fmt, 'refs/heads']);

  const rows: BranchRow[] = [];
  const cfg = getCfg();

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const [fullRef, short, upstream, track, headMark] = line.split('\t');

    const row: BranchRow = {
      fullRef,
      short,
      kind: 'local',
      protected: isProtectedBranch(short, cfg.protected),
    };

    if (upstream) {
      row.upstream = upstream;
    }
    if (headMark === '*') {
      row.isCurrent = true;
    }

    const ab = parseTrackShort(track);
    if (ab.ahead !== undefined) {
      row.ahead = ab.ahead;
    }
    if (ab.behind !== undefined) {
      row.behind = ab.behind;
    }

    rows.push(row);
  }

  return rows;
}

export async function listRemoteBranches(cwd: string): Promise<BranchRow[]> {
  const fmt = '%(refname)\t%(refname:short)';
  const { stdout } = await runGit(cwd, ['for-each-ref', '--format', fmt, 'refs/remotes']);

  const rows: BranchRow[] = [];
  const cfg = getCfg();

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const [fullRef, short] = line.split('\t');

    // skip HEAD pointers like refs/remotes/origin/HEAD
    if (/\/HEAD$/.test(fullRef)) {
      continue;
    }

    const parts = short.split('/');
    parts.shift();
    const name = parts.join('/');

    rows.push({
      fullRef,
      short,
      kind: 'remote',
      protected: isProtectedBranch(name, cfg.protected),
    });
  }

  return rows;
}

export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const name = stdout.trim();
    if (name === 'HEAD') {
      return undefined;
    }
    return name;
  } catch {
    return undefined;
  }
}

// =====================
// Git actions
// =====================

export async function checkoutBranch(cwd: string, name: string) {
  // If a remote ref like "origin/feature" is passed, create/switch to a local tracking branch.
  // NOTE: local branch names commonly include '/', so we must NOT treat every "a/b" as remote.

  // If local exists, prefer it.
  try {
    await runGit(cwd, ['show-ref', '--verify', `refs/heads/${name}`]);
    await runGit(cwd, ['checkout', name]);
    return;
  } catch {
    // continue
  }

  // If remote exists, create local tracking.
  // We strip the remote prefix when creating local branch.
  try {
    await runGit(cwd, ['show-ref', '--verify', `refs/remotes/${name}`]);
    const localName = name.split('/').slice(1).join('/');
    await runGit(cwd, ['checkout', '-b', localName, '--track', name]);
    return;
  } catch {
    // continue
  }

  await runGit(cwd, ['checkout', name]);
}

export async function createBranch(cwd: string, name: string, base?: string, checkout = true) {
  if (checkout) {
    if (base) {
      await runGit(cwd, ['checkout', '-b', name, base]);
    } else {
      await runGit(cwd, ['checkout', '-b', name]);
    }
  } else {
    if (base) {
      await runGit(cwd, ['branch', name, base]);
    } else {
      await runGit(cwd, ['branch', name]);
    }
  }
}

export async function renameBranch(cwd: string, oldName: string, newName: string) {
  await runGit(cwd, ['branch', '-m', oldName, newName]);
}

export async function deleteLocalBranch(cwd: string, name: string, force = false) {
  await runGit(cwd, ['branch', force ? '-D' : '-d', name]);
}

export async function mergeIntoCurrent(cwd: string, source: string) {
  await runGit(cwd, ['merge', source]);
}

export async function deleteRemoteBranch(cwd: string, remote: string, name: string) {
  await runGit(cwd, ['push', remote, '--delete', name]);
}

// =====================
// Dead branches
// =====================

export async function resolveBaseBranch(cwd: string): Promise<string> {
  const cfg = getCfg();
  if (cfg.baseBranch && cfg.baseBranch !== 'auto') {
    return cfg.baseBranch;
  }

  // Try origin/HEAD
  try {
    const { stdout } = await runGit(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const m = stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (m) {
      return m[1];
    }
  } catch {
    // ignore
  }

  // Fallbacks
  for (const cand of ['main', 'master', 'develop']) {
    try {
      await runGit(cwd, ['show-ref', '--verify', `refs/heads/${cand}`]);
      return cand;
    } catch {
      // ignore
    }
  }

  const cur = await getCurrentBranch(cwd);
  return cur ?? 'main';
}

export async function detectDeadBranches(cwd: string, base: string): Promise<string[]> {
  const { stdout } = await runGit(cwd, ['branch', '--merged', base]);
  const current = await getCurrentBranch(cwd);
  const cfg = getCfg();

  const lines = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const names = lines.map((l) => l.replace(/^\*\s+/, '')).map((n) => n.replace(/^\(no branch\)$/, ''));

  return names.filter((n) => !!n && n !== current && !isProtectedBranch(n, cfg.protected));
}

/**
 * Builds a map from local branch name -> upstream (if set)
 * Used to resolve remote branch name for a local when cleaning up.
 */
export async function getUpstreamMap(cwd: string): Promise<Map<string, string>> {
  const locals = await listLocalBranches(cwd);
  return new Map(locals.flatMap((l) => (l.upstream ? [[l.short, l.upstream]] : [])));
}
