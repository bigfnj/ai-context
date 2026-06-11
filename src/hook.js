const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_SCRIPT_DIR  = path.join(os.homedir(), '.ai-context', 'hooks');
const HOOK_SCRIPT_PATH = path.join(HOOK_SCRIPT_DIR, 'session-end.sh');
const ACTIVE_FILE      = path.join(os.homedir(), '.ai-context', '.active');

// Minimal hook script — fires after every Claude Code Stop event.
// Writes a .session marker so external tooling can confirm the hook is running.
// Future iterations can parse the event payload and extract CTX_UPDATE directly.
const HOOK_SCRIPT = [
    '#!/bin/bash',
    '# AI Context — session-end hook (managed by the AI Context VS Code extension)',
    '# Fires after every Claude Code response (Stop event).',
    '# Edit via: AI Context → Hook → Uninstall / re-install with customizations.',
    '',
    'CTX_DIR="$HOME/.ai-context"',
    'ACTIVE_FILE="$CTX_DIR/.active"',
    '',
    '[ -f "$ACTIVE_FILE" ] || exit 0',
    'CONTEXT_NAME=$(cat "$ACTIVE_FILE" 2>/dev/null)',
    '[ -n "$CONTEXT_NAME" ] || exit 0',
    '',
    '# Touch a heartbeat file so the extension can confirm the hook is active.',
    'touch "$CTX_DIR/${CONTEXT_NAME}.json.heartbeat"',
    '',
    'exit 0',
].join('\n') + '\n';

function readClaudeSettings() {
    const p = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(p)) return {};
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeClaudeSettings(settings) {
    const p   = path.join(os.homedir(), '.claude', 'settings.json');
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf8');
}

function isHookInstalled() {
    const s = readClaudeSettings();
    const stopGroups = (s && s.hooks && Array.isArray(s.hooks.Stop)) ? s.hooks.Stop : [];
    for (const group of stopGroups) {
        for (const h of (group.hooks || [])) {
            if (h.type === 'command' && typeof h.command === 'string'
                && h.command.includes('session-end.sh')) return true;
        }
    }
    return false;
}

function installHook() {
    if (!fs.existsSync(HOOK_SCRIPT_DIR)) fs.mkdirSync(HOOK_SCRIPT_DIR, { recursive: true });
    fs.writeFileSync(HOOK_SCRIPT_PATH, HOOK_SCRIPT, { mode: 0o755 });

    if (isHookInstalled()) return { ok: true, alreadyInstalled: true };

    const settings = readClaudeSettings();
    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: HOOK_SCRIPT_PATH }] });
    writeClaudeSettings(settings);
    return { ok: true };
}

function uninstallHook() {
    const settings = readClaudeSettings();
    if (!settings.hooks || !Array.isArray(settings.hooks.Stop)) return { ok: true };
    settings.hooks.Stop = settings.hooks.Stop.filter(group =>
        !(group.hooks || []).some(h => h.type === 'command'
            && typeof h.command === 'string' && h.command.includes('session-end.sh'))
    );
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeClaudeSettings(settings);
    return { ok: true };
}

// Writes the name of the currently active context to ~/.ai-context/.active
// so the hook script can find it without VS Code involvement.
function writeActiveContext(name) {
    const dir = path.join(os.homedir(), '.ai-context');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (name) {
        fs.writeFileSync(ACTIVE_FILE, name, 'utf8');
    } else {
        try { fs.unlinkSync(ACTIVE_FILE); } catch { /* already absent */ }
    }
}

function readActiveContext() {
    try {
        return fs.existsSync(ACTIVE_FILE) ? fs.readFileSync(ACTIVE_FILE, 'utf8').trim() : null;
    } catch { return null; }
}

module.exports = {
    HOOK_SCRIPT_PATH,
    ACTIVE_FILE,
    isHookInstalled,
    installHook,
    uninstallHook,
    writeActiveContext,
    readActiveContext,
};
