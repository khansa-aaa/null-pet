const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep tests out of the real data folder.
process.env.NULL_PET_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'null-pet-test-'));
process.env.NULL_PET_METER = path.join(process.env.NULL_PET_DATA, 'fable-meter.json');
process.env.NULL_PET_CLAUDE_DIR = path.join(process.env.NULL_PET_DATA, 'claude');

const { riskOf } = require('../src/risk');
const { projectOf, isOwn, SessionWatcher } = require('../src/sessions');
const { readTranscript } = require('../src/snapshot');
const memory = require('../src/memory');
const usage = require('../src/usage');
const { Brain } = require('../src/brain');
const settings = require('../src/settings');

const PROJECTS = [
  { id: 'shop-app', root: '/Users/dev/code/shop-app' },
  { id: 'docs-site', root: '/Users/dev/code/docs-site' }
];
settings.update((s) => (s.projects = PROJECTS.map((p) => ({ ...p, name: p.id, enabled: true }))));

test('projects are added by folder, with unique ids, and removed without touching the rest', () => {
  const a = settings.addProject('/Users/dev/code/My App/');
  assert.deepEqual({ id: a.id, name: a.name, root: a.root }, { id: 'my-app', name: 'My App', root: '/Users/dev/code/My App' });
  assert.equal(settings.addProject('/Users/dev/code/My App').id, 'my-app'); // same folder: no duplicate
  assert.equal(settings.addProject('/Users/dev/other/my-app').id, 'my-app-2');
  settings.removeProject('my-app');
  settings.removeProject('my-app-2');
  assert.deepEqual(settings.read().projects.map((p) => p.id), ['shop-app', 'docs-site']);
});

test('risky actions are caught even when the planner forgets', () => {
  assert.ok(riskOf({ title: 'Apply migration 0142', prompt: 'run supabase db push' }));
  assert.ok(riskOf({ title: 'Ship it', prompt: 'deploy the web app to production' }));
  assert.ok(riskOf({ title: 'Reply to customers', prompt: 'send the emails to all customers' }));
  assert.ok(riskOf({ title: 'x', prompt: 'then git push origin main' }));
  assert.ok(riskOf({ title: 'x', prompt: 'y', risky: true, risk_reason: 'touches RLS' }));
  assert.equal(riskOf({ title: 'Fix failing unit tests', prompt: 'Run npm test and fix the onboarding tests, then commit.' }), null);
  assert.equal(riskOf({ title: 'Write docs', prompt: 'Document the matching flow in docs/matching.md' }), null);
});

test('sessions are grouped by project root, including subfolders; other folders are ignored', () => {
  assert.equal(projectOf({ cwd: '/Users/dev/code/shop-app' }, PROJECTS).id, 'shop-app');
  assert.equal(projectOf({ cwd: '/Users/dev/code/shop-app/admin-dashboard' }, PROJECTS).id, 'shop-app');
  assert.equal(projectOf({ cwd: '/Users/dev/code/docs-site/frontend' }, PROJECTS).id, 'docs-site');
  assert.equal(projectOf({ cwd: '/Users/dev/code/shop-app-old' }, PROJECTS), null);
  assert.equal(projectOf({ cwd: '/Users/dev/code/general' }, PROJECTS), null);
});

test("null's own planner and courier runs are not treated as project sessions", () => {
  assert.ok(isOwn({ name: 'null-planner-docs-site', cwd: '/x' }));
  assert.ok(isOwn({ name: 'null-courier', cwd: '/x' }));
  assert.ok(isOwn({ name: 'whatever', cwd: path.join(process.env.NULL_PET_DATA, 'projects', 'docs-site', 'workspace') }));
  assert.ok(!isOwn({ name: 'null-shop-app-ab1', cwd: '/Users/dev/code/shop-app' }));
  assert.ok(!isOwn({ name: 'shop-app-88', cwd: '/Users/dev/code/shop-app' }));
});

