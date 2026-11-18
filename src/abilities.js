// What null's own planner runs may use, and how it asks for more.
//
// A planner run gets every Claude Code tool (built-in and your MCP servers), but only the ones on
// this list run; the rest are refused and reported back. null turns each refusal into a request
// on the card: Allow always adds a rule here, so future runs use that ability without asking.
// Your own sessions are not affected: this list is only for null's planning runs.
const settings = require('./settings');

// On from the start: reading the project and its git history, fetching pages and searching the
// web. Nothing here changes files or clicks or types anywhere.
const DEFAULTS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git branch:*)',
  'Bash(ls:*)',
  'WebFetch',
  'WebSearch'
];

// Never offered: browser tools hang in a headless run (even listing tabs), which would stall the
// whole plan. Browser work goes to a session instead, where the browser works.
const NOT_OFFERED = [/^mcp__playwright__/, /^mcp__claude-in-chrome__/, /^mcp__.*browser/i, /^AskUserQuestion$/];

// Commands where the first word alone would allow too much (git push vs git log): the rule keeps
// the first two words.
const TWO_WORD = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'gh', 'docker', 'supabase', 'vercel', 'flutter', 'dart', 'firebase', 'brew', 'pip', 'python', 'python3', 'node', 'kubectl', 'aws', 'gcloud']);

const granted = () => settings.read().abilities_granted || [];
const allowed = () => [...new Set([...DEFAULTS, ...granted()])];

// The rule that would allow this call from now on, and a short description of the call.
function ruleFor(toolName, input = {}) {
  if (toolName === 'Bash') {
    const words = String(input.command || '').trim().split(/\s+/).filter((w) => !/^[A-Z_]+=/.test(w));
    if (!words.length) return null;
    const head = TWO_WORD.has(words[0]) && words[1] && !words[1].startsWith('-') ? `${words[0]} ${words[1]}` : words[0];
    return { rule: `Bash(${head}:*)`, detail: String(input.command).slice(0, 160) };
  }
  const detail = input.url || input.query || input.file_path || input.path || input.pattern || input.element || input.ref || '';
  return { rule: toolName, detail: String(detail).slice(0, 160) };
}

const LABELS = {
  WebFetch: 'Fetch web pages',
  WebSearch: 'Search the web',
  Edit: 'Edit files',
  Write: 'Create and overwrite files',
  NotebookEdit: 'Edit notebooks',
  Agent: 'Start helper agents',
  Bash: 'Run a command'
};

function label(rule) {
  const m = /^Bash\((.+):\*\)$/.exec(rule);
  if (m) return `Run \`${m[1]}\` commands`;
  if (LABELS[rule]) return LABELS[rule];
  const browser = /^mcp__playwright__browser_(.+)$/.exec(rule);
  if (browser) return `Browser: ${browser[1].replace(/_/g, ' ')}`;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(rule);
  if (mcp) return `${mcp[1].replace(/[-_]/g, ' ')}: ${mcp[2].replace(/_/g, ' ')}`;
  return rule;
}

// Refusals from a run → requests to show, one per rule, skipping anything already allowed.
function requestsFrom(denials) {
  const have = new Set(allowed());
  const out = new Map();
  for (const d of denials || []) {
    if (!d || !d.tool_name) continue;
    if (NOT_OFFERED.some((re) => re.test(d.tool_name))) continue;
    const r = ruleFor(d.tool_name, d.tool_input || {});
    if (!r || have.has(r.rule) || out.has(r.rule)) continue;
    out.set(r.rule, { rule: r.rule, label: label(r.rule), detail: r.detail, tool: d.tool_name });
  }
  return [...out.values()];
}

function grant(rule) {
  if (!rule || typeof rule !== 'string') return;
  settings.update((s) => (s.abilities_granted = [...new Set([...(s.abilities_granted || []), rule])]));
}

function revoke(rule) {
  settings.update((s) => (s.abilities_granted = (s.abilities_granted || []).filter((r) => r !== rule)));
}

module.exports = { DEFAULTS, NOT_OFFERED, allowed, granted, grant, revoke, ruleFor, requestsFrom, label };
