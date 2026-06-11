const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const settings = {
    agents: ['claude', 'copilot'],
    autoGitignore: false,
    autoDetect: true,
    followActiveEditor: true,
    followTerminalCwd: true,
    maxActions: 3,
    architectureMaxAgeDays: 30,
};

const mockVscode = {
    workspace: {
        workspaceFolders: null,
        getConfiguration: () => ({
            get: key => settings[key],
            update: async (key, value) => { settings[key] = value; },
        }),
        createFileSystemWatcher: () => ({
            onDidChange: () => {},
            onDidCreate: () => {},
            dispose: () => {},
        }),
        onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
        openTextDocument: async doc => doc,
    },
    window: {
        activeTerminal: null,
        activeTextEditor: null,
        onDidChangeActiveTerminal: () => ({ dispose: () => {} }),
        onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showQuickPick: async () => undefined,
        showInputBox: async () => undefined,
        showTextDocument: async () => undefined,
        withProgress: async (_options, task) => task(),
    },
    commands: {
        registerCommand: () => ({ dispose: () => {} }),
    },
    Uri: { file: fsPath => ({ fsPath }) },
    RelativePattern: function RelativePattern(base, pattern) {
        this.base = base;
        this.pattern = pattern;
    },
    ProgressLocation: { Notification: 1 },
    ConfigurationTarget: { Global: 1 },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return mockVscode;
    return originalLoad.call(this, request, parent, isMain);
};

const context = require('../src/context');
const inject = require('../src/inject');
const extension = require('../src/extension');
const permissions = require('../src/permissions');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-context-'));
}

function count(content, needle) {
    return content.split(needle).length - 1;
}

// ── context.js ────────────────────────────────────────────────────────────────

function testContextMemoryNormalization() {
    const dir = tmpDir();
    const ctx = context.createDefaultContext('Demo', dir);
    ctx.v = 1;
    ctx.n = 'Run unit tests';
    ctx.a = ['one', 'two', 'three', 'two', 'four'];
    ctx.d = Array.from({ length: 25 }, (_, i) => `decision-${i}`);
    ctx.c = Array.from({ length: 25 }, (_, i) => `constraint-${i}`);
    ctx.f = Array.from({ length: 35 }, (_, i) => `file-${i}`);
    ctx.b = Array.from({ length: 18 }, (_, i) => `blocker-${i}`);

    context.saveContext(dir, 'Demo', ctx);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'Demo.json'), 'utf8'));

    assert.strictEqual(saved.v, 3);
    assert.strictEqual(saved.n, 'Run unit tests');
    assert.deepStrictEqual(saved.a, ['three', 'two', 'four']);
    assert.strictEqual(saved.h.length, 1);
    assert.ok(saved.h[0].includes('compacted 1 older action'));
    assert.ok(saved.h[0].includes('one'));
    assert.strictEqual(saved.d.length, 20);
    assert.strictEqual(saved.c.length, 20);
    assert.strictEqual(saved.f.length, 30);
    assert.strictEqual(saved.b.length, 15);
    assert.strictEqual(saved.m.compactionVersion, 1);
    assert.ok(saved.m.compactedAt);
    assert.ok(saved.lastUsed);
}

function testHistoryCap() {
    const result = context.compactActions(
        ['old-1', 'old-2', 'recent'],
        Array.from({ length: 12 }, (_, i) => `history-${i}`),
        1
    );
    assert.deepStrictEqual(result.actions, ['recent']);
    assert.strictEqual(result.history.length, 12);
    assert.strictEqual(result.history[0], 'history-1');
    assert.ok(result.history[11].includes('old-1'));
    assert.ok(result.compacted);
}

function testArchField() {
    const dir = tmpDir();
    const ctx = context.createDefaultContext('ArchTest', dir);
    assert.strictEqual(ctx.arch, null, 'default arch is null');

    // Save with arch
    const now = new Date().toISOString();
    ctx.arch = {
        summary:     'REST API',
        stack:       ['Node.js', 'Express'],
        keyFiles:    [{ path: 'src/index.js', role: 'entry' }],
        patterns:    ['async/await'],
        avoid:       ['callbacks'],
        lastAudited: now,
    };
    context.saveContext(dir, 'ArchTest', ctx);
    const loaded = context.loadContext(dir, 'ArchTest');
    assert.strictEqual(loaded.arch.summary, 'REST API');
    assert.deepStrictEqual(loaded.arch.stack, ['Node.js', 'Express']);
    assert.strictEqual(loaded.arch.lastAudited, now);

    // null arch passthrough
    const ctx2 = context.createDefaultContext('NoArch', dir);
    ctx2.arch = null;
    context.saveContext(dir, 'NoArch', ctx2);
    assert.strictEqual(context.loadContext(dir, 'NoArch').arch, null);
}

