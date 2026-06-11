const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SettingsViewProvider } = require('./settingsView');
const { installHook, uninstallHook, isHookInstalled, writeActiveContext } = require('./hook');

const {
    readClaudeSettings, captureNewClaudePerms, isClaudePermCovered, applyClaudePerms,
    consolidatePermissionsToGlobal, hasRemovalCommands, purgeRemovalMemory,
    listRemovalCommands, removeRemovalCommandFromClaudeGlobal, applyRemovalFilter,
} = require('./permissions');

const {
    getCtxDir, listContexts, listArchivedContexts, loadContext, loadArchivedContext,
    saveContext, deleteContext, archiveContext, restoreArchivedContext, listProjectDirs,
    getProjectsRoot, normalizePath, createDefaultContext, getWorkspaceRoot,
    scanAndCreateContexts, formatRelativeTime, searchContexts, checkContextHealth,
    listTemplates, createFromTemplate,
} = require('./context');

const {
    autoInject, autoInjectMulti, clearInjectionForContext, getAgents,
    getInjectionTargets, extractContextFromFile,
} = require('./inject');

const ACTIVE_KEY   = 'ai.activeContext';
const PREVIOUS_KEY = 'ai.previousContext';

// Parses a CTX_UPDATE:{...} line written by an agent into a sidecar file.
function extractContextUpdate(content) {
    if (!content || typeof content !== 'string') return null;
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('CTX_UPDATE:')) {
            try { return JSON.parse(trimmed.slice('CTX_UPDATE:'.length)); } catch { return null; }
        }
    }
    return null;
}

// ── State helpers ─────────────────────────────────────────────────────────────

function getActive(wsState) { return wsState.get(ACTIVE_KEY) || null; }
function getPrevious(wsState) { return wsState.get(PREVIOUS_KEY) || null; }
async function setActive(wsState, name) { return wsState.update(ACTIVE_KEY, name); }

// ── Path helpers (also exposed via __test) ────────────────────────────────────

function isSameOrChildPath(parent, child) {
    if (!parent || !child) return false;
    const p = normalizePath(parent);
    const c = normalizePath(child);
    return c === p || c.startsWith(p + '/');
}

function getEditorPath(editor) {
    if (!editor || !editor.document) return null;
    const { scheme, fsPath } = editor.document.uri;
    if (scheme !== 'file') return null;
    return normalizePath(fsPath);
}

function getTerminalCwd(terminal) {
    if (!terminal || !terminal.shellIntegration) return null;
    const cwd = terminal.shellIntegration.cwd;
    if (!cwd) return null;
    if (typeof cwd === 'string') return normalizePath(cwd);
    if (cwd.fsPath) return normalizePath(cwd.fsPath);
    return null;
}

// ── Context switching ─────────────────────────────────────────────────────────

// Finds the best matching context for filePath and switches to it.
// Returns the matched context name, or null if no match found.
function syncActiveContextForPath(ctxDir, wsState, filePath, opts = {}) {
    if (!filePath) return null;
    const normalized = normalizePath(filePath);
    const names = listContexts(ctxDir);
    let best = null;
    let bestLen = 0;
    for (const name of names) {
        const ctx = loadContext(ctxDir, name);
        const root = ctx.root ? normalizePath(ctx.root) : '';
        if (root && isSameOrChildPath(root, normalized) && root.length > bestLen) {
            best    = name;
            bestLen = root.length;
        }
    }
    if (!best) return null;
    const current = getActive(wsState);
    if (best === current) return best;
    wsState.update(ACTIVE_KEY, best);
    wsState.update(PREVIOUS_KEY, current || null);
    const ctx = loadContext(ctxDir, best);
    autoInject(ctx);
    writeActiveContext(best);
    if (opts.notify !== false) {
        const config = vscode.workspace.getConfiguration('aiContext');
        if (config.get('showNotifications')) {
            vscode.window.showInformationMessage(`AI Context: switched to "${best}"`);
        }
    }
    return best;
}

// ── Sidecar merge ─────────────────────────────────────────────────────────────

