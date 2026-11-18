// null's window: the animated sprite and the recommendation card.
const api = window.nullPet;
const $ = (id) => document.getElementById(id);

// ---------- sprite ----------
// The sheet is 8 columns x 11 rows of 192x208 frames (the Codex pet layout), drawn 67.2 px wide.
// Rows 0-8 are the animations below; rows 9-10 are 16 look directions.
const FW = 67.2;
const FH = (208 * FW) / 192;
const times = (n, each, last) => [...Array(n - 1).fill(each), last];
const ANIMS = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  runRight: { row: 1, durations: times(8, 120, 220) },
  runLeft: { row: 2, durations: times(8, 120, 220) },
  wave: { row: 3, durations: times(4, 140, 280) },
  jump: { row: 4, durations: times(5, 140, 280) },
  sad: { row: 5, durations: times(8, 140, 240) },
  think: { row: 6, durations: times(6, 150, 260) },
  work: { row: 7, durations: times(6, 120, 220) },
  celebrate: { row: 8, durations: times(6, 150, 280) }
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sprite = $('sprite');
// Your own sheet in assets/custom/, when there is one; the CSS has the built-in sheet.
const sheet = new URLSearchParams(location.search).get('sprite');
if (sheet === 'custom/sprite.webp' || sheet === 'custom/sprite.png') sprite.style.backgroundImage = `url("../assets/${sheet}")`;
let anim = 'idle';
let frame = 0;
let timer = null;
let base = 'idle';
let revertTimer = null;
let look = -1;
let dragging = false;

function draw() {
  if (anim === 'idle' && look >= 0 && !dragging) {
    sprite.style.backgroundPosition = `${-(look % 8) * FW}px ${-(9 + Math.floor(look / 8)) * FH}px`;
    return;
  }
  sprite.style.backgroundPosition = `${-frame * FW}px ${-ANIMS[anim].row * FH}px`;
}
function tick() {
  const a = ANIMS[anim];
  draw();
  if (reduceMotion) return;
  let wait = a.durations[frame];
  if (anim === 'idle' && frame === a.durations.length - 1) wait += 2000 + Math.random() * 3000;
  timer = setTimeout(() => {
    frame = (frame + 1) % a.durations.length;
    tick();
  }, wait);
}
function play(name) {
  if (!ANIMS[name]) return;
  anim = name;
  frame = 0;
  clearTimeout(timer);
  tick();
}
function react(name, ms) {
  clearTimeout(revertTimer);
  play(name);
  revertTimer = setTimeout(() => play(base), ms);
}
function setBase(name) {
  base = name;
  clearTimeout(revertTimer);
  play(name);
}
api.on('null:look', (idx) => {
  look = idx;
  if (anim === 'idle') draw();
});
api.on('null:anim', (name) => {
  if (name === 'think') return setBase('think');
  if (name === 'base') return setBase(anyBusy ? 'work' : 'idle');
  if (name === 'work') return react('work', 4000);
  react(name, name === 'jump' ? 1400 : 2400);
});
play('idle');

// ---------- state ----------
let state = { mode: 'manual', projects: [], cards: [], usage: {} };
let selected = null; // project id shown in the card
let anyBusy = false;
const checked = new Map(); // card id -> Set of action ids left ticked

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cardFor = (pid) => state.cards.find((c) => c.project === pid) || null;

