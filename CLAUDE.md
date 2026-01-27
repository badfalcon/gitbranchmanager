# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Git Souji is a VS Code extension focused on cleaning up Git branches. "Souji" means "cleaning" in Japanese. It provides detection and deletion of dead/stale/gone branches for both local and remote, along with full branch management capabilities (checkout, create, rename, delete, merge) from a single webview panel.

## Build, Test, and Develop Commands

```bash
# Install dependencies
npm install

# Compile TypeScript and build with webpack (development)
npm run compile

# Watch mode for development (auto-recompile on changes)
npm run watch

# Lint TypeScript source files
npm run lint

# Run all tests (pretest runs lint + compile + tests)
npm test

# Build for production (minified, source maps hidden)
npm run vscode:prepublish
```

## Architecture Overview

The extension follows a layered architecture:

### **Extension Entry Point** ([src/extension.ts](src/extension.ts))
- Registers the `gitsouji.openCleaner` command
- Calls `pickRepository()` to let user select a Git repo (in multi-folder workspaces)
- Opens the webview panel via `openManagerPanel()`

### **Core Application Logic** ([src/app.ts](src/app.ts))
Main TypeScript module containing:

- **Types**: `BranchRow`, `BranchKind`, `WebviewMessage`, `ExtensionConfig`, `RepoContext`, `CleanupFilter`
- **Configuration**: `getCfg()` reads VS Code settings (`gitSouji.*`)
- **Git Operations**: Pure functions that wrap `runGit()` calls:
  - **Queries**: `listLocalBranches()`, `listRemoteBranches()`, `getCurrentBranch()`, `resolveBaseBranch()`
  - **Actions**: `checkoutBranch()`, `createBranch()`, `renameBranch()`, `deleteLocalBranch()`, `mergeIntoCurrent()`, `deleteRemoteBranch()`
  - **Local Cleanup Detection**:
    - `detectDeadBranches()` - finds merged branches
    - `detectStaleBranches()` - finds branches with old commits
    - `detectGoneBranches()` - finds branches with deleted upstream
    - `getBranchLastCommitDates()` - gets commit age info for local branches
    - `listLocalBranchesWithStatus()` - combined status for all local branches
  - **Remote Cleanup Detection**:
    - `detectMergedRemoteBranches()` - finds merged remote branches
    - `getRemoteBranchLastCommitDates()` - gets commit age info for remote branches
    - `listRemoteBranchesWithStatus()` - combined status for all remote branches
  - **Utilities**:
    - `fetchWithPrune()` - updates remote tracking refs
    - `getUpstreamMap()` - maps local branches to their upstream tracking refs
- **Helpers**:
  - `isProtectedBranch()` - supports exact match, prefix (`*`), and glob patterns
  - `parseTrackShort()` - parses git ahead/behind counts
  - `simpleBranchNameValidator()` - validates branch names with localized error messages
  - `escapeHtml()` - HTML entity escaping for safety

### **Git Execution** ([src/git/gitRunner.ts](src/git/gitRunner.ts))
- `runGit(cwd, args)` - executes git commands via `child_process.execFile`
- Throws `GitError` with command details on failure
- Buffer limit: 1MB for large outputs

### **Webview Panel** ([src/webview/panel.ts](src/webview/panel.ts))
- `openManagerPanel()` - creates webview, injects CSP/nonce, handles message dispatch
- Message handler for user actions (checkout, create, rename, delete, merge, cleanup)
- `getState()` - fetches current branch list with cleanup status indicators for both local and remote
- Auto-fetches with prune when `autoFetchPrune` is enabled
- Embeds webview i18n strings as base64 JSON
- Loads HTML from [media/branchManager.html](media/branchManager.html)