test('the watcher emits idle only on a busy → idle change, per project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'null-sessions-'));
  const write = (s) => fs.writeFileSync(path.join(dir, `${s.pid}.json`), JSON.stringify(s));
  const pid = process.pid; // a live pid
  write({ pid, name: 'fd-1', cwd: '/Users/dev/code/shop-app', status: 'idle' });
  const w = new SessionWatcher(() => PROJECTS, { dir });
  const events = [];
  w.on('idle', (p, s) => events.push(['idle', p, s.name]));
  w.on('busy', (p, s) => events.push(['busy', p, s.name]));
  w.scan(true);
  write({ pid, name: 'fd-1', cwd: '/Users/dev/code/shop-app', status: 'busy' });
  w.scan(false);
  write({ pid, name: 'fd-1', cwd: '/Users/dev/code/shop-app', status: 'idle' });
  w.scan(false);
  w.scan(false);
  assert.deepEqual(events, [
    ['busy', 'shop-app', 'fd-1'],
    ['idle', 'shop-app', 'fd-1']
  ]);
  assert.equal(w.list()['shop-app'].length, 1);
  assert.equal(w.list()['docs-site'].length, 0);
});

test('transcript reading picks the latest prompt, reply, title and recap', () => {
  const lines = [
    { type: 'user', message: { role: 'user', content: 'fix the login bug' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Fixed it and committed.' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'ai-title', aiTitle: 'login-bug' },
    { type: 'system', subtype: 'turn_duration', durationMs: 5 },
    { type: 'system', subtype: 'away_summary', content: 'Login bug fixed; tests green.' },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }
  ].map((r) => JSON.stringify(r));
  const t = readTranscript(lines);
  assert.equal(t.lastPrompt, 'fix the login bug');
  assert.equal(t.lastAssistant, 'Fixed it and committed.');
  assert.equal(t.title, 'login-bug');
  assert.equal(t.awaySummary, 'Login bug fixed; tests green.');
  assert.equal(t.endedTurn, true);
});

test('each project has its own memory; writing one never touches the other', () => {
  memory.writeMemory('shop-app', 'SHOP: checkout redesign next');
  memory.writeMemory('docs-site', 'DOCS: search for the beta');
  memory.addHistory('shop-app', { event: 'rejected', title: 'redo onboarding' });
  assert.match(memory.readMemory('shop-app'), /SHOP:/);
  assert.doesNotMatch(memory.readMemory('shop-app'), /DOCS:/);
  assert.match(memory.readMemory('docs-site'), /DOCS:/);
  assert.equal(memory.history('docs-site').length, 0);
  assert.match(memory.historyText('shop-app'), /rejected: redo onboarding/);
  assert.notEqual(memory.workspace('shop-app'), memory.workspace('docs-site'));
  assert.throws(() => memory.dir('../escape'));
});

test('usage pace compares utilization with how much of the week has passed', () => {
  const now = Date.now();
  const resetsAt = Math.round((now + 3.5 * 24 * 3600 * 1000) / 1000); // halfway through the week
  usage.record({ unifiedWindows: { seven_day: { utilization: 0.25, resetsAt, status: 'allowed' } } });
  const s = usage.summary(now);
  assert.ok(Math.abs(s.elapsed - 0.5) < 0.01);
  assert.ok(Math.abs(s.pace - 0.5) < 0.02);
  assert.equal(s.limited, false);
});

test('targets are checked against live sessions: busy or doubled targets move to a spare idle one or a new tab', () => {
  const fake = new (require('events'))();
  fake.list = () => ({
    'shop-app': [
      { pid: 1, name: 'a', status: 'idle' },
      { pid: 2, name: 'b', status: 'busy' },
      { pid: 3, name: 'c', status: 'idle' }
    ],
    'docs-site': []
  });
  const brain = new Brain(fake, async () => []);
  const p = settings.project('shop-app');
  const acts = brain.normalize(p, {
    actions: [
      { title: 't1', prompt: 'p', target_kind: 'existing', target_session: 'a', risky: false },
      { title: 't2', prompt: 'p', target_kind: 'existing', target_session: 'b', risky: false },
      { title: 't3', prompt: 'p', target_kind: 'existing', target_session: 'a', risky: false },
      { title: 'deploy', prompt: 'deploy to prod', target_kind: 'new', target_session: '', risky: false }
    ]
  });
  assert.equal(acts[0].target_session, 'a');
  assert.equal(acts[1].target_session, 'c');
  assert.equal(acts[2].target_kind, 'new');
  assert.ok(acts[3].risk);
  assert.equal(acts[0].risk, null);
});

test('auto mode never dispatches risky actions, and manual mode dispatches nothing', async () => {
  const fake = new (require('events'))();
  fake.list = () => ({ 'shop-app': [{ pid: 1, name: 'a', status: 'idle' }, { pid: 2, name: 'c', status: 'idle' }], 'docs-site': [] });
  const sent = [];
  const brain = new Brain(fake, async (_p, actions) => {
    sent.push(...actions.map((a) => a.title));
    return actions.map((a) => ({ action: a, ok: true, target: a.target_session }));
  });
  const p = settings.project('shop-app');
  const rec = {
    status: 's',
    reply: '',
    memory_update: '',
    actions: [
      { title: 'tests', prompt: 'fix tests', target_kind: 'existing', target_session: 'a', why: '', risky: false, risk_reason: '' },
      { title: 'ship', prompt: 'deploy to production', target_kind: 'existing', target_session: 'c', why: '', risky: false, risk_reason: '' }
    ]
  };
  settings.update((s) => (s.mode = 'manual'));
  await brain.accept(p, rec, 'sess', { reason: 'r' });
  assert.deepEqual(sent, []);
  assert.equal(brain.cards.get('shop-app').actions.length, 2);

  settings.update((s) => (s.mode = 'auto'));
  brain.cards.clear();
  await brain.accept(p, rec, 'sess', { reason: 'r' });
  assert.deepEqual(sent, ['tests']);
  const card = brain.cards.get('shop-app');
  assert.equal(card.actions.length, 1);
  assert.equal(card.actions[0].title, 'ship');
  settings.update((s) => (s.mode = 'manual'));
});

test('Fable readings go to the shared meter, and the mode follows Fable against the weekly share', () => {
  const resetsAt = Math.round(Date.now() / 1000) + 3600;
  usage.record({ unifiedWindows: { seven_day: { utilization: 0.6, resetsAt }, seven_day_overage_included: { utilization: 0.24, resetsAt } } });
  let meter = JSON.parse(fs.readFileSync(process.env.NULL_PET_METER, 'utf8'));
  assert.equal(meter.fable.used, 24);
  assert.equal(meter.week.used, 60);
  assert.equal(usage.summary().fableMode, 'boost');
  // a reply from another model carries only the weekly window: the Fable reading is kept
  usage.record({ unifiedWindows: { seven_day: { utilization: 0.62, resetsAt } } });
  meter = JSON.parse(fs.readFileSync(process.env.NULL_PET_METER, 'utf8'));
  assert.equal(meter.fable.used, 24);
  assert.equal(meter.week.used, 62);
  assert.equal(usage.fableMode(55, 60), 'normal');
  assert.equal(usage.fableMode(70, 60), 'save');
  assert.equal(usage.fableMode(96, 99), 'save');
});

test('/summary gathers commits, session turns and null events since the last marker, then moves it', async () => {
  const { execFileSync } = require('child_process');
  const summary = require('../src/summary');
  const { TRANSCRIPTS_DIR } = require('../src/paths');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'null-sum-repo-'));
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  g('init', '-q');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'old work');
  const project = { id: 'docs-site', name: 'docs-site', root };
  const head0 = String(g('rev-parse', 'HEAD')).trim();
  const t0 = Date.now() - 1000;
  summary.writeMarker('docs-site', { at: t0, head: head0 });
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'add quiz grading');
  fs.writeFileSync(path.join(root, 'wip.txt'), 'x');

  // a transcript for this project, and one for a look-alike folder that must be ignored
  const now = new Date().toISOString();
  const rec = (cwd) =>
    [
      { type: 'ai-title', aiTitle: 'quiz-grading', cwd },
      { type: 'user', cwd, timestamp: now, message: { content: 'grade the quizzes' } },
      { type: 'assistant', cwd, timestamp: now, message: { content: [{ type: 'text', text: 'Grading done, 12 tests pass.' }] } }
    ].map((r) => JSON.stringify(r)).join('\n');
  const slug = root.replace(/[^a-zA-Z0-9]/g, '-');
  fs.mkdirSync(path.join(TRANSCRIPTS_DIR, slug), { recursive: true });
  fs.writeFileSync(path.join(TRANSCRIPTS_DIR, slug, 's1.jsonl'), rec(root));
  fs.mkdirSync(path.join(TRANSCRIPTS_DIR, `${slug}-old`), { recursive: true });
  fs.writeFileSync(path.join(TRANSCRIPTS_DIR, `${slug}-old`, 's2.jsonl'), rec(`${root}-old`));
  memory.addHistory('docs-site', { event: 'sent', title: 'Grade quizzes', target: 'at-1' });

  const data = await summary.gather(project, summary.readMarker('docs-site'));
  assert.match(data.text, /add quiz grading/);
  assert.doesNotMatch(data.text, /old work/);
  assert.match(data.text, /Uncommitted files \(1\)/);
  assert.match(data.text, /Claude Code sessions with activity \(1\)/);
  assert.match(data.text, /12 tests pass/);
  assert.match(data.text, /sent: Grade quizzes → at-1/);
  assert.equal(data.empty, false);

  const text = summary.format({ done: ['Quiz grading added; 12 tests pass'], in_progress: [], needs_you: ['wip.txt uncommitted'] }, t0);
  assert.match(text, /Done\n• Quiz grading added/);
  assert.match(text, /Needs you\n• wip.txt uncommitted/);
  assert.doesNotMatch(text, /In progress/);
});