function testIsArchStale() {
    // null arch → stale
    assert.ok(context.isArchStale({ arch: null }, 30));
    assert.ok(context.isArchStale({}, 30));

    // fresh arch
    const fresh = new Date(Date.now() - 5 * 86400000).toISOString(); // 5 days ago
    assert.ok(!context.isArchStale({ arch: { lastAudited: fresh } }, 30));

    // stale arch
    const old = new Date(Date.now() - 40 * 86400000).toISOString(); // 40 days ago
    assert.ok(context.isArchStale({ arch: { lastAudited: old } }, 30));

    // custom maxDays
    assert.ok(!context.isArchStale({ arch: { lastAudited: old } }, 60));
    assert.ok(context.isArchStale({ arch: { lastAudited: fresh } }, 3));
}

// ── inject.js ─────────────────────────────────────────────────────────────────

function testCompactInjectionProjection() {
    const block = inject.buildInjectionBlock({
        v: 3, p: 'Demo', root: '/tmp/Demo', t: 'task', i: 'intent', n: 'next',
        s: { phase: 'test' }, b: ['blocker'], d: ['decision'], c: ['constraint'],
        f: ['src/inject.js'], h: ['older summary'], a: ['recent action'], e: null,
        m: { compactedAt: 'never' }, arch: null,
    });
    const firstLine = block.split('\n')[0];
    assert.ok(firstLine.startsWith(`${inject.AGENT_CONTEXT_NAME}=`));

    const projected = JSON.parse(firstLine.slice(`${inject.AGENT_CONTEXT_NAME}=`.length));
    assert.deepStrictEqual(projected.b, ['blocker']);
    assert.deepStrictEqual(projected.d, ['decision']);
    assert.deepStrictEqual(projected.c, ['constraint']);
    assert.deepStrictEqual(projected.f, ['src/inject.js']);
    assert.deepStrictEqual(projected.h, ['older summary']);
    assert.deepStrictEqual(projected.a, ['recent action']);
    assert.strictEqual(projected.createdAt, undefined);
    assert.strictEqual(projected.lastUsed,  undefined);
    assert.strictEqual(projected.m,         undefined);
}

function testInjectionBlockIncludesArch() {
    const now = new Date().toISOString();
    const block = inject.buildInjectionBlock({
        v: 3, p: 'Demo', root: '/tmp/Demo', t: 'task', n: 'next', s: {}, b: [], d: [], c: [], f: [], h: [], a: [], e: null,
        arch: { summary: 'REST API', stack: ['Node.js'], keyFiles: [], patterns: [], avoid: [], lastAudited: now },
    });
    assert.ok(block.includes('REST API'), 'arch summary should appear in block');
    assert.ok(block.includes('Node.js'), 'arch stack should appear in block');
    assert.ok(block.includes('fresh'), 'fresh arch should be labeled fresh');
    assert.ok(!block.includes('STALE'), 'fresh arch should not be labeled stale');
}

function testInjectionBlockStaleArch() {
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    const block = inject.buildInjectionBlock({
        v: 3, p: 'Demo', root: '/tmp/Demo', t: 'task', n: 'next', s: {}, b: [], d: [], c: [], f: [], h: [], a: [], e: null,
        arch: { summary: 'Old summary', stack: [], keyFiles: [], patterns: [], avoid: [], lastAudited: old },
    });
    assert.ok(block.includes('STALE'), 'stale arch should be labeled STALE');
    assert.ok(block.includes('arch'), 'stale block should include arch update instruction');
}

function testInjectionBlockMissingArch() {
    const block = inject.buildInjectionBlock({
        v: 3, p: 'Demo', root: '/tmp/Demo', t: 'task', n: 'next', s: {}, b: [], d: [], c: [], f: [], h: [], a: [], e: null,
        arch: null,
    });
    assert.ok(block.includes('NOT INITIALIZED'), 'missing arch should say NOT INITIALIZED');
}