// Merges a CTX_UPDATE payload into the stored context and re-injects.
function mergeContextUpdate(ctxDir, name, update) {
    if (!update || !name) return;
    const ctx  = loadContext(ctxDir, name);
    const next = { ...ctx };

    if (update.t) next.t = update.t;
    if (update.i) next.i = update.i;
    if (update.n) next.n = update.n;
    if (update.s && typeof update.s === 'object') next.s = { ...ctx.s, ...update.s };
    if (Array.isArray(update.a) && update.a.length > 0)
        next.a = [...(ctx.a || []), ...update.a];
    if (Array.isArray(update.d) && update.d.length > 0)
        next.d = [...new Set([...(ctx.d || []), ...update.d])];
    if (Array.isArray(update.c) && update.c.length > 0)
        next.c = [...new Set([...(ctx.c || []), ...update.c])];
    if (Array.isArray(update.b)) next.b = update.b;
    if (Array.isArray(update.f) && update.f.length > 0)
        next.f = [...new Set([...(ctx.f || []), ...update.f])];
    if (update.arch && typeof update.arch === 'object') next.arch = update.arch;
    if (update.e !== undefined) next.e = update.e;

    saveContext(ctxDir, name, next);
    autoInject(loadContext(ctxDir, name));
}

// ── Activation ────────────────────────────────────────────────────────────────

