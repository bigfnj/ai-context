const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { ensureDir, normalizePath, getCtxDir, isArchStale } = require('./context');

const INJECT_START = '<!-- AI_CTX_START -->';
const INJECT_END   = '<!-- AI_CTX_END -->';
const AGENT_CONTEXT_NAME = 'AI_CONTEXT';

const GITIGNORE_SEED_PATTERNS = [
    'CLAUDE.md',
    'AGENTS.md',
    '.github/copilot-instructions.md',
    '.cursorrules',
    '.windsurfrules',
    'SESSION_LOG*.md',
    'SESSION_HANDOFF*.md',
];

const CODEX_REPO_SCAN_MAX_DEPTH = 4;
const CODEX_REPO_SCAN_SKIP_DIRS = new Set([
    '.git', '.vs', '.vscode', 'bin', 'build', 'coverage', 'dist',
    'node_modules', 'obj', 'out', 'packages',
]);

function uniquePaths(paths) {
    const seen = new Set();
    const result = [];
    for (const filePath of paths) {
        const normalized = normalizePath(filePath);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function isGitRepoRoot(dir) {
    try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

function findGitRepoRoots(root, maxDepth = CODEX_REPO_SCAN_MAX_DEPTH) {
    const normalizedRoot = normalizePath(root);
    if (!normalizedRoot || !fs.existsSync(normalizedRoot)) return [];
    const repos = [];
    const walk = (dir, depth) => {
        if (isGitRepoRoot(dir)) repos.push(dir);
        if (depth >= maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (CODEX_REPO_SCAN_SKIP_DIRS.has(entry.name)) continue;
            walk(path.join(dir, entry.name), depth + 1);
        }
    };
    walk(normalizedRoot, 0);
    return uniquePaths(repos);
}

function getCodexTargets(root) {
    return uniquePaths([
        path.join(root, 'AGENTS.md'),
        ...findGitRepoRoots(root).map(repoRoot => path.join(repoRoot, 'AGENTS.md')),
    ]);
}

const AGENT_TARGETS = {
    claude:   root => [path.join(root, 'CLAUDE.md')],
    codex:    root => getCodexTargets(root),
    copilot:  root => [path.join(root, '.github', 'copilot-instructions.md')],
    cursor:   root => [path.join(root, '.cursorrules')],
    windsurf: root => [path.join(root, '.windsurfrules')],
    kilo:     root => getCodexTargets(root),
};

function getAgents() {
    const config = vscode.workspace.getConfiguration('aiContext');
    const agents = config.get('agents');
    return Array.isArray(agents) && agents.length > 0
        ? agents
        : ['claude', 'copilot'];
}

function getInjectionTargets(root) {
    const seen    = new Set();
    const targets = [];
    for (const agent of getAgents()) {
        const fn = AGENT_TARGETS[agent];
        if (!fn) continue;
        for (const filePath of fn(root)) {
            const norm = normalizePath(filePath);
            if (norm && !seen.has(norm)) {
                seen.add(norm);
                targets.push(filePath);
            }
        }
    }
    return targets;
}

// Returns agent-specific paths that are global (outside any project root) — e.g.
// ~/.claude/CLAUDE.md which Claude Code reads on every session regardless of CWD.
// These are injected alongside project targets but are never gitignored.
// Only applies when the context root is under projectsRoot (~/projects by default) —
// home-directory or other top-level roots are excluded.
function getGlobalTargets(root) {
    const agents = getAgents();
    if (!agents.includes('claude')) return [];

    if (root) {
        const config = vscode.workspace.getConfiguration('aiContext');
        const raw = (config.get('projectsRoot') || '').trim();
        const projectsRoot = raw
            ? path.resolve(raw.replace(/^~(?=\/|$)/, os.homedir()))
            : path.join(os.homedir(), 'projects');
        const normalized = path.resolve(normalizePath(root));
        if (!normalized.startsWith(projectsRoot + path.sep) && normalized !== projectsRoot) {
            return [];
        }
    }

    return [path.join(os.homedir(), '.claude', 'CLAUDE.md')];
}

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function buildAgentContext(ctx) {
    const result = {
        v:    ctx.v || 3,
        p:    ctx.p || '',
        root: ctx.root || '',
        t:    ctx.t || '',
        i:    ctx.i || '',
        n:    ctx.n || '',
        s:    asObject(ctx.s),
        b:    asArray(ctx.b),
        d:    asArray(ctx.d),
        c:    asArray(ctx.c),
        f:    asArray(ctx.f),
        h:    asArray(ctx.h),
        a:    asArray(ctx.a),
        e:    ctx.e === undefined ? null : ctx.e,
    };
    const allow = ctx.perms && Array.isArray(ctx.perms.allow) ? ctx.perms.allow : [];
    if (allow.length > 0) result.perms = { allow };
    if (ctx.arch) result.arch = ctx.arch;
    return result;
}

function extractContextFromFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const range   = findMarkedRange(content, INJECT_START, INJECT_END);
        if (!range) return null;
        const block = content.slice(range.start, range.end);
        for (const line of block.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith(`${AGENT_CONTEXT_NAME}=`)) {
                return JSON.parse(trimmed.slice(AGENT_CONTEXT_NAME.length + 1));
            }
        }
    } catch { /* unparseable */ }
    return null;
}

