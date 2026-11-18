// Watches ~/.claude/sessions/<pid>.json: every live Claude Code session writes one, with its cwd,
// name and status ("busy" or "idle"). Reading these costs no Claude usage at all.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { SESSIONS_DIR, DATA_DIR } = require('./paths');

// null's own headless runs (planner, courier) are named with this prefix and run inside DATA_DIR.
const OWN_PREFIX = /^null-(planner|courier|summary)/;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const inside = (dir, root) => {
  const d = path.resolve(dir);
  const r = path.resolve(root);
  return d === r || d.startsWith(r + path.sep);
};

// Which project (if any) a session belongs to: its cwd is the project root or under it.
function projectOf(session, projects) {
  if (!session.cwd) return null;
  return projects.find((p) => p.root && inside(session.cwd, p.root)) || null;
}

function isOwn(session) {
  return OWN_PREFIX.test(session.name || '') || (session.cwd && inside(session.cwd, DATA_DIR));
}

function readAll(dir = SESSIONS_DIR) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s && s.pid && alive(s.pid)) out.push(s);
    } catch (_) {
      // a file mid-write; next poll will get it
    }
  }
  return out;
}

class SessionWatcher extends EventEmitter {
  constructor(getProjects, { pollMs = 3000, dir = SESSIONS_DIR } = {}) {
    super();
    this.getProjects = getProjects;
    this.pollMs = pollMs;
    this.dir = dir;
    this.known = new Map(); // pid -> last seen record
    this.timer = null;
    this.fsw = null;
  }

  start() {
    this.scan(true);
    this.timer = setInterval(() => this.scan(false), this.pollMs);
    try {
      let pending = null;
      this.fsw = fs.watch(this.dir, () => {
        clearTimeout(pending);
        pending = setTimeout(() => this.scan(false), 250);
      });
    } catch (_) {
      // polling alone is enough
    }
  }

  stop() {
    clearInterval(this.timer);
    if (this.fsw) this.fsw.close();
  }

  // All watched sessions, grouped by project id.
  list() {
    const projects = this.getProjects();
    const by = Object.fromEntries(projects.map((p) => [p.id, []]));
    for (const s of this.known.values()) {
      const p = projectOf(s, projects);
      if (p && !isOwn(s)) by[p.id].push(s);
    }
    for (const id of Object.keys(by)) by[id].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return by;
  }

  scan(first) {
    const projects = this.getProjects();
    const now = readAll(this.dir);
    const seen = new Set();
    let changed = false;
    for (const s of now) {
      seen.add(s.pid);
      const prev = this.known.get(s.pid);
      this.known.set(s.pid, s);
      if (!prev || prev.status !== s.status || prev.name !== s.name) changed = true;
      if (first || isOwn(s)) continue;
      const p = projectOf(s, projects);
      if (!p) continue;
      if (prev && prev.status === 'busy' && s.status === 'idle') this.emit('idle', p.id, s);
      if (prev && prev.status !== 'busy' && s.status === 'busy') this.emit('busy', p.id, s);
      if (!prev) this.emit('appeared', p.id, s);
    }
    for (const pid of [...this.known.keys()]) {
      if (!seen.has(pid)) {
        const s = this.known.get(pid);
        this.known.delete(pid);
        changed = true;
        const p = projectOf(s, projects);
        if (p && !isOwn(s)) this.emit('gone', p.id, s);
      }
    }
    if (changed || first) this.emit('change', this.list());
  }
}

module.exports = { SessionWatcher, projectOf, isOwn, readAll, alive };
