const fs = require('fs');
const path = require('path');
const os = require('os');

function readClaudeSettings() {
    try {
        const filePath = path.join(os.homedir(), '.claude', 'settings.json');
        if (!fs.existsSync(filePath)) return {};
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return {};
    }
}

function writeClaudeSettings(settings) {
    try {
        const filePath = path.join(os.homedir(), '.claude', 'settings.json');
        const content = JSON.stringify(settings, null, 2);
        fs.writeFileSync(filePath, content, 'utf-8');
    } catch (err) {
        console.error('Failed to write Claude settings:', err.message);
    }
}

function tokenizeCommand(cmdStr) {
    const tokens = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let i = 0;

    while (i < cmdStr.length) {
        const ch = cmdStr[i];

        if (ch === '\\' && i + 1 < cmdStr.length) {
            current += cmdStr[i] + cmdStr[i + 1];
            i += 2;
            continue;
        }

        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            current += ch;
            i++;
            continue;
        }

        if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            current += ch;
            i++;
            continue;
        }

        if ((ch === ' ' || ch === '\t') && !inSingleQuote && !inDoubleQuote) {
            if (current.trim()) tokens.push(current.trim());
            current = '';
            i++;
            continue;
        }

        current += ch;
        i++;
    }

    if (current.trim()) tokens.push(current.trim());
    return tokens;
}

function generalizePath(pathStr, projectRoot) {
    if (!pathStr || !projectRoot) return '*';

    const normalized = pathStr.replace(/\/$/, '');
    const projNorm = projectRoot.replace(/\/$/, '');

    if (normalized.startsWith(projNorm)) {
        const base = projNorm.split('/').slice(0, -1).join('/');
        return base + '/**';
    }

    const homeDir = os.homedir();
    if (normalized.startsWith(homeDir)) {
        const parts = normalized.split('/');
        if (parts.length > 4) {
            const base = parts.slice(0, 3).join('/');
            return base + '/**';
        }
    }

    return '*';
}

function isPathLike(token) {
    return token.startsWith('/') || token.includes('/') || token.startsWith('~');
}

function isFlag(token) {
    return token.startsWith('-') && token.length > 1 && token[1] !== '/';
}

function isSubcommandLike(token) {
    return /^[a-zA-Z0-9._\-]+$/.test(token) && !token.startsWith('-') && !token.startsWith('/');
}

function generalizeClaudePerm(rawPerm, projectRoot) {
    if (!rawPerm || typeof rawPerm !== 'string') return '';

    const parenMatch = rawPerm.match(/^(\w+)\((.*)\)$/);
    if (!parenMatch) {
        return rawPerm.trim();
    }

    const [, tool, cmdStr] = parenMatch;

    const tokens = tokenizeCommand(cmdStr);
    if (tokens.length === 0) return `${tool}(*)`;

    const rebuilt = [];
    let lastWasFlag = false;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (isFlag(token)) {
            rebuilt.push(token);
            lastWasFlag = true;
            continue;
        }

        if (lastWasFlag) {
            rebuilt.push('*');
            return `${tool}(${rebuilt.join(' ')})`;
        }

        if (isSubcommandLike(token)) {
            rebuilt.push(token);
            continue;
        }

        rebuilt.push('*');
        return `${tool}(${rebuilt.join(' ')})`;
    }

    if (rebuilt.length === 0 || !rebuilt[rebuilt.length - 1].endsWith('*')) {
        rebuilt.push('*');
    }

    const pattern = rebuilt.join(' ');
    return `${tool}(${pattern})`;
}

function isClaudePermCovered(candidate, existingPerms) {
    if (!candidate || !Array.isArray(existingPerms)) return false;

    for (const existing of existingPerms) {
        if (existing === candidate) return true;
    }

    // Extract inner command from "Tool(command)" format
    const candidateMatch = candidate.match(/^(\w+)\((.*)\)$/);
    if (!candidateMatch) return false;
    const [, candTool, candCmd] = candidateMatch;

    for (const existing of existingPerms) {
        const existingMatch = existing.match(/^(\w+)\((.*)\)$/);
        if (!existingMatch) continue;
        const [, exTool, exCmd] = existingMatch;

        if (candTool !== exTool) continue;

        if (exCmd.endsWith('*')) {
            const exPrefix = exCmd.slice(0, -1).trim();
            const candTrimmed = candCmd.trim();
            if (exPrefix === '' || candTrimmed.startsWith(exPrefix)) return true;
        }
    }

    return false;
}