function getArchMaxAgeDays() {
    const config = vscode.workspace.getConfiguration('aiContext');
    const val = Number(config.get('architectureMaxAgeDays'));
    return Number.isFinite(val) && val > 0 ? val : 30;
}

// Returns the human-readable architecture section for the injection block.
function buildArchSection(ctx) {
    const maxDays = getArchMaxAgeDays();
    const arch    = ctx.arch;

    if (!arch || !arch.lastAudited) {
        return [
            '### Architecture  ⚠ NOT INITIALIZED',
            'No architecture state exists for this project. Before starting work:',
            '1. Audit the codebase — explore key files, understand the structure and patterns.',
            '2. Include an `arch` field in your first CTX_UPDATE (format below).',
        ].join('\n');
    }

    const audited    = new Date(arch.lastAudited);
    const ageDays    = Math.floor((Date.now() - audited.getTime()) / 86400000);
    const stale      = isArchStale(ctx, maxDays);
    const statusLine = stale
        ? `### Architecture  ⚠ STALE (${ageDays}d old — limit ${maxDays}d)`
        : `### Architecture  ✓ fresh (${ageDays}d old)`;

    const lines = [statusLine];
    if (stale) {
        lines.push(
            `Architecture state is ${ageDays} days old. Before starting work:`,
            '1. Check recent git commits for structural changes (`git log --oneline -20`).',
            '2. Update the `arch` field in your first CTX_UPDATE if anything significant changed.',
        );
    }
    if (arch.summary) lines.push(`**Summary:** ${arch.summary}`);
    if (arch.stack && arch.stack.length > 0) lines.push(`**Stack:** ${arch.stack.join(', ')}`);
    if (arch.keyFiles && arch.keyFiles.length > 0) {
        lines.push('**Key Files:**');
        for (const kf of arch.keyFiles) {
            if (typeof kf === 'string') {
                lines.push(`- \`${kf}\``);
            } else if (kf && kf.path) {
                lines.push(`- \`${kf.path}\`${kf.role ? ` — ${kf.role}` : ''}`);
            }
        }
    }
    if (arch.patterns && arch.patterns.length > 0) lines.push(`**Patterns:** ${arch.patterns.join('; ')}`);
    if (arch.avoid && arch.avoid.length > 0) lines.push(`**Avoid:** ${arch.avoid.join('; ')}`);
    return lines.join('\n');
}

// Returns the human-readable session section for the injection block.
function buildSessionSection(ctx) {
    const lines = ['### Session'];
    if (ctx.t && ctx.t !== 'init') lines.push(`**Task:** ${ctx.t}`);
    if (ctx.i) lines.push(`**Intent:** ${ctx.i}`);
    if (ctx.n) lines.push(`**Next:** ${ctx.n}`);
    const d = asArray(ctx.d);
    if (d.length > 0) { lines.push('**Decisions:**'); d.forEach(x => lines.push(`- ${x}`)); }
    const c = asArray(ctx.c);
    if (c.length > 0) { lines.push('**Constraints:**'); c.forEach(x => lines.push(`- ${x}`)); }
    const b = asArray(ctx.b);
    if (b.length > 0) { lines.push('**Blockers:**'); b.forEach(x => lines.push(`- ${x}`)); }
    const a = asArray(ctx.a);
    if (a.length > 0) {
        lines.push('**Recent:**');
        a.slice(-8).forEach(x => lines.push(`- ${x}`));
    }
    return lines.join('\n');
}

