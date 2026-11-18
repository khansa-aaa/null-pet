// One memory per project, in its own folder. Nothing here ever reads another project's folder:
// every function takes the project id and only touches projects/<id>/.
//   memory.md      goals, decisions and things the user rejected; the planner rewrites it
//   history.jsonl  every recommendation and what happened to it
//   workspace/     the cwd of that project's planner runs, so their transcripts stay apart too
const fs = require('fs');
const path = require('path');
const { PROJECTS_DIR } = require('./paths');

const MAX_MEMORY = 6000;

function dir(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`bad project id: ${id}`);
  const d = path.join(PROJECTS_DIR, id);
  fs.mkdirSync(path.join(d, 'workspace'), { recursive: true });
  return d;
}

const workspace = (id) => path.join(dir(id), 'workspace');

function readMemory(id) {
  try {
    return fs.readFileSync(path.join(dir(id), 'memory.md'), 'utf8');
  } catch (_) {
    return '';
  }
}

function writeMemory(id, text) {
  const t = String(text || '').trim();
  if (!t) return;
  fs.writeFileSync(path.join(dir(id), 'memory.md'), `${t.slice(0, MAX_MEMORY)}\n`);
}

function addHistory(id, entry) {
  fs.appendFileSync(path.join(dir(id), 'history.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function history(id, n = 15) {
  try {
    return fs
      .readFileSync(path.join(dir(id), 'history.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((l) => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

// History as a few short lines for the planner prompt.
function historyText(id, n = 15) {
  return history(id, n)
    .map((h) => `- ${h.at.slice(0, 16).replace('T', ' ')} ${h.event}: ${h.title || ''}${h.target ? ` → ${h.target}` : ''}${h.note ? ` (${h.note})` : ''}`)
    .join('\n');
}

module.exports = { dir, workspace, readMemory, writeMemory, addHistory, history, historyText };
