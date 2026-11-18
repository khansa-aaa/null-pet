// null: a small desktop pet that keeps your Claude Code sessions busy.
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, Notification, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./src/settings');
const usage = require('./src/usage');
const { SessionWatcher } = require('./src/sessions');
const { Brain } = require('./src/brain');
const { dispatch, closeSession, reopenSession } = require('./src/dispatch');
const { lookIndex } = require('./src/look');
const { DATA_DIR, LAUNCH_AGENT, LOG_FILE } = require('./src/paths');
const { log } = require('./src/log');

const COLLAPSED = { w: 90, h: 90 };
const EXPANDED = { w: 400, h: 600 };
const LARGE = { w: 600, h: 860 }; // the card's expand button; never more than the screen allows
const SPRITE = { w: 67.2, h: 72.8, right: 6, bottom: 2 };

let pet = null;
let tray = null;
let anchor = null;
let dragStart = null;
let open = false;

// A snapshot run uses its own profile, so it can run beside the real null.
if (process.env.NULL_PET_SNAPSHOT) app.setPath('userData', path.join(process.env.NULL_PET_SNAPSHOT, 'profile'));
if (!app.requestSingleInstanceLock()) app.quit();

// The sprite in assets/custom/ (the Codex "null" pet), or the plain fallback pet when it's missing.
const CUSTOM = path.join(__dirname, 'assets', 'custom');
function asset(names) {
  for (const n of names) if (fs.existsSync(path.join(CUSTOM, n))) return path.join(CUSTOM, n);
  return path.join(__dirname, 'assets', names[names.length - 1]);
}

const watcher = new SessionWatcher(() => settings.read().projects);
const brain = new Brain(watcher, dispatch, { closer: closeSession, opener: reopenSession });

const send = (channel, payload) => pet && !pet.isDestroyed() && pet.webContents.send(channel, payload);
const pushState = () => send('null:state', brain.state());

// ---------- pet window ----------
function defaultAnchor() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { right: wa.x + wa.width - 24, bottom: wa.y + wa.height - 12 };
}
function validAnchor(a) {
  if (!a || !Number.isFinite(a.right) || !Number.isFinite(a.bottom)) return false;
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return a.right - 20 > w.x && a.right - 20 < w.x + w.width && a.bottom - 20 > w.y && a.bottom - 20 < w.y + w.height;
  });
}
// The pet's bottom-right corner stays put; the card grows up and to the left.
function place(w, h) {
  if (!pet || !anchor) return;
  const wa = screen.getDisplayNearestPoint({ x: anchor.right - 20, y: anchor.bottom - 20 }).workArea;
  const x = Math.min(Math.max(anchor.right - w, wa.x), wa.x + wa.width - w);
  const y = Math.max(anchor.bottom - h, wa.y);
  pet.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
}
function cardSize() {
  if (!settings.read().card_large) return EXPANDED;
  const wa = screen.getDisplayNearestPoint({ x: anchor.right - 20, y: anchor.bottom - 20 }).workArea;
  return { w: Math.max(EXPANDED.w, Math.min(LARGE.w, wa.width - 16)), h: Math.max(EXPANDED.h, Math.min(LARGE.h, wa.height - 16)) };
}
function setOpen(v) {
  open = v;
  const size = v ? cardSize() : COLLAPSED;
  place(size.w, size.h);
  send('null:open', v);
  send('null:large', !!settings.read().card_large);
  refreshTray();
}
function setLarge(on) {
  settings.update((s) => (s.card_large = !!on));
  if (open) setOpen(true);
  else send('null:large', !!on);
}