// Returns the CTX_UPDATE instructions section.
function buildUpdateInstructions(ctx, storePath, archStale) {
    const sidecar = storePath ? `${storePath}.update` : `~/.ai-context/${ctx.p || 'context'}.json.update`;
    const lines = [
        '### Update Instructions',
        `After EVERY response, write a single line to \`${sidecar}\`:`,
        '```',
        'CTX_UPDATE:{"n":"next step","a":["action taken"],"d":["new decision"],"c":["constraint"],"b":["blocker"]}',
        '```',
    ];
    if (archStale) {
        lines.push(
            '',
            'Architecture is stale or missing — include the `arch` field in your first CTX_UPDATE:',
            '```',
            'CTX_UPDATE:{"arch":{"summary":"...","stack":["Node.js","React"],"keyFiles":[{"path":"src/index.js","role":"entry point"}],"patterns":["..."],"avoid":["..."],"lastAudited":"' + new Date().toISOString() + '"},"n":"..."}',
            '```',
        );
    }
    lines.push('', 'Write ONLY to the sidecar file above — never include `CTX_UPDATE:` in chat output.');
    return lines.join('\n');
}

function buildInjectionBlock(ctx, storePath) {
    const projected = buildAgentContext(ctx);
    const maxDays   = getArchMaxAgeDays();
    const archStale = isArchStale(ctx, maxDays);

    const parts = [
        `${AGENT_CONTEXT_NAME}=${JSON.stringify(projected)}`,
        '',
        `## AI Context — ${ctx.p || 'Project'}`,
        '',
        buildArchSection(ctx),
        '',
        buildSessionSection(ctx),
        '',
        buildUpdateInstructions(ctx, storePath, archStale),
    ];
    return parts.join('\n');
}

function buildMultiInjectionBlock(contexts, storePathsByName) {
    const valid = (contexts || []).filter(c => c && c.p);
    if (valid.length === 0) return '';
    if (valid.length === 1) {
        const ctx = valid[0];
        return buildInjectionBlock(ctx, storePathsByName[ctx.p] || null);
    }

    const lines = [];
    for (const ctx of valid) {
        lines.push(`${AGENT_CONTEXT_NAME}=${JSON.stringify(buildAgentContext(ctx))}`);
    }
    lines.push(
        '',
        `Multiple ${AGENT_CONTEXT_NAME} entries are active. Use the entry whose "p" matches the project you are working in.`,
        '',
        'After each response, write a single CTX_UPDATE line for whichever context received material changes:',
    );
    for (const ctx of valid) {
        const sp = storePathsByName[ctx.p];
        if (sp) lines.push(`  - p="${ctx.p}" → ${sp}.update`);
    }
    lines.push(
        '',
        'Do NOT include any `CTX_UPDATE:` line in your visible chat reply — only the sidecar file is consumed by the extension.',
    );
    return lines.join('\n');
}

function findMarkedRange(content, startMarker, endMarker) {
    const start = content.indexOf(startMarker);
    if (start === -1) return null;
    const endStart = content.indexOf(endMarker, start);
    const end      = endStart === -1 ? content.length : endStart + endMarker.length;
    return { start, end };
}

function findInjectionRange(content) {
    return findMarkedRange(content, INJECT_START, INJECT_END);
}

function injectMarkedBlock(filePath, blockContent, startMarker, endMarker) {
    ensureDir(path.dirname(filePath));
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const block    = `${startMarker}\n${blockContent}\n${endMarker}`;
    const range    = findMarkedRange(existing, startMarker, endMarker);
    let next;
    if (range) {
        next = existing.slice(0, range.start) + block + existing.slice(range.end);
    } else {
        const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
        next = existing + sep + block + '\n';
    }
    if (next === existing) return false;
    fs.writeFileSync(filePath, next);
    return true;
}

// Strips stray CTX_UPDATE lines that leaked outside our marker block into the
// agent file. The instruction template INSIDE the block is preserved.
function scrubLeakedContextUpdates(content) {
    const stripLines = (s) => s
        .split('\n')
        .filter(l => !l.trim().startsWith('CTX_UPDATE:'))
        .join('\n');
    const range = findMarkedRange(content, INJECT_START, INJECT_END);
    if (!range) return stripLines(content);
    return stripLines(content.slice(0, range.start))
        + content.slice(range.start, range.end)
        + stripLines(content.slice(range.end));
}

function injectIntoFile(filePath, blockContent) {
    if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, 'utf8');
        const cleaned  = scrubLeakedContextUpdates(existing);
        if (cleaned !== existing) fs.writeFileSync(filePath, cleaned);
    }
    injectMarkedBlock(filePath, blockContent, INJECT_START, INJECT_END);
}

function clearMarkedBlock(filePath, startMarker, endMarker) {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    const range   = findMarkedRange(content, startMarker, endMarker);
    if (!range) return;
    const before = content.slice(0, range.start).trimEnd();
    const after  = content.slice(range.end).trimStart();
    const next   = [before, after].filter(Boolean).join('\n\n');
    fs.writeFileSync(filePath, next ? `${next}\n` : '');
}

