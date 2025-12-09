import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type BranchRow = {
  fullRef: string; // e.g. refs/heads/feature/x or refs/remotes/origin/main
  short: string;   // e.g. feature/x or origin/main
  kind: 'local' | 'remote';
  isCurrent?: boolean;
  upstream?: string; // e.g. origin/main
  ahead?: number;
  behind?: number;
};

type RepoContext = {
  repoRoot: string;
};

export async function activate(context: vscode.ExtensionContext) {
  console.log('git-branch-manager activated');

  const disposable = vscode.commands.registerCommand('gitbranchmanager.openManager', async () => {
    const repo = await pickRepository();
    if (!repo) {
      vscode.window.showWarningMessage('Git リポジトリが見つかりません。フォルダを開くか Git を初期化してください。');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'gitBranchManager',
      'Branch Manager',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const nonce = String(Math.random()).slice(2);
    panel.webview.html = getHtml(nonce);

    const refresh = async () => {
      try {
        const state = await getState({ repoRoot: repo.repoRoot });
        panel.webview.postMessage({ type: 'state', state });
      } catch (err: any) {
        panel.webview.postMessage({ type: 'error', message: err?.message ?? String(err) });
      }
    };

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'ready':
            await refresh();
            break;
          case 'refresh':
            await refresh();
            break;
          case 'checkout':
            await checkoutBranch(repo.repoRoot, msg.name);
            await refresh();
            break;
          case 'create': {
            const name = await vscode.window.showInputBox({ prompt: '新しいブランチ名', validateInput: simpleBranchNameValidator });
            if (!name) break;
            const base = await vscode.window.showInputBox({ prompt: 'ベースブランチ（省略可。例: main）' });
            await createBranch(repo.repoRoot, name, base || undefined, true);
            await refresh();
            break;
          }
          case 'rename': {
            const newName = await vscode.window.showInputBox({ prompt: `新しいブランチ名（${msg.oldName} → ?）`, validateInput: simpleBranchNameValidator, value: msg.oldName });
            if (!newName || newName === msg.oldName) break;
            await renameBranch(repo.repoRoot, msg.oldName, newName);
            await refresh();
            break;
          }
          case 'deleteLocal': {
            const cfg = getCfg();
            const proceed = !cfg.confirmBeforeDelete || await confirm(`ローカルブランチ ${msg.name} を削除しますか？`);
            if (proceed) {
              await deleteLocalBranch(repo.repoRoot, msg.name, cfg.forceDeleteLocal);
              await refresh();
            }
            break;
          }
          case 'mergeIntoCurrent': {
            const proceed = await confirm(`現在のブランチに ${msg.source} をマージしますか？`);
            if (proceed) {
              await mergeIntoCurrent(repo.repoRoot, msg.source);
              await refresh();
            }
            break;
          }
          case 'deleteRemote': {
            const proceed = await confirm(`リモートブランチ ${msg.remote}/${msg.name} を削除しますか？`);
            if (proceed) {
              await deleteRemoteBranch(repo.repoRoot, msg.remote, msg.name);
              await refresh();
            }
            break;
          }
          case 'detectDead': {
            const base = await resolveBaseBranch(repo.repoRoot);
            const dead = await detectDeadBranches(repo.repoRoot, base);
            if (dead.length === 0) {
              vscode.window.showInformationMessage(`デッドブランチはありません（基準: ${base}）`);
              break;
            }
            const pick = await vscode.window.showQuickPick(dead.map(d => ({ label: d, picked: true })), {
              canPickMany: true,
              title: `削除するデッドブランチを選択（基準: ${base}）`
            });
            if (pick && pick.length) {
              const cfg = getCfg();
              const names = pick.map(p => p.label);
              const proceed = !cfg.confirmBeforeDelete || await confirm(`選択した ${names.length} 件のローカルブランチを削除しますか？`);
              if (proceed) {
                for (const n of names) {
                  await deleteLocalBranch(repo.repoRoot, n, cfg.forceDeleteLocal);
                }
                if (cfg.includeRemoteInDeadCleanup) {
                  // 対応する追跡リモートがある場合は削除を試行
                  const locals = await listLocalBranches(repo.repoRoot);
                  const upstreams = new Map(locals.map(l => [l.short, l.upstream].filter(Boolean) as [string, string]));
                  for (const n of names) {
                    const up = upstreams.get(n);
                    if (up && up.includes('/')) {
                      const [remote, ...rest] = up.split('/');
                      const rName = rest.join('/');
                      try { await deleteRemoteBranch(repo.repoRoot, remote, rName); } catch { /* ignore */ }
                    }
                  }
                }
                await refresh();
              }
            }
            break;
          }
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message ?? String(err));
      }
    }, undefined, context.subscriptions);

    await refresh();
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}

