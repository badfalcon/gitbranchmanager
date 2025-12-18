# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Git Branch Manager is a VS Code extension that provides a unified UI for managing Git branches. It enables checkout, create, rename, delete, merge, and dead branch detection operations from a single webview panel.

## Build, Test, and Develop Commands

```bash
# Install dependencies
npm install

# Compile TypeScript and build with webpack (development)
npm run compile

# Watch mode for development (auto-recompile on changes)
npm run watch

# Lint TypeScript source files
npm lint

# Run all tests (pretest runs lint + compile + tests)
npm test

# Build for production (minified, source maps hidden)
npm run vscode:prepublish
```

## Architecture Overview

The extension follows a layered architecture:

### **Extension Entry Point** ([src/extension.ts](src/extension.ts))
- Registers the `gitbranchmanager.openManager` command
- Calls `pickRepository()` to let user select a Git repo (in multi-folder workspaces)
- Opens the webview panel via `openManagerPanel()`

### **Core Application Logic** ([src/app.ts](src/app.ts))
Main TypeScript module containing:

- **Types**: `BranchRow`, `BranchKind`, `WebviewMessage`, `ExtensionConfig`, `RepoContext`
- **Configuration**: `getCfg()` reads VS Code settings (`gitBranchManager.*`)
- **Git Operations**: Pure functions that wrap `runGit()` calls:
  - **Queries**: `listLocalBranches()`, `listRemoteBranches()`, `getCurrentBranch()`, `resolveBaseBranch()`
  - **Actions**: `checkoutBranch()`, `createBranch()`, `renameBranch()`, `deleteLocalBranch()`, `mergeIntoCurrent()`, `deleteRemoteBranch()`
  - **Dead branch detection**: `detectDeadBranches()`, `getUpstreamMap()`
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
- Message handler for user actions (checkout, create, rename, delete, merge, detect dead)
- `getState()` - fetches current branch list and status
- Embeds webview i18n strings as base64 JSON
- Loads HTML from [media/branchManager.html](media/branchManager.html)

### **Webview UI** ([media/branchManager.html](media/branchManager.html))
- Static HTML with inline CSS/JavaScript
- Tables for local and remote branches
- Action buttons (checkout, log, rename, delete, merge into current, etc.)
- i18n strings injected at runtime as base64-encoded JSON

## Key Design Patterns

### Protected Branches
- Configured via `gitBranchManager.protectedBranches` setting
- Supports:
  - Exact match: `"main"`
  - Prefix match: `"release/*"`
  - Glob patterns: `"hotfix/*/wip"` (converts `*` to `.*` regex)
- Blocks: delete, rename, merge (as source), delete remote operations

### Dead Branch Detection
- Base branch resolved via `resolveBaseBranch()`:
  1. Uses configured `baseBranch` if not "auto"
  2. Tries `origin/HEAD` symbolic ref
  3. Falls back to `main` → `master` → `develop`
  4. Uses current branch if all else fails
- Finds merged branches via `git branch --merged BASE`
- Can optionally delete corresponding remote branches via upstream tracking

### Configuration Keys
All settings are under `gitBranchManager.*`:
- `baseBranch` (default: "auto") - base branch for dead detection
- `protectedBranches` (default: ["main", "master", "develop"]) - protected branch patterns
- `confirmBeforeDelete` (default: true) - show confirmation before destructive ops
- `forceDeleteLocal` (default: false) - use `git branch -D` instead of `-d`
- `includeRemoteInDeadCleanup` (default: false) - delete remote when cleaning dead local

## Webview Message Protocol

Two-way message flow between extension and webview:

**Webview → Extension (Actions)**:
- `{ type: 'ready' }` - webview initialized
- `{ type: 'refresh' }` - user requests refresh
- `{ type: 'openLogTerminal'; ref: string }` - open git log in terminal
- `{ type: 'checkout'; name: string }` - switch branch
- `{ type: 'create' }` - create new branch (prompts user)
- `{ type: 'rename'; oldName: string }` - rename branch (prompts user)
- `{ type: 'deleteLocal'; name: string }` - delete local branch
- `{ type: 'mergeIntoCurrent'; source: string }` - merge into current
- `{ type: 'deleteRemote'; remote: string; name: string }` - delete remote branch
- `{ type: 'detectDead' }` - find merged branches (multi-select + delete)

**Extension → Webview (State)**:
- `{ type: 'state'; state: { locals: BranchRow[]; remotes: BranchRow[]; current?: string; repoRoot: string } }` - branch list
- `{ type: 'error'; message: string }` - error notification

## Testing

Tests are in [src/test/extension.test.ts](src/test/extension.test.ts) using Mocha + Assert:
- `isProtectedBranch()` - exact, prefix, glob matching
- `parseTrackShort()` - ahead/behind parsing
- `escapeHtml()` - HTML entity escaping

Run tests with `npm test` (auto-compiles and lints first).

## Localization (i18n)

- Uses VS Code's native `vscode.l10n.t()` API
- Localization files in [l10n/](l10n/):
  - `bundle.l10n.json` - English (fallback)
  - `bundle.l10n.ja.json` - Japanese
- All user-facing strings use `vscode.l10n.t()` with optional parameters
- Webview i18n: strings built into `getWebviewI18n()` in [src/webview/panel.ts](src/webview/panel.ts:320)

## Build Outputs

- **Development**: `dist/extension.js` (webpack, source maps enabled)
- **Production**: `dist/extension.js` (webpack, minified, hidden source maps)
- TypeScript declaration files: `.d.ts` files (not bundled)

## Important Notes

- **Git requirement**: The extension assumes `git` command is available on PATH
- **CSP enforcement**: Webview uses strict CSP with nonce injection for security
- **Error handling**: Git errors include command args and cwd for debugging
- **Repository detection**: Multi-folder workspace support with filtering for actual Git repos
- **Checkout from remote**: If checking out `origin/feature`, automatically creates local tracking branch `feature`
- **Mutex warnings in tests**: `vscode-test` may report "Error mutex already exists"; this is expected due to VS Code process contention and doesn't affect exit code

## File Structure

```
gitbranchmanager/
├── src/
│   ├── extension.ts           # Entry point, command registration
│   ├── app.ts                 # Core logic (types, git ops, config, helpers)
│   ├── webview/
│   │   └── panel.ts           # Webview creation, message handling
│   ├── git/
│   │   └── gitRunner.ts       # Git command execution wrapper
│   └── test/
│       └── extension.test.ts   # Unit tests
├── media/
│   └── branchManager.html     # Webview UI (injected at runtime)
├── l10n/
│   ├── bundle.l10n.json       # English strings
│   └── bundle.l10n.ja.json    # Japanese strings
├── webpack.config.js          # Webpack build config
├── tsconfig.json              # TypeScript config
├── package.json               # Dependencies and scripts
└── CLAUDE.md                  # This file
```
