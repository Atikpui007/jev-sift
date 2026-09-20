// Runs at session start. Copies the status line script to a stable path and, if the
// user has no status line configured, points Claude Code at it. Never overwrites an
// existing status line. Safe to run every session.
const fs = require('fs'), path = require('path'), os = require('os');
const root = process.env.CLAUDE_PLUGIN_ROOT || __dirname;
const dir = path.join(os.homedir(), '.claude', 'jev-sift');
const dst = path.join(dir, 'statusline.sh');
try {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts', 'statusline.sh'), dst);
  fs.chmodSync(dst, 0o755);
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  if (!settings.statusLine) {
    settings.statusLine = { type: 'command', command: dst, padding: 0 };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
} catch (e) {
  // never block a session over the status line
}