function clearInjection(filePath) {
    clearMarkedBlock(filePath, INJECT_START, INJECT_END);
}

function getGitignoreRoot(projectRoot, filePath) {
    const boundary = path.resolve(normalizePath(projectRoot));
    let dir = path.resolve(path.dirname(filePath));
    while (dir === boundary || dir.startsWith(boundary + path.sep)) {
        if (isGitRepoRoot(dir)) return dir;
        if (dir === boundary) break;
        dir = path.dirname(dir);
    }
    return boundary;
}

function updateGitignoreFile(gitignoreRoot, targetPaths) {
    const gitignorePath = path.join(gitignoreRoot, '.gitignore');
    let content = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, 'utf8')
        : '';
    const lines = content.split('\n').map(l => l.trim());
    const toAdd = [];
    for (const filePath of targetPaths) {
        const rel = path.relative(gitignoreRoot, filePath).replace(/\\/g, '/');
        if (!lines.includes(rel)) toAdd.push(rel);
    }
    for (const pattern of GITIGNORE_SEED_PATTERNS) {
        if (!lines.includes(pattern) && !toAdd.includes(pattern)) toAdd.push(pattern);
    }
    if (toAdd.length === 0) return;
    const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, content + sep + toAdd.join('\n') + '\n');
}

function updateGitignore(projectRoot, targetPaths) {
    const grouped = new Map();
    for (const filePath of targetPaths) {
        const gitignoreRoot = getGitignoreRoot(projectRoot, filePath);
        const paths = grouped.get(gitignoreRoot) || [];
        paths.push(filePath);
        grouped.set(gitignoreRoot, paths);
    }
    for (const [gitignoreRoot, paths] of grouped) {
        updateGitignoreFile(gitignoreRoot, paths);
    }
}

function ensureUntrackedInGit(filePath, repoRoot) {
    try {
        execSync(`git ls-files --error-unmatch "${filePath}"`,
            { cwd: repoRoot, stdio: 'ignore', timeout: 4000 });
        execSync(`git rm --cached "${filePath}"`,
            { cwd: repoRoot, stdio: 'ignore', timeout: 4000 });
    } catch { /* not tracked or no git */ }
}

function getValidContextRoot(ctx) {
    const root = ctx.root && ctx.root.trim() ? normalizePath(ctx.root) : '';
    if (!root) return null;
    try {
        return fs.existsSync(root) && fs.statSync(root).isDirectory() ? root : null;
    } catch {
        return null;
    }
}

function autoInject(ctx) {
    return autoInjectMulti(ctx, []);
}

function autoInjectMulti(primaryCtx, secondaryCtxs) {
    const root = getValidContextRoot(primaryCtx);
    if (!root) return false;

    const ctxDir  = getCtxDir();
    const allCtxs = [primaryCtx, ...(secondaryCtxs || []).filter(c => c && c.p && c.p !== primaryCtx.p)];
    const storePaths = {};
    for (const c of allCtxs) {
        if (c.p) storePaths[c.p] = path.join(ctxDir, `${c.p}.json`);
    }

    const block         = buildMultiInjectionBlock(allCtxs, storePaths);
    const targets       = getInjectionTargets(root);
    const globalTargets = getGlobalTargets(root);

    for (const filePath of [...targets, ...globalTargets]) injectIntoFile(filePath, block);
    for (const filePath of targets) ensureUntrackedInGit(filePath, root);

    const config = vscode.workspace.getConfiguration('aiContext');
    if (config.get('autoGitignore')) updateGitignore(root, targets);
    return true;
}

function clearInjectionForContext(ctx) {
    const root = getValidContextRoot(ctx);
    if (!root) return false;
    for (const filePath of getInjectionTargets(root)) clearInjection(filePath);
    for (const filePath of getGlobalTargets(root)) clearInjection(filePath);
    return true;
}

module.exports = {
    INJECT_START,
    INJECT_END,
    AGENT_CONTEXT_NAME,
    AGENT_TARGETS,
    GITIGNORE_SEED_PATTERNS,
    getAgents,
    getInjectionTargets,
    getGlobalTargets,
    findGitRepoRoots,
    getCodexTargets,
    buildAgentContext,
    buildInjectionBlock,
    buildMultiInjectionBlock,
    findInjectionRange,
    findMarkedRange,
    getGitignoreRoot,
    getValidContextRoot,
    injectIntoFile,
    clearInjection,
    injectMarkedBlock,
    clearMarkedBlock,
    scrubLeakedContextUpdates,
    updateGitignore,
    updateGitignoreFile,
    ensureUntrackedInGit,
    clearInjectionForContext,
    extractContextFromFile,
    autoInject,
    autoInjectMulti,
};
