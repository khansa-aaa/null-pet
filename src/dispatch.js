// Getting a prompt to a Claude Code session.
//  - An existing session (already open in Terminal): a short headless "courier" run sends it with
//    SendMessage, the supported cross-session channel. The session runs it as a new turn.
//  - A new session: a new Terminal tab running `claude -n null-<project>-<n> "<prompt>"` in the
//    project folder. It is a normal interactive session, so your plugins and settings load as usual.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { claude, structured } = require('./claude');
const memory = require('./memory');
const settings = require('./settings');
const { COURIER_DIR } = require('./paths');

const COURIER_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { to: { type: 'string' }, ok: { type: 'boolean' }, detail: { type: 'string' } },
        required: ['to', 'ok', 'detail'],
        additionalProperties: false
      }
    }
  },
  required: ['results'],
  additionalProperties: false
};

function envelope(action, { auto }) {
  return [
    `Next task from null, the user's Claude Code orchestrator pet (${auto ? 'the user turned on auto mode, which pre-approves tasks like this' : 'the user approved this task'}).`,
    "Do the task in this session as if the user had typed it. Don't reply to the sender: it was a one-shot courier and has already exited.",
    '',
    '---',
    action.prompt
  ].join('\n');
}

// Sends each { to, text } with one SendMessage call. Returns [{ to, ok, detail }].
async function courier(messages) {
  if (!messages.length) return [];
  const body = messages
    .map((m, i) => `<message n="${i + 1}" to="${m.to}">\n${m.text}\n</message>`)
    .join('\n\n');
  const prompt = `You are null's courier. For each <message> below, call SendMessage exactly once with "to" set to its "to" attribute and "message" set to the message text copied EXACTLY, character for character (no summary, no edits, no additions). If a bare name is ambiguous or not found, call ListAgents once and use the matching "name [ref]". Send nothing else and do nothing else. Then report one result per message: ok=true only when SendMessage reported success; detail = the tool's result text (shortened).

${body}`;
  const result = await claude(
    [
      '--name',
      'null-courier',
      '--permission-mode',
      settings.read().courier_permission_mode || 'auto', // match your sessions' mode, or they hold the message for approval
      '--allowedTools',
      'ListAgents',
      'SendMessage',
      '--disallowedTools',
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
      'Read',
      'WebFetch',
      'WebSearch',
      'Agent',
      '--json-schema',
      JSON.stringify(COURIER_SCHEMA)
    ],
    prompt,
    { cwd: COURIER_DIR, timeout: 4 * 60 * 1000 }
  );
  return structured(result).results || [];
}

const osa = (script) =>
  new Promise((resolve, reject) => execFile('/usr/bin/osascript', ['-e', script], { timeout: 20000 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(String(out).trim()))));

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // shell single-quote
const asq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; // AppleScript string

let counter = 0;
function newName(project) {
  counter += 1;
  return `null-${project.id}-${Date.now().toString(36).slice(-4)}${counter}`;
}

// Opens a new Terminal tab (or window, if a tab can't be made) running an interactive claude.
async function openSession(project, action) {
  const dir = path.join(memory.dir(project.id), 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.txt`);
  fs.writeFileSync(file, action.prompt);
  const name = newName(project);
  const cmd = `cd ${shq(project.root)} && claude -n ${shq(name)} "$(cat ${shq(file)})"`;
  // A new tab in the front Terminal window (Cmd-T needs Accessibility for System Events). The command
  // is only typed into that tab if we can prove it's the fresh one: the window gained a tab and the
  // selected tab isn't running anything. Otherwise it goes to a brand-new window, so it can never
  // land in a tab where one of the user's Claude sessions is running.
  const result = await osa(`tell application "Terminal"
  if (count of windows) is 0 then
    do script ${asq(cmd)}
    return "window"
  end if
  set w to front window
  set tabCount to count of tabs of w
  activate
  try
    tell application "System Events" to keystroke "t" using command down
  end try
  delay 0.6
  if (count of tabs of w) > tabCount and (busy of selected tab of w) is false then
    do script ${asq(cmd)} in selected tab of w
    return "tab"
  end if
  do script ${asq(cmd)}
  return "window"
end tell`);
  return { name, where: result === 'tab' ? 'a new Terminal tab' : 'a new Terminal window' };
}

// Dispatches a set of actions. Returns [{ action, ok, target, detail }].
async function dispatch(project, actions, { auto = false } = {}) {
  const out = [];
  const existing = actions.filter((a) => a.target_kind === 'existing');
  const fresh = actions.filter((a) => a.target_kind !== 'existing');
  if (existing.length) {
    let results = [];
    try {
      results = await courier(existing.map((a) => ({ to: a.target_session, text: envelope(a, { auto }) })));
    } catch (e) {
      results = existing.map((a) => ({ to: a.target_session, ok: false, detail: e.message }));
    }
    existing.forEach((a, i) => {
      const r = results.find((x) => x.to && x.to.split(' [')[0] === a.target_session) || results[i] || { ok: false, detail: 'no result from courier' };
      out.push({ action: a, ok: !!r.ok, target: a.target_session, detail: r.detail || '' });
    });
  }
  for (const a of fresh) {
    try {
      const { name, where } = await openSession(project, a);
      out.push({ action: a, ok: true, target: name, detail: `opened ${where}` });
    } catch (e) {
      out.push({ action: a, ok: false, target: 'new session', detail: e.message });
    }
  }
  return out;
}

module.exports = { dispatch, courier, openSession, envelope };
