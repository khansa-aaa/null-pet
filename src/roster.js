// Every session of ONE project, open or recently closed, with a one-line purpose for each.
//
// Open sessions come from the watcher. Closed ones are transcripts in the project's folders under
// ~/.claude/projects that no live session holds. A closed session has no name of its own on disk,
// so names are remembered while sessions are live. Purposes come from one short headless run per
// project, only for sessions that are new or have grown a lot since their purpose was written.
const fs = require('fs');
const path = require('path');
const { claude, structured } = require('./claude');
const memory = require('./memory');
const { TRANSCRIPTS_DIR } = require('./paths');

const CLOSED_DAYS = 7; // closed sessions older than this aren't offered
const MAX_CLOSED = 8;
const SCAN_TTL_MS = 30 * 1000;
const MIN_GAP_MS = 5 * 60 * 1000; // between purpose runs for one project
const REDO_MS = 45 * 60 * 1000; // a purpose is rewritten at most this often, and only after growth

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
};

const inside = (cwd, root) => cwd === root || String(cwd || '').startsWith(`${root}/`);

// ---------- the per-project cache ----------
const file = (id) => path.join(memory.dir(id), 'roster.json');

function load(id) {
  try {
    const r = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    return r && r.sessions ? r : { sessions: {}, ranAt: 0 };
  } catch (_) {
    return { sessions: {}, ranAt: 0 };
  }
}

function save(id, r) {
  // keep the file small: drop entries not seen for a month
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const [sid, e] of Object.entries(r.sessions)) if ((e.lastSeen || 0) < cutoff) delete r.sessions[sid];
  fs.writeFileSync(file(id), JSON.stringify(r, null, 2));
}

// ---------- reading transcripts cheaply ----------
function readRange(f, start, length) {
  const fd = fs.openSync(f, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const parse = (text) =>
  text
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);

const isPrompt = (r) => {
  if (r.type !== 'user' || r.isSidechain || r.isMeta || !r.message) return false;
  const c = r.message.content;
  if (Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')) return false;
  const t = textOf(c);
  return !!t.trim() && !t.startsWith('<');
};

const peekCache = new Map(); // file -> { mtimeMs, size, info }

// What a transcript says about its session: folder, title, first and recent prompts, last reply.
function peek(f) {
  let st;
  try {
    st = fs.statSync(f);
  } catch (_) {
    return null;
  }
  const hit = peekCache.get(f);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;
  const head = parse(readRange(f, 0, Math.min(st.size, 256 * 1024)));
  const tailStart = Math.max(0, st.size - 400 * 1024);
  const tailLines = parse(readRange(f, tailStart, st.size - tailStart));
  const info = { cwd: null, title: null, firstPrompt: null, prompts: [], lastReply: null, size: st.size, mtimeMs: st.mtimeMs };
  for (const r of head) {
    if (!info.cwd && r.cwd) info.cwd = r.cwd;
    if (!info.firstPrompt && isPrompt(r)) info.firstPrompt = textOf(r.message.content);
    if (info.cwd && info.firstPrompt) break;
  }
  for (const r of tailLines) {
    if (r.type === 'ai-title' && r.aiTitle) info.title = r.aiTitle;
    if (!info.cwd && r.cwd) info.cwd = r.cwd;
    if (isPrompt(r)) info.prompts.push(textOf(r.message.content));
    else if (r.type === 'assistant' && !r.isSidechain && r.message) {
      const t = textOf(r.message.content);
      if (t.trim()) info.lastReply = t;
    }
  }
  if (!info.title) for (const r of head) if (r.type === 'ai-title' && r.aiTitle) info.title = r.aiTitle;
  info.prompts = info.prompts.slice(-3);
  peekCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, info });
  return info;
}

