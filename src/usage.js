// Weekly and 5-hour usage, as Claude Code reports it in the rate_limit_event of every headless run.
// Example: { status, rateLimitType: 'seven_day', unifiedWindows: { seven_day: { utilization: 0.31, resetsAt, status } } }
const fs = require('fs');
const path = require('path');
const { DATA_DIR, METER_FILE } = require('./paths');

const FILE = path.join(DATA_DIR, 'usage.json');
// A small shared file that a model-routing hook or plugin can read to steer how much work goes to Fable.
// Percentages 0-100; resetsAt in epoch seconds. Fable's own weekly window only comes back on
// replies Fable wrote, and null's planner runs are Fable, so null keeps this reading fresh.
const METER = METER_FILE;
const FABLE = 'seven_day_overage_included';
// The bands for fableMode below, in percentage points.
const BEHIND = 10;
const AHEAD = 5;
const RESERVE = 95;
let state = load();
const listeners = new Set();

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    return { windows: {}, at: null };
  }
}

function record(info) {
  if (!info) return;
  const windows = { ...state.windows };
  for (const [name, w] of Object.entries(info.unifiedWindows || {})) {
    if (w && Number.isFinite(w.utilization)) windows[name] = { utilization: w.utilization, resetsAt: w.resetsAt || null, status: w.status || 'allowed' };
  }
  if (info.rateLimitType && !windows[info.rateLimitType] && Number.isFinite(info.utilization)) {
    windows[info.rateLimitType] = { utilization: info.utilization, resetsAt: info.resetsAt || null, status: info.status || 'allowed' };
  }
  state = { windows, at: Date.now() };
  writeMeter(info.unifiedWindows || {});
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (_) {
    // not important
  }
  for (const fn of listeners) fn(summary());
}

function writeMeter(fresh) {
  const pick = (w) => w && Number.isFinite(w.utilization) && { used: Math.round(w.utilization * 1000) / 10, resetsAt: w.resetsAt || undefined, at: Date.now() };
  const fable = pick(fresh[FABLE]);
  const week = pick(fresh.seven_day);
  if (!fable && !week) return;
  let meter = {};
  try {
    meter = JSON.parse(fs.readFileSync(METER, 'utf8')) || {};
  } catch (_) {
    // first write
  }
  if (fable) meter.fable = fable;
  if (week) meter.week = week;
  try {
    fs.mkdirSync(path.dirname(METER), { recursive: true });
    const tmp = `${METER}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meter, null, 2));
    fs.renameSync(tmp, METER);
  } catch (_) {
    // readers then keep their last reading
  }
}

// boost: Fable trails the weekly share, so more work should go to Fable; save: the reverse.
function fableMode(fableUsed, weekUsed) {
  if (fableUsed == null || weekUsed == null) return 'normal';
  if (fableUsed >= RESERVE) return 'save';
  if (fableUsed < weekUsed - BEHIND) return 'boost';
  if (fableUsed > weekUsed + AHEAD) return 'save';
  return 'normal';
}

// How far through the week we are (0..1), from the seven-day window's reset time.
function weekElapsed(resetsAt, now = Date.now()) {
  if (!resetsAt) return null;
  const end = resetsAt * 1000;
  const start = end - 7 * 24 * 3600 * 1000;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

// pace > 1: spending faster than an even week would; < 1: behind (room to push more work).
function summary(now = Date.now()) {
  const week = state.windows.seven_day || null;
  const five = state.windows.five_hour || null;
  const elapsed = week ? weekElapsed(week.resetsAt, now) : null;
  const pace = week && elapsed ? week.utilization / Math.max(elapsed, 0.02) : null;
  const limited = Object.values(state.windows).some((w) => w.status && w.status !== 'allowed' && w.status !== 'allowed_warning');
  let fable = state.windows[FABLE] || null;
  if (fable && fable.resetsAt && fable.resetsAt * 1000 <= now) fable = { ...fable, utilization: 0 };
  const weekNow = week && week.resetsAt && week.resetsAt * 1000 <= now ? 0 : week && week.utilization;
  const mode = fableMode(fable ? fable.utilization * 100 : null, weekNow != null ? weekNow * 100 : null);
  return { week, five, fable, fableMode: mode, elapsed, pace, limited, at: state.at };
}

module.exports = { record, summary, weekElapsed, fableMode, METER, onChange: (fn) => listeners.add(fn) };
