import * as vscode from 'vscode';

import { GitError, runGit } from './git/gitRunner';

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

  // Cleanup status indicators
  /** Branch is merged into base branch (safe `git branch -d` cleanup candidate) */
  isMerged?: boolean;
  /**
   * Branch was merged into a non-base parent branch via a merge commit, but has
   * not reached the base branch. Display-only: it earns a "merged" badge but is
   * intentionally excluded from cleanup candidates, since `git branch -d` would
   * reject it.
   */
  isMergedIntoParent?: boolean;
  /** Last commit older than staleDays threshold */
  isStale?: boolean;
  /** Upstream no longer exists (shows [gone]) */
  isGone?: boolean;
  /** ISO date string of last commit */
  lastCommitDate?: string;
  /** Calculated age in days for UI display */
  lastCommitAgeInDays?: number;
  /** Author name of the last commit (%(authorname)) */
  lastCommitAuthor?: string;
};

export type RepoContext = {
  repoRoot: string;
};

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openLogTerminal'; ref: string }
  | { type: 'openSettings' }
  | { type: 'checkout'; name: string }
  | { type: 'create' }
  | { type: 'rename'; oldName: string }
  | { type: 'deleteLocal'; name: string }
  | { type: 'mergeIntoCurrent'; source: string }
  | { type: 'deleteRemote'; remote: string; name: string }
  // Deletion queue: webview stages branches; extension handles storage + execution
  | { type: 'addToQueue'; items: { name: string; kind: 'local' | 'remote'; includeRemote?: boolean }[] };

export type DeletionQueueItem = {
  name: string;
  kind: 'local' | 'remote';
  /** For local items: also delete the corresponding remote branch */
  includeRemote?: boolean;
  status: 'pending' | 'deleting' | 'deleted' | 'failed';
  error?: string;
  /** Machine-readable failure cause, resolved when status becomes 'failed' */
  errorCause?: DeletionErrorCause;
};

// =====================
// Config
// =====================

export type ExtensionConfig = {
  baseBranch: string;
  protected: string[];
  confirmBeforeDelete: boolean;
  forceDeleteLocal: boolean;
  includeRemoteInDeadCleanup: boolean;
  // New cleanup settings
  staleDays: number;
  autoFetchPrune: boolean;
  detectParentMerges: boolean;
  showStatusBadges: boolean;
  allowRemoteBranchDeletion: boolean;
};