function render() {
  // mode switch
  $('mode-manual').setAttribute('aria-checked', String(state.mode !== 'auto'));
  $('mode-auto').setAttribute('aria-checked', String(state.mode === 'auto'));

  // badge: cards waiting
  const n = state.cards.length;
  $('badge').hidden = !n;
  $('badge').textContent = n;

  // pet base animation follows the sessions
  const busy = state.projects.some((p) => p.sessions.some((s) => s.status === 'busy'));
  const thinking = state.projects.some((p) => p.planning);
  if (busy !== anyBusy || (!thinking && base === 'think')) {
    anyBusy = busy;
    if (!thinking) setBase(busy ? 'work' : 'idle');
  }

  if (!selected || !state.projects.find((p) => p.id === selected)) selected = (state.cards[0] && state.cards[0].project) || (state.projects[0] && state.projects[0].id);

  // tabs
  $('tabs').innerHTML = state.projects
    .filter((p) => p.enabled)
    .map((p) => {
      const dot = p.planning ? '<span class="dot think" title="thinking"></span>' : cardFor(p.id) ? '<span class="dot" title="waiting for you"></span>' : '';
      return `<button class="tab" role="tab" data-pid="${esc(p.id)}" aria-selected="${p.id === selected}">${esc(p.name)} ${dot}</button>`;
    })
    .join('');

  const p = state.projects.find((x) => x.id === selected);
  const card = p && cardFor(p.id);
  $('foot').hidden = !p;
  $('decide').hidden = !card;
  $('chat-input').placeholder = card ? 'Chat, /summary, or a reason then Reject' : 'Ask null something, or /summary';
  $('body').innerHTML = p ? (card ? cardHtml(card, p) : overviewHtml(p)) : '<p class="empty">No projects yet. Add the folder of a project you run Claude Code in, and null will watch its sessions.</p><div><button class="btn approve" data-add>Add project folder…</button></div>';
  if (card) {
    const busyCard = card.busy || p.planning;
    $('approve').disabled = busyCard || !card.actions.length;
    $('reject').disabled = busyCard;
    $('chat-send').disabled = busyCard;
    const sel = checked.get(card.id);
    const k = sel ? sel.size : card.actions.length;
    $('approve').textContent = card.actions.length ? `Approve${k < card.actions.length ? ` ${k} of ${card.actions.length}` : card.actions.length > 1 ? ` all ${card.actions.length}` : ''}` : 'Approve';
  } else {
    $('chat-send').disabled = false;
  }
  renderUsage();
}