function testInjectionForbidsInlineCtxUpdate() {
    const single = inject.buildInjectionBlock(
        { v: 3, p: 'Demo', root: '/tmp/Demo', arch: null },
        '/tmp/.ai-context/Demo.json',
    );
    assert.ok(single.includes('Do NOT') || single.includes('never include'),
        'block must forbid inline CTX_UPDATE');
    assert.ok(single.includes('.update'),
        'block must tell agent where the sidecar lives');

    const multi = inject.buildMultiInjectionBlock(
        [{ v: 3, p: 'Demo', root: '/tmp/Demo', arch: null }, { v: 3, p: 'Other', root: '/tmp/Other', arch: null }],
        { Demo: '/tmp/.ai-context/Demo.json', Other: '/tmp/.ai-context/Other.json' },
    );
    assert.ok(multi.includes('Do NOT') || multi.includes('never'),
        'multi-context block must also forbid inline CTX_UPDATE');
}

function testPathContainment() {
    const { isSameOrChildPath } = extension.__test;
    assert.strictEqual(isSameOrChildPath('/tmp/Project', '/tmp/Project'), true);
    assert.strictEqual(isSameOrChildPath('/tmp/Project', '/tmp/Project/src'), true);
    assert.strictEqual(isSameOrChildPath('/tmp/Project', '/tmp/ProjectX'), false);
}

function testCurrentLocationPathHelpers() {
    const { getEditorPath, getTerminalCwd } = extension.__test;
    assert.strictEqual(
        getEditorPath({ document: { uri: { scheme: 'file', fsPath: '/tmp/Project/' } } }),
        '/tmp/Project'
    );
    assert.strictEqual(
        getEditorPath({ document: { uri: { scheme: 'untitled', fsPath: '/tmp/Project' } } }),
        null
    );
    assert.strictEqual(
        getTerminalCwd({ shellIntegration: { cwd: { fsPath: '/tmp/Project/src/' } } }),
        '/tmp/Project/src'
    );
    assert.strictEqual(
        getTerminalCwd({ shellIntegration: { cwd: '/tmp/Project/src/' } }),
        '/tmp/Project/src'
    );
}

function testSyncActiveContextForPath() {
    const ctxDir  = tmpDir();
    const project = tmpDir();
    context.saveContext(ctxDir, 'Project', context.createDefaultContext('Project', project));

    const wsMap = {};
    const wsState = {
        get: (key) => wsMap[key] || null,
        update: async (key, value) => { wsMap[key] = value; },
    };

    const matched = extension.__test.syncActiveContextForPath(
        ctxDir, wsState, path.join(project, 'src'), { notify: false }
    );

    assert.strictEqual(matched, 'Project');
    assert.strictEqual(wsMap['ai.activeContext'], 'Project');
    assert.ok(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8').includes(inject.AGENT_CONTEXT_NAME));
}

function testMergeContextUpdate() {
    const ctxDir = tmpDir();
    const project = tmpDir();
    const base = context.createDefaultContext('Merge', project);
    base.a = ['old action'];
    base.d = ['old decision'];
    context.saveContext(ctxDir, 'Merge', base);

    const update = {
        n:    'new next step',
        a:    ['action from agent'],
        d:    ['new decision'],
        arch: { summary: 'Updated arch', stack: ['Node.js'], keyFiles: [], patterns: [], avoid: [], lastAudited: new Date().toISOString() },
    };
    extension.__test.mergeContextUpdate(ctxDir, 'Merge', update);

    const loaded = context.loadContext(ctxDir, 'Merge');
    assert.strictEqual(loaded.n, 'new next step');
    assert.ok(loaded.a.includes('old action'));
    assert.ok(loaded.a.includes('action from agent'));
    assert.ok(loaded.d.includes('old decision'));
    assert.ok(loaded.d.includes('new decision'));
    assert.ok(loaded.arch && loaded.arch.summary === 'Updated arch', 'arch should be updated');
}

function testInjectionMarkerRepair() {
    const dir  = tmpDir();
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, `Header\n${inject.INJECT_START}\nstale block without end`);

    inject.injectIntoFile(file, 'fresh block');
    const injected = fs.readFileSync(file, 'utf8');
    assert.strictEqual(count(injected, inject.INJECT_START), 1);
    assert.strictEqual(count(injected, inject.INJECT_END), 1);
    assert.ok(injected.includes('Header'));
    assert.ok(injected.includes('fresh block'));
    assert.ok(!injected.includes('stale block'));

    inject.clearInjection(file);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'Header\n');
}