export function getCfg(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('gitSouji');

  // settings.json can be hand-edited past the package.json schema, so guard the
  // values the rest of the code trusts: a non-array protected list would crash
  // isProtectedBranch's for..of, and a 0/negative/NaN staleDays would mark every
  // branch stale.
  const protectedRaw = cfg.get<unknown>('protectedBranches', ['main', 'master', 'develop']);
  const protectedList = Array.isArray(protectedRaw)
    ? protectedRaw.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : ['main', 'master', 'develop'];

  const staleDaysRaw = cfg.get<number>('staleDays', 30);
  const staleDays = Number.isFinite(staleDaysRaw) ? Math.max(1, Math.floor(staleDaysRaw)) : 30;

  return {
    baseBranch: cfg.get<string>('baseBranch', 'auto'),
    protected: protectedList,
    confirmBeforeDelete: cfg.get<boolean>('confirmBeforeDelete', true),
    forceDeleteLocal: cfg.get<boolean>('forceDeleteLocal', false),
    includeRemoteInDeadCleanup: cfg.get<boolean>('includeRemoteInDeadCleanup', false),
    // New cleanup settings
    staleDays,
    autoFetchPrune: cfg.get<boolean>('autoFetchPrune', false),
    detectParentMerges: cfg.get<boolean>('detectParentMerges', true),
    showStatusBadges: cfg.get<boolean>('showStatusBadges', true),
    allowRemoteBranchDeletion: cfg.get<boolean>('allowRemoteBranchDeletion', false),
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
  if (input.startsWith('-')) {
    // A leading '-' would be parsed as a git option (e.g. "-D", "--track").
    return vscode.l10n.t("A branch name cannot start with '-'.");
  }
  if (input.endsWith('.') || input.endsWith('/')) {
    return vscode.l10n.t("A branch name cannot end with '.' or '/'.");
  }
  if (input.includes('..') || input.includes('//')) {
    return vscode.l10n.t("'..' and consecutive '/' are not allowed.");
  }
  if (input.includes('@{')) {
    return vscode.l10n.t("'@{' is not allowed in branch names.");
  }
  return undefined;
}

export async function confirm(message: string) {
  const yes = vscode.l10n.t('Yes');
  const pick = await vscode.window.showWarningMessage(message, { modal: true }, yes);
  return pick === yes;
}

export async function isGitRepository(folderPath: string): Promise<boolean> {
  try {
    await runGit(folderPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/** True if the `git` binary is available on PATH. Used to distinguish
 * "no repository" from "git not installed" when surfacing errors. */
export async function isGitInstalled(): Promise<boolean> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  try {
    await runGit(cwd, ['--version']);
    return true;
  } catch (err) {
    // ENOENT means the binary is missing; any other failure implies git ran.
    return !(err instanceof GitError && err.code === 'ENOENT');
  }
}

type WorkspaceRepo = { label: string; repoRoot: string };

async function listWorkspaceRepos(): Promise<WorkspaceRepo[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  const picks = await Promise.all(
    folders.map(async (f) => ({
      label: f.name,
      repoRoot: f.uri.fsPath,
      ok: await isGitRepository(f.uri.fsPath),
    }))
  );
  return picks.filter((p) => p.ok).map(({ label, repoRoot }) => ({ label, repoRoot }));
}

export async function pickRepository(
  options?: { forcePrompt?: boolean }
): Promise<RepoContext | undefined> {
  const repos = await listWorkspaceRepos();
  if (repos.length === 0) {
    return undefined;
  }
  if (repos.length === 1 && !options?.forcePrompt) {
    return { repoRoot: repos[0].repoRoot };
  }
  const chosen = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: r.label, description: r.repoRoot, repoRoot: r.repoRoot })),
    { title: vscode.l10n.t('Select a Git repository') }
  );
  return chosen ? { repoRoot: chosen.repoRoot } : undefined;
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
    // Any `*` (leading, trailing, interior, or multiple) is treated as a glob
    // wildcard. A lone trailing `*` reduces to a prefix match via `.*$`.
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

/** Machine-readable cause of a failed branch deletion. */
export type DeletionErrorCause =
  // Coarse "checked out somewhere" — the git message alone cannot tell the
  // current branch apart from another worktree; resolveDeletionCause refines it.
  | 'unmerged'
  | 'checkedOut'
  | 'checkedOutCurrent'
  | 'checkedOutWorktree'
  | 'refLocked'
  | 'remoteGone'
  | 'remoteRejected'
  | 'networkUnreachable'
  | 'authOrPermission'
  | 'notFound';

/**
 * GitError messages are shaped `git <args> failed: Command failed: git <args>
 * <stderr>` (our wrapper plus Node's execFile message), so the branch name
 * appears in the text before the actual stderr. Strip both command echoes so
 * a name like "fix/not-fully-merged-thing" can't graze substring patterns.
 */
function stripGitCommandPrefix(message: string): string {
  return message
    .replace(/^git .*? failed: /s, '')
    .replace(/^Command failed: git [^\n]*\n?/, '');
}

/**
 * Map a raw git branch-deletion error to a machine-readable cause.
 * Returns undefined when the message matches no known pattern.
 * Never returns 'checkedOutCurrent'/'checkedOutWorktree' — only the coarse
 * 'checkedOut'; use resolveDeletionCause to refine those.
 */