// Every session in the project: what it's for, and Close / Open / Pause.
function sessionsHtml(p) {
  const r = p.roster || { open: [], closed: [] };
  const closing = new Set(p.closing || []);
  const purpose = (s) => (s.purpose ? `<div class="purpose">${esc(s.purpose)}</div>` : '<div class="purpose empty">working out what it does…</div>');
  const open = r.open
    .map((s) => {
      const state = closing.has(s.pid) ? 'closing…' : s.paused ? `paused · ${s.status}` : s.status;
      const close =
        s.status === 'idle' && !closing.has(s.pid)
          ? `<button class="mini" data-close="${s.pid}" title="End this session and close its tab. You can open it again.">Close</button>`
          : `<button class="mini" disabled title="${s.status === 'idle' ? 'Closing' : 'Working: close it when it is idle'}">Close</button>`;
      const pause = `<button class="mini${s.paused ? ' on' : ''}" data-pause="${esc(s.sessionId)}" data-paused="${s.paused ? 1 : 0}" title="${
        s.paused ? 'Let null give it work again' : 'Keep it open, but null sends it nothing'
      }">${s.paused ? 'Resume' : 'Pause'}</button>`;
      return `<li class="sess${s.paused ? ' paused' : ''}"><span class="st ${esc(s.status)}"></span><div class="who"><div class="nm">${esc(s.name)} <span class="empty">${esc(state)}</span></div>${purpose(s)}</div><div class="ctl">${pause}${close}</div></li>`;
    })
    .join('');
  const closed = r.closed
    .map(
      (c) =>
        `<li class="sess closed"><span class="st"></span><div class="who"><div class="nm">${esc(c.name)} <span class="empty">closed ${esc(ago(c.lastActive))}</span></div>${purpose(c)}</div><div class="ctl"><button class="mini" data-open="${esc(c.sessionId)}" title="Reopen it in a new Terminal tab, with its history">Open</button></div></li>`
    )
    .join('');
  return `<div class="roster">
    <div class="sec">Open sessions (${r.open.length})</div>
    ${r.open.length ? `<ul class="sessions">${open}</ul>` : '<p class="empty">None open in this project.</p>'}
    ${r.closed.length ? `<div class="sec">Closed recently (${r.closed.length})</div><ul class="sessions">${closed}</ul>` : ''}
  </div>`;
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// Things only the user can do, gathered from the sessions' replies.
function needsHtml(p) {
  const list = p.needs || [];
  if (!list.length) return '';
  const icon = { login: 'Log in', decision: 'Decide', answer: 'Answer', purchase: 'Buy', approval: 'Approve', other: 'Do' };
  return `<div class="needs"><div class="sec warn">Needs you (${list.length})</div><ul>${list
    .map(
      (n) =>
        `<li><span class="kind">${esc(icon[n.kind] || 'Do')}</span><div><div>${esc(n.ask)}</div><div class="purpose">${n.session ? `${esc(n.session)} · ` : ''}blocks: ${esc(n.blocks || '')}</div></div></li>`
    )
    .join('')}</ul></div>`;
}

function overviewHtml(p) {
  return `
    ${p.planning ? '<div class="thinking">null is reading the project and planning…</div>' : '<div class="status">Nothing waiting. I\'ll pop up when a session finishes.</div>'}
    ${p.error ? `<div class="error">Last plan failed: ${esc(p.error)}</div>` : ''}
    ${needsHtml(p)}
    ${sessionsHtml(p)}
    ${notesHtml(p)}
    <div><button class="btn" data-recommend="${esc(p.id)}" ${p.planning ? 'disabled' : ''}>Recommend now</button></div>`;
}

// The planner gives arrays of short bullets; older cards may carry a plain sentence.
function bullets(label, list) {
  const items = (Array.isArray(list) ? list : list ? [list] : []).filter(Boolean);
  if (!items.length) return '';
  return `<div class="ww"><span class="ww-label">${label}</span><ul>${items.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`;
}

function notesHtml(p) {
  const notes = p.notes || [];
  if (!notes.length && !p.summarizing) return '';
  return `<div class="chat">${notes.map((m) => `<div class="msg ${m.from === 'you' ? 'you' : 'null'}${m.kind === 'summary' ? ' summary' : ''}">${esc(m.text)}</div>`).join('')}${
    p.summarizing ? '<div class="thinking">summarizing…</div>' : ''
  }</div>`;
}

function cardHtml(card, p) {
  const sel = checked.get(card.id);
  const actions = card.actions
    .map((a) => {
      const on = !sel || sel.has(a.id);
      const target = a.target_kind === 'existing' ? `→ <span class="target">${esc(a.target_session)}</span>` : '→ <span class="target">new Terminal tab</span>';
      return `<li class="action ${a.risk ? 'risky' : ''}">
        <input type="checkbox" data-act="${esc(a.id)}" ${on ? 'checked' : ''} aria-label="Include ${esc(a.title)}">
        <div class="title">${esc(a.title)}</div>
        <div class="meta">${target}</div>
        ${bullets('What', a.what)}${bullets('Why', a.why)}
        ${a.risk ? `<div class="risk">⚠ Needs your OK: ${esc(a.risk)}</div>` : ''}
        <details><summary>Prompt</summary><pre class="prompt">${esc(a.prompt)}</pre></details>
      </li>`;
    })
    .join('');
  const chat = card.chat.length ? `<div class="chat">${card.chat.map((m) => `<div class="msg ${m.from === 'you' ? 'you' : 'null'}">${esc(m.text)}</div>`).join('')}</div>` : '';
  return `
    <div class="status">${esc(card.status)}</div>
    <div class="reason">${esc(card.reason || '')}</div>
    ${needsHtml(p)}
    ${card.actions.length ? `<ul class="actions">${actions}</ul>` : '<p class="empty">No actions proposed.</p>'}
    ${chat}
    ${card.busy || p.planning ? '<div class="thinking">working on it…</div>' : ''}
    ${notesHtml(p)}
    <details class="roster-wrap"${openRoster ? ' open' : ''}><summary>Sessions</summary>${sessionsHtml(p)}</details>`;
}

function renderUsage() {
  const u = state.usage || {};
  if (!u.week) {
    $('usage').innerHTML = `<span>week: usage shows after null's first run</span><span>${state.paused ? 'paused' : ''}</span>`;
    return;
  }
  const pct = Math.round(u.week.utilization * 100);
  const even = u.elapsed != null ? Math.round(u.elapsed * 100) : null;
  const resets = u.week.resetsAt ? new Date(u.week.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  $('usage').innerHTML = `<div class="usage-row"><span>week ${pct}%</span><span class="bar" title="${pct}% used; the line marks an even pace (${even}%)"><i></i>${even != null ? '<b></b>' : ''}</span><span>${state.paused ? 'paused · ' : ''}resets ${esc(resets)}</span></div>`;
  // CSP forbids inline style attributes, so widths are set through the CSSOM
  $('usage').querySelector('.bar i').style.width = `${Math.min(100, pct)}%`;
  const mark = $('usage').querySelector('.bar b');
  if (mark) mark.style.left = `${even}%`;
  if (!u.fable) return;
  // Fable has its own weekly limit; the line on its bar marks the weekly share it should keep up with.
  const fpct = Math.round(u.fable.utilization * 100);
  const tag = { boost: 'behind ↑ more Fable', save: 'ahead ↓ less Fable', normal: 'on pace' }[u.fableMode || 'normal'];
  const row = document.createElement('div');
  row.className = 'usage-row';
  row.innerHTML = `<span>fable ${fpct}%</span><span class="bar fable" title="Fable's own limit: ${fpct}% used. The line marks the weekly share (${pct}%); Fable use should keep up with it."><i></i><b></b></span><span>${esc(tag)}</span>`;
  row.querySelector('.bar i').style.width = `${Math.min(100, fpct)}%`;
  row.querySelector('.bar b').style.left = `${Math.min(100, pct)}%`;
  $('usage').appendChild(row);
}

async function refresh() {
  state = await api.state();
  render();
}
api.on('null:state', (s) => {
  state = s;
  render();
});
api.on('null:open', (v) => {
  $('card').hidden = !v;
  if (v) refresh();
});
let toastTimer = null;
function showToast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 12000);
}
api.on('null:toast', (t) => showToast(t.text));

