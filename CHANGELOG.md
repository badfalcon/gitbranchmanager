# Change Log

All notable changes to the "gitsouji" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.3.2] - 2026-03-19

### Fixed

- Cleanup preview modal now respects the active search filter (regex/text/case sensitivity)
- `detectMergedRemoteBranches`: base branch is now correctly excluded regardless of whether it is specified as a short name (`main`) or full remote ref (`origin/main`)
- `detectDeadBranches`: base branch itself is no longer incorrectly included in merged branch results
- Upstream tracking map is now fetched *before* local branch deletion to avoid losing tracking info
- Git log terminal command now quotes branch names to prevent special-character injection

### Added

- Branch name validator rejects names containing `@{`
- Webview panel is reused on re-open instead of spawning duplicates

### Changed

- CSP nonce is now generated with `crypto.randomBytes` instead of `Math.random`

## [1.3.1] - 2026-02-04

### Added

- Extension icon for VS Code Marketplace and extension list

## [1.3.0] - 2026-01-27

### Added

- Sortable columns in cleanup preview modal (Name, Status, Last Commit)
- Comprehensive unit tests with mocking (48 tests total)

### Changed

- Separated marketplace description (`STORE.md`) from repository README
- Removed explicit `activationEvents` (auto-inferred by VS Code)

## [1.2.0] - 2026-01-27

### Added

- Unified search bar for filtering both local and remote branches
- Case sensitivity toggle (Aa) for branch search
- Regex toggle (.*) for branch search with pattern matching
- Settings button (gear icon) in toolbar for quick access to extension settings
- `allowRemoteBranchDeletion` setting to control remote branch deletion UI

### Changed

- Reorganized settings with logical grouping and order
- Tab name changed to "Git Souji" for consistency
- Protected branches now hide checkboxes instead of showing disabled ones
- Improved settings descriptions with markdown formatting

## [1.1.0] - 2026-01-26

### Added

- Sortable columns for branch tables (Name, Status, Last Commit)
- Configuration option `allowRemoteBranchDeletion` to control remote branch deletion

## [1.0.0] - 2026-01-19

### Added

- Unified webview UI for Git branch management
- Local branch operations: checkout, create, rename, delete, merge
- Remote branch operations: checkout (with auto-tracking), delete
- Status badges for branches (merged/stale/gone) for both local and remote
- Cleanup toolbar with Merged/Stale/Gone/Cleanup All buttons for local branches
- Cleanup toolbar with Merged/Stale/Cleanup All buttons for remote branches
- Select mode for manual multi-select deletion (local and remote)
- Force delete confirmation dialog for unmerged branches
- Confirmation dialog when deleting untracked remote branches with same name
- Protected branch system with exact, prefix, and glob pattern matching
- Configuration options:
  - `baseBranch`: Base branch for dead branch detection (default: "auto")
  - `protectedBranches`: Protected branch patterns (default: ["main", "master", "develop"])
  - `confirmBeforeDelete`: Show confirmation dialogs (default: true)
  - `forceDeleteLocal`: Force delete unmerged branches (default: false)
  - `includeRemoteInDeadCleanup`: Delete remote branches during cleanup (default: false)
  - `staleDays`: Days threshold for stale detection (default: 30)
  - `autoFetchPrune`: Auto fetch with prune before gone detection (default: false)
  - `showStatusBadges`: Show merged/stale/gone badges in branch list (default: true)
- Multi-folder workspace support with repository picker
- Localization support: English and Japanese
- Git log terminal integration
- SCM view integration with toolbar button
