// "/summary" in null's chat: what changed in ONE project since the user last asked.
// Gathers commits, uncommitted files, what every Claude Code session in the project did (open or
// since closed), and null's own sends and decisions; then one short headless run boils that down
// to a few bullets. The marker (time + HEAD) moves forward only when a summary is shown.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { claude, structured } = require('./claude');
const memory = require('./memory');
const { TRANSCRIPTS_DIR } = require('./paths');

const FIRST_LOOKBACK_MS = 24 * 3600 * 1000; // the first /summary covers the last day
const MAX_CHARS = 40000;

const git = (cwd, args) =>
  new Promise((resolve) => execFile('git', args, { cwd, timeout: 8000, maxBuffer: 4_000_000 }, (e, out) => resolve(e ? '' : String(out).trim())));

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const markerFile = (id) => path.join(memory.dir(id), 'summary-marker.json');

function readMarker(id) {
  try {
    return JSON.parse(fs.readFileSync(markerFile(id), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeMarker(id, marker) {
  fs.writeFileSync(markerFile(id), JSON.stringify(marker, null, 2));
}

const inside = (cwd, root) => cwd === root || String(cwd || '').startsWith(`${root}/`);

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
};

// Each turn since `since` in one transcript: what was asked and the session's final words.
function turnsSince(file, root, since) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch (_) {
    return null;
  }
  let title = '';
  let cwdOk = false;
  const turns = [];
  for (const line of lines) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (r.cwd && inside(r.cwd, root)) cwdOk = true;
    if (r.type === 'ai-title' && r.aiTitle) title = r.aiTitle;
    if (r.isSidechain || !r.timestamp || Date.parse(r.timestamp) < since) continue;
    const content = r.message && r.message.content;
    if (r.type === 'user' && !r.isMeta) {
      const isToolResult = Array.isArray(content) && content.some((c) => c && c.type === 'tool_result');
      const text = textOf(content);
      if (!isToolResult && text && !text.startsWith('<')) turns.push({ prompt: text, reply: '' });
    } else if (r.type === 'assistant' && turns.length) {
      const text = textOf(content);
      if (text) turns[turns.length - 1].reply = text;
    }
  }
  if (!cwdOk || !turns.length) return null;
  return { title, turns };
}

function sessionsSince(project, since) {
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
      const file = path.join(TRANSCRIPTS_DIR, d, f);
      try {
        if (fs.statSync(file).mtimeMs < since) continue;
      } catch (_) {
        continue;
      }
      const s = turnsSince(file, project.root, since); // the cwd check drops a look-alike folder (my-app-old)
      if (s) out.push(s);
    }
  }
  return out;
}

async function gather(project, marker, now = Date.now()) {
  const since = marker && marker.at ? marker.at : now - FIRST_LOOKBACK_MS;
  const root = project.root;
  const head = await git(root, ['rev-parse', 'HEAD']);
  const known = marker && marker.head && (await git(root, ['cat-file', '-t', marker.head])) === 'commit';
  const range = known ? [`${marker.head}..HEAD`] : [`--since=@${Math.floor(since / 1000)}`];
  const [commits, stat, status] = await Promise.all([
    git(root, ['log', '--format=%h %s', ...range, '-60']),
    known ? git(root, ['diff', '--shortstat', `${marker.head}..HEAD`]) : Promise.resolve(''),
    git(root, ['status', '--short'])
  ]);
  const dirty = status.split('\n').filter(Boolean);
  const sessions = sessionsSince(project, since);
  const events = memory.history(project.id, 200).filter((h) => Date.parse(h.at) >= since && h.event !== 'recommended');

  const parts = [`Project: ${project.name}. Changes since ${new Date(since).toLocaleString()}.`];
  parts.push(`## Commits (${commits ? commits.split('\n').length : 0})${stat ? `; ${stat}` : ''}\n${commits || '(none)'}`);
  parts.push(`## Uncommitted files (${dirty.length})\n${dirty.slice(0, 30).join('\n') || '(none)'}`);
  parts.push(
    `## Claude Code sessions with activity (${sessions.length})\n${
      sessions
        .map((s) => `### ${s.title || '(untitled)'}\n${s.turns.slice(-6).map((t) => `- asked: ${clip(t.prompt, 220)}\n  result: ${clip(t.reply, 600) || '(no reply yet)'}`).join('\n')}`)
        .join('\n') || '(none)'
    }`
  );
  parts.push(`## null's sends and decisions\n${events.map((h) => `- ${h.event}: ${h.title || ''}${h.target ? ` → ${h.target}` : ''}${h.note ? ` (${clip(h.note, 120)})` : ''}`).join('\n') || '(none)'}`);
  let text = parts.join('\n\n');
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n…(cut)`;
  const empty = !commits && !dirty.length && !sessions.length && !events.length;
  return { text, since, head, empty };
}

const SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'Finished and landed (committed or completed), most important first.' },
    in_progress: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Started but not finished, including uncommitted work.' },
    needs_you: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Failures, blockers, questions or decisions waiting for the user.' }
  },
  required: ['done', 'in_progress', 'needs_you'],
  additionalProperties: false
};

const SYSTEM = `You write null's change summaries for the user. Each bullet is one fact, at most 14 words, plain words, no filler, no praise, no hedging. Merge related items (one bullet per feature or fix, not per commit). Name the concrete thing (screen, table, endpoint, test). Include numbers that matter (tests passing, files, migrations). Drop trivia (formatting, typo fixes, chores) unless that is all there is. Use only the facts given; never invent. Empty lists are fine.`;

async function summarize(project, data) {
  const result = await claude(
    ['--name', `null-summary-${project.id}`, '--tools', '', '--append-system-prompt', SYSTEM, '--json-schema', JSON.stringify(SCHEMA)],
    `${data.text}\n\nSummarize these changes.`,
    { cwd: memory.workspace(project.id), timeout: 4 * 60 * 1000 }
  );
  return structured(result);
}

function format(s, since) {
  const when = new Date(since).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const block = (name, list) => (list && list.length ? `${name}\n${list.map((b) => `• ${b}`).join('\n')}` : '');
  const body = [block('Done', s.done), block('In progress', s.in_progress), block('Needs you', s.needs_you)].filter(Boolean).join('\n\n');
  return `Since ${when}:\n\n${body || 'Nothing worth noting.'}`;
}

// The whole /summary: returns the text to show, and moves the marker forward.
async function run(project, now = Date.now()) {
  const marker = readMarker(project.id);
  const data = await gather(project, marker, now);
  const text = data.empty ? `Since ${new Date(data.since).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}: no changes.` : format(await summarize(project, data), data.since);
  writeMarker(project.id, { at: now, head: data.head || (marker && marker.head) || null });
  return text;
}

module.exports = { run, gather, summarize, format, readMarker, writeMarker, turnsSince, SCHEMA };