function createPet() {
  const saved = settings.read().anchor;
  anchor = validAnchor(saved) ? saved : defaultAnchor();
  pet = new BrowserWindow({
    x: Math.round(anchor.right - COLLAPSED.w),
    y: Math.round(anchor.bottom - COLLAPSED.h),
    width: COLLAPSED.w,
    height: COLLAPSED.h,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  pet.setAlwaysOnTop(true, 'screen-saver');
  pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const sprite = path.relative(path.join(__dirname, 'assets'), asset(['sprite.webp', 'sprite.png']));
  pet.loadFile(path.join(__dirname, 'ui', 'pet.html'), { query: { sprite } });
  pet.webContents.on('did-finish-load', pushState);
  pet.on('closed', () => (pet = null));
}

// null glances at the cursor while it moves (the sheet's 16 look frames).
function watchCursor() {
  let last = null;
  let movedAt = 0;
  let sent = -1;
  setInterval(() => {
    if (!pet || !pet.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    if (!last || p.x !== last.x || p.y !== last.y) movedAt = Date.now();
    last = p;
    const b = pet.getBounds();
    const center = { x: b.x + b.width - SPRITE.right - SPRITE.w / 2, y: b.y + b.height - SPRITE.bottom - SPRITE.h / 2 };
    const idx = Date.now() - movedAt < 2500 ? lookIndex(center, p, 45) : -1;
    if (idx !== sent) {
      sent = idx;
      send('null:look', idx);
    }
  }, 100);
}

// ---------- tray ----------
function launchAtLogin() {
  return fs.existsSync(LAUNCH_AGENT);
}
function setLaunchAtLogin(on) {
  if (!on) {
    try {
      fs.unlinkSync(LAUNCH_AGENT);
    } catch (_) {
      // already gone
    }
    return;
  }
  const electron = process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.null-pet</string>
  <key>ProgramArguments</key><array><string>${electron}</string><string>${__dirname}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(LAUNCH_AGENT), { recursive: true });
  fs.writeFileSync(LAUNCH_AGENT, plist);
}

function setMode(mode) {
  settings.update((s) => (s.mode = mode));
  log('mode', mode);
  refreshTray();
  pushState();
}

function menuTemplate() {
  const s = settings.read();
  return [
    { label: open ? 'Close card' : 'Open card', click: () => setOpen(!open) },
    { type: 'separator' },
    { label: 'Manual: ask me (approve / reject / chat)', type: 'radio', checked: s.mode !== 'auto', click: () => setMode('manual') },
    { label: 'Auto: run safe actions without asking', type: 'radio', checked: s.mode === 'auto', click: () => setMode('auto') },
    { label: 'Pause null', type: 'checkbox', checked: !!s.paused, click: (i) => (settings.update((x) => (x.paused = i.checked)), pushState()) },
    { type: 'separator' },
    ...s.projects.map((p) => ({ label: `Recommend now: ${p.name}`, enabled: p.enabled !== false, click: () => brain.trigger(p.id, 'The user asked for a recommendation') })),
    {
      label: 'Projects',
      submenu: [
        ...s.projects.map((p) => ({
          label: p.name,
          submenu: [
            { label: 'Watch this project', type: 'checkbox', checked: p.enabled !== false, click: (i) => (settings.update((x) => (x.projects.find((q) => q.id === p.id).enabled = i.checked)), refreshTray(), pushState()) },
            { label: p.root, enabled: false },
            { label: 'Remove (keeps its memory folder)', click: () => (settings.removeProject(p.id), refreshTray(), pushState()) }
          ]
        })),
        ...(s.projects.length ? [{ type: 'separator' }] : []),
        { label: 'Add project folder…', click: addProject }
      ]
    },
    { type: 'separator' },
    { label: 'Start null at login', type: 'checkbox', checked: launchAtLogin(), click: (i) => setLaunchAtLogin(i.checked) },
    { label: 'Open memory folder', click: () => shell.openPath(DATA_DIR) },
    { label: 'Open log', click: () => shell.openPath(LOG_FILE) },
    { label: 'Reset position', click: resetPosition },
    { type: 'separator' },
    { label: 'Quit null', click: () => app.quit() }
  ];
}

async function addProject() {
  app.focus({ steal: true });
  const r = await dialog.showOpenDialog({ title: 'Choose a project folder for null to watch', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return;
  const p = settings.addProject(r.filePaths[0]);
  log('project added', p.id);
  refreshTray();
  pushState();
  setOpen(true);
  if (!settings.read().paused) brain.trigger(p.id, 'this project was just added; take stock of it');
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
  tray.setTitle(settings.read().mode === 'auto' ? 'auto' : '');
}

function createTray() {
  const icon = nativeImage.createFromPath(asset(['tray.png']));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 18, height: 18 }));
  if (icon.isEmpty()) tray.setTitle('∅');
  tray.setToolTip('null');
  refreshTray();
}

function resetPosition() {
  anchor = defaultAnchor();
  settings.update((s) => (s.anchor = anchor));
  const b = pet.getBounds();
  place(b.width, b.height);
}

// ---------- brain → UI ----------
function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => setOpen(true));
  n.show();
}