export function classifyDeletionCause(
  message: string | undefined
): DeletionErrorCause | undefined {
  if (!message) {
    return undefined;
  }
  const m = stripGitCommandPrefix(message).toLowerCase();

  if (m.includes('not fully merged')) {
    return 'unmerged';
  }
  if (
    m.includes('checked out') ||
    m.includes('used by worktree') ||
    (m.includes('cannot delete') && m.includes('currently'))
  ) {
    return 'checkedOut';
  }
  if (
    m.includes('cannot lock ref') ||
    m.includes('unable to lock ref') ||
    (m.includes('unable to create') && m.includes('.lock'))
  ) {
    return 'refLocked';
  }
  if (
    m.includes('remote ref does not exist') ||
    (m.includes('unable to delete') && m.includes('remote'))
  ) {
    return 'remoteGone';
  }
  if (
    m.includes('remote rejected') ||
    m.includes('pre-receive hook declined') ||
    m.includes('protected branch')
  ) {
    return 'remoteRejected';
  }
  // Network patterns must be checked before authOrPermission: SSH failures
  // often contain both a specific network line and the generic "could not
  // read from remote repository" wrapper.
  if (
    m.includes('could not resolve host') ||
    m.includes('could not resolve hostname') ||
    m.includes('timed out') ||
    m.includes('could not connect to server') ||
    m.includes('network is unreachable') ||
    m.includes('failed to connect')
  ) {
    return 'networkUnreachable';
  }
  if (
    m.includes('authentication failed') ||
    m.includes('could not read from remote') ||
    m.includes('permission denied') ||
    m.includes('access denied') ||
    // Hosting services answer unauthorized access to private repos with
    // "repository not found" — a repo-level 404 is almost always credentials.
    (m.includes('repository') && m.includes('not found'))
  ) {
    return 'authOrPermission';
  }
  if (m.includes('not found') || m.includes("couldn't find remote ref")) {
    return 'notFound';
  }
  return undefined;
}

/** Human-friendly, localized message for a deletion-failure cause. */
export function deletionCauseMessage(cause: DeletionErrorCause): string {
  switch (cause) {
    case 'unmerged':
      return vscode.l10n.t('Not fully merged — enable force delete (-D) to remove it.');
    case 'checkedOut':
    case 'checkedOutWorktree':
      return vscode.l10n.t('This branch is checked out and cannot be deleted.');
    case 'checkedOutCurrent':
      return vscode.l10n.t('This is the current branch — switch away before deleting it.');
    case 'refLocked':
      return vscode.l10n.t(
        'Another Git process is holding a lock on this ref. Try again in a moment.'
      );
    case 'remoteGone':
      return vscode.l10n.t('The remote branch no longer exists.');
    case 'remoteRejected':
      return vscode.l10n.t('The remote rejected the deletion (protected branch or server hook).');
    case 'networkUnreachable':
      return vscode.l10n.t('Could not connect to the remote — check your network connection.');
    case 'authOrPermission':
      return vscode.l10n.t('Could not reach the remote (authentication or permission error).');
    case 'notFound':
      return vscode.l10n.t('Branch not found.');
  }
}

/**
 * Map a raw git branch-deletion error to a concise, human-friendly reason.
 * Returns undefined when the message matches no known pattern, in which case
 * the caller should fall back to showing the raw error.
 * Kept as a backward-compatible wrapper; prefer classifyDeletionCause +
 * deletionCauseMessage for cause-aware handling.
 */
export function classifyDeletionError(message: string | undefined): string | undefined {
  const cause = classifyDeletionCause(message);
  return cause ? deletionCauseMessage(cause) : undefined;
}

/**
 * Classify a deletion failure, refining the ambiguous 'checkedOut' cause into
 * 'checkedOutCurrent' vs 'checkedOutWorktree' by asking git for the current
 * branch (one extra `git rev-parse`, only when needed). Notes:
 * - Detached HEAD makes getCurrentBranch return undefined, so a checked-out
 *   failure conservatively resolves to 'checkedOutWorktree' (there is no
 *   "current branch" to offer switching away from).
 * - cwd is the opened folder (which may itself be a linked worktree), so the
 *   comparison correctly means "checked out in THIS worktree".
 * - An out-of-band checkout between the failed delete and the rev-parse could
 *   skew the result; that tiny staleness window is acceptable.
 */
export async function resolveDeletionCause(
  cwd: string,
  branchName: string,
  message: string | undefined
): Promise<DeletionErrorCause | undefined> {
  const coarse = classifyDeletionCause(message);
  if (coarse !== 'checkedOut') {
    return coarse;
  }
  const current = await getCurrentBranch(cwd);
  return current === branchName ? 'checkedOutCurrent' : 'checkedOutWorktree';
}

