// Settings and paths shared by the whole server.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4747);
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 30);
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
const MIN = 60_000;
const CLAUDE_BIN = process.env.CLAUDE_BIN || [path.join(os.homedir(), '.local', 'bin', 'claude')].find((p) => fs.existsSync(p)) || 'claude';
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORTAL_FILE = path.join(ROOT, 'portal-agents.json');
const TOWN_FILE = path.join(ROOT, 'town.json');
const CLAN_FILE = path.join(ROOT, 'clan.json');
// Only the game page knows this token, so other web pages can't drive the spawn endpoints.
const API_TOKEN = crypto.randomBytes(24).toString('hex');
const MODELS = ['opus', 'sonnet', 'haiku'];
const DEFAULT_PROJECTS_FOLDER = process.env.PROJECTS_FOLDER
  || [path.join(os.homedir(), 'Documents', 'Projects'), path.join(os.homedir(), 'Documents')].find((p) => fs.existsSync(p))
  || os.homedir();
// What a portal-hired agent may do without asking: edit files in its project plus read-only and build/test commands.
const ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'TodoWrite',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
  // Read-only git in another folder; a hired agent can't cd before running git.
  'Bash(git fetch:*)', 'Bash(git -C * status*)', 'Bash(git -C * diff*)', 'Bash(git -C * log*)', 'Bash(git -C * fetch*)',
  'Bash(npm test:*)', 'Bash(npm run build:*)', 'Bash(npm run test:*)',
  'Bash(./mvnw compile:*)', 'Bash(./mvnw test:*)', 'Bash(./gradlew build:*)', 'Bash(./gradlew test:*)',
];

module.exports = { PUBLIC_DIR, PORT, HISTORY_DAYS, CLAUDE_DIR, CODEX_DIR, MIN, CLAUDE_BIN, PORTAL_FILE, TOWN_FILE, CLAN_FILE, API_TOKEN, MODELS, DEFAULT_PROJECTS_FOLDER, ALLOWED_TOOLS };