// ========= Helpers =========

function getCfg() {
  const cfg = vscode.workspace.getConfiguration('gitBranchManager');
  return {
    baseBranch: cfg.get<string>('baseBranch', 'auto'),
    protected: cfg.get<string[]>('protectedBranches', ['main','master','develop']),
    confirmBeforeDelete: cfg.get<boolean>('confirmBeforeDelete', true),
    forceDeleteLocal: cfg.get<boolean>('forceDeleteLocal', false),
    includeRemoteInDeadCleanup: cfg.get<boolean>('includeRemoteInDeadCleanup', false),
  };
}

async function pickRepository(): Promise<RepoContext | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;

  // 最も近いGitルートを推定（単一ルート前提の簡易実装）
  // ユーザーが複数ルートの場合は最初のフォルダを採用
  const repoRoot = folders[0].uri.fsPath;
  try {
    // 確実にGit管理下かを確認
    await runGit(repoRoot, ['rev-parse', '--git-dir']);
    return { repoRoot };
  } catch {
    return undefined;
  }
}

async function getState(ctx: RepoContext) {
  const [locals, remotes, current] = await Promise.all([
    listLocalBranches(ctx.repoRoot),
    listRemoteBranches(ctx.repoRoot),
    getCurrentBranch(ctx.repoRoot)
  ]);
  for (const b of locals) b.isCurrent = b.short === current;
  return { locals, remotes, repoRoot: ctx.repoRoot, current };
}

async function listLocalBranches(cwd: string): Promise<BranchRow[]> {
  // for-each-ref with upstream and ahead/behind info where possible
  const fmt = '%(refname)\t%(refname:short)\t%(upstream:short)\t%(upstream:trackshort)\t%(HEAD)';
  const { stdout } = await runGit(cwd, ['for-each-ref', '--format', fmt, 'refs/heads']);
  const rows: BranchRow[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const [fullRef, short, upstream, track, headMark] = line.split('\t');
    const row: BranchRow = { fullRef, short, kind: 'local' };
    if (upstream) row.upstream = upstream;
    if (headMark === '*') row.isCurrent = true;
    if (track) {
      // e.g. "+1 -2" or "<>", parse numbers if present
      const m = track.match(/\+?(\d+)?\s*-?(\d+)?/);
      if (m) {
        if (m[1]) row.ahead = Number(m[1]);
        if (m[2]) row.behind = Number(m[2]);
      }
    }
    rows.push(row);
  }
  return rows;
}

async function listRemoteBranches(cwd: string): Promise<BranchRow[]> {
  const fmt = '%(refname)\t%(refname:short)';
  const { stdout } = await runGit(cwd, ['for-each-ref', '--format', fmt, 'refs/remotes']);
  const rows: BranchRow[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const [fullRef, short] = line.split('\t');
    // skip HEAD pointers like refs/remotes/origin/HEAD
    if (/\/HEAD$/.test(fullRef)) continue;
    rows.push({ fullRef, short, kind: 'remote' });
  }
  return rows;
}

async function getCurrentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const name = stdout.trim();
    if (name === 'HEAD') return undefined;
    return name;
  } catch {
    return undefined;
  }
}

