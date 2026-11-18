// The planner: one headless Claude Code run per recommendation, for ONE project at a time.
// It runs in that project's own workspace folder (projects/<id>/workspace) with read-only tools and
// the project root added, sees only that project's snapshot, memory and history, and answers with
// structured JSON. Chat about a card resumes that card's planner conversation.
// Its model comes from your Claude Code settings, like any other session (user settings are loaded).
const { claude, structured } = require('./claude');
const memory = require('./memory');

const ACTION = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'What this does, in under 70 characters.' },
    prompt: {
      type: 'string',
      description:
        'The full prompt to give the Claude Code session, as the user would type it: the goal, scope, what "done" means, and any checks to run. It must make sense to that session as written.'
    },
    target_kind: { type: 'string', enum: ['existing', 'new'] },
    target_session: { type: 'string', description: 'For existing: the exact session name from the list. For new: empty.' },
    what: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 4,
      description: 'What the session will do, as 1-4 bullets of at most 12 words each: the concrete changes and the check that proves it is done.'
    },
    why: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 3,
      description: 'Why now, as 1-3 bullets of at most 12 words each: the gap or goal it closes, from the snapshot or memory.'
    },
    risky: { type: 'boolean', description: 'True for production, deploys, migrations, RLS, releases, deleting, pushing, sends or anything hard to undo.' },
    risk_reason: { type: 'string', description: 'Why it is risky, or empty.' }
  },
  required: ['title', 'prompt', 'target_kind', 'target_session', 'what', 'why', 'risky', 'risk_reason'],
  additionalProperties: false
};

const SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', description: 'Where the project stands, in one sentence of at most 20 words.' },
    reply: { type: 'string', description: "Your answer to the user's chat message, or empty when there was none." },
    needs_you: {
      type: 'array',
      maxItems: 6,
      description: 'Everything still waiting on the user that only they can do: logins, decisions, answers to questions, purchases, approvals. Read every session\'s last reply for these. Empty when nothing is waiting.',
      items: {
        type: 'object',
        properties: {
          ask: { type: 'string', description: 'What the user has to do, at most 16 words, concrete (e.g. "Log in to Vercel in the Chrome window, or run ! vercel login").' },
          session: { type: 'string', description: 'The session waiting on it (exact name), or empty when it is project-wide.' },
          kind: { type: 'string', enum: ['login', 'decision', 'answer', 'purchase', 'approval', 'other'] },
          blocks: { type: 'string', description: 'What stays stuck until it is done, at most 12 words.' }
        },
        required: ['ask', 'session', 'kind', 'blocks'],
        additionalProperties: false
      }
    },
    actions: { type: 'array', items: ACTION, maxItems: 3 },
    memory_update: { type: 'string', description: 'The full new memory.md for this project when something durable changed, or empty to keep it.' }
  },
  required: ['status', 'reply', 'needs_you', 'actions', 'memory_update'],
  additionalProperties: false
};

function system(project, maxBusy) {
  return `You are null, the user's Claude Code orchestrator for ONE project: ${project.name} (${project.root}).
Much of the user's weekly Claude allowance goes unused because sessions sit idle between tasks. Your job: whenever sessions are idle, recommend the next 1-3 pieces of work that actually move this project forward, so the allowance turns into progress.

How to recommend:
- Each action is a prompt that goes to one Claude Code session as-is. Write it the way the user would: concrete goal, scope, done criteria, checks to run. Follow the project's conventions (CLAUDE.md / AGENTS.md).
- Prefer the idle sessions listed. A follow-up to what a session was just doing goes to that same session (it has the context). Use the exact session name. At most one action per session.
- Use target_kind "new" only when no idle session fits and the work stands on its own; a new session starts with no context, so its prompt must be complete. Never let busy sessions in this project exceed ${maxBusy}.
- Spread independent work across idle sessions in parallel. Never duplicate what a busy session is doing.
- Never re-propose something the user rejected (see memory and history) unless the user brings it back.
- Mark risky: production, deploys, migrations, RLS/policies, releases/store submissions, deleting data or files, git push, sending emails/outreach/messages, payments, secrets, anything outward-facing or hard to undo.
- Check facts with Read/Grep/git if needed, but keep it short (at most ~8 tool calls). You cannot edit anything.
- "what" and "why" are what the user reads to decide, so make them clear and short: bullets, one fact each, at most 12 words, no filler, no repeating the title. The detail belongs in the prompt.
- needs_you: list every open ask from the sessions' last replies (logins, decisions, answers, purchases, approvals), each once, most blocking first. Never bury these in status. A session whose last reply asks the user something gets no new work that depends on that answer.
- Never plan around a missing login or decision by quietly narrowing the work: list it in needs_you, then propose only work that truly doesn't need it.
- If nothing is worth doing, return no actions and say why in status.
- This is the only project you know about. Never mention or plan for any other project.

memory_update: rewrite memory.md (under 4000 characters) only when you learned something durable: goals, current milestone, decisions, the user's preferences, rejected ideas with reasons. Otherwise empty.`;
}