function testInvalidRootIsSkipped() {
    const dir         = tmpDir();
    const missingRoot = path.join(dir, 'missing');
    const result = inject.autoInject({ p: 'Missing', root: missingRoot, t: 'init', s: {}, a: [] });
    assert.strictEqual(result, false);
    assert.strictEqual(fs.existsSync(path.join(missingRoot, 'AGENTS.md')), false);
}

function testCodexTargetsNestedGitRoots() {
    const dir        = tmpDir();
    const nestedRepo = path.join(dir, 'nested-repo');
    fs.mkdirSync(path.join(nestedRepo, '.git'), { recursive: true });
    const prev = settings.agents;
    settings.agents = ['codex'];
    const targets = inject.getInjectionTargets(dir)
        .map(p => path.relative(dir, p).replace(/\\/g, '/'))
        .sort();
    assert.deepStrictEqual(targets, ['AGENTS.md', 'nested-repo/AGENTS.md']);
    settings.agents = prev;
}

function testCodexTargetsDedupRootGitRepo() {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.git'));
    const prev = settings.agents;
    settings.agents = ['codex'];
    assert.deepStrictEqual(inject.getInjectionTargets(dir), [path.join(dir, 'AGENTS.md')]);
    settings.agents = prev;
}

function testKiloTargetsAgentMd() {
    const dir        = tmpDir();
    const nestedRepo = path.join(dir, 'nested-repo');
    fs.mkdirSync(path.join(nestedRepo, '.git'), { recursive: true });
    const prev = settings.agents;
    settings.agents = ['kilo'];
    const targets = inject.getInjectionTargets(dir)
        .map(p => path.relative(dir, p).replace(/\\/g, '/'))
        .sort();
    assert.deepStrictEqual(targets, ['AGENTS.md', 'nested-repo/AGENTS.md']);
    settings.agents = prev;
}

function testCodexKiloTargetsDeduplicate() {
    const dir        = tmpDir();
    const nestedRepo = path.join(dir, 'nested-repo');
    fs.mkdirSync(path.join(nestedRepo, '.git'), { recursive: true });
    const prev = settings.agents;
    settings.agents = ['codex', 'kilo'];
    const targets = inject.getInjectionTargets(dir)
        .map(p => path.relative(dir, p).replace(/\\/g, '/'))
        .sort();
    assert.deepStrictEqual(targets, ['AGENTS.md', 'nested-repo/AGENTS.md']);
    settings.agents = prev;
}

function testAutoInjectWritesNestedCodexTargets() {
    const dir        = tmpDir();
    const nestedRepo = path.join(dir, 'nested-repo');
    fs.mkdirSync(path.join(nestedRepo, '.git'), { recursive: true });
    const prev = settings.agents;
    settings.agents = ['codex'];
    const result = inject.autoInject({ v: 3, p: 'Nested', root: dir, t: 'init', s: {}, a: [] });
    assert.strictEqual(result, true);
    assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes(inject.AGENT_CONTEXT_NAME));
    assert.ok(fs.readFileSync(path.join(nestedRepo, 'AGENTS.md'), 'utf8').includes(inject.AGENT_CONTEXT_NAME));
    settings.agents = prev;
}

function testGitignoreUsesNestedGitRoot() {
    const dir        = tmpDir();
    const nestedRepo = path.join(dir, 'nested-repo');
    fs.mkdirSync(path.join(nestedRepo, '.git'), { recursive: true });
    inject.updateGitignore(dir, [
        path.join(dir, 'AGENTS.md'),
        path.join(nestedRepo, 'AGENTS.md'),
    ]);
    const rootIgnore   = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    const nestedIgnore = fs.readFileSync(path.join(nestedRepo, '.gitignore'), 'utf8');
    assert.ok(rootIgnore.includes('AGENTS.md'));
    assert.ok(nestedIgnore.includes('AGENTS.md'));
    for (const pattern of inject.GITIGNORE_SEED_PATTERNS) {
        assert.ok(rootIgnore.split('\n').filter(l => l.trim() === pattern).length <= 1, `root dup: ${pattern}`);
        assert.ok(nestedIgnore.split('\n').filter(l => l.trim() === pattern).length <= 1, `nested dup: ${pattern}`);
    }
}