function captureNewClaudePerms(beforeAllow, afterAllow, projectRoot, existingPerms = [], preventRemovalCapture = false) {
    if (!Array.isArray(beforeAllow) || !Array.isArray(afterAllow)) return [];

    const beforeSet = new Set(beforeAllow);
    let newRaw = afterAllow.filter(p => !beforeSet.has(p));

    if (preventRemovalCapture) {
        newRaw = newRaw.filter(perm => {
            const m = perm.match(/^(\w+)\((.*)\)$/);
            if (!m) return true;
            const [, tool, cmd] = m;
            if (tool.toLowerCase() === 'bash' && isRemovalCommand(cmd)) return false;
            return true;
        });
    }

    const result = [];
    for (const raw of newRaw) {
        const generalized = generalizeClaudePerm(raw, projectRoot);
        if (!isClaudePermCovered(generalized, [...existingPerms, ...result])) {
            result.push(generalized);
        }
    }

    return result;
}

function applyClaudePerms(storedPerms) {
    if (!Array.isArray(storedPerms) || storedPerms.length === 0) return;

    const settings = readClaudeSettings();

    if (!settings.permissions) settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

    const existing = settings.permissions.allow;
    for (const perm of storedPerms) {
        if (!isClaudePermCovered(perm, existing)) {
            existing.push(perm);
        }
    }

    writeClaudeSettings(settings);
}

// ── Removal command detection ─────────────────────────────────────────────────