// ---------- card events ----------
$('close').addEventListener('click', () => api.close());
$('mode-manual').addEventListener('click', () => api.setMode('manual'));
$('mode-auto').addEventListener('click', () => api.setMode('auto'));
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pid]');
  if (!b) return;
  selected = b.dataset.pid;
  render();
});
let openRoster = false;
$('body').addEventListener('toggle', (e) => e.target.classList && e.target.classList.contains('roster-wrap') && (openRoster = e.target.open), true);
const say = (r) => r && r.text && showToast(r.text);
$('body').addEventListener('click', (e) => {
  if (e.target.closest('[data-add]')) return api.addProject();
  const c = e.target.closest('[data-close]');
  if (c) return api.closeSession(Number(c.dataset.close)).then(say);
  const o = e.target.closest('[data-open]');
  if (o) return api.openSession(selected, o.dataset.open).then(say);
  const pz = e.target.closest('[data-pause]');
  if (pz) return api.pauseSession(selected, pz.dataset.pause, pz.dataset.paused !== '1').then(say);
  const r = e.target.closest('[data-recommend]');
  if (r) api.recommend(r.dataset.recommend);
});
$('body').addEventListener('change', (e) => {
  const box = e.target.closest('[data-act]');
  if (!box) return;
  const card = cardFor(selected);
  if (!card) return;
  const sel = checked.get(card.id) || new Set(card.actions.map((a) => a.id));
  if (box.checked) sel.add(box.dataset.act);
  else sel.delete(box.dataset.act);
  checked.set(card.id, sel);
  render();
});
$('approve').addEventListener('click', () => {
  const card = cardFor(selected);
  if (!card) return;
  const sel = checked.get(card.id);
  const ids = sel ? [...sel] : card.actions.map((a) => a.id);
  if (!ids.length) return;
  api.approve(card.id, ids);
});
$('reject').addEventListener('click', () => {
  const card = cardFor(selected);
  if (!card) return;
  const why = $('chat-input').value.trim();
  $('chat-input').value = '';
  api.reject(card.id, why);
});
function sendChat() {
  const text = $('chat-input').value.trim();
  if (!selected || !text) return;
  $('chat-input').value = '';
  api.say(selected, text);
}
$('chat-send').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && api.close());

// ---------- click vs drag ----------
const petEl = $('pet');
let down = null;
petEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
  dragging = false;
  petEl.setPointerCapture(e.pointerId);
});
petEl.addEventListener('pointermove', (e) => {
  if (!down) return;
  const dx = e.screenX - down.x;
  const dy = e.screenY - down.y;
  if (!dragging && Math.hypot(dx, dy) > 4) {
    dragging = true;
    api.dragStart();
    react(dx > 0 ? 'runRight' : 'runLeft', 60000);
  }
  if (dragging) api.dragMove(dx, dy);
});
petEl.addEventListener('pointerup', () => {
  if (!down) return;
  const wasDrag = dragging;
  down = null;
  dragging = false;
  if (wasDrag) {
    api.dragEnd();
    setBase(base);
  } else api.toggle();
});
petEl.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), api.toggle()));
petEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.menu();
});

refresh();
