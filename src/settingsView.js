const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
    getCtxDir, listContexts, loadContext, saveContext, listArchivedContexts,
    formatRelativeTime, checkContextHealth, isArchStale,
} = require('./context');
const { autoInject } = require('./inject');
// permissions module used only for server-side message handling (removePerm, etc.)
const { isHookInstalled, writeActiveContext } = require('./hook');

const ACTIVE_KEY = 'ai.activeContext';

class SettingsViewProvider {
    constructor(extensionUri, wsState) {
        this._extensionUri = extensionUri;
        this._wsState      = wsState;
        this._view         = null;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
    }

    show() {
        if (this._view) this._view.show(true);
    }

    refresh() {
        if (this._view) {
            this._view.webview.html = this._getHtml(this._view.webview);
        }
    }

    _getPayload() {
        const ctxDir    = getCtxDir();
        const active    = this._wsState.get(ACTIVE_KEY) || null;
        const names    = listContexts(ctxDir);
        const archived = listArchivedContexts();
        const config    = vscode.workspace.getConfiguration('aiContext');

        const activeCtx = active ? loadContext(ctxDir, active) : null;
        let activeInfo  = null;
        if (activeCtx) {
            const health   = checkContextHealth(activeCtx);
            const maxDays  = Number(config.get('architectureMaxAgeDays')) || 30;
            const archAge  = activeCtx.arch && activeCtx.arch.lastAudited
                ? Math.floor((Date.now() - new Date(activeCtx.arch.lastAudited).getTime()) / 86400000)
                : null;
            activeInfo = {
                name:       active,
                task:       activeCtx.t || '',
                next:       activeCtx.n || '',
                root:       activeCtx.root || '',
                lastUsed:   formatRelativeTime(activeCtx.lastUsed),
                health:     health.warnings,
                archAge,
                archStale:  isArchStale(activeCtx, maxDays),
                permCount:  (activeCtx.perms?.allow || []).length,
            };
        }

        const contexts = names.map(name => {
            const ctx = loadContext(ctxDir, name);
            return {
                name,
                root:     ctx.root || '',
                task:     ctx.t || '',
                lastUsed: formatRelativeTime(ctx.lastUsed),
                active:   name === active,
            };
        });

        const perms = activeCtx?.perms?.allow || [];

        const settings = {
            projectsRoot:          config.get('projectsRoot') || '',
            agents:                config.get('agents') || ['claude', 'copilot'],
            autoDetect:            config.get('autoDetect') !== false,
            followActiveEditor:    config.get('followActiveEditor') !== false,
            followTerminalCwd:     config.get('followTerminalCwd') !== false,
            scanOnLaunch:          config.get('scanOnLaunch') || false,
            showNotifications:     config.get('showNotifications') !== false,
            autoGitignore:         config.get('autoGitignore') !== false,
            maxActions:            config.get('maxActions') || 40,
            architectureMaxAgeDays:config.get('architectureMaxAgeDays') || 30,
            preventRemovalCapture: config.get('preventRemovalCapture') || false,
        };

        return {
            active,
            activeInfo,
            contexts,
            archived,
            settings,
            perms,
            hookInstalled: isHookInstalled(),
        };
    }