// Transcripts that belong to this project: folders named after the root (or a folder inside it),
// checked against the cwd recorded inside, so a look-alike folder such as "my-app-old" is skipped.
function transcripts(project, sinceMs) {
  const slug = project.root.replace(/[^a-zA-Z0-9]/g, '-');
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(TRANSCRIPTS_DIR).filter((d) => d === slug || d.startsWith(`${slug}-`));
  } catch (_) {
    return out;
  }
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(TRANSCRIPTS_DIR, d)).filter((f) => f.endsWith('.jsonl'));
    } catch (_) {
      continue;
    }
    for (const f of files) {
      const full = path.join(TRANSCRIPTS_DIR, d, f);
      let st;
      try {
        st = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (st.mtimeMs < sinceMs) continue;
      out.push({ sessionId: f.slice(0, -'.jsonl'.length), file: full });
    }
  }
  return out;
}

// ---------- the roster ----------
const scanCache = new Map(); // project id -> { at, closed }

// Remembers live sessions (their names are lost once they close) and returns the cache.
function remember(project, live) {
  const r = load(project.id);
  let dirty = false;
  const now = Date.now();
  for (const s of live) {
    if (!s.sessionId) continue;
    const e = r.sessions[s.sessionId] || {};
    if (e.name !== s.name || e.cwd !== s.cwd || now - (e.lastSeen || 0) > 60 * 1000) {
      r.sessions[s.sessionId] = { ...e, name: s.name, cwd: s.cwd, lastSeen: now };
      dirty = true;
    }
  }
  if (dirty) save(project.id, r);
  return r;
}

function closedSessions(project, live, now = Date.now()) {
  const hit = scanCache.get(project.id);
  const liveIds = new Set(live.map((s) => s.sessionId));
  if (hit && now - hit.at < SCAN_TTL_MS) return hit.closed.filter((c) => !liveIds.has(c.sessionId));
  const r = load(project.id);
  const closed = [];
  for (const t of transcripts(project, now - CLOSED_DAYS * 24 * 3600 * 1000)) {
    if (liveIds.has(t.sessionId)) continue;
    const info = peek(t.file);
    if (!info || !info.cwd || !inside(info.cwd, project.root) || !info.firstPrompt) continue;
    const e = r.sessions[t.sessionId] || {};
    closed.push({
      sessionId: t.sessionId,
      name: e.name || info.title || clip(info.firstPrompt, 40),
      cwd: info.cwd,
      title: info.title,
      purpose: e.purpose || null,
      lastActive: info.mtimeMs
    });
  }
  closed.sort((a, b) => b.lastActive - a.lastActive);
  const top = closed.slice(0, MAX_CLOSED);
  scanCache.set(project.id, { at: now, closed: top });
  return top;
}

// Open sessions (with purposes) and recently closed ones, for the card.
function view(project, live, now = Date.now()) {
  const r = remember(project, live);
  return {
    open: live.map((s) => ({
      pid: s.pid,
      sessionId: s.sessionId,
      name: s.name,
      status: s.status,
      paused: !!(r.sessions[s.sessionId] && r.sessions[s.sessionId].paused),
      purpose: (r.sessions[s.sessionId] && r.sessions[s.sessionId].purpose) || null
    })),
    closed: closedSessions(project, live, now).map((c) => ({ ...c, purpose: (r.sessions[c.sessionId] && r.sessions[c.sessionId].purpose) || c.purpose }))
  };
}

// Paused sessions stay open, but null plans no work for them and sends them nothing.
function setPaused(projectId, sessionId, paused) {
  const r = load(projectId);
  const e = r.sessions[sessionId] || { lastSeen: Date.now() };
  r.sessions[sessionId] = { ...e, paused: !!paused };
  save(projectId, r);
}

const isPaused = (projectId, sessionId) => {
  const e = load(projectId).sessions[sessionId];
  return !!(e && e.paused);
};

const purposeOf = (projectId, sessionId) => {
  const e = load(projectId).sessions[sessionId];
  return (e && e.purpose) || null;
};

