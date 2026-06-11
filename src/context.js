const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CONTEXT_VERSION = 3;
const DEFAULT_MAX_ACTIONS = 40;
const DEFAULT_MAX_HISTORY = 12;
const MEMORY_LIMITS = {
    b: 15,
    c: 20,
    d: 20,
    f: 30,
    h: DEFAULT_MAX_HISTORY,
};
const COMPACTION_VERSION = 1;

function getCtxDir() {
    const config   = vscode.workspace.getConfiguration('aiContext');
    const override = config.get('contextDir');
    if (override && override.trim()) return normalizePath(override.trim());
    return path.join(os.homedir(), '.ai-context');
}

function getArchiveDir() {
    return path.join(getCtxDir(), 'archive');
}

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0
        ? normalizePath(folders[0].uri.fsPath)
        : os.homedir();
}

// Resolves ~ and trims trailing slashes for consistent prefix matching.
function normalizePath(p) {
    if (!p || typeof p !== 'string') return p;
    p = p.trim();
    if (p.startsWith('~')) p = os.homedir() + p.slice(1);
    return p.replace(/\/+$/, '');
}

function getProjectsRoot() {
    const config     = vscode.workspace.getConfiguration('aiContext');
    const configured = config.get('projectsRoot');
    if (configured && configured.trim()) return normalizePath(configured.trim());
    return path.join(os.homedir(), 'projects');
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function asList(value) {
    if (!Array.isArray(value)) return [];
    const seen   = new Set();
    const result = [];
    for (let i = value.length - 1; i >= 0; i--) {
        if (value[i] === null || value[i] === undefined) continue;
        const item = String(value[i]).trim();
        if (!item || seen.has(item)) continue;
        seen.add(item);
        result.unshift(item);
    }
    return result;
}

function trimList(value, max) {
    return asList(value).slice(-max);
}

function compactText(value, maxLength = 80) {
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function summarizeActions(actions, date = new Date()) {
    const items = asList(actions).map(action => compactText(action));
    if (items.length === 0) return null;
    const shown = items.length <= 8
        ? items
        : [...items.slice(0, 4), '...', ...items.slice(-4)];
    const day   = date.toISOString().slice(0, 10);
    const label = items.length === 1 ? 'action' : 'actions';
    return compactText(`${day}: compacted ${items.length} older ${label}: ${shown.join(' -> ')}`, 600);
}

function compactActions(actions, history, maxActions = DEFAULT_MAX_ACTIONS) {
    const cleanActions = asList(actions);
    const cleanHistory = asList(history);
    const max = Number.isFinite(maxActions) && maxActions > 0
        ? Math.floor(maxActions)
        : DEFAULT_MAX_ACTIONS;
    if (cleanActions.length <= max) {
        return {
            actions: cleanActions,
            history: cleanHistory.slice(-MEMORY_LIMITS.h),
            compacted: false,
        };
    }
    const overflow = cleanActions.slice(0, cleanActions.length - max);
    const summary  = summarizeActions(overflow);
    return {
        actions: cleanActions.slice(-max),
        history: summary ? [...cleanHistory, summary].slice(-MEMORY_LIMITS.h) : cleanHistory.slice(-MEMORY_LIMITS.h),
        compacted: !!summary,
    };
}

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getMaxActions() {
    const config     = vscode.workspace.getConfiguration('aiContext');
    const configured = Number(config.get('maxActions'));
    if (!Number.isFinite(configured) || configured < 1) return DEFAULT_MAX_ACTIONS;
    return Math.min(Math.floor(configured), 200);
}

function createDefaultContext(name, root = '') {
    return {
        v:         DEFAULT_CONTEXT_VERSION,
        u:         os.userInfo().username,
        p:         name,
        root:      normalizePath(root || ''),
        t:         'init',
        s:         {},
        n:         '',
        b:         [],
        d:         [],
        c:         [],
        f:         [],
        h:         [],
        a:         [],
        e:         null,
        i:         '',
        arch:      null,
        m:         { compactedAt: null, compactionVersion: COMPACTION_VERSION },
        createdAt: new Date().toISOString(),
        lastUsed:  null,
        perms:     { allow: [] },
    };
}

function normalizeArch(src) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
    return {
        summary:     typeof src.summary === 'string' ? src.summary : '',
        stack:       Array.isArray(src.stack) ? src.stack.filter(s => typeof s === 'string') : [],
        keyFiles:    Array.isArray(src.keyFiles) ? src.keyFiles : [],
        patterns:    Array.isArray(src.patterns) ? src.patterns.filter(s => typeof s === 'string') : [],
        avoid:       Array.isArray(src.avoid) ? src.avoid.filter(s => typeof s === 'string') : [],
        lastAudited: typeof src.lastAudited === 'string' ? src.lastAudited : null,
    };
}

// Returns true if architecture state is absent or older than maxAgeDays.
function isArchStale(ctx, maxAgeDays) {
    const maxDays = typeof maxAgeDays === 'number' && maxAgeDays > 0 ? maxAgeDays : 30;
    if (!ctx || !ctx.arch || !ctx.arch.lastAudited) return true;
    const audited = new Date(ctx.arch.lastAudited);
    if (isNaN(audited.getTime())) return true;
    return (Date.now() - audited.getTime()) / 86400000 > maxDays;
}

function normalizeContext(ctx, name) {
    const base = createDefaultContext(name);
    const src  = ctx && typeof ctx === 'object' ? ctx : {};
    const compacted = compactActions(src.a, src.h, getMaxActions());
    const srcMeta = asObject(src.m);
    const srcMem  = asObject(src.mem);
    const m = {
        ...base.m,
        ...srcMeta,
        compactionVersion: COMPACTION_VERSION,
        compactedAt: compacted.compacted ? new Date().toISOString() : (srcMeta.compactedAt || null),
    };
    const srcPerms = src.perms && typeof src.perms === 'object' && !Array.isArray(src.perms) ? src.perms : {};
    const rawAllow = srcPerms.allow || [];
    const perms = {
        allow: Array.isArray(rawAllow) ? rawAllow.filter(p => typeof p === 'string' && p.trim()) : [],
    };
    return {
        ...base,
        ...src,
        v:         Number.isInteger(src.v) ? Math.max(src.v, DEFAULT_CONTEXT_VERSION) : base.v,
        u:         src.u || base.u,
        p:         src.p || name || base.p,
        root:      normalizePath(src.root || base.root),
        t:         src.t || base.t,
        s:         asObject(src.s),
        n:         src.n || '',
        b:         trimList(Array.isArray(src.b) ? src.b : srcMem.b, MEMORY_LIMITS.b),
        d:         trimList(Array.isArray(src.d) ? src.d : srcMem.d, MEMORY_LIMITS.d),
        c:         trimList(Array.isArray(src.c) ? src.c : srcMem.c, MEMORY_LIMITS.c),
        f:         trimList(Array.isArray(src.f) ? src.f : srcMem.f, MEMORY_LIMITS.f),
        h:         compacted.history,
        a:         compacted.actions,
        e:         src.e === undefined ? null : src.e,
        i:         src.i || '',
        arch:      normalizeArch(src.arch),
        m,
        perms,
        createdAt: src.createdAt || base.createdAt,
        lastUsed:  src.lastUsed || null,
    };
}

function listContexts(dir) {
    ensureDir(dir);
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.basename(f, '.json'));
}