async function checkoutBranch(cwd: string, name: string) {
  // If a remote ref like "origin/feature" is passed, create/switch to a local tracking branch
  if (name.includes('/')) {
    const parts = name.split('/');
    const remote = parts.shift() as string;
    const branch = parts.join('/');
    // If local exists, just checkout; otherwise create tracking
    try {
      await runGit(cwd, ['show-ref', '--verify', `refs/heads/${branch}`]);
      await runGit(cwd, ['checkout', branch]);
    } catch {
      await runGit(cwd, ['checkout', '-b', branch, '--track', `${remote}/${branch}`]);
    }
    return;
  }
  await runGit(cwd, ['checkout', name]);
}

async function createBranch(cwd: string, name: string, base?: string, checkout = true) {
  if (checkout) {
    if (base) await runGit(cwd, ['checkout', '-b', name, base]);
    else await runGit(cwd, ['checkout', '-b', name]);
  } else {
    if (base) await runGit(cwd, ['branch', name, base]);
    else await runGit(cwd, ['branch', name]);
  }
}

async function renameBranch(cwd: string, oldName: string, newName: string) {
  await runGit(cwd, ['branch', '-m', oldName, newName]);
}

async function deleteLocalBranch(cwd: string, name: string, force = false) {
  await runGit(cwd, ['branch', force ? '-D' : '-d', name]);
}

async function mergeIntoCurrent(cwd: string, source: string) {
  await runGit(cwd, ['merge', source]);
}

async function deleteRemoteBranch(cwd: string, remote: string, name: string) {
  await runGit(cwd, ['push', remote, '--delete', name]);
}

