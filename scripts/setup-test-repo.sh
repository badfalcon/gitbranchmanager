#!/usr/bin/env bash
#
# setup-test-repo.sh — (re)generate a rich Git repository for manually
# verifying the Git Sohji extension (branch cleanup detection, deletion
# queue, retry, the Author column, sorting, etc.).
#
# It is destructive and idempotent: it wipes and rebuilds both the working
# repo and its bare "origin" remote from scratch, so you can re-run it
# whenever you want a clean, known state.
#
# Usage:
#   bash scripts/setup-test-repo.sh [REPO_DIR] [REMOTE_DIR]
#
# Defaults (Windows paths used by this project):
#   REPO_DIR   = C:/Users/BYD-Masuda/VSCodeProjects/gitsouji-test-repo
#   REMOTE_DIR = C:/Users/BYD-Masuda/VSCodeProjects/gitsouji-test-remote.git
#
# Then in VS Code: F5 (Extension Development Host) and open REPO_DIR.
#
set -euo pipefail

REPO="${1:-C:/Users/BYD-Masuda/VSCodeProjects/gitsouji-test-repo}"
REMOTE="${2:-C:/Users/BYD-Masuda/VSCodeProjects/gitsouji-test-remote.git}"

# Authors (name <email>) used across branches to exercise the Author column,
# including a CJK name, an accented name, and a very long name (ellipsis).
A_ALICE="Alice Anderson <alice@example.com>"
A_BOB="Bob Brown <bob@example.com>"
A_CAROL="Carol Chen <carol@example.com>"
A_DAVE="Dave Davis <dave@example.com>"
A_ERIN="Erin Estrada <erin@example.com>"
A_JP="山田 太郎 <yamada@example.com>"
A_DE="Sören Müller <soren@example.com>"
A_LONG="Maximilian Alexander Featherstonehaugh III <max@example.com>"

echo ">>> wiping $REPO"
rm -rf "$REPO"
echo ">>> wiping $REMOTE"
rm -rf "$REMOTE"

git init -q --bare -b main "$REMOTE"
git init -q -b main "$REPO"
cd "$REPO"
git config user.name "Test User"
git config user.email "test@example.com"
git config commit.gpgsign false
git remote add origin "$REMOTE"

# commit FILE MESSAGE AUTHOR [AGE_DAYS]
# Commits a change, attributing authorship to AUTHOR (committer stays
# "Test User"). AGE_DAYS backdates the author+committer date for stale tests.
commit() {
  local file="$1" msg="$2" author="$3" age="${4:-0}"
  printf '%s\n' "$msg" >> "$file"
  git add "$file"
  if [ "$age" -gt 0 ]; then
    local d
    d="$(date -u -d "-${age} days" +%Y-%m-%dT%H:%M:%S)"
    GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" \
      git commit -q --author="$author" -m "$msg"
  else
    git commit -q --author="$author" -m "$msg"
  fi
}

mkbranch() { git checkout -q -b "$1" "${2:-main}"; }

# --- base history on main (protected) ---
commit README.md "chore: init test repo" "$A_ALICE"
commit README.md "docs: project overview"  "$A_BOB"

# --- develop (protected) ---
mkbranch develop main
commit dev.txt "chore: bootstrap develop" "$A_CAROL"
git checkout -q main

# --- merged/* : fully merged into main (Merged / dead candidates) ---
for spec in "merged/login:$A_ALICE:login.txt" \
            "merged/logout:$A_BOB:logout.txt" \
            "merged/profile:$A_CAROL:profile.txt" \
            "merged/settings:$A_JP:settings.txt"; do
  br="${spec%%:*}"; rest="${spec#*:}"; author="${rest%:*}"; file="${rest##*:}"
  mkbranch "$br" main
  commit "$file" "feat: $br" "$author"
  git checkout -q main
  git merge -q --no-ff "$br" -m "Merge $br"
done

# --- stale/* : old commits, NOT merged (Stale candidates) ---
mkbranch stale/old-spike main;       commit spike.txt    "spike: old experiment"   "$A_DAVE" 60;  git checkout -q main
mkbranch stale/ancient-poc main;     commit poc.txt      "poc: ancient prototype"  "$A_DE"   200; git checkout -q main
mkbranch stale/dusty-refactor main;  commit refactor.txt "refactor: long stalled"  "$A_LONG" 95;  git checkout -q main

# --- feature/* : recent, NOT merged (active; also force-retry candidates) ---
mkbranch feature/dashboard main;     commit dashboard.txt     "feat: dashboard"     "$A_BOB"   1;  git checkout -q main
mkbranch feature/search main;        commit search.txt        "feat: search"        "$A_CAROL" 2;  git checkout -q main
mkbranch feature/notifications main; commit notifications.txt  "feat: notifications" "$A_DAVE"  3;  git checkout -q main
mkbranch feature/export main;        commit export.txt        "feat: export"        "$A_JP"    0;  git checkout -q main
mkbranch feature/long-author main;   commit longauthor.txt    "feat: long author"   "$A_LONG"  5;  git checkout -q main

# --- parent-merge : sub merged into a non-base parent (merged (parent) badge) ---
mkbranch epic/payments main
commit payments.txt "feat: payments epic base" "$A_ALICE"
mkbranch sub/payments-ui epic/payments
commit payments-ui.txt "feat: payments UI" "$A_BOB"
git checkout -q epic/payments
git merge -q --no-ff sub/payments-ui -m "Merge sub/payments-ui"
git checkout -q main

# --- release / hotfix (not protected by default config) ---
mkbranch release/1.1.0 main; commit release.txt "chore: cut release 1.1.0" "$A_CAROL" 7; git checkout -q main
mkbranch hotfix/crash main;  commit hotfix.txt  "fix: crash on startup"    "$A_ERIN"  1; git checkout -q main

# --- push a representative set to origin (for remote table / remote cleanup) ---
git push -q origin main develop \
  merged/login merged/logout merged/profile \
  stale/old-spike stale/ancient-poc \
  feature/dashboard feature/search feature/export \
  epic/payments
git remote set-head origin main 2>/dev/null || true

# --- gone/* : had an upstream that was then deleted (Gone candidates) ---
for spec in "gone/wip-1:$A_ERIN:wip1.txt" \
            "gone/wip-2:$A_ALICE:wip2.txt" \
            "gone/wip-3:$A_DE:wip3.txt"; do
  br="${spec%%:*}"; rest="${spec#*:}"; author="${rest%:*}"; file="${rest##*:}"
  mkbranch "$br" main
  commit "$file" "wip: $br" "$author" 10
  git push -q -u origin "$br"
  git checkout -q main
  git push -q origin --delete "$br"
done
# Prune so the deleted upstreams show as [gone] locally.
git fetch -q --prune origin

git checkout -q main

echo
echo "=== local branches (name -> author) ==="
git for-each-ref --sort=refname --format='%(refname:short)	%(authorname)' refs/heads
echo
echo "=== remote-tracking branches (name -> author) ==="
git for-each-ref --sort=refname --format='%(refname:short)	%(authorname)' refs/remotes
echo
echo "=== gone branches ==="
git branch -vv | grep ': gone]' || echo "(none)"
echo
echo ">>> done. Repo: $REPO   Remote: $REMOTE"