function listArchivedContexts() {
    const archiveDir = getArchiveDir();
    if (!fs.existsSync(archiveDir)) return [];
    return fs.readdirSync(archiveDir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.basename(f, '.json'));
}

function loadContext(dir, name) {
    const file = path.join(dir, `${name}.json`);
    if (!fs.existsSync(file)) return createDefaultContext(name);
    try {
        return normalizeContext(JSON.parse(fs.readFileSync(file, 'utf8')), name);
    } catch {
        return { ...createDefaultContext(name), e: 'ctx_parse_err', createdAt: null };
    }
}

function loadArchivedContext(name) {
    const file = path.join(getArchiveDir(), `${name}.json`);
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return { root: '', lastUsed: null, createdAt: null };
    }
}

function saveContext(dir, name, ctx) {
    ensureDir(dir);
    const next = normalizeContext(ctx, name);
    fs.writeFileSync(
        path.join(dir, `${name}.json`),
        JSON.stringify({ ...next, lastUsed: new Date().toISOString() })
    );
}

function deleteContext(dir, name) {
    const file = path.join(dir, `${name}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

function archiveContext(dir, name) {
    const src        = path.join(dir, `${name}.json`);
    const archiveDir = getArchiveDir();
    ensureDir(archiveDir);
    let dest = path.join(archiveDir, `${name}.json`);
    if (fs.existsSync(dest)) dest = path.join(archiveDir, `${name}_${Date.now()}.json`);
    fs.renameSync(src, dest);
    return path.basename(dest, '.json');
}

function restoreArchivedContext(archiveName) {
    const archiveDir = getArchiveDir();
    const src        = path.join(archiveDir, `${archiveName}.json`);
    const dir        = getCtxDir();
    ensureDir(dir);
    const baseName = archiveName.replace(/_\d{13}$/, '');
    let destName   = baseName;
    let dest       = path.join(dir, `${destName}.json`);
    let counter    = 1;
    while (fs.existsSync(dest)) {
        destName = `${baseName}_restored_${counter++}`;
        dest     = path.join(dir, `${destName}.json`);
    }
    fs.renameSync(src, dest);
    return destName;
}

function listProjectDirs() {
    const projectsDir = getProjectsRoot();
    if (!fs.existsSync(projectsDir)) return [];
    try {
        return fs.readdirSync(projectsDir)
            .filter(f => {
                try { return fs.statSync(path.join(projectsDir, f)).isDirectory(); } catch { return false; }
            })
            .map(f => ({ label: f, path: path.join(projectsDir, f) }));
    } catch {
        return [];
    }
}

function scanAndCreateContexts(dir, projectsRoot) {
    const normalized = normalizePath(projectsRoot);
    if (!normalized || !fs.existsSync(normalized)) return [];
    const existingRoots = new Set(
        listContexts(dir)
            .map(name => normalizePath(loadContext(dir, name).root))
            .filter(Boolean)
    );
    const created = [];
    try {
        const entries = fs.readdirSync(normalized).filter(f => {
            try { return fs.statSync(path.join(normalized, f)).isDirectory(); } catch { return false; }
        });
        for (const entry of entries) {
            const projectPath = normalizePath(path.join(normalized, entry));
            if (!existingRoots.has(projectPath)) {
                let ctxName = entry;
                let counter = 1;
                while (fs.existsSync(path.join(dir, `${ctxName}.json`))) {
                    ctxName = `${entry}_${counter++}`;
                }
                saveContext(dir, ctxName, createDefaultContext(entry, projectPath));
                created.push(ctxName);
            }
        }
    } catch {
        // ignore scan errors
    }
    return created;
}

function searchContexts(dir, query) {
    if (!query || !query.trim()) return [];
    const q = query.trim().toLowerCase();
    return listContexts(dir)
        .map(name => {
            const ctx = loadContext(dir, name);
            let score = 0;
            if (ctx.p    && ctx.p.toLowerCase().includes(q))    score += 3;
            if (ctx.root && ctx.root.toLowerCase().includes(q)) score += 2;
            if (ctx.n    && ctx.n.toLowerCase().includes(q))    score += 2;
            if (asList(ctx.f).some(v => v.toLowerCase().includes(q))) score += 1;
            if (asList(ctx.d).some(v => v.toLowerCase().includes(q))) score += 1;
            if (asList(ctx.c).some(v => v.toLowerCase().includes(q))) score += 1;
            return score > 0 ? { name, root: ctx.root || '', note: ctx.n || '', lastUsed: ctx.lastUsed, score } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
}

function checkContextHealth(ctx) {
    const warnings = [];
    if (!ctx.root || !ctx.root.trim()) {
        warnings.push('No project root set');
    } else {
        if (!fs.existsSync(ctx.root)) warnings.push(`Root path not found: ${ctx.root}`);
        else if (!fs.existsSync(path.join(ctx.root, '.git'))) warnings.push('Root is not a git repository');
    }
    for (const f of asList(ctx.f)) {
        const abs = path.isAbsolute(f) ? f : ctx.root ? path.join(ctx.root, f) : null;
        if (abs && !fs.existsSync(abs)) warnings.push(`Missing file: ${f}`);
    }
    if (ctx.lastUsed) {
        const days = Math.floor((Date.now() - new Date(ctx.lastUsed).getTime()) / 86400000);
        if (days > 30) warnings.push(`Stale — last used ${days} days ago`);
    }
    const maxA = DEFAULT_MAX_ACTIONS;
    if (Array.isArray(ctx.a) && ctx.a.length >= maxA * 0.9) warnings.push('Actions near compaction limit');
    if (ctx.e) warnings.push(`Parse error flag: ${ctx.e}`);
    return { ok: warnings.length === 0, warnings };
}

function listTemplates(dir) {
    return listContexts(dir).filter(name => {
        const ctx = loadContext(dir, name);
        return ctx.m && ctx.m.isTemplate === true;
    });
}

function createFromTemplate(dir, templateName, newName, root) {
    const tmpl = loadContext(dir, templateName);
    const base = createDefaultContext(newName, root || '');
    saveContext(dir, newName, {
        ...base,
        b: asList(tmpl.b),
        d: asList(tmpl.d),
        c: asList(tmpl.c),
        f: asList(tmpl.f),
        n: tmpl.n || '',
        i: tmpl.i || '',
    });
}

function formatRelativeTime(isoString) {
    if (!isoString) return 'never';
    const diff    = Date.now() - new Date(isoString).getTime();
    const minutes = Math.floor(diff / 60000);
    const hours   = Math.floor(diff / 3600000);
    const days    = Math.floor(diff / 86400000);
    const months  = Math.floor(days / 30);
    const years   = Math.floor(days / 365);
    if (minutes < 1)  return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24)   return `${hours}h ago`;
    if (days < 30)    return `${days}d ago`;
    if (months < 12)  return `${months} month${months !== 1 ? 's' : ''} ago`;
    return `${years} year${years !== 1 ? 's' : ''} ago`;
}

module.exports = {
    DEFAULT_CONTEXT_VERSION,
    DEFAULT_MAX_ACTIONS,
    DEFAULT_MAX_HISTORY,
    getCtxDir,
    getArchiveDir,
    getWorkspaceRoot,
    getProjectsRoot,
    normalizePath,
    ensureDir,
    createDefaultContext,
    normalizeContext,
    summarizeActions,
    compactActions,
    isArchStale,
    listContexts,
    listArchivedContexts,
    loadContext,
    loadArchivedContext,
    saveContext,
    deleteContext,
    archiveContext,
    restoreArchivedContext,
    listProjectDirs,
    scanAndCreateContexts,
    formatRelativeTime,
    searchContexts,
    checkContextHealth,
    listTemplates,
    createFromTemplate,
};