    _getHtml(webview) {
        const payload = JSON.stringify(this._getPayload()).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 8px; }
  details { margin-top: 4px; }
  details + details { margin-top: 2px; }
  summary { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; user-select: none; list-style: none; display: flex; align-items: center; gap: 4px; }
  summary::before { content: '▸'; font-size: 10px; transition: transform 0.1s; display: inline-block; }
  details[open] > summary::before { transform: rotate(90deg); }
  summary:hover { color: var(--vscode-foreground); }
  details > :not(summary) { padding-top: 6px; }
  .card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; margin-bottom: 8px; }
  .card-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .card-value { font-weight: 600; font-size: 13px; margin-top: 2px; word-break: break-all; }
  .card-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 600; }
  .badge-ok   { background: var(--vscode-testing-iconPassed); color: #fff; }
  .badge-warn { background: var(--vscode-testing-iconFailed); color: #fff; }
  .badge-stale{ background: var(--vscode-editorWarning-foreground); color: #000; }
  .badge-none { background: var(--vscode-descriptionForeground); color: #fff; }
  button { padding: 3px 8px; font-size: 12px; border: 1px solid var(--vscode-button-border,transparent); border-radius: 3px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-row { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
  .ctx-item { display: flex; align-items: center; justify-content: space-between; padding: 4px 6px; border-radius: 3px; margin-bottom: 2px; }
  .ctx-item:hover { background: var(--vscode-list-hoverBackground); }
  .ctx-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .ctx-name { font-weight: 600; font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctx-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 8px; white-space: nowrap; }
  .ctx-item.active .ctx-meta { color: var(--vscode-list-activeSelectionForeground); opacity: 0.8; }
  .warning { font-size: 11px; color: var(--vscode-editorWarning-foreground); margin-top: 3px; }
  .perm-item { display: flex; align-items: center; justify-content: space-between; font-size: 11px; padding: 2px 4px; border-radius: 2px; }
  .perm-item:hover { background: var(--vscode-list-hoverBackground); }
  .perm-code { font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 3px 0; }
  .toggle-label { font-size: 12px; }
  .toggle-sub { font-size: 11px; color: var(--vscode-descriptionForeground); }
  input[type="checkbox"] { width: 14px; height: 14px; cursor: pointer; }
  input[type="number"], input[type="text"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border,transparent); border-radius: 2px; padding: 2px 6px; font-size: 12px; width: 100%; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border,transparent); border-radius: 2px; padding: 2px 4px; font-size: 12px; width: 100%; }
  .section-empty { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 0; }
  .hook-status { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot-on  { background: var(--vscode-testing-iconPassed); }
  .dot-off { background: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<script>const DATA = ${payload};</script>
<div id="root"></div>
<script>
(function() {
const { active, activeInfo, contexts, archived, settings, perms, hookInstalled } = DATA;

const root = document.getElementById('root');
const vsc = acquireVsCodeApi();
const send = (type, payload) => vsc.postMessage({ type, payload });

function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'className') el.className = v;
            else if (k === 'style') el.style.cssText = v;
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
            else el.setAttribute(k, v);
        }
    }
    for (const c of children) {
        if (c == null) continue;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
}

function section(title, open, ...children) {
    const details = h('details', open ? { open: '' } : {});
    details.appendChild(h('summary', null, title));
    for (const c of children) { if (c) details.appendChild(c); }
    return details;
}

function btn(label, cls, onClick) {
    return h('button', { className: cls || '', onClick }, label);
}

// ── Active Context ───────────────────────────────────────────────────────────
function renderActive() {
    const card = h('div', { className: 'card' });
    if (!active || !activeInfo) {
        card.appendChild(h('div', { className: 'card-value' }, 'No active context'));
        card.appendChild(h('div', { className: 'card-meta' }, 'Select or create a context to begin.'));
        const row = h('div', { className: 'btn-row' });
        row.appendChild(btn('New', '', () => send('cmd', { command: 'ai.newContext' })));
        row.appendChild(btn('Set Active', 'secondary', () => send('cmd', { command: 'ai.setActiveContext' })));
        card.appendChild(row);
        return card;
    }

    card.appendChild(h('div', { className: 'card-label' }, 'Active Context'));
    card.appendChild(h('div', { className: 'card-value' }, activeInfo.name));
    if (activeInfo.root) card.appendChild(h('div', { className: 'card-meta' }, activeInfo.root));
    if (activeInfo.task && activeInfo.task !== 'init') {
        card.appendChild(h('div', { className: 'card-meta', style: 'margin-top:4px' }, '\u{1F4CB} ' + activeInfo.task));
    }
    if (activeInfo.next) {
        card.appendChild(h('div', { className: 'card-meta' }, '\u{27A1} ' + activeInfo.next));
    }

    const metaRow = h('div', { className: 'card-meta', style: 'margin-top:4px;display:flex;gap:6px;align-items:center;flex-wrap:wrap' });
    metaRow.appendChild(h('span', null, 'Last used: ' + activeInfo.lastUsed));
    if (activeInfo.permCount > 0) metaRow.appendChild(h('span', { className: 'badge badge-ok' }, activeInfo.permCount + ' perms'));
    if (activeInfo.archStale) {
        const label = activeInfo.archAge === null ? 'arch missing' : 'arch stale';
        metaRow.appendChild(h('span', { className: 'badge badge-stale' }, label));
    } else {
        metaRow.appendChild(h('span', { className: 'badge badge-ok' }, 'arch fresh'));
    }
    card.appendChild(metaRow);

    if (activeInfo.health.length > 0) {
        for (const w of activeInfo.health) {
            card.appendChild(h('div', { className: 'warning' }, '⚠ ' + w));
        }
    }

    const row = h('div', { className: 'btn-row' });
    row.appendChild(btn('Re-inject', '', () => send('cmd', { command: 'ai.reinjectContext' })));
    row.appendChild(btn('Switch', 'secondary', () => send('cmd', { command: 'ai.setActiveContext' })));
    row.appendChild(btn('View JSON', 'secondary', () => send('cmd', { command: 'ai.viewContext' })));
    row.appendChild(btn('Health', 'secondary', () => send('cmd', { command: 'ai.healthCheck' })));
    card.appendChild(row);
    return card;
}

// ── Contexts list ────────────────────────────────────────────────────────────
function renderContexts() {
    const wrap = document.createElement('div');

    if (contexts.length === 0) {
        wrap.appendChild(h('div', { className: 'section-empty' }, 'No contexts yet.'));
    } else {
        for (const ctx of contexts) {
            const item = h('div', { className: 'ctx-item' + (ctx.active ? ' active' : '') });
            const left = h('div', { style: 'flex:1;min-width:0' });
            left.appendChild(h('div', { className: 'ctx-name' }, ctx.name));
            if (ctx.root) left.appendChild(h('div', { className: 'ctx-meta' }, ctx.root));
            item.appendChild(left);
            item.appendChild(h('div', { className: 'ctx-meta' }, ctx.lastUsed));
            if (!ctx.active) {
                item.addEventListener('dblclick', () => {
                    send('activate', { name: ctx.name });
                });
            }
            wrap.appendChild(item);
        }
    }

    const row = h('div', { className: 'btn-row' });
    row.appendChild(btn('New', '', () => send('cmd', { command: 'ai.newContext' })));
    row.appendChild(btn('Search', 'secondary', () => send('cmd', { command: 'ai.searchContexts' })));
    if (archived.length > 0) row.appendChild(btn('Archived (' + archived.length + ')', 'secondary', () => send('cmd', { command: 'ai.cleanUpContexts' })));
    wrap.appendChild(row);
    return wrap;
}

// ── Hook ────────────────────────────────────────────────────────────────────
function renderHook() {
    const wrap = document.createElement('div');
    const status = h('div', { className: 'hook-status' });
    status.appendChild(h('div', { className: 'dot ' + (hookInstalled ? 'dot-on' : 'dot-off') }));
    status.appendChild(h('span', { style: 'font-size:12px' }, hookInstalled ? 'Claude Code hook installed' : 'Hook not installed'));
    wrap.appendChild(status);
    wrap.appendChild(h('div', { className: 'card-meta', style: 'margin-bottom:6px' },
        hookInstalled
            ? 'The Stop hook fires after every response and writes a heartbeat marker.'
            : 'Installing the hook enables session-level automation. Restart Claude Code after installing.'
    ));
    const row = h('div', { className: 'btn-row' });
    if (hookInstalled) {
        row.appendChild(btn('Uninstall', 'secondary', () => send('cmd', { command: 'ai.uninstallHook' })));
    } else {
        row.appendChild(btn('Install', '', () => send('cmd', { command: 'ai.installHook' })));
    }
    wrap.appendChild(row);
    return wrap;
}

// ── Behaviour ───────────────────────────────────────────────────────────────
function renderBehaviour() {
    const wrap = document.createElement('div');
    function row(label, key, val) {
        const el = h('div', { className: 'toggle-row' });
        el.appendChild(h('div', { className: 'toggle-label' }, label));
        const cb = h('input', { type: 'checkbox' });
        cb.checked = val;
        cb.addEventListener('change', () => send('setting', { key, value: cb.checked }));
        el.appendChild(cb);
        return el;
    }
    const s = settings;
    wrap.appendChild(row('Auto-detect context', 'autoDetect', s.autoDetect));
    wrap.appendChild(row('Follow active editor', 'followActiveEditor', s.followActiveEditor));
    wrap.appendChild(row('Follow terminal CWD', 'followTerminalCwd', s.followTerminalCwd));
    wrap.appendChild(row('Scan projects on launch', 'scanOnLaunch', s.scanOnLaunch));
    wrap.appendChild(row('Show notifications', 'showNotifications', s.showNotifications));
    wrap.appendChild(row('Auto-gitignore agent files', 'autoGitignore', s.autoGitignore));
    wrap.appendChild(row('Prevent removal capture', 'preventRemovalCapture', s.preventRemovalCapture));

    // Architecture max age
    const archRow = h('div', { className: 'toggle-row', style: 'margin-top:4px' });
    archRow.appendChild(h('div', { className: 'toggle-label' }, 'Arch stale after (days)'));
    const archInput = h('input', { type: 'number', style: 'width:60px', value: String(s.architectureMaxAgeDays) });
    archInput.addEventListener('change', () => send('setting', { key: 'architectureMaxAgeDays', value: Number(archInput.value) || 30 }));
    archRow.appendChild(archInput);
    wrap.appendChild(archRow);
    return wrap;
}

// ── Permissions ──────────────────────────────────────────────────────────────
function renderPerms() {
    const wrap = document.createElement('div');
    if (perms.length === 0) {
        wrap.appendChild(h('div', { className: 'section-empty' }, 'No context permissions stored.'));
    } else {
        for (const perm of perms) {
            const row = h('div', { className: 'perm-item' });
            row.appendChild(h('span', { className: 'perm-code' }, perm));
            const del = btn('×', 'secondary', () => send('removePerm', { perm }));
            del.style.fontSize = '11px';
            del.style.padding  = '0 4px';
            row.appendChild(del);
            wrap.appendChild(row);
        }
    }
    const row = h('div', { className: 'btn-row', style: 'margin-top:4px' });
    row.appendChild(btn('Apply to Claude', '', () => send('cmd', { command: 'ai.managePermissions' })));
    wrap.appendChild(row);
    return wrap;
}

// ── Build page ───────────────────────────────────────────────────────────────
root.appendChild(section('Active Context', true,  renderActive()));
root.appendChild(section('Contexts',       true,  renderContexts()));
root.appendChild(section('Hook',           true,  renderHook()));
root.appendChild(section('Permissions',    true,  renderPerms()));
root.appendChild(section('Behaviour',      false, renderBehaviour()));

})();
</script>
</body>
</html>`;
    }

    async _handleMessage(msg) {
        const ctxDir  = getCtxDir();
        const active  = this._wsState.get(ACTIVE_KEY) || null;
        const config  = vscode.workspace.getConfiguration('aiContext');

        if (msg.type === 'cmd') {
            await vscode.commands.executeCommand(msg.payload.command);
            this.refresh();
            return;
        }

        if (msg.type === 'activate') {
            const name = msg.payload.name;
            if (!name) return;
            this._wsState.update('ai.activeContext', name);
            autoInject(loadContext(ctxDir, name));
            writeActiveContext(name);
            this.refresh();
            return;
        }

        if (msg.type === 'setting') {
            const { key, value } = msg.payload;
            await config.update(key, value, vscode.ConfigurationTarget.Global);
            this.refresh();
            return;
        }

        if (msg.type === 'removePerm') {
            if (!active) return;
            const ctx  = loadContext(ctxDir, active);
            const allow = (ctx.perms?.allow || []).filter(p => p !== msg.payload.perm);
            saveContext(ctxDir, active, { ...ctx, perms: { allow } });
            this.refresh();
            return;
        }

        if (msg.type === 'createFromTemplate') {
            await vscode.commands.executeCommand('ai.newContextFromTemplate');
            this.refresh();
        }
    }
}

module.exports = { SettingsViewProvider };