/**
 * Split a remote ref short name (e.g. "origin/feature" or "origin/feat/x")
 * into its remote and branch-name parts. Returns undefined when either part
 * is empty (e.g. "origin", "feature", "origin/").
 */
export function splitRemoteRef(ref: string): { remote: string; name: string } | undefined {
  const parts = ref.split('/');
  const remote = parts.shift();
  const name = parts.join('/');
  if (!remote || !name) {
    return undefined;
  }
  return { remote, name };
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
    // If a local branch with the stripped name already exists, switch to it
    // rather than failing with "a branch named '<x>' already exists".
    try {
      await runGit(cwd, ['show-ref', '--verify', `refs/heads/${localName}`]);
      await runGit(cwd, ['checkout', localName]);
    } catch {
      await runGit(cwd, ['checkout', '-b', localName, '--track', name]);
    }
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
  // `--` guards against a branch name that begins with '-' being read as an option.
  await runGit(cwd, ['branch', '-m', '--', oldName, newName]);
}

export async function deleteLocalBranch(cwd: string, name: string, force = false) {
  await runGit(cwd, ['branch', force ? '-D' : '-d', '--', name]);
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
  let stdout: string;
  try {
    ({ stdout } = await runGit(cwd, ['branch', '--merged', base]));
  } catch {
    // Base may not resolve to a real commit yet (fresh repo / unborn HEAD),
    // in which case there are simply no merged candidates. Degrade gracefully
    // so a brand-new repository shows an empty list instead of an error.
    return [];
  }
  const current = await getCurrentBranch(cwd);
  const cfg = getCfg();

  const lines = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const names = lines
    // `+` marks a branch checked out in another worktree; `*` the current one.
    .map((l) => l.replace(/^[*+]\s+/, ''))
    // Drop "(no branch)" / "(HEAD detached at ...)" entries.
    .filter((n) => !!n && !n.startsWith('('));

  return names.filter((n) => n !== current && n !== base && !isProtectedBranch(n, cfg.protected));
}

/**
 * Builds a map from local branch name -> upstream (if set)
 * Used to resolve remote branch name for a local when cleaning up.
 */
export async function getUpstreamMap(cwd: string): Promise<Map<string, string>> {
  const locals = await listLocalBranches(cwd);
  return new Map(locals.flatMap((l) => (l.upstream ? [[l.short, l.upstream]] : [])));
}

// =====================
// New Cleanup Detection Functions
// =====================

/**
 * Get last commit date for each local branch.
 * Returns Map of branch name -> { date: ISO string, ageInDays: number }
 */
export async function getBranchLastCommitDates(
  cwd: string
): Promise<Map<string, { date: string; ageInDays: number; author?: string }>> {
  const fmt = '%(refname:short)\t%(committerdate:iso-strict)\t%(authorname)';
  const { stdout } = await runGit(cwd, ['for-each-ref', '--format', fmt, 'refs/heads']);

  const now = Date.now();
  const result = new Map<string, { date: string; ageInDays: number; author?: string }>();

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const [name, dateStr, author] = line.split('\t');
    if (name && dateStr) {
      const commitDate = new Date(dateStr);
      const ageInDays = Math.floor((now - commitDate.getTime()) / (1000 * 60 * 60 * 24));
      result.set(name, { date: dateStr, ageInDays, author: author || undefined });
    }
  }

  return result;
}

/**
 * Detect stale branches (last commit older than staleDays threshold).
 */
export async function detectStaleBranches(cwd: string, staleDays: number): Promise<string[]> {
  const dates = await getBranchLastCommitDates(cwd);
  const current = await getCurrentBranch(cwd);
  const cfg = getCfg();

  const stale: string[] = [];
  for (const [name, { ageInDays }] of dates) {
    if (ageInDays >= staleDays && name !== current && !isProtectedBranch(name, cfg.protected)) {
      stale.push(name);
    }
  }

  return stale;
}

/**
 * Detect gone branches (local tracking branches whose upstream no longer exists).
 * Parses `git branch -vv` output looking for [origin/xxx: gone] pattern.
 */
