// Where null keeps its files, and where Claude Code keeps the ones null reads.
const os = require('os');
const path = require('path');

const HOME = os.homedir();
// A screenshot run (NULL_PET_SNAPSHOT=<dir>) keeps everything inside <dir>, away from your real data.
const SNAPSHOT = process.env.NULL_PET_SNAPSHOT || '';
const DATA_DIR = process.env.NULL_PET_DATA || (SNAPSHOT ? path.join(SNAPSHOT, 'data') : path.join(HOME, 'Library', 'Application Support', 'null-pet'));
const CLAUDE_DIR = process.env.NULL_PET_CLAUDE_DIR || path.join(os.homedir(), '.claude');

module.exports = {
  HOME,
  DATA_DIR,
  SETTINGS_FILE: path.join(DATA_DIR, 'settings.json'),
  LOG_FILE: path.join(DATA_DIR, 'null.log'),
  PROJECTS_DIR: path.join(DATA_DIR, 'projects'), // one folder per project: memory, history, workspace
  COURIER_DIR: path.join(DATA_DIR, 'courier'),
  SESSIONS_DIR: path.join(CLAUDE_DIR, 'sessions'),
  TRANSCRIPTS_DIR: path.join(CLAUDE_DIR, 'projects'),
  METER_FILE: process.env.NULL_PET_METER || (SNAPSHOT ? path.join(SNAPSHOT, 'fable-meter.json') : path.join(CLAUDE_DIR, 'fable-meter.json')),
  LAUNCH_AGENT: path.join(HOME, 'Library', 'LaunchAgents', 'dev.null-pet.plist')
};
