#!/usr/bin/env node
// Optional: use one of the pets that ships inside your own copy of the ChatGPT / Codex desktop app
// (for example "null") instead of null's built-in sprite. The art belongs to OpenAI, so it is not in
// this repository: this copies it from the app on YOUR Mac into assets/custom/, which git ignores.
//
//   npm run sprite:codex            # the "null" pet
//   npm run sprite:codex -- --list  # show the pets your app has
//   npm run sprite:codex -- hoots   # another one
//   npm run sprite:default          # back to the built-in sprite
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APPS = ['/Applications/ChatGPT.app', '/Applications/Codex.app', path.join(process.env.HOME || '', 'Applications', 'ChatGPT.app'), path.join(process.env.HOME || '', 'Applications', 'Codex.app')];
const CUSTOM = path.join(__dirname, '..', 'assets', 'custom');
const arg = process.argv[2] || 'null';

if (arg === '--reset') {
  fs.rmSync(CUSTOM, { recursive: true, force: true });
  console.log('Back to the built-in sprite. If null is running, quit and start it again to see it.');
  process.exit(0);
}

const asar = APPS.map((a) => path.join(a, 'Contents', 'Resources', 'app.asar')).find((f) => fs.existsSync(f));
if (!asar) {
  console.error('Could not find the ChatGPT or Codex desktop app in /Applications.');
  process.exit(1);
}

// An asar archive: a 16-byte prefix, a JSON index, then the files back to back.
const fd = fs.openSync(asar, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const base = 8 + head.readUInt32LE(4);
const json = Buffer.alloc(head.readUInt32LE(12));
fs.readSync(fd, json, 0, json.length, 16);
const sheets = [];
(function walk(node, at) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    if (entry.files) walk(entry, `${at}/${name}`);
    else if (/-spritesheet-v\d+.*\.webp$/i.test(name) && !entry.unpacked) sheets.push({ pet: name.replace(/-spritesheet.*/i, ''), name, entry });
  }
})(JSON.parse(json.toString('utf8')), '');

if (arg === '--list') {
  console.log(sheets.map((s) => s.pet).join('\n') || '(no pet sheets found in this version of the app)');
  process.exit(0);
}

const sheet = sheets.find((s) => s.pet === arg) || sheets.find((s) => s.pet.startsWith(arg));
if (!sheet) {
  console.error(`No pet called "${arg}" in ${asar}. Try: npm run sprite:codex -- --list`);
  process.exit(1);
}

const buf = Buffer.alloc(sheet.entry.size);
fs.readSync(fd, buf, 0, buf.length, base + Number(sheet.entry.offset));
fs.closeSync(fd);
fs.mkdirSync(CUSTOM, { recursive: true });
const out = path.join(CUSTOM, 'sprite.webp');
fs.writeFileSync(out, buf);
console.log(`Copied the "${sheet.pet}" sheet to assets/custom/sprite.webp`);

// Tray and notification icons from the first frame (192x208, top-left). Best effort: needs macOS sips.
try {
  const frame = path.join(CUSTOM, 'frame.png');
  execFileSync('sips', ['-s', 'format', 'png', '-c', '208', '192', '--cropOffset', '0', '0', out, '--out', frame], { stdio: 'ignore' });
  execFileSync('sips', ['-p', '208', '208', frame], { stdio: 'ignore' });
  execFileSync('sips', ['-z', '64', '64', frame, '--out', path.join(CUSTOM, 'tray.png')], { stdio: 'ignore' });
  execFileSync('sips', ['-z', '256', '256', frame, '--out', path.join(CUSTOM, 'icon.png')], { stdio: 'ignore' });
  fs.rmSync(frame, { force: true });
  console.log('Made the tray and app icons too.');
} catch (_) {
  console.log('Could not make the tray icon (sips failed); the built-in tray icon stays.');
}
console.log('Start null (or, if it is already running, quit and start it again) to see it.');
