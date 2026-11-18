// null's settings, kept in settings.json in the data folder. Projects are added from the pet's
// menu ("Add project folder…") or by editing the file.
const fs = require('fs');
const path = require('path');
const { SETTINGS_FILE } = require('./paths');

const DEFAULTS = {
  mode: 'manual', // 'manual': approve / reject / chat on every card. 'auto': run safe actions without asking.
  paused: false,
  projects: [], // { id, name, root, enabled }: one per project folder; each gets its own memory
  idle_debounce_s: 20, // a session must stay idle this long before null plans for it
  max_busy_per_project: 4, // null won't start new sessions past this many busy ones in a project
  week_cap: 0.95, // auto mode stops dispatching once the 7-day window passes this utilization
  courier_permission_mode: 'auto', // the permission mode your own sessions run in; a mismatch makes them hold null's messages for approval
  card_large: false, // the card's expand button
  abilities_granted: [], // tool rules you allowed for null's planner on top of src/abilities.js DEFAULTS
  anchor: null
};

let cache = null;

function read() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (_) {
    // first run
  }
  cache = { ...DEFAULTS, ...saved, projects: saved.projects || DEFAULTS.projects };
  return cache;
}

function update(fn) {
  const s = read();
  fn(s);
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return s;
}

const project = (id) => read().projects.find((p) => p.id === id) || null;

// A project id names its memory folder: lowercase letters, digits and dashes, unique.
function slug(name, taken) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

// Adds a project folder (or returns the one already set up for it).
function addProject(root) {
  const dir = path.resolve(String(root)).replace(/\/+$/, '') || '/';
  const existing = read().projects.find((p) => p.root === dir);
  if (existing) return existing;
  const name = path.basename(dir) || dir;
  const p = { id: slug(name, read().projects.map((x) => x.id)), name, root: dir, enabled: true };
  update((s) => (s.projects = [...s.projects, p]));
  return p;
}

// Stops tracking a project. Its memory folder stays on disk.
function removeProject(id) {
  update((s) => (s.projects = s.projects.filter((p) => p.id !== id)));
}

module.exports = { read, update, project, addProject, removeProject, DEFAULTS };