function testScrubLeakedContextUpdatesOutsideMarker() {
    const dir       = tmpDir();
    const agentFile = path.join(dir, 'CLAUDE.md');
    const original  = [
        'Pre-existing user notes.',
        'CTX_UPDATE:{"v":3,"p":"Leaked","t":"should-be-stripped"}',
        '',
        inject.INJECT_START,
        'AI_CONTEXT={"v":3,"p":"Demo"}',
        'After each response, write a single line `CTX_UPDATE:{"v":3,...}` to ...update — preserved inside block.',
        inject.INJECT_END,
        '',
        'Trailing notes.',
        'CTX_UPDATE:{"v":3,"p":"AlsoLeaked"}',
        '',
    ].join('\n');
    fs.writeFileSync(agentFile, original);

    const cleaned = inject.scrubLeakedContextUpdates(original);
    assert.ok(!cleaned.includes('"Leaked"'));
    assert.ok(!cleaned.includes('"AlsoLeaked"'));
    assert.ok(cleaned.includes('preserved inside block'));
    assert.ok(cleaned.includes('Pre-existing user notes.'));

    inject.injectIntoFile(agentFile, 'AI_CONTEXT={"v":3,"p":"Demo"}\nrefreshed-instruction');
    const after = fs.readFileSync(agentFile, 'utf8');
    assert.ok(!after.includes('"Leaked"'));
    assert.ok(!after.includes('"AlsoLeaked"'));
    assert.ok(after.includes('refreshed-instruction'));
}

function testScrubLeakedContextUpdatesWithoutMarker() {
    const input = [
        'first line',
        'CTX_UPDATE:{"leak":1}',
        '   CTX_UPDATE:{"indented-leak":2}',
        'last line',
    ].join('\n');
    const cleaned = inject.scrubLeakedContextUpdates(input);
    assert.strictEqual(cleaned, 'first line\nlast line');
}

// ── permissions.js ────────────────────────────────────────────────────────────

function testGeneralizeClaudePerm() {
    const root = '/home/bigfnj/projects/MyProject';
    assert.strictEqual(permissions.__test.generalizeClaudePerm('WebSearch', root), 'WebSearch');
    assert.strictEqual(permissions.__test.generalizeClaudePerm('Bash(python3)', root), 'Bash(python3 *)');
    assert.strictEqual(permissions.__test.generalizeClaudePerm("Bash(python3 -c 'import openpyxl')", root), 'Bash(python3 -c *)');
    assert.strictEqual(permissions.__test.generalizeClaudePerm("Bash(git commit -m 'msg')", root), 'Bash(git commit -m *)');
    assert.strictEqual(permissions.__test.generalizeClaudePerm('Bash(npx markdownlint-cli2 *)', root), 'Bash(npx markdownlint-cli2 *)');
}

function testIsClaudePermCovered() {
    assert.strictEqual(permissions.__test.isClaudePermCovered('WebSearch', ['WebSearch']), true);
    assert.strictEqual(permissions.__test.isClaudePermCovered("Bash(python3 -c 'x')", ['Bash(python3 -c *)']), true);
    assert.strictEqual(permissions.__test.isClaudePermCovered('Bash(python3 -c *)', ['Bash(python3 *)']), true);
    assert.strictEqual(permissions.__test.isClaudePermCovered('Bash(git *)', ['Bash(python3 *)']), false);
}

function testCaptureNewClaudePerms() {
    const root = '/home/bigfnj/projects/MyProject';
    const before1 = ['WebSearch'];
    const after1  = ['WebSearch', "Bash(python3 -c 'x')", "Bash(python3 -c 'y')"];
    const result1 = permissions.__test.captureNewClaudePerms(before1, after1, root, []);
    assert.deepStrictEqual(result1, ['Bash(python3 -c *)']);

    const result2 = permissions.__test.captureNewClaudePerms(
        [], ["Bash(git commit -m 'msg')"], root, ['Bash(git *)']
    );
    assert.deepStrictEqual(result2, []);
}

// ── context — misc ────────────────────────────────────────────────────────────