brain.on('state', pushState);
brain.on('thinking', (on) => send('null:anim', on ? 'think' : 'base'));
brain.on('card', (card) => {
  pushState();
  send('null:anim', 'jump');
  if (!open) notify(`null · ${card.projectName}`, card.actions.length ? card.actions.map((a) => a.title).join(' · ') : card.status);
  setOpen(true);
});
brain.on('sending', () => send('null:anim', 'work'));
brain.on('sent', ({ project, results }) => {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  send('null:anim', bad.length ? 'sad' : 'celebrate');
  send('null:toast', {
    project,
    text: [ok.length ? `Sent: ${ok.map((r) => `${r.title} → ${r.target}`).join('; ')}` : '', bad.length ? `Couldn't send: ${bad.map((r) => `${r.title} (${r.detail})`).join('; ')}` : '']
      .filter(Boolean)
      .join('\n')
  });
  if (!open && settings.read().mode === 'auto' && ok.length) notify('null (auto)', ok.map((r) => `${r.title} → ${r.target}`).join('\n'));
});
brain.on('toast', (t) => send('null:toast', t));
brain.on('error', ({ project, message }) => {
  send('null:anim', 'sad');
  send('null:toast', { project, text: `Planning failed: ${message}` });
});
usage.onChange(pushState);

// ---------- IPC ----------
ipcMain.handle('null:state', () => brain.state());
ipcMain.on('null:toggle', () => setOpen(!open));
ipcMain.on('null:close', () => setOpen(false));
ipcMain.on('null:large', (_e, on) => setLarge(on));
ipcMain.on('null:mode', (_e, mode) => setMode(mode === 'auto' ? 'auto' : 'manual'));
ipcMain.handle('null:approve', (_e, cardId, actionIds) => brain.approve(cardId, actionIds));
ipcMain.handle('null:reject', (_e, cardId, why) => brain.reject(cardId, why));
ipcMain.handle('null:chat', (_e, cardId, text) => brain.chat(cardId, text));
ipcMain.handle('null:say', (_e, pid, text) => brain.say(pid, text));
ipcMain.handle('null:dismiss', (_e, cardId) => brain.dismiss(cardId));
ipcMain.handle('null:recommend', (_e, pid) => brain.trigger(pid, 'The user asked for a recommendation'));
ipcMain.handle('null:addProject', () => addProject());
ipcMain.handle('null:closeSession', (_e, pid) => brain.closeSession(pid));
ipcMain.handle('null:openSession', (_e, pid, sessionId) => brain.openSession(pid, sessionId));
ipcMain.handle('null:pauseSession', (_e, pid, sessionId, paused) => brain.pauseSession(pid, sessionId, paused));
ipcMain.on('drag:start', () => {
  if (!pet) return;
  const [x, y] = pet.getPosition();
  dragStart = { x, y };
});
ipcMain.on('drag:move', (_e, d) => pet && dragStart && pet.setPosition(Math.round(dragStart.x + d.dx), Math.round(dragStart.y + d.dy)));
ipcMain.on('drag:end', () => {
  if (!pet || !dragStart) return;
  const b = pet.getBounds();
  anchor = { right: b.x + b.width, bottom: b.y + b.height };
  settings.update((s) => (s.anchor = anchor));
  dragStart = null;
});
ipcMain.on('pet:menu', () => pet && Menu.buildFromTemplate(menuTemplate()).popup({ window: pet }));

// ---------- lifecycle ----------
app.on('second-instance', () => pet && (pet.show(), setOpen(true)));

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  createPet();
  createTray();
  watchCursor();
  watcher.start();
  log('null started', { mode: settings.read().mode, projects: settings.read().projects.map((p) => p.id) });
  if (process.env.NULL_PET_SNAPSHOT) return snapshotWindows(process.env.NULL_PET_SNAPSHOT);
  // First look at each project a few seconds after starting, staggered.
  if (!process.env.NULL_PET_NO_STARTUP_PLAN) {
    settings
      .read()
      .projects.filter((p) => p.enabled !== false)
      .forEach((p, i) => setTimeout(() => !settings.read().paused && brain.trigger(p.id, 'null just started; take stock of the project'), 6000 + i * 4000));
  }
});

