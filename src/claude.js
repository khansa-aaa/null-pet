// Running the Claude Code CLI headless.
//
// null does NOT isolate its runs from your Claude Code settings: plugins, hooks and model choices in
// ~/.claude/settings.json apply to every run null starts, the same as to your own sessions.
// So no --setting-sources / disableAllHooks here.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const usage = require('./usage');
const { log } = require('./log');

let shellPathPromise = null;
function shellPath() {
  if (!shellPathPromise) {
    shellPathPromise = new Promise((resolve) => {
      execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'echo "__PATH__$PATH"'], { timeout: 8000 }, (_e, out) => {
        const m = /__PATH__(.*)/.exec(out || '');
        resolve(m ? m[1].trim() : '');
      });
    });
  }
  return shellPathPromise;
}

async function childEnv() {
  const home = os.homedir();
  const extra = [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  const PATH = [await shellPath(), process.env.PATH, ...extra].filter(Boolean).join(path.delimiter);
  const env = { ...process.env, PATH };
  delete env.ELECTRON_RUN_AS_NODE;
  // If null was started from inside a Claude Code session, it inherited that session's identity
  // (session id, messaging socket, child-session marker). Runs that kept it would act as that
  // session's children: no transcript, and messages sent on its behalf. Each run must be its own.
  delete env.AI_AGENT; // set for commands an agent runs; a session that sees it doesn't register itself
  for (const k of Object.keys(env)) {
    if ((k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_JOB_DIR' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_')) && k !== 'CLAUDE_CODE_PLUGIN_DIRS') delete env[k];
  }
  return env;
}

function findBin(bin, env) {
  for (const dir of env.PATH.split(path.delimiter)) {
    const f = path.join(dir, bin);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch (_) {
      // keep looking
    }
  }
  return null;
}

const lastLine = (t) => String(t || '').trim().split('\n').filter(Boolean).pop() || '';

// Runs `claude -p` with stream-json output. Returns the final result event, and records any
// rate-limit event on the way (that's how null learns the weekly usage).
async function claude(args, input, { cwd, timeout = 10 * 60 * 1000 }) {
  const env = await childEnv();
  const bin = findBin('claude', env);
  if (!bin) throw new Error('Claude Code is not installed or not on the PATH.');
  fs.mkdirSync(cwd, { recursive: true });
  const full = ['-p', ...args, '--output-format', 'stream-json', '--verbose'];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, full, { env, cwd });
    let buf = '';
    let stderr = '';
    let result = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    const onLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (_) {
        return;
      }
      if (ev.type === 'rate_limit_event') usage.record(ev.rate_limit_info);
      if (ev.type === 'result') result = ev;
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      onLine(buf);
      if (timedOut) return reject(new Error('Claude took too long to answer.'));
      if (!result) return reject(new Error(lastLine(stderr) || 'Claude Code stopped unexpectedly.'));
      if (result.is_error) return reject(new Error(result.result || 'Claude Code reported an error.'));
      log('claude', { cwd: path.basename(cwd), models: Object.keys(result.modelUsage || {}), ms: result.duration_ms });
      resolve(result);
    });
    child.stdin.end(input || '');
  });
}

// Structured output from a --json-schema run.
function structured(result) {
  if (result.structured_output) return result.structured_output;
  const t = String(result.result || '').trim();
  const m = /\{[\s\S]*\}/.exec(t);
  return JSON.parse(m ? m[0] : t);
}

module.exports = { claude, structured, childEnv, findBin };