test('typing /summary runs the summary for that project; other text without a card asks for a plan', async () => {
  const summary = require('../src/summary');
  const real = summary.run;
  summary.run = async (p) => `summary of ${p.id}`;
  const fake = new (require('events'))();
  fake.list = () => ({ 'shop-app': [], 'docs-site': [] });
  const brain = new Brain(fake, async () => []);
  const asked = [];
  brain.trigger = async (pid, reason) => asked.push([pid, reason]);
  await brain.say('docs-site', '/summary');
  assert.deepEqual(brain.notes.get('docs-site').map((n) => n.text), ['/summary', 'summary of docs-site']);
  assert.equal(brain.notes.get('shop-app'), undefined);
  await brain.say('shop-app', 'what about the checkout redesign?');
  assert.deepEqual(asked, [['shop-app', 'The user asked: what about the checkout redesign?']]);
  summary.run = real;
});

test('recommendations ask for short What and Why bullets', () => {
  const { SCHEMA } = require('../src/planner');
  const a = SCHEMA.properties.actions.items;
  assert.equal(a.properties.what.type, 'array');
  assert.equal(a.properties.why.type, 'array');
  assert.ok(a.required.includes('what') && a.required.includes('why'));
});

test('the roster lists open and recently closed sessions with purposes, and remembers pauses', async () => {
  const roster = require('../src/roster');
  const { TRANSCRIPTS_DIR } = require('../src/paths');
  const root = '/Users/dev/code/roster-app';
  const project = { id: 'roster-app', name: 'roster-app', root };
  const slug = root.replace(/[^a-zA-Z0-9]/g, '-');
  fs.mkdirSync(path.join(TRANSCRIPTS_DIR, slug), { recursive: true });
  const tr = (cwd, prompt, reply) =>
    [
      { type: 'ai-title', aiTitle: prompt.slice(0, 20), cwd },
      { type: 'user', cwd, timestamp: new Date().toISOString(), message: { content: prompt } },
      { type: 'assistant', cwd, timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: reply }] } }
    ].map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(path.join(TRANSCRIPTS_DIR, slug, 'aaaaaaaa-live.jsonl'), tr(root, 'fix the checkout tests', 'done'));
  fs.writeFileSync(path.join(TRANSCRIPTS_DIR, slug, 'bbbbbbbb-gone.jsonl'), tr(`${root}/web`, 'draft the onboarding emails', 'drafted 5'));
  fs.mkdirSync(path.join(TRANSCRIPTS_DIR, `${slug}-old`), { recursive: true });
  fs.writeFileSync(path.join(TRANSCRIPTS_DIR, `${slug}-old`, 'cccccccc-other.jsonl'), tr(`${root}-old`, 'not this project', 'x'));
  const live = [{ pid: 11, sessionId: 'aaaaaaaa-live', name: 'checkout', cwd: root, status: 'idle' }];

  let v = roster.view(project, live);
  assert.deepEqual(v.open.map((s) => s.name), ['checkout']);
  assert.deepEqual(v.closed.map((c) => c.sessionId), ['bbbbbbbb-gone']);
  assert.equal(v.closed[0].cwd, `${root}/web`);

  let asked = '';
  const fake = async (_args, input) => {
    asked = input;
    return { structured_output: { items: [{ id: '1', purpose: 'Checkout tests and payment bugs' }, { id: '2', purpose: 'Onboarding email drafts' }] } };
  };
  assert.equal(await roster.refresh(project, live, { run: fake }), true);
  assert.match(asked, /fix the checkout tests/);
  assert.doesNotMatch(asked, /not this project/);
  assert.equal(await roster.refresh(project, live, { run: fake }), false); // throttled, and nothing is stale
  v = roster.view(project, live);
  assert.equal(v.open[0].purpose, 'Checkout tests and payment bugs');
  assert.equal(v.closed[0].purpose, 'Onboarding email drafts');

  roster.setPaused('roster-app', 'aaaaaaaa-live', true);
  assert.equal(roster.isPaused('roster-app', 'aaaaaaaa-live'), true);
  assert.equal(roster.view(project, live).open[0].paused, true);
  roster.setPaused('roster-app', 'aaaaaaaa-live', false);
});