async function resolveBaseBranch(cwd: string): Promise<string> {
  const cfg = getCfg();
  if (cfg.baseBranch && cfg.baseBranch !== 'auto') return cfg.baseBranch;
  // Try origin/HEAD
  try {
    const { stdout } = await runGit(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const m = stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch {}
  // Fallbacks
  for (const cand of ['main', 'master', 'develop']) {
    try {
      await runGit(cwd, ['show-ref', '--verify', `refs/heads/${cand}`]);
      return cand;
    } catch {}
  }
  // As last resort, current branch
  const cur = await getCurrentBranch(cwd);
  return cur ?? 'main';
}

async function detectDeadBranches(cwd: string, base: string): Promise<string[]> {
  const { stdout } = await runGit(cwd, ['branch', '--merged', base]);
  const current = await getCurrentBranch(cwd);
  const cfg = getCfg();
  const lines = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const names = lines.map(l => l.replace(/^\*\s+/, '')).map(n => n.replace(/^\(no branch\)$/, '')); // normalize
  return names.filter(n => !!n && n !== current && !isProtected(n, cfg.protected));
}

function isProtected(name: string, protectedList: string[]): boolean {
  for (const p of protectedList) {
    if (p.endsWith('*')) {
      const prefix = p.slice(0, -1);
      if (name.startsWith(prefix)) return true;
    } else if (p.includes('*')) {
      // simple glob: convert * to .*
      const re = new RegExp('^' + p.split('*').map(escapeRegExp).join('.*') + '$');
      if (re.test(name)) return true;
    } else if (name === p) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, r => '\\' + r);
}

async function runGit(cwd: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (stderr && stderr.trim()) {
    // many git commands use stderr for progress; don't treat as error unless exit code non-zero (which execFile would throw)
  }
  return { stdout: stdout.toString() };
}

function getHtml(nonce: string) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta charset="UTF-8" />
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
.toolbar { margin: 8px 0; display: flex; gap: 8px; align-items: center; }
.table { width: 100%; border-collapse: collapse; margin-top: 8px; }
.table th, .table td { border-bottom: 1px solid var(--vscode-editorGroup-border); padding: 6px 8px; font-size: 12px; }
.badge { padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.btn { padding: 2px 8px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; border-radius: 4px; }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.section { margin-top: 16px; }
.actions button { margin-right: 6px; }
code { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
  <div class="toolbar">
    <button class="btn primary" id="refresh">Refresh</button>
    <button class="btn" id="create">Create</button>
    <button class="btn" id="detectDead">Detect Dead</button>
    <span id="repo"></span>
    <span id="error" style="color: var(--vscode-errorForeground);"></span>
  </div>

  <div class="section">
    <h3>Local Branches</h3>
    <table class="table" id="local"></table>
  </div>

  <div class="section">
    <h3>Remote Branches</h3>
    <table class="table" id="remote"></table>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const $ = (id) => document.getElementById(id);
    const localEl = $('local');
    const remoteEl = $('remote');
    const repoEl = $('repo');
    const errEl = $('error');

    $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    $('create').addEventListener('click', () => vscode.postMessage({ type: 'create' }));
    $('detectDead').addEventListener('click', () => vscode.postMessage({ type: 'detectDead' }));

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'state') {
        errEl.textContent = '';
        render(msg.state);
      } else if (msg.type === 'error') {
        errEl.textContent = msg.message || 'Error';
      }
    });

    function render(state) {
      repoEl.textContent = state.repoRoot;
      localEl.innerHTML = '';
      remoteEl.innerHTML = '';
      renderLocal(state.locals);
      renderRemote(state.remotes);
    }

    function renderLocal(rows) {
      const header = '<tr><th>Current</th><th>Name</th><th>Upstream</th><th>Ahead</th><th>Behind</th><th>Actions</th></tr>';
      localEl.insertAdjacentHTML('beforeend', header);
      for (const r of rows) {
        const cur = r.isCurrent ? '<span class="badge">HEAD</span>' : '';
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + cur + '</td>'
          + '<td><code>' + escapeHtml(r.short) + '</code></td>'
          + '<td>' + (r.upstream ? '<code>' + escapeHtml(r.upstream) + '</code>' : '') + '</td>'
          + '<td>' + (r.ahead ?? '') + '</td>'
          + '<td>' + (r.behind ?? '') + '</td>'
          + '<td class="actions"></td>';
        const actions = tr.querySelector('.actions');
        actions.appendChild(btn('Checkout', () => vscode.postMessage({ type: 'checkout', name: r.short })));
        actions.appendChild(btn('Rename', () => vscode.postMessage({ type: 'rename', oldName: r.short })));
        actions.appendChild(btn('Delete', () => vscode.postMessage({ type: 'deleteLocal', name: r.short })));
        actions.appendChild(btn('Merge into current', () => vscode.postMessage({ type: 'mergeIntoCurrent', source: r.short })));
        localEl.appendChild(tr);
      }
    }

    function renderRemote(rows) {
      const header = '<tr><th>Remote</th><th>Name</th><th>Actions</th></tr>';
      remoteEl.insertAdjacentHTML('beforeend', header);
      for (const r of rows) {
        const parts = r.short.split('/');
        const remote = parts.shift();
        const name = parts.join('/');
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + escapeHtml(remote) + '</td>'
          + '<td><code>' + escapeHtml(name) + '</code></td>'
          + '<td class="actions"></td>';
        const actions = tr.querySelector('.actions');
        actions.appendChild(btn('Checkout', () => vscode.postMessage({ type: 'checkout', name: r.short })));
        actions.appendChild(btn('Delete Remote', () => vscode.postMessage({ type: 'deleteRemote', remote, name })));
        remoteEl.appendChild(tr);
      }
    }

    function btn(label, onClick) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }

    function escapeHtml(s) {
      const map = { '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' };
      return String(s).replace(/[&<>"']/g, function(c) { return map[c]; });
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function simpleBranchNameValidator(input?: string) {
  if (!input) return 'ブランチ名を入力してください';
  if (/\s/.test(input)) return '空白は使用できません';
  if (/[~^:\\?*\[\]]/.test(input)) return '無効な文字を含みます (~ ^ : \\ ? * [ ])';
  if (input.endsWith('.') || input.endsWith('/')) return '末尾に . や / は使用できません';
  if (input.includes('..') || input.includes('//')) return '".." や連続した "/" は使用できません';
  return undefined;
}

async function confirm(message: string) {
  const yes = 'はい';
  const pick = await vscode.window.showWarningMessage(message, { modal: true }, yes);
  return pick === yes;
}