// Patterns for commands the extension must never auto-allow when the
// "Prevent Removal Capture" toggle is on. Covers OS file removal, database
// DDL/DML destructives (SQL + NoSQL), container/orchestrator deletes, cloud
// CLI delete subcommands, IaC destroys, package uninstalls, and git
// destructives. Designed to match RAW commands (with quoted SQL strings
// intact) — apply the filter BEFORE generalization so wildcards don't hide
// destructive content.
const REMOVAL_PATTERNS = [
    // ── OS file removal ──
    /^(rm|rmdir|del|erase|remove|wipe|unlink|uninstall|purge)$/i,
    /^rm\b/i,
    /^rmdir\b/i,
    /^del\b/i,
    /^erase\b/i,
    /^unlink\b/i,
    /^find\b.*\s-delete\b/i,
    /^find\b.*\s-exec\s+rm\b/i,

    // ── Database destructive (SQL DDL/DML) ──
    /\bdrop\s+(table|database|schema|index|view|function|procedure|trigger|sequence|tablespace|role|user|owned|materialized\s+view|extension)\b/i,
    /\btruncate\s+(table|only)\b/i,
    /\bdelete\s+from\b/i,
    /\bdrop\s+if\s+exists\b/i,
    /\balter\s+table\s+\S+\s+drop\b/i, // ALTER TABLE foo DROP COLUMN/CONSTRAINT/...

    // ── NoSQL destructive (MongoDB shell / mongosh) ──
    /\b(?:db\.\w+\.)?drop\s*\(\s*\)/i,
    /\b(?:db\.\w+\.)?(deleteMany|deleteOne|remove)\s*\(/i,
    /\b(?:db\.\w+\.)?dropIndex(?:es)?\s*\(/i,
    /\bdropDatabase\s*\(/i,

    // ── Redis destructive ──
    /^redis-cli\b.*\b(flushall|flushdb|del)\b/i,
    /\b(flushall|flushdb)\b/i,

    // ── Container / orchestrator destructive ──
    /^(docker|podman)\s+(rm|rmi)\b/i,
    /^(docker|podman)\s+(volume|network|container|image|stack|service|secret|config|pod|system)\s+(rm|rmi|prune)\b/i,
    /^kubectl\s+(delete|drain)\b/i,
    /^helm\s+(delete|uninstall)\b/i,

    // ── Cloud CLIs — delete in subcommand position ──
    /^aws\s+\S+\s+(delete|rm|rb)\b/i,
    /^aws\s+s3\s+(rm|rb)\b/i,
    /^gcloud\s+\S+(\s+\S+)*\s+delete\b/i,
    /^az\s+\S+(\s+\S+)*\s+delete\b/i,

    // ── IaC destructive ──
    /^terraform\s+destroy\b/i,
    /^terraform\s+state\s+rm\b/i,
    /^terraform\s+apply\s+-destroy\b/i,
    /^pulumi\s+destroy\b/i,

    // ── Package manager uninstall / remove ──
    /^(npm|yarn|pnpm)\s+(uninstall|remove|rm)\b/i,
    /^pip3?\s+uninstall\b/i,
    /^cargo\s+remove\b/i,
    /^(apt|apt-get)\s+(remove|purge|autoremove)\b/i,
    /^dnf\s+(remove|erase|autoremove)\b/i,
    /^yum\s+(remove|erase)\b/i,
    /^brew\s+(uninstall|remove)\b/i,
    /^pacman\s+-R/i,

    // ── Git destructive / history-rewriting ──
    /^git\s+rm\b/i,
    /^git\s+reset\s+--hard\b/i,
    /^git\s+clean\s+-[a-z]*[fdx]/i,
    /^git\s+(branch|tag)\s+-[Dd]\b/i,
    /^git\s+push\b.*\s(?:-f|--force|--force-with-lease|--delete)\b/i,
    /^git\s+update-ref\s+-d\b/i,
    /^git\s+filter-branch\b/i,
    /^git\s+filter-repo\b/i,

    // ── Generic destructive verbs as standalone commands ──
    /^drop\b/i,
    /^destroy\b/i,
    /^truncate\b/i,
    /^wipe\b/i,
];

function isRemovalCommand(cmdStr) {
    if (!cmdStr || typeof cmdStr !== 'string') return false;
    const trimmed = cmdStr.trim();
    for (const pattern of REMOVAL_PATTERNS) {
        if (pattern.test(trimmed)) return true;
    }
    return false;
}

function filterRemovalCommands(commands) {
    if (!Array.isArray(commands)) return [];
    return commands.filter(cmd => !isRemovalCommand(cmd));
}

function hasRemovalCommands(claudePerms) {
    if (!Array.isArray(claudePerms)) return false;
    for (const perm of claudePerms) {
        const m = perm.match(/^(\w+)\((.*)\)$/);
        if (!m) continue;
        const [, tool, cmd] = m;
        if (tool.toLowerCase() === 'bash' && isRemovalCommand(cmd)) return true;
    }
    return false;
}

function purgeRemovalCommandsFromAllow(allowList) {
    if (!Array.isArray(allowList)) return [];
    return allowList.filter(perm => {
        const m = perm.match(/^(\w+)\((.*)\)$/);
        if (!m) return true;
        const [, tool, cmd] = m;
        if (tool.toLowerCase() === 'bash' && isRemovalCommand(cmd)) return false;
        return true;
    });
}



// Filter that drops removal commands when the aiContext.preventRemovalCapture
// toggle is on. Wraps purgeRemovalCommandsFromAllow so all watchers can use a
// consistent gate without each repeating the toggle check. Pass the boolean
// directly so this stays vscode-free (the caller reads the config).
function applyRemovalFilter(allowEntries, preventRemovalEnabled) {
    if (!preventRemovalEnabled) return allowEntries;
    return purgeRemovalCommandsFromAllow(allowEntries);
}

function listRemovalCommands(contextAllow) {
    const result = [];

    for (const perm of (contextAllow || [])) {
        const m = perm.match(/^(\w+)\((.+)\)$/);
        if (!m) continue;
        if (m[1].toLowerCase() === 'bash' && isRemovalCommand(m[2])) {
            result.push({ source: 'context', perm });
        }
    }

    const claudeAllow = readClaudeSettings()?.permissions?.allow || [];
    for (const perm of claudeAllow) {
        const m = perm.match(/^(\w+)\((.+)\)$/);
        if (!m) continue;
        if (m[1].toLowerCase() === 'bash' && isRemovalCommand(m[2])) {
            result.push({ source: 'claude', perm });
        }
    }

    return result;
}

function removeRemovalCommandFromClaudeGlobal(perm) {
    const settings = readClaudeSettings();
    if (!settings.permissions || !Array.isArray(settings.permissions.allow)) return false;
    const before = settings.permissions.allow.length;
    settings.permissions.allow = settings.permissions.allow.filter(p => p !== perm);
    if (settings.permissions.allow.length === before) return false;
    writeClaudeSettings(settings);
    return true;
}

function purgeRemovalMemory() {
    const settings = readClaudeSettings();
    if (!settings.permissions) settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

    const before = settings.permissions.allow.length;
    settings.permissions.allow = purgeRemovalCommandsFromAllow(settings.permissions.allow);
    const removed = before - settings.permissions.allow.length;
    writeClaudeSettings(settings);

    return { removed, claude: removed };
}

function consolidatePermissionsToGlobal(contexts, loadContext, saveContext) {
    if (!Array.isArray(contexts) || contexts.length === 0) return { consolidated: [], count: 0 };

    const patternFreq = {};
    const patternToProjects = {};

    for (const ctxName of contexts) {
        try {
            const ctx = loadContext(ctxName);
            const allowPerms = (ctx.perms && ctx.perms.allow) ? ctx.perms.allow : [];

            for (const perm of allowPerms) {
                if (!patternFreq[perm]) {
                    patternFreq[perm] = 0;
                    patternToProjects[perm] = [];
                }
                patternFreq[perm]++;
                patternToProjects[perm].push(ctxName);
            }
        } catch {
            // Skip invalid contexts
        }
    }

    const toPromote = Object.entries(patternFreq)
        .filter(([, freq]) => freq >= 2)
        .map(([perm]) => perm);

    if (toPromote.length === 0) return { consolidated: [], count: 0 };

    applyClaudePerms(toPromote);

    for (const ctxName of contexts) {
        try {
            const ctx = loadContext(ctxName);
            const allowPerms = (ctx.perms && ctx.perms.allow) ? ctx.perms.allow : [];
            const filtered = allowPerms.filter(p => !toPromote.includes(p));

            if (filtered.length !== allowPerms.length) {
                saveContext(ctxName, { ...ctx, perms: { ...ctx.perms, allow: filtered } });
            }
        } catch {
            // Skip invalid contexts
        }
    }

    return { consolidated: toPromote, count: toPromote.length };
}

// ── Claude Code "quick settings" (global ~/.claude/settings.json) ─────────────
// These keys live at the top level of settings.json (or one level deep for
// permissions.defaultMode) and are GLOBAL — not per-project, unlike the Codex
// trust/sandbox settings. The CLAUDE SETTINGS sidebar section reads current
// values via readClaudeRunSettings() and writes single keys via
// applyClaudeSetting(). Booleans that Claude Code treats as on-by-default are
// reported as enabled when absent, so the UI toggle reflects real behavior
// rather than showing "off" for a setting that is effectively on.
function readClaudeRunSettings() {
    const s = readClaudeSettings();
    const perms = s.permissions && typeof s.permissions === 'object' && !Array.isArray(s.permissions) ? s.permissions : {};
    return {
        model:                    typeof s.model === 'string' ? s.model : '',
        effortLevel:              typeof s.effortLevel === 'string' ? s.effortLevel : '',
        permDefaultMode:          typeof perms.defaultMode === 'string' ? perms.defaultMode : 'default',
        // Default-on booleans: absent counts as enabled.
        alwaysThinkingEnabled:    s.alwaysThinkingEnabled !== false,
        autoCompactEnabled:       s.autoCompactEnabled !== false,
        fileCheckpointingEnabled: s.fileCheckpointingEnabled !== false,
        // Default-off booleans: enabled only when explicitly true.
        fastMode:                 s.fastMode === true,
        showThinkingSummaries:    s.showThinkingSummaries === true,
    };
}

// Writes a single key into ~/.claude/settings.json, preserving everything else.
// `key` may be a one-level dotted path ("permissions.defaultMode") for nested
// keys — that covers every current quick setting. A null/undefined value
// deletes the key, reverting to the Claude Code default.
function applyClaudeSetting(key, value) {
    const s = readClaudeSettings();
    const dot = key.indexOf('.');
    if (dot === -1) {
        if (value === null || value === undefined) delete s[key];
        else s[key] = value;
    } else {
        const parent = key.slice(0, dot);
        const child  = key.slice(dot + 1);
        if (!s[parent] || typeof s[parent] !== 'object' || Array.isArray(s[parent])) s[parent] = {};
        if (value === null || value === undefined) delete s[parent][child];
        else s[parent][child] = value;
    }
    writeClaudeSettings(s);
}

module.exports = {
    readClaudeSettings,
    writeClaudeSettings,
    readClaudeRunSettings,
    applyClaudeSetting,
    generalizeClaudePerm,
    isClaudePermCovered,
    captureNewClaudePerms,
    applyClaudePerms,
    consolidatePermissionsToGlobal,
    isRemovalCommand,
    filterRemovalCommands,
    hasRemovalCommands,
    purgeRemovalCommandsFromAllow,
    purgeRemovalMemory,
    listRemovalCommands,
    removeRemovalCommandFromClaudeGlobal,
    applyRemovalFilter,
    __test: {
        generalizeClaudePerm,
        isClaudePermCovered,
        captureNewClaudePerms,
        tokenizeCommand,
        generalizePath,
    },
};
