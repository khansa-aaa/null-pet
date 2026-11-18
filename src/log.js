const fs = require('fs');
const path = require('path');
const { LOG_FILE } = require('./paths');

// One line per event, newest last. Trimmed to the last ~2000 lines when it grows past 1 MB.
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
    if (fs.statSync(LOG_FILE).size > 1_000_000) {
      const keep = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-2000).join('\n');
      fs.writeFileSync(LOG_FILE, keep);
    }
  } catch (_) {
    // logging must never break null
  }
  if (process.env.NULL_PET_DEBUG) process.stdout.write(line);
}

module.exports = { log };