export async function detectGoneBranches(cwd: string): Promise<string[]> {
  const { stdout } = await runGit(cwd, ['branch', '-vv']);
  const current = await getCurrentBranch(cwd);
  const cfg = getCfg();

  const gone: string[] = [];
  // Match patterns like: "  branch-name abc1234 [origin/branch-name: gone] commit message"
  // Leading marker may be `*` (current) or `+` (checked out in another worktree).
  const goneRegex = /^[*+]?\s+(\S+)\s+\S+\s+\[[^\]]+:\s*gone\]/;

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(goneRegex);
    if (match) {
      const name = match[1];
      if (name !== current && !isProtectedBranch(name, cfg.protected)) {
        gone.push(name);
      }
    }
  }

  return gone;
}

/**
 * Map local branch name -> tip commit SHA.
 */
async function getLocalBranchTips(cwd: string): Promise<Map<string, string>> {
  const { stdout } = await runGit(cwd, [
    'for-each-ref',
    '--format',
    '%(refname:short)\t%(objectname)',
    'refs/heads',
  ]);

  const map = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const [short, sha] = line.split('\t');
    if (short && sha) {
      map.set(short, sha);
    }
  }
  return map;
}

/**
 * Collect commit SHAs that were merged INTO another line of history: the
 * 2nd-or-later parents of every merge commit reachable from any local or
 * remote-tracking branch.
 *
 * Being a merge-in parent is what distinguishes "this branch was merged into a
 * parent" from "this branch merely has descendants" (a branch forked off it):
 * a forked branch's tip is only ever a first-parent ancestor, never a merge-in
 * parent, so it is not collected here — which avoids falsely flagging the parent
 * branch (e.g. feature-a) as merged just because feature-b branched from it.
 *
 * Degrades gracefully (empty set) if the history walk fails, e.g. the output
 * exceeds runGit's buffer in a very large repo.
 */
async function getMergeParentCommits(cwd: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    // %P prints all parent SHAs space-separated: "<first-parent> <merged-in...>".
    const { stdout } = await runGit(cwd, [
      'log',
      '--branches',
      '--remotes',
      '--merges',
      '--pretty=tformat:%P',
    ]);

    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      const parents = line.trim().split(/\s+/);
      // Skip parents[0] (the branch merged into); the rest were merged in.
      for (let i = 1; i < parents.length; i++) {
        set.add(parents[i]);
      }
    }
  } catch {
    // ignore: parent-merge detection simply unavailable for this repo
  }
  return set;
}

/**
 * Detect local branches that were merged into a parent branch via a merge commit,
 * even one that has not yet reached the base branch (e.g. a stacked feature-b
 * merged back into feature-a).
 *
 * A branch counts only when its tip commit is a merge-in parent (see
 * getMergeParentCommits), so branches that merely have descendants are not
 * flagged — Git cannot otherwise tell "merged into" apart from "branched off".
 *
 * Note: fast-forward and squash merges leave no merge commit and are not detected
 * here; merges into the base branch remain covered by detectDeadBranches.
 */
export async function detectMergedIntoOtherBranches(cwd: string): Promise<string[]> {
  const cfg = getCfg();
  const [tips, mergeParents, current] = await Promise.all([
    getLocalBranchTips(cwd),
    getMergeParentCommits(cwd),
    getCurrentBranch(cwd),
  ]);

  const merged: string[] = [];
  for (const [short, sha] of tips) {
    if (short === current || isProtectedBranch(short, cfg.protected)) {
      continue;
    }
    if (mergeParents.has(sha)) {
      merged.push(short);
    }
  }
  return merged;
}

/**
 * Get Set of branches merged into the base branch (safe cleanup candidates).
 */
export async function getMergedBranchSet(cwd: string, base: string): Promise<Set<string>> {
  const dead = await detectDeadBranches(cwd, base);
  return new Set(dead);
}

/**
 * Get Set of gone branch names (for efficient lookup).
 */
export async function getGoneBranchSet(cwd: string): Promise<Set<string>> {
  const gone = await detectGoneBranches(cwd);
  return new Set(gone);
}

/**
 * Fetch with prune to update remote tracking refs.
 */
export async function fetchWithPrune(cwd: string, remote = 'origin'): Promise<void> {
  await runGit(cwd, ['fetch', remote, '--prune']);
}