### **Webview UI** ([media/branchManager.html](media/branchManager.html))
- Static HTML with inline CSS/JavaScript
- **Unified search bar**: Filter both local and remote branches with case sensitivity (Aa) and regex (.*) toggles
- **Settings button**: Gear icon for quick access to extension settings
- **Sortable columns**: Click headers to sort by Name, Status, or Last Commit
- Tables for local and remote branches with status badges (merged/stale/gone)
- **Local cleanup toolbar**: Merged/Stale/Gone/Cleanup All buttons
- **Remote cleanup toolbar**: Merged/Stale/Cleanup All buttons (hidden when `allowRemoteBranchDeletion` is false)
- **Select mode**: Toggle to show checkboxes for manual multi-select deletion
- **Preview modal**: Bulk deletion preview with checkbox selection and sortable columns (Name, Status, Last Commit)
- i18n strings injected at runtime as base64-encoded JSON

## Key Design Patterns

### Protected Branches
- Configured via `gitSouji.protectedBranches` setting
- Supports:
  - Exact match: `"main"`
  - Prefix match: `"release/*"`
  - Glob patterns: `"hotfix/*/wip"` (converts `*` to `.*` regex)
- Blocks: delete, rename, merge (as source), delete remote, cleanup operations

### Branch Cleanup Detection

**Local branches** - Three types of cleanup candidates:

1. **Merged (Dead)**: Branches fully merged into base branch
   - Base branch resolved via `resolveBaseBranch()`:
     1. Uses configured `baseBranch` if not "auto"
     2. Tries `origin/HEAD` symbolic ref
     3. Falls back to `main` → `master` → `develop`
     4. Uses current branch if all else fails
   - Detected via `git branch --merged BASE`

2. **Stale**: Branches with no commits for N days
   - Threshold configured via `staleDays` setting (default: 30)
   - Uses `git for-each-ref` to get commit dates

3. **Gone**: Local tracking branches whose upstream was deleted
   - Detected via `git branch -vv` looking for `[origin/xxx: gone]`
   - Optional auto `git fetch --prune` via `autoFetchPrune` setting

**Remote branches** - Two types of cleanup candidates:

1. **Merged**: Remote branches fully merged into base branch
   - Detected via `git branch -r --merged BASE`

2. **Stale**: Remote branches with no commits for N days
   - Uses `git for-each-ref` on `refs/remotes`

### Deletion Behavior

**Local branch deletion**:
- Uses `git branch -d` by default (safe delete)
- If deletion fails (unmerged branch), prompts: "X branches are not fully merged. Force delete them?"
- If confirmed, retries with `git branch -D` (force delete)
- Reports any failures to user

**Remote branch deletion** (when "Also delete corresponding remote branches" is checked):
- For **tracked branches**: deletes directly using upstream ref
- For **untracked branches**: prompts "Also delete X remote branches with same name (not tracked)?"
- If confirmed, attempts to delete `origin/<branch-name>`

### Select Mode
- Toggle "Select" button to enter select mode
- Checkboxes appear on selectable branch rows (hidden for current/protected branches)
- Select branches from both local and remote tables simultaneously
- Counter shows "X selected"
- Click "Delete Selected" to bulk delete all selected branches

### Configuration Keys
All settings are under `gitSouji.*`, organized by category:

**Detection:**
- `baseBranch` (default: "auto") - base branch for merged detection
- `staleDays` (default: 30) - days threshold for stale detection
- `autoFetchPrune` (default: false) - auto fetch with prune before gone detection

**Protection:**
- `protectedBranches` (default: ["main", "master", "develop"]) - protected branch patterns

**Deletion:**
- `confirmBeforeDelete` (default: true) - show confirmation before destructive ops
- `forceDeleteLocal` (default: false) - use `git branch -D` instead of `-d`
- `allowRemoteBranchDeletion` (default: false) - enable remote branch deletion UI
- `includeRemoteInDeadCleanup` (default: false) - delete remote when cleaning dead local

**Display:**
- `showStatusBadges` (default: true) - show merged/stale/gone badges in branch list

## Webview Message Protocol

Two-way message flow between extension and webview:

**Webview → Extension (Actions)**:
- `{ type: 'ready' }` - webview initialized
- `{ type: 'refresh' }` - user requests refresh
- `{ type: 'openLogTerminal'; ref: string }` - open git log in terminal
- `{ type: 'openSettings' }` - open extension settings
- `{ type: 'checkout'; name: string }` - switch branch
- `{ type: 'create' }` - create new branch (prompts user)
- `{ type: 'rename'; oldName: string }` - rename branch (prompts user)
- `{ type: 'deleteLocal'; name: string }` - delete local branch
- `{ type: 'mergeIntoCurrent'; source: string }` - merge into current
- `{ type: 'deleteRemote'; remote: string; name: string }` - delete remote branch
- `{ type: 'executeCleanup'; branches: string[]; includeRemote: boolean }` - bulk delete local branches (with optional remote)
- `{ type: 'executeRemoteCleanup'; branches: string[] }` - bulk delete remote branches
- `{ type: 'deleteSelectedBranches'; localBranches: string[]; remoteBranches: string[] }` - delete selected branches from select mode

**Extension → Webview (State)**:
- `{ type: 'state'; state: { locals: BranchRow[]; remotes: BranchRow[]; current?: string; repoRoot: string; showStatusBadges?: boolean; allowRemoteBranchDeletion?: boolean } }` - branch list with status
- `{ type: 'error'; message: string }` - error notification

## Testing

Tests are in [src/test/extension.test.ts](src/test/extension.test.ts) using Mocha + Assert + Sinon:

**Pure function tests (18 tests):**
- `isProtectedBranch()` - exact, prefix, glob, case sensitivity, special chars
- `parseTrackShort()` - ahead/behind parsing, edge cases
- `escapeHtml()` - HTML entity escaping, XSS prevention
- `simpleBranchNameValidator()` - invalid chars, patterns, edge cases

**Git function tests with mocking (30 tests):**
- Uses `sinon` to stub `runGit()` for isolated unit tests
- Tests for: `listLocalBranches`, `listRemoteBranches`, `getCurrentBranch`, `checkoutBranch`, `createBranch`, `renameBranch`, `deleteLocalBranch`, `deleteRemoteBranch`, `mergeIntoCurrent`, `fetchWithPrune`, `resolveBaseBranch`, `getUpstreamMap`, `detectDeadBranches`, `detectGoneBranches`, `detectStaleBranches`, `detectMergedRemoteBranches`, `getBranchLastCommitDates`, `getRemoteBranchLastCommitDates`, `listLocalBranchesWithStatus`, `listRemoteBranchesWithStatus`

```bash
# Run all tests (auto-compiles and lints first)
npm test

# Run specific test by pattern (requires compiled tests)
npm run compile-tests && npx vscode-test --grep "isProtectedBranch"
```

## Localization (i18n)

- Uses VS Code's native `vscode.l10n.t()` API
- Localization files in [l10n/](l10n/):
  - `bundle.l10n.json` - English (fallback)
  - `bundle.l10n.ja.json` - Japanese
- All user-facing strings use `vscode.l10n.t()` with optional parameters
- Webview i18n: strings built into `getWebviewI18n()` in [src/webview/panel.ts](src/webview/panel.ts)

## Build Outputs

- **Development**: `dist/extension.js` (webpack, source maps enabled)
- **Production**: `dist/extension.js` (webpack, minified, hidden source maps)
- TypeScript declaration files: `.d.ts` files (not bundled)

## Documentation

- **README.md** - Repository documentation (development-focused)
- **STORE.md** - VS Code Marketplace description (user-focused, set via `package.json` `"readme"` field)
- **CHANGELOG.md** - Version history
- **CLAUDE.md** - This file (Claude Code context)

## Important Notes

- **Git requirement**: The extension assumes `git` command is available on PATH
- **CSP enforcement**: Webview uses strict CSP with nonce injection for security
- **Error handling**: Git errors include command args and cwd for debugging; failed branch deletions are reported to user
- **Repository detection**: Multi-folder workspace support with filtering for actual Git repos
- **Checkout from remote**: If checking out `origin/feature`, automatically creates local tracking branch `feature`
- **Mutex warnings in tests**: `vscode-test` may report "Error mutex already exists"; this is expected due to VS Code process contention and doesn't affect exit code