// Development aid: NULL_PET_SNAPSHOT=/some/dir npm start saves the pictures used in the README
// (made-up projects and sessions, the built-in sprite), then quits. Nothing outside that folder is touched.
async function snapshotWindows(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => fs.writeFileSync(path.join(dir, name), (await pet.webContents.capturePage()).toPNG());
  fs.mkdirSync(dir, { recursive: true });
  pet.webContents.on('console-message', (_e, level, message, line) => fs.appendFileSync(path.join(dir, 'console.txt'), `${level} ${message} (line ${line})\n`));
  await wait(1500);
  await shot('empty-pet.png');
  setOpen(true);
  await wait(800);
  await shot('first-run.png');

  settings.update((s) => {
    s.projects = [
      { id: 'shop-app', name: 'shop-app', root: '/Users/you/code/shop-app', enabled: true },
      { id: 'docs-site', name: 'docs-site', root: '/Users/you/code/docs-site', enabled: true }
    ];
  });
  const resetsAt = Math.round(Date.now() / 1000) + 2.2 * 24 * 3600;
  usage.record({ unifiedWindows: { seven_day: { utilization: 0.61, resetsAt, status: 'allowed' }, seven_day_overage_included: { utilization: 0.34, resetsAt, status: 'allowed' } } });
  watcher.list = () => ({
    'shop-app': [
      { pid: 1, name: 'checkout-tests', status: 'idle' },
      { pid: 2, name: 'cart-redesign', status: 'idle' },
      { pid: 3, name: 'api-rate-limits', status: 'busy' }
    ],
    'docs-site': [
      { pid: 4, name: 'search-index', status: 'busy' },
      { pid: 5, name: 'broken-links', status: 'idle' }
    ]
  });
  brain.cards.set('shop-app', {
    id: 'sample',
    project: 'shop-app',
    projectName: 'shop-app',
    status: 'Cart redesign is merged; 3 checkout tests fail on main.',
    reason: 'session "checkout-tests" just finished its turn',
    actions: [
      {
        id: 'a1',
        title: 'Fix the 3 failing checkout tests',
        prompt: 'Run npm test. Fix the 3 failing tests in tests/checkout without weakening them, re-run the suite, and commit when it is green.',
        target_kind: 'existing',
        target_session: 'checkout-tests',
        what: ['Fix 3 failures in tests/checkout', 'Commit once the suite is green'],
        why: ['main is red', 'Blocks every other merge'],
        risk: null
      },
      {
        id: 'a2',
        title: 'Add empty and error states to the new cart',
        prompt: 'In src/cart, add the empty-cart and failed-to-load states from docs/cart-redesign.md, with tests.',
        target_kind: 'existing',
        target_session: 'cart-redesign',
        what: ['Build the empty and failed-to-load states', 'Cover both with tests'],
        why: ['Listed as unfinished in the redesign doc'],
        risk: null
      },
      {
        id: 'a3',
        title: 'Apply the orders index migration',
        prompt: 'Apply migration 0142_orders_index to production and confirm the query plan.',
        target_kind: 'new',
        target_session: '',
        what: ['Run migration 0142 on production'],
        why: ['Order history takes 4 s without the index'],
        risk: 'mentions “production”'
      }
    ],
    plannerSession: 'x',
    chat: [],
    createdAt: Date.now(),
    busy: false
  });
  const purposes = {
    'checkout-tests': 'Checkout tests and payment bugs',
    'cart-redesign': 'New cart screens and their states',
    'api-rate-limits': 'API rate limiting and retry rules',
    'search-index': 'Docs search index and ranking',
    'broken-links': 'Link checker and redirect fixes'
  };
  brain.rosterView = (p, live) => ({
    open: live.map((s) => ({ ...s, sessionId: `demo-${s.pid}`, paused: s.name === 'api-rate-limits', purpose: purposes[s.name] })),
    closed:
      p.id === 'shop-app'
        ? [
            { sessionId: 'demo-c1', name: 'release-notes', purpose: 'Changelog and release notes for 2.4', lastActive: Date.now() - 3 * 3600 * 1000 },
            { sessionId: 'demo-c2', name: 'stripe-webhooks', purpose: 'Stripe webhook retries and logging', lastActive: Date.now() - 26 * 3600 * 1000 }
          ]
        : []
  });
  brain.needs.set('shop-app', [
    { ask: 'Log in to Vercel in the Chrome window, or run ! vercel login', session: 'api-rate-limits', kind: 'login', blocks: 'checking the production env values' },
    { ask: 'Choose the free-shipping threshold: $50 or $75', session: 'cart-redesign', kind: 'decision', blocks: 'the cart banner copy' }
  ]);
  brain.notes.set('docs-site', [
    { from: 'you', text: '/summary' },
    {
      from: 'null',
      kind: 'summary',
      text: 'Since Tue 09:12 am:\n\nDone\n• Search index rebuilt; queries answer in 40 ms (was 310)\n• 27 broken links fixed across guides/\n\nIn progress\n• Versioned docs: sidebar done, redirects not yet\n\nNeeds you\n• Pick the default docs version: 2.x or 3.0-beta'
    }
  ]);
  pushState();
  await wait(1200);
  await shot('card.png');
  await pet.webContents.executeJavaScript(`(() => { const d = document.querySelector('.roster-wrap'); d.open = true; document.getElementById('body').scrollTop = 99999; })()`);
  await wait(600);
  await shot('sessions.png');
  setLarge(true);
  await wait(900);
  await shot('large.png');
  setLarge(false);
  await wait(500);
  await pet.webContents.executeJavaScript(`document.querySelector('[data-pid="docs-site"]').click()`);
  await wait(800);
  await shot('summary.png');
  setOpen(false);
  await wait(800);
  await shot('pet.png');
  app.quit();
}