test('paused sessions get no work; a busy session is never closed; open asks are kept on the card', async () => {
  const roster = require('../src/roster');
  const fake = new (require('events'))();
  fake.list = () => ({
    'shop-app': [
      { pid: 1, sessionId: 's-a', name: 'a', status: 'idle' },
      { pid: 2, sessionId: 's-b', name: 'b', status: 'idle' },
      { pid: 3, sessionId: 's-c', name: 'c', status: 'busy' }
    ],
    'docs-site': []
  });
  const closed = [];
  const brain = new Brain(fake, async () => [], { closer: async (s) => (closed.push(s.pid), { tab: true }) });
  roster.setPaused('shop-app', 's-a', true);
  const p = settings.project('shop-app');
  const acts = brain.normalize(p, { actions: [{ title: 't', prompt: 'p', target_kind: 'existing', target_session: 'a', risky: false }] });
  assert.equal(acts[0].target_session, 'b'); // moved off the paused session
  assert.deepEqual(brain.workable('shop-app').map((s) => s.name), ['b', 'c']);
  roster.setPaused('shop-app', 's-a', false);

  assert.equal((await brain.closeSession(3)).ok, false);
  assert.equal((await brain.closeSession(2)).ok, true);
  assert.deepEqual(closed, [2]);

  settings.update((s) => (s.mode = 'manual'));
  await brain.accept(p, { status: 's', reply: '', memory_update: '', actions: [], needs_you: [{ ask: 'Log in to Vercel', session: 'b', kind: 'login', blocks: 'env check' }] }, 'x', { reason: 'r' });
  assert.ok(brain.cards.get('shop-app'), 'a card stays up for open asks even with no actions');
  assert.equal(brain.state().projects.find((x) => x.id === 'shop-app').needs[0].kind, 'login');
  const { SCHEMA } = require('../src/planner');
  assert.ok(SCHEMA.required.includes('needs_you'));
});
