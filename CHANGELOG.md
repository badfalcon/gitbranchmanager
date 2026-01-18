# Change Log

All notable changes to the "gitsouji" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