/**
 * List local branches with all cleanup status indicators populated.
 */
export async function listLocalBranchesWithStatus(
  cwd: string,
  baseBranch: string,
  staleDays: number,
  detectParentMerges = true
): Promise<BranchRow[]> {
  const [branches, mergedSet, parentMergedList, datesMap, goneSet] = await Promise.all([
    listLocalBranches(cwd),
    getMergedBranchSet(cwd, baseBranch),
    detectParentMerges ? detectMergedIntoOtherBranches(cwd) : Promise.resolve([]),
    getBranchLastCommitDates(cwd),
    getGoneBranchSet(cwd),
  ]);

  const parentMergedSet = new Set(parentMergedList);

  for (const b of branches) {
    b.isMerged = mergedSet.has(b.short);
    // Display-only badge for parent-merges; base-merged branches already covered.
    b.isMergedIntoParent = !b.isMerged && parentMergedSet.has(b.short);
    b.isGone = goneSet.has(b.short);

    const dateInfo = datesMap.get(b.short);
    if (dateInfo) {
      b.lastCommitDate = dateInfo.date;
      b.lastCommitAgeInDays = dateInfo.ageInDays;
      b.lastCommitAuthor = dateInfo.author;
      b.isStale = dateInfo.ageInDays >= staleDays;
    }
  }

  return branches;
}

/**
 * Get last commit date for each remote branch.
 * Returns Map of short name (e.g., "origin/feature") -> { date: ISO string, ageInDays: number }
 */
export async function getRemoteBranchLastCommitDates(
  cwd: string
): Promise<Map<string, { date: string; ageInDays: number; author?: string }>> {
  const fmt = '%(refname:short)\t%(committerdate:iso-strict)\t%(authorname)';
  const { stdout } = await runGit(cwd, ['for-each-ref', '--format', fmt, 'refs/remotes']);

  const now = Date.now();
  const result = new Map<string, { date: string; ageInDays: number; author?: string }>();

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const [name, dateStr, author] = line.split('\t');
    // Skip HEAD pointers
    if (name && dateStr && !name.endsWith('/HEAD')) {
      const commitDate = new Date(dateStr);
      const ageInDays = Math.floor((now - commitDate.getTime()) / (1000 * 60 * 60 * 24));
      result.set(name, { date: dateStr, ageInDays, author: author || undefined });
    }
  }

  return result;
}

/**
 * Detect remote branches merged into base branch.
 */
export async function detectMergedRemoteBranches(cwd: string, base: string): Promise<Set<string>> {
  let stdout: string;
  try {
    ({ stdout } = await runGit(cwd, ['branch', '-r', '--merged', base]));
  } catch {
    // Same as detectDeadBranches: an unresolved base means no candidates.
    return new Set<string>();
  }

  const merged = new Set<string>();
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const name = line.trim();
    // Skip HEAD pointers and the base branch itself.
    // base is typically a short name ("main"), but could be "origin/main" if user configured it.
    // name is always in "origin/main" form, so compare both ways.
    const branchNameWithoutRemote = name.split('/').slice(1).join('/');
    if (name && !name.endsWith('/HEAD') && branchNameWithoutRemote !== base && name !== base) {
      merged.add(name);
    }
  }

  return merged;
}

/**
 * List remote branches with status indicators (merged/stale).
 */
export async function listRemoteBranchesWithStatus(
  cwd: string,
  baseBranch: string,
  staleDays: number
): Promise<BranchRow[]> {
  const [branches, mergedSet, datesMap] = await Promise.all([
    listRemoteBranches(cwd),
    detectMergedRemoteBranches(cwd, baseBranch),
    getRemoteBranchLastCommitDates(cwd),
  ]);

  for (const b of branches) {
    b.isMerged = mergedSet.has(b.short);

    const dateInfo = datesMap.get(b.short);
    if (dateInfo) {
      b.lastCommitDate = dateInfo.date;
      b.lastCommitAgeInDays = dateInfo.ageInDays;
      b.lastCommitAuthor = dateInfo.author;
      b.isStale = dateInfo.ageInDays >= staleDays;
    }
  }

  return branches;
}
