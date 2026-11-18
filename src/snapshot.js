// A short brief of where ONE project stands: git, the project's own docs, and what each of its live
// sessions last did. Built from local files only; nothing here touches another project.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { TRANSCRIPTS_DIR } = require('./paths');

const MAX_CHARS = 24000; // ~6K tokens

const git = (cwd, args) =>
  new Promise((resolve) => execFile('git', args, { cwd, timeout: 8000, maxBuffer: 2_000_000 }, (e, out) => resolve(e ? '' : String(out).trim())));

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+\n/g, '\n').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function transcriptPath(session) {
  const slug = String(session.cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
  const direct = path.join(TRANSCRIPTS_DIR, slug, `${session.sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(TRANSCRIPTS_DIR)) {
      const f = path.join(TRANSCRIPTS_DIR, d, `${session.sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch (_) {
    // none
  }
  return null;
}

function tail(file, bytes = 400_000) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is probably cut
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
};

// The latest human prompt, the latest assistant text, the session's title and Claude Code's own
// "away summary" (a recap it writes when a session sits idle).
function readTranscript(lines) {
  const out = { title: null, lastPrompt: null, lastAssistant: null, awaySummary: null, endedTurn: false, at: null };
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (r.timestamp) out.at = r.timestamp;
    if (r.type === 'ai-title' && r.aiTitle) out.title = r.aiTitle;
    else if (r.type === 'last-prompt' && r.lastPrompt) out.lastPrompt = r.lastPrompt;
    else if (r.type === 'system' && r.subtype === 'away_summary' && r.content) out.awaySummary = String(r.content);
    else if (r.type === 'system' && r.subtype === 'turn_duration') out.endedTurn = true;
    else if (r.type === 'assistant' && r.message && !r.isSidechain) {
      const t = textOf(r.message.content);
      if (t.trim()) {
        out.lastAssistant = t;
        out.endedTurn = false;
      }
    } else if (r.type === 'user' && r.message && !r.isSidechain && !r.isMeta) {
      const t = textOf(r.message.content);
      if (t.trim() && !t.startsWith('<')) out.lastPrompt = t;
    }
  }
  return out;
}

function sessionBrief(session) {
  const f = transcriptPath(session);
  if (!f) return { name: session.name, status: session.status };
  let t = {};
  try {
    t = readTranscript(tail(f));
  } catch (_) {
    // unreadable: report what we know
  }
  return {
    name: session.name,
    status: session.status,
    title: t.title,
    lastPrompt: clip(t.lastPrompt, 700),
    lastAssistant: clip(t.lastAssistant, 1800),
    awaySummary: clip(t.awaySummary, 800),
    lastActivity: t.at
  };
}

function docHeadings(root) {
  const parts = [];
  for (const name of ['PROJECT.md', 'CLAUDE.md', 'AGENTS.md', 'README.md']) {
    const f = path.join(root, name);
    if (!fs.existsSync(f)) continue;
    try {
      const text = fs.readFileSync(f, 'utf8');
      const heads = text.split('\n').filter((l) => /^#{1,3} /.test(l)).slice(0, 25);
      parts.push(`${name}: ${heads.join(' | ')}`);
    } catch (_) {
      // skip
    }
    if (parts.length >= 2) break;
  }
  return parts.join('\n');
}

async function build(project, sessions) {
  const root = project.root;
  const [branch, status, log] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['status', '--short']),
    git(root, ['log', '--oneline', '-8'])
  ]);
  const statusLines = status.split('\n').filter(Boolean);
  const sess = sessions.map(sessionBrief);
  let text = [
    `# Project: ${project.name} (${root})`,
    `## Git`,
    `branch: ${branch || '(not a git repo)'}`,
    `uncommitted files: ${statusLines.length}${statusLines.length ? `\n${statusLines.slice(0, 25).join('\n')}` : ''}`,
    `recent commits:\n${log || '(none)'}`,
    `## Docs`,
    docHeadings(root) || '(none found)',
    `## Live Claude Code sessions in this project (${sess.length})`,
    ...sess.map((s) =>
      [
        `### ${s.name} [${s.status}]${s.title && s.title !== s.name ? ` — ${s.title}` : ''}`,
        s.lastActivity ? `last activity: ${s.lastActivity}` : '',
        s.awaySummary ? `recap: ${s.awaySummary}` : '',
        s.lastPrompt ? `last prompt: ${s.lastPrompt}` : '',
        s.lastAssistant ? `last reply: ${s.lastAssistant}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    )
  ].join('\n');
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n…(cut)`;
  return { text, sessions: sess, branch, dirty: statusLines.length };
}

module.exports = { build, readTranscript, transcriptPath, sessionBrief };