function testMemFormatFallback() {
    const dir = tmpDir();
    const ctxWithMem = {
        v: 3, p: 'Demo', root: dir, t: 'task',
        mem: { b: ['blocker-mem'], d: ['decision-mem'], c: ['constraint-mem'], f: ['file-mem.js'] },
        h: [], a: [], s: {}, n: '', i: '', e: null,
    };
    context.saveContext(dir, 'Demo', ctxWithMem);
    const loaded = context.loadContext(dir, 'Demo');
    assert.deepStrictEqual(loaded.b, ['blocker-mem']);
    assert.deepStrictEqual(loaded.d, ['decision-mem']);
    assert.deepStrictEqual(loaded.c, ['constraint-mem']);
    assert.deepStrictEqual(loaded.f, ['file-mem.js']);
}

function testSearchContexts() {
    const dir = tmpDir();
    context.saveContext(dir, 'AlphaProject', { ...context.createDefaultContext('AlphaProject', '/home/user/alpha'), n: 'working on auth' });
    context.saveContext(dir, 'BetaService',  { ...context.createDefaultContext('BetaService',  '/home/user/beta'),  f: ['src/database.js'] });
    context.saveContext(dir, 'GammaApp',     { ...context.createDefaultContext('GammaApp',     '/home/user/gamma'), n: 'frontend work' });

    const results = context.searchContexts(dir, 'alpha');
    assert.ok(results.length > 0);
    assert.strictEqual(results[0].name, 'AlphaProject');

    const authResults = context.searchContexts(dir, 'auth');
    assert.ok(authResults.some(r => r.name === 'AlphaProject'));

    const noResults = context.searchContexts(dir, 'zzznomatch');
    assert.strictEqual(noResults.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
}

function testCheckContextHealth() {
    const dir = tmpDir();

    const ctx1 = context.createDefaultContext('TestCtx', dir);
    const h1 = context.checkContextHealth(ctx1);
    assert.ok(!h1.ok || h1.warnings.some(w => w.includes('git')));

    const ctx2 = { ...context.createDefaultContext('NoRoot', '/nonexistent/xyz') };
    const h2 = context.checkContextHealth(ctx2);
    assert.ok(!h2.ok);
    assert.ok(h2.warnings.some(w => w.includes('not found')));

    const ctx3 = { ...context.createDefaultContext('ErrCtx', dir), e: 'ctx_parse_err' };
    assert.ok(!context.checkContextHealth(ctx3).ok);

    const ctx4 = context.createDefaultContext('NoRootSet', '');
    assert.ok(!context.checkContextHealth(ctx4).ok);
    fs.rmSync(dir, { recursive: true, force: true });
}

function testTemplates() {
    const dir  = tmpDir();
    const base = context.createDefaultContext('MyProject', '/home/user/myproject');
    base.d = ['Use TypeScript'];
    base.c = ['No external deps'];
    base.f = ['src/index.ts'];
    context.saveContext(dir, 'MyProject', base);

    const tplCtx = { ...base, p: 'MyProject-template', a: [], s: {}, m: { isTemplate: true } };
    context.saveContext(dir, 'MyProject-template', tplCtx);

    const templates = context.listTemplates(dir);
    assert.ok(templates.includes('MyProject-template'));
    assert.ok(!templates.includes('MyProject'));

    context.createFromTemplate(dir, 'MyProject-template', 'NewProject', '/home/user/new');
    const newCtx = context.loadContext(dir, 'NewProject');
    assert.deepStrictEqual(newCtx.d, base.d);
    assert.deepStrictEqual(newCtx.a, []);
    fs.rmSync(dir, { recursive: true, force: true });
}

function testScanAndCreateContexts() {
    const ctxDir      = tmpDir();
    const projectsRoot = tmpDir();

    assert.deepStrictEqual(context.scanAndCreateContexts(ctxDir, path.join(projectsRoot, 'no-exist')), []);
    assert.deepStrictEqual(context.scanAndCreateContexts(ctxDir, ''), []);

    for (const name of ['alpha', 'beta', 'gamma']) {
        fs.mkdirSync(path.join(projectsRoot, name), { recursive: true });
    }
    fs.writeFileSync(path.join(projectsRoot, 'README.txt'), 'not a project');

    const created = context.scanAndCreateContexts(ctxDir, projectsRoot);
    assert.strictEqual(created.length, 3);
    assert.deepStrictEqual(created.slice().sort(), ['alpha', 'beta', 'gamma']);

    assert.deepStrictEqual(context.scanAndCreateContexts(ctxDir, projectsRoot), []);

    fs.mkdirSync(path.join(projectsRoot, 'delta'), { recursive: true });
    context.saveContext(ctxDir, 'delta', context.createDefaultContext('delta', '/some/other/path'));
    const created2 = context.scanAndCreateContexts(ctxDir, projectsRoot);
    assert.deepStrictEqual(created2, ['delta_1']);

    fs.rmSync(ctxDir, { recursive: true, force: true });
    fs.rmSync(projectsRoot, { recursive: true, force: true });
}

function testGitignoreSeedPatterns() {
    const dir         = tmpDir();
    const gitignorePath = path.join(dir, '.gitignore');
    inject.updateGitignoreFile(dir, []);
    const content = fs.readFileSync(gitignorePath, 'utf8');
    for (const pattern of inject.GITIGNORE_SEED_PATTERNS) {
        assert.ok(content.includes(pattern), `seed pattern missing: ${pattern}`);
    }
    inject.updateGitignoreFile(dir, []);
    const content2 = fs.readFileSync(gitignorePath, 'utf8');
    for (const pattern of inject.GITIGNORE_SEED_PATTERNS) {
        const c = content2.split('\n').filter(l => l.trim() === pattern).length;
        assert.strictEqual(c, 1, `pattern duplicated: ${pattern}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
}

function testEnsureUntrackedInGitNoOp() {
    const dir      = tmpDir();
    const filePath = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(filePath, 'test');
    assert.doesNotThrow(() => inject.ensureUntrackedInGit(filePath, dir));
    fs.rmSync(dir, { recursive: true, force: true });
}

function testGetGlobalTargetsProjectsOnly() {
    const home = os.homedir();
    settings.projectsRoot = '';  // use default (~/projects)

    // Project under ~/projects — should get global injection
    const underProjects = path.join(home, 'projects', 'my-project');
    const targets = inject.getGlobalTargets(underProjects);
    assert.ok(targets.length > 0, 'expected global target for project under ~/projects');
    assert.ok(targets[0].includes('.claude'), 'global target should be in ~/.claude/');

    // Home directory itself — should NOT get global injection
    assert.strictEqual(inject.getGlobalTargets(home).length, 0,
        'home dir root should not trigger global injection');

    // Dir outside ~/projects — should NOT get global injection
    assert.strictEqual(inject.getGlobalTargets('/tmp/random-project').length, 0,
        'dir outside projects root should not trigger global injection');

    // Explicit projectsRoot override
    settings.projectsRoot = path.join(home, 'work');
    assert.ok(inject.getGlobalTargets(path.join(home, 'work', 'proj')).length > 0,
        'should respect custom projectsRoot override');
    assert.strictEqual(inject.getGlobalTargets(underProjects).length, 0,
        '~/projects project should be excluded when projectsRoot overridden to ~/work');

    settings.projectsRoot = '';  // restore default
}

// ── Run all ───────────────────────────────────────────────────────────────────

testContextMemoryNormalization();
testHistoryCap();
testArchField();
testIsArchStale();
testCompactInjectionProjection();
testInjectionBlockIncludesArch();
testInjectionBlockStaleArch();
testInjectionBlockMissingArch();
testInjectionForbidsInlineCtxUpdate();
testPathContainment();
testCurrentLocationPathHelpers();
testSyncActiveContextForPath();
testMergeContextUpdate();
testInjectionMarkerRepair();
testInvalidRootIsSkipped();
testCodexTargetsNestedGitRoots();
testCodexTargetsDedupRootGitRepo();
testKiloTargetsAgentMd();
testCodexKiloTargetsDeduplicate();
testAutoInjectWritesNestedCodexTargets();
testGitignoreUsesNestedGitRoot();
testScrubLeakedContextUpdatesOutsideMarker();
testScrubLeakedContextUpdatesWithoutMarker();
testMemFormatFallback();
testGeneralizeClaudePerm();
testIsClaudePermCovered();
testCaptureNewClaudePerms();
testSearchContexts();
testCheckContextHealth();
testTemplates();
testScanAndCreateContexts();
testGitignoreSeedPatterns();
testEnsureUntrackedInGitNoOp();
testGetGlobalTargetsProjectsOnly();

console.log('unit tests passed');