function activate(context) {
    const wsState = context.workspaceState;
    const ctxDir  = getCtxDir();

    // ── Settings view ─────────────────────────────────────────────────────────
    const settingsProvider = new SettingsViewProvider(context.extensionUri, wsState);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('aiContext.settingsView', settingsProvider)
    );

    // ── File watchers ─────────────────────────────────────────────────────────

    // Context store: re-inject when .json files change externally.
    const ctxWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(ctxDir, '*.json')
    );
    ctxWatcher.onDidChange(uri => {
        const name    = path.basename(uri.fsPath, '.json');
        const active  = getActive(wsState);
        if (name === active) autoInject(loadContext(ctxDir, name));
        settingsProvider.refresh();
    });
    ctxWatcher.onDidCreate(() => settingsProvider.refresh());
    context.subscriptions.push(ctxWatcher);

    // Sidecar: agent wrote CTX_UPDATE → merge and re-inject.
    const updateWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(ctxDir, '*.json.update')
    );
    updateWatcher.onDidCreate(uri => handleSidecar(uri.fsPath));
    updateWatcher.onDidChange(uri => handleSidecar(uri.fsPath));
    context.subscriptions.push(updateWatcher);

    function handleSidecar(filePath) {
        const base = path.basename(filePath, '.json.update');
        try {
            const raw    = fs.readFileSync(filePath, 'utf8');
            const update = extractContextUpdate(raw);
            fs.unlinkSync(filePath);
            if (update) {
                mergeContextUpdate(ctxDir, base, update);
                settingsProvider.refresh();
            }
        } catch { /* race — file may already be gone */ }
    }

    // .cwd file: shell PROMPT_COMMAND writes $PWD here for zero-friction switching.
    const cwdFile = path.join(ctxDir, '.cwd');
    if (fs.existsSync(path.dirname(cwdFile))) {
        const cwdWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(ctxDir, '.cwd')
        );
        cwdWatcher.onDidChange(() => {
            try {
                const cwd = fs.readFileSync(cwdFile, 'utf8').trim();
                if (cwd) syncActiveContextForPath(ctxDir, wsState, cwd, { notify: true });
            } catch { /* ignore */ }
        });
        context.subscriptions.push(cwdWatcher);
    }

    // Claude settings watcher: captures new permissions as they are granted.
    const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let claudeSettingsBefore = null;
    try {
        claudeSettingsBefore = readClaudeSettings()?.permissions?.allow || [];
    } catch { claudeSettingsBefore = []; }

    const claudeDir = path.join(os.homedir(), '.claude');
    if (fs.existsSync(claudeDir)) {
        const claudeWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(claudeDir, 'settings.json')
        );
        claudeWatcher.onDidChange(() => {
            const active = getActive(wsState);
            if (!active) return;
            const config = vscode.workspace.getConfiguration('aiContext');
            const preventRemoval = config.get('preventRemovalCapture') || false;
            try {
                const afterAllow  = readClaudeSettings()?.permissions?.allow || [];
                const ctx         = loadContext(ctxDir, active);
                const existingCtx = ctx.perms?.allow || [];
                const captured    = captureNewClaudePerms(
                    claudeSettingsBefore, afterAllow,
                    ctx.root || '',
                    existingCtx,
                    preventRemoval
                );
                claudeSettingsBefore = afterAllow;
                if (captured.length > 0) {
                    saveContext(ctxDir, active, {
                        ...ctx, perms: { allow: [...existingCtx, ...captured] },
                    });
                    settingsProvider.refresh();
                }
            } catch { /* settings may be mid-write */ }
        });
        context.subscriptions.push(claudeWatcher);
    }

    // ── Auto-detect on startup ────────────────────────────────────────────────

    const config = vscode.workspace.getConfiguration('aiContext');
    if (config.get('scanOnLaunch')) {
        scanAndCreateContexts(ctxDir, getProjectsRoot());
    }

    // Inject active context (or try to detect one).
    const currentActive = getActive(wsState);
    if (currentActive && listContexts(ctxDir).includes(currentActive)) {
        const ctx = loadContext(ctxDir, currentActive);
        autoInject(ctx);
        writeActiveContext(currentActive);
    } else if (config.get('autoDetect')) {
        const wsRoot = getWorkspaceRoot();
        if (wsRoot) syncActiveContextForPath(ctxDir, wsState, wsRoot, { notify: false });
    }

    // Follow active editor.
    if (config.get('followActiveEditor')) {
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (!vscode.workspace.getConfiguration('aiContext').get('followActiveEditor')) return;
                const p = getEditorPath(editor);
                if (p) syncActiveContextForPath(ctxDir, wsState, p, { notify: true });
            })
        );
    }

    // Follow terminal CWD.
    if (config.get('followTerminalCwd')) {
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTerminal(terminal => {
                if (!vscode.workspace.getConfiguration('aiContext').get('followTerminalCwd')) return;
                const cwd = getTerminalCwd(terminal);
                if (cwd) syncActiveContextForPath(ctxDir, wsState, cwd, { notify: true });
            })
        );
    }

    // Workspace folder change.
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            if (!vscode.workspace.getConfiguration('aiContext').get('autoDetect')) return;
            const wsRoot = getWorkspaceRoot();
            if (wsRoot) syncActiveContextForPath(ctxDir, wsState, wsRoot, { notify: true });
        })
    );

    // ── Commands ──────────────────────────────────────────────────────────────

    const reg = (cmd, fn) => context.subscriptions.push(
        vscode.commands.registerCommand(cmd, fn)
    );

    reg('ai.setActiveContext', async () => {
        const names = listContexts(ctxDir);
        if (names.length === 0) {
            vscode.window.showWarningMessage('No contexts found. Create one first.');
            return;
        }
        const pick = await vscode.window.showQuickPick(names, { placeHolder: 'Select active context' });
        if (!pick) return;
        const prev = getActive(wsState);
        await setActive(wsState, pick);
        await wsState.update(PREVIOUS_KEY, prev || null);
        autoInject(loadContext(ctxDir, pick));
        writeActiveContext(pick);
        settingsProvider.refresh();
    });

    reg('ai.viewContext', async () => {
        const active = getActive(wsState);
        if (!active) { vscode.window.showWarningMessage('No active context.'); return; }
        const ctx   = loadContext(ctxDir, active);
        const json  = JSON.stringify(ctx, null, 2);
        const doc   = await vscode.workspace.openTextDocument({ content: json, language: 'json' });
        await vscode.window.showTextDocument(doc);
    });

    reg('ai.newContext', async () => {
        const name = await vscode.window.showInputBox({ prompt: 'Context name', placeHolder: 'MyProject' });
        if (!name || !name.trim()) return;
        const cleanName = name.trim();
        if (listContexts(ctxDir).includes(cleanName)) {
            vscode.window.showWarningMessage(`Context "${cleanName}" already exists.`);
            return;
        }
        const dirs   = listProjectDirs().map(d => d.path);
        const rootPick = await vscode.window.showQuickPick(
            [...dirs, '$(folder) Browse...', '(none)'],
            { placeHolder: 'Select project root' }
        );
        let root = '';
        if (rootPick && rootPick !== '(none)' && !rootPick.startsWith('$(')) root = rootPick;
        saveContext(ctxDir, cleanName, createDefaultContext(cleanName, root));
        await setActive(wsState, cleanName);
        autoInject(loadContext(ctxDir, cleanName));
        writeActiveContext(cleanName);
        settingsProvider.refresh();
    });

    reg('ai.deleteContext', async () => {
        const names = listContexts(ctxDir);
        if (names.length === 0) { vscode.window.showWarningMessage('No contexts to delete.'); return; }
        const pick = await vscode.window.showQuickPick(names, { placeHolder: 'Delete context' });
        if (!pick) return;
        const confirm = await vscode.window.showWarningMessage(
            `Archive "${pick}"?`, { modal: true }, 'Archive', 'Delete permanently'
        );
        if (!confirm) return;
        const ctx = loadContext(ctxDir, pick);
        clearInjectionForContext(ctx);
        if (confirm === 'Archive') {
            archiveContext(ctxDir, pick);
        } else {
            deleteContext(ctxDir, pick);
        }
        if (getActive(wsState) === pick) {
            await setActive(wsState, null);
            writeActiveContext(null);
        }
        settingsProvider.refresh();
    });

    reg('ai.cleanUpContexts', async () => {
        const archived = listArchivedContexts();
        if (archived.length === 0) { vscode.window.showInformationMessage('No archived contexts.'); return; }
        const pick = await vscode.window.showQuickPick(
            ['Delete ALL archived', ...archived], { placeHolder: 'Select archived context to delete' }
        );
        if (!pick) return;
        const archiveDir = path.join(ctxDir, 'archive');
        if (pick === 'Delete ALL archived') {
            for (const name of archived) {
                try { fs.unlinkSync(path.join(archiveDir, `${name}.json`)); } catch { /* ok */ }
            }
        } else {
            try { fs.unlinkSync(path.join(archiveDir, `${pick}.json`)); } catch { /* ok */ }
        }
        settingsProvider.refresh();
    });

    reg('ai.restoreContext', async () => {
        const archived = listArchivedContexts();
        if (archived.length === 0) { vscode.window.showInformationMessage('No archived contexts to restore.'); return; }
        const pick = await vscode.window.showQuickPick(archived, { placeHolder: 'Restore context' });
        if (!pick) return;
        const restored = restoreArchivedContext(pick);
        vscode.window.showInformationMessage(`Restored as "${restored}"`);
        settingsProvider.refresh();
    });

    reg('ai.reinjectContext', async () => {
        const active = getActive(wsState);
        if (!active) { vscode.window.showWarningMessage('No active context.'); return; }
        autoInject(loadContext(ctxDir, active));
        vscode.window.showInformationMessage(`Re-injected context "${active}"`);
    });

    reg('ai.managePermissions', async () => {
        const active = getActive(wsState);
        if (!active) { vscode.window.showWarningMessage('No active context.'); return; }
        const ctx    = loadContext(ctxDir, active);
        const allow  = ctx.perms?.allow || [];
        const picks  = [
            '$(add) Apply context permissions to Claude',
            '$(trash) Purge removal commands from Claude global',
            '$(list-flat) Consolidate common permissions to global',
            '$(close) Clear all context permissions',
        ];
        const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Permissions action' });
        if (!pick) return;
        if (pick.includes('Apply context')) {
            applyClaudePerms(allow);
            vscode.window.showInformationMessage(`Applied ${allow.length} permission(s) to Claude settings.`);
        } else if (pick.includes('Purge removal')) {
            const result = purgeRemovalMemory();
            vscode.window.showInformationMessage(`Removed ${result.removed} removal command(s).`);
        } else if (pick.includes('Consolidate')) {
            const all = listContexts(ctxDir);
            const result = consolidatePermissionsToGlobal(
                all,
                (n) => loadContext(ctxDir, n),
                (n, c) => saveContext(ctxDir, n, c)
            );
            vscode.window.showInformationMessage(`Consolidated ${result.count} pattern(s) to global.`);
        } else if (pick.includes('Clear all')) {
            saveContext(ctxDir, active, { ...ctx, perms: { allow: [] } });
            settingsProvider.refresh();
        }
    });

    reg('ai.config', () => settingsProvider.show());
    reg('ai.openSettingsPanel', () => settingsProvider.show());

    reg('ai.duplicateContext', async () => {
        const names = listContexts(ctxDir);
        if (names.length === 0) { vscode.window.showWarningMessage('No contexts to duplicate.'); return; }
        const pick = await vscode.window.showQuickPick(names, { placeHolder: 'Duplicate context' });
        if (!pick) return;
        const newName = await vscode.window.showInputBox({ prompt: 'New context name', value: `${pick}_copy` });
        if (!newName || !newName.trim()) return;
        const src = loadContext(ctxDir, pick);
        saveContext(ctxDir, newName.trim(), { ...src, p: newName.trim() });
        settingsProvider.refresh();
    });

    reg('ai.searchContexts', async () => {
        const query = await vscode.window.showInputBox({ prompt: 'Search contexts', placeHolder: 'keyword' });
        if (!query) return;
        const results = searchContexts(ctxDir, query);
        if (results.length === 0) { vscode.window.showInformationMessage('No matching contexts.'); return; }
        const items = results.map(r => ({ label: r.name, description: r.note || r.root, detail: `Last used: ${formatRelativeTime(r.lastUsed)}` }));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select to activate' });
        if (!pick) return;
        const prev = getActive(wsState);
        await setActive(wsState, pick.label);
        await wsState.update(PREVIOUS_KEY, prev || null);
        autoInject(loadContext(ctxDir, pick.label));
        writeActiveContext(pick.label);
        settingsProvider.refresh();
    });

    reg('ai.healthCheck', async () => {
        const active = getActive(wsState);
        if (!active) { vscode.window.showWarningMessage('No active context.'); return; }
        const ctx    = loadContext(ctxDir, active);
        const health = checkContextHealth(ctx);
        if (health.ok) {
            vscode.window.showInformationMessage(`Context "${active}" is healthy.`);
        } else {
            vscode.window.showWarningMessage(`"${active}" has issues:\n${health.warnings.join('\n')}`);
        }
    });

    reg('ai.saveAsTemplate', async () => {
        const active = getActive(wsState);
        if (!active) { vscode.window.showWarningMessage('No active context.'); return; }
        const ctx  = loadContext(ctxDir, active);
        const name = await vscode.window.showInputBox({ prompt: 'Template name', value: `${active}-template` });
        if (!name || !name.trim()) return;
        saveContext(ctxDir, name.trim(), { ...ctx, p: name.trim(), m: { ...ctx.m, isTemplate: true } });
        vscode.window.showInformationMessage(`Saved template "${name.trim()}"`);
        settingsProvider.refresh();
    });

    reg('ai.newContextFromTemplate', async () => {
        const templates = listTemplates(ctxDir);
        if (templates.length === 0) { vscode.window.showInformationMessage('No templates found.'); return; }
        const tmpl = await vscode.window.showQuickPick(templates, { placeHolder: 'Select template' });
        if (!tmpl) return;
        const name = await vscode.window.showInputBox({ prompt: 'New context name' });
        if (!name || !name.trim()) return;
        createFromTemplate(ctxDir, tmpl, name.trim(), '');
        settingsProvider.refresh();
    });

    reg('ai.installHook', async () => {
        const result = installHook();
        if (result.alreadyInstalled) {
            vscode.window.showInformationMessage('Claude Code hook is already installed.');
        } else {
            vscode.window.showInformationMessage('Claude Code Stop hook installed. Restart Claude Code to activate.');
        }
        settingsProvider.refresh();
    });

    reg('ai.uninstallHook', async () => {
        uninstallHook();
        vscode.window.showInformationMessage('Claude Code Stop hook removed.');
        settingsProvider.refresh();
    });
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
    __test: {
        isSameOrChildPath,
        getEditorPath,
        getTerminalCwd,
        syncActiveContextForPath,
        mergeContextUpdate,
        extractContextUpdate,
    },
};