const TOOLS = ['--tools', 'Read', 'Grep', 'Glob', 'Bash'];
const ALLOWED = ['--allowedTools', 'Read', 'Grep', 'Glob', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git branch:*)', 'Bash(ls:*)'];

function baseArgs(project, maxBusy) {
  return [
    '--name',
    `null-planner-${project.id}`,
    '--permission-mode',
    'default', // anything not allowed above is denied, never run
    ...TOOLS,
    ...ALLOWED,
    '--add-dir',
    project.root,
    '--append-system-prompt',
    system(project, maxBusy),
    '--json-schema',
    JSON.stringify(SCHEMA)
  ];
}

function usageLine(u) {
  if (!u || !u.week) return 'Weekly usage: unknown yet.';
  const pct = Math.round(u.week.utilization * 100);
  const el = u.elapsed != null ? `${Math.round(u.elapsed * 100)}% of the week elapsed` : '';
  const week = `Weekly usage: ${pct}% used${el ? `, ${el}` : ''}${u.pace != null ? ` (pace ${u.pace.toFixed(2)}; below 1 means there is room for more parallel work)` : ''}.`;
  if (!u.fable) return week;
  const f = Math.round(u.fable.utilization * 100);
  const note = {
    boost: 'Fable is behind, so there is room to send more work to Fable: favour deep work that earns it (architecture, hard debugging, thorough reviews, careful plans).',
    save: 'Fable is ahead or nearly used up, so it should be kept for work that needs it: keep proposals to ordinary build work.',
    normal: 'Fable is on pace.'
  }[u.fableMode || 'normal'];
  return `${week} Fable's own weekly limit: ${f}% used. ${note}`;
}

function input(project, snap, sessions, { reason, usage, maxBusy }) {
  const label = (s) => `\n  - ${s.name}${s.purpose ? `: ${s.purpose}` : ''}`;
  const idle = sessions.filter((s) => s.status === 'idle').map(label);
  const busy = sessions.filter((s) => s.status !== 'idle').map(label);
  return `Why you're being asked: ${reason}
${usageLine(usage)}
Idle sessions you can use (exact name, then its main job):${idle.length ? idle.join('') : ' (none)'}
Busy sessions (leave alone):${busy.length ? busy.join('') : ' (none)'}
New sessions allowed: ${Math.max(0, maxBusy - busy.length - idle.length)} (only if no idle session fits)

<memory>
${memory.readMemory(project.id) || '(empty: first run for this project)'}
</memory>

<recent_history>
${memory.historyText(project.id) || '(none)'}
</recent_history>

<snapshot>
${snap.text}
</snapshot>

Recommend the next set of actions.`;
}

async function recommend(project, snap, sessions, opts) {
  const result = await claude(baseArgs(project, opts.maxBusy), input(project, snap, sessions, opts), { cwd: memory.workspace(project.id), timeout: 8 * 60 * 1000 });
  return { rec: structured(result), session: result.session_id };
}

// Chat or a rejection: continue that card's planner conversation.
async function followUp(project, plannerSession, text, opts) {
  const args = ['--resume', plannerSession, ...baseArgs(project, opts.maxBusy)];
  const result = await claude(args, `${text}\n\n(Idle sessions now: ${opts.idle.join(', ') || 'none'}. Answer in "reply", and return the updated set of actions.)`, {
    cwd: memory.workspace(project.id),
    timeout: 8 * 60 * 1000
  });
  return { rec: structured(result), session: result.session_id };
}

module.exports = { recommend, followUp, SCHEMA, system, input };