// ---------- purposes ----------
const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          purpose: { type: 'string', description: "The session's main job, at most 10 words, starting with a verb or noun. No session name, no filler." }
        },
        required: ['id', 'purpose'],
        additionalProperties: false
      }
    }
  },
  required: ['items'],
  additionalProperties: false
};

const SYSTEM =
  "You label Claude Code sessions for a dashboard. For each session, write its main job in at most 10 words: the feature, fix, area or task it owns (e.g. 'Checkout tests and payment bugs', 'Venue outreach drafts'). Judge from all its prompts, not just the last. Use only the facts given.";

// Which sessions need a (new) purpose: never labelled, or grown by a third since, and not too often.
function stale(r, sessionId, info, now) {
  const e = r.sessions[sessionId];
  if (!e || !e.purpose) return true;
  return now - (e.purposeAt || 0) > REDO_MS && info.size > (e.purposeSize || 0) * 1.33 + 20000;
}

const running = new Set();

// Labels the sessions that need it with one headless run. Returns true when it ran.
async function refresh(project, live, { now = Date.now(), run = claude } = {}) {
  if (running.has(project.id)) return false;
  const r = remember(project, live);
  if (now - (r.ranAt || 0) < MIN_GAP_MS) return false;
  const want = [];
  const liveIds = new Set(live.map((s) => s.sessionId));
  const candidates = [
    ...live.filter((s) => s.sessionId).map((s) => ({ sessionId: s.sessionId, name: s.name })),
    ...closedSessions(project, live, now).map((c) => ({ sessionId: c.sessionId, name: c.name }))
  ];
  const files = new Map(transcripts(project, now - CLOSED_DAYS * 24 * 3600 * 1000).map((t) => [t.sessionId, t.file]));
  for (const c of candidates) {
    const info = files.has(c.sessionId) ? peek(files.get(c.sessionId)) : null;
    if (!info || !info.firstPrompt) continue;
    if (stale(r, c.sessionId, info, now)) want.push({ ...c, info, live: liveIds.has(c.sessionId) });
  }
  if (!want.length) return false;
  running.add(project.id);
  r.ranAt = now; // counts even if the run fails, so a failing run isn't retried on every change
  save(project.id, r);
  try {
    const body = want
      .slice(0, 12)
      .map(
        (w, i) =>
          `<session id="${i + 1}" name="${clip(w.name, 60)}"${w.info.title ? ` title="${clip(w.info.title, 80)}"` : ''}>\nfirst prompt: ${clip(w.info.firstPrompt, 400)}\nrecent prompts: ${
            w.info.prompts.map((p) => clip(p, 200)).join(' | ') || '(none)'
          }\nlast reply: ${clip(w.info.lastReply, 400) || '(none)'}\n</session>`
      )
      .join('\n');
    const result = await run(
      ['--name', `null-summary-${project.id}-roster`, '--tools', '', '--append-system-prompt', SYSTEM, '--json-schema', JSON.stringify(SCHEMA)],
      `Project: ${project.name}\n\n${body}\n\nLabel each session.`,
      { cwd: memory.workspace(project.id), timeout: 3 * 60 * 1000 }
    );
    const items = (structured(result).items || []).filter((x) => x && x.purpose);
    const fresh = load(project.id);
    for (const it of items) {
      const w = want[Number(it.id) - 1];
      if (!w) continue;
      const e = fresh.sessions[w.sessionId] || { name: w.name, lastSeen: now };
      fresh.sessions[w.sessionId] = { ...e, purpose: clip(it.purpose, 80), purposeAt: now, purposeSize: w.info.size, lastSeen: e.lastSeen || now };
    }
    fresh.ranAt = now;
    save(project.id, fresh);
    scanCache.delete(project.id);
    return true;
  } finally {
    running.delete(project.id);
  }
}

module.exports = { view, refresh, remember, closedSessions, purposeOf, setPaused, isPaused, peek, SCHEMA };
