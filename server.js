// Agent Colony — reads local Claude Code and Codex session logs and streams colony state to the game page.
// Run: node server.js   then open http://localhost:4747
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 4747);
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 30);
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
const MIN = 60_000;
const CLAUDE_BIN = process.env.CLAUDE_BIN || [path.join(os.homedir(), '.local', 'bin', 'claude')].find((p) => fs.existsSync(p)) || 'claude';
const PORTAL_FILE = path.join(__dirname, 'portal-agents.json');
const TOWN_FILE = path.join(__dirname, 'town.json');
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
  'Bash(npm test:*)', 'Bash(npm run build:*)', 'Bash(npm run test:*)',
  'Bash(./mvnw compile:*)', 'Bash(./mvnw test:*)', 'Bash(./gradlew build:*)', 'Bash(./gradlew test:*)',
];

// $ per 1M tokens. Cache writes are billed at 1.25x input (5m) or 2x input (1h).
const PRICES = [
  { match: /fable|mythos/, input: 10, output: 50, cacheRead: 0.25 },
  { match: /opus-5-5/, input: 4, output: 20, cacheRead: 0.2 },
  { match: /opus/, input: 5, output: 25, cacheRead: 0.5 },
  { match: /sonnet-4/, input: 3, output: 15, cacheRead: 0.3 },
  { match: /sonnet/, input: 2, output: 10, cacheRead: 0.2 },
  { match: /haiku-4/, input: 1, output: 5, cacheRead: 0.1 },
  { match: /haiku/, input: 0.1, output: 0.5, cacheRead: 0.01 },
  // Codex/GPT rates are a placeholder estimate — edit to match your plan.
  { match: /gpt|codex|^o\d/, input: 1.25, output: 10, cacheRead: 0.125 },
];
const DEFAULT_PRICE = PRICES[1];

const agents = new Map();
const files = new Map();
const events = [];
const dailyCost = new Map();
const dailyLines = new Map();
let initialScanDone = false;

function priceFor(model) {
  const name = String(model || '').toLowerCase();
  return PRICES.find((p) => p.match.test(name)) || DEFAULT_PRICE;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// Which kind of building a project gets, from the marker files in its folder (or one level down).
const STACK_MARKERS = [
  ['angular', ['angular.json']],
  ['java', ['pom.xml', 'build.gradle', 'build.gradle.kts']],
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py']],
  ['go', ['go.mod']],
  ['rust', ['Cargo.toml']],
  ['node', ['package.json']],
  ['web', ['index.html']],
];
const stackCache = new Map();

function stacksIn(folder) {
  let names;
  try { names = new Set(fs.readdirSync(folder)); } catch { return []; }
  return STACK_MARKERS.filter(([, markers]) => markers.some((m) => names.has(m))).map(([stack]) => stack);
}

function stackOf(folder) {
  if (!folder) return 'misc';
  if (stackCache.has(folder)) return stackCache.get(folder);
  let found = stacksIn(folder);
  if (!found.length) {
    let children = [];
    try { children = fs.readdirSync(folder, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).slice(0, 20); } catch { /* unreadable */ }
    found = [...new Set(children.flatMap((d) => stacksIn(path.join(folder, d.name))))];
  }
  const isFullStack = found.includes('java') && (found.includes('angular') || found.includes('node'));
  const stack = isFullStack ? 'fullstack' : found[0] || 'misc';
  stackCache.set(folder, stack);
  return stack;
}

// ---- project profile: size and features, read from manifest files in the background and refreshed hourly ----
const PROFILE_TTL_MS = 60 * MIN;
const MAX_ENTRIES_SCANNED = 30_000;
const SKIP_DIRS = new Set(['node_modules', 'target', 'build', 'dist', 'out', 'bin', 'obj', 'vendor', 'coverage', 'venv', '__pycache__']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'e2e']);
const SOURCE_FILE = /\.(java|kt|kts|scala|ts|tsx|js|jsx|mjs|py|go|rs|swift|cs|rb|php|vue|svelte|html|scss|css|sql)$/;
const TEST_FILE = /[._](spec|test)\.|^test_|Tests?\.java$/;
const PROJECT_MANIFESTS = [
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'package.json', 'requirements.txt', 'pyproject.toml', 'setup.py',
  'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json',
];
const MANIFESTS = [
  ...PROJECT_MANIFESTS, 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'src/main/resources/application.properties', 'src/main/resources/application.yml',
];
const CONTAINER_MARKERS = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'k8s', 'helm', 'charts'];
const CI_MARKERS = ['.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml'];
const UI_PATTERN = /@angular\/core|"react"|"vue"|"svelte"|"next"|thymeleaf/;
// Listed in display priority: a building shows the first few its project has.
const FEATURE_PATTERNS = [
  ['api', /spring-boot-starter-web|webflux|jersey|"express"|"fastify"|"koa"|@nestjs\/core|flask|fastapi|django|gin-gonic|actix-web|axum/],
  ['db', /data-jpa|jdbc|postgres|mysql|mssql|sqlserver|mongodb|mongoose|hibernate|flyway|liquibase|prisma|typeorm|sequelize|sqlalchemy|psycopg|"pg"|sqlite|redis/],
  ['messaging', /kafka|amqp|rabbitmq|activemq|websocket|socket\.io|"ws"|nats|mqtt|stomp/],
  ['security', /starter-security|spring-security|oauth2|jjwt|jsonwebtoken|passport|keycloak|auth0|next-auth|ldap|saml/],
  ['ai', /anthropic|openai|langchain|spring-ai|ollama|llamaindex/],
  ['jobs', /quartz|node-cron|"cron"|celery|apscheduler|"bull"|bullmq|"agenda"|shedlock/],
];
const profiles = new Map();
const profileQueue = new Set();

function readSmall(file) {
  try { return fs.readFileSync(file, 'utf8').slice(0, 256 * 1024); } catch { return ''; }
}

function hasAny(folders, markers) {
  return folders.some((folder) => markers.some((marker) => fs.existsSync(path.join(folder, marker))));
}

function walkSources(root) {
  let sourceFiles = 0;
  let visited = 0;
  let hasTests = false;
  const pending = [[root, 0]];
  while (pending.length && visited < MAX_ENTRIES_SCANNED) {
    const [dir, depth] = pending.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* unreadable */ }
    for (const entry of entries) {
      visited += 1;
      if (entry.isDirectory()) {
        if (TEST_DIRS.has(entry.name)) hasTests = true;
        const skip = entry.name.startsWith('.') || SKIP_DIRS.has(entry.name) || depth >= 12;
        if (!skip) pending.push([path.join(dir, entry.name), depth + 1]);
      } else if (SOURCE_FILE.test(entry.name)) {
        sourceFiles += 1;
        if (TEST_FILE.test(entry.name)) hasTests = true;
      }
    }
  }
  return { sourceFiles, hasTests };
}

function tierOf(sourceFiles, modules) {
  if (modules >= 3 && sourceFiles >= 150) return 'campus';
  if (sourceFiles >= 800) return 'tower';
  if (sourceFiles >= 150) return 'office';
  if (sourceFiles >= 30) return 'house';
  return 'cottage';
}

// Null when the folder can't be listed (e.g. macOS blocks ~/Downloads for background services), so the page keeps its plain look.
function readProfile(folder) {
  let entries;
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return null; }
  const children = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name))
    .slice(0, 20)
    .map((d) => path.join(folder, d.name));
  const folders = [folder, ...children];
  const manifestText = folders.flatMap((dir) => MANIFESTS.map((name) => readSmall(path.join(dir, name)))).join('\n').toLowerCase();
  const rootPom = readSmall(path.join(folder, 'pom.xml'));
  const mavenModules = (rootPom.match(/<module>/g) || []).length;
  const childProjects = children.filter((dir) => PROJECT_MANIFESTS.some((name) => fs.existsSync(path.join(dir, name)))).length;
  const modules = Math.max(mavenModules, childProjects);
  const { sourceFiles, hasTests } = walkSources(folder);
  const features = FEATURE_PATTERNS.filter(([, pattern]) => pattern.test(manifestText)).map(([name]) => name);
  if (hasAny(folders, CONTAINER_MARKERS)) features.push('containers');
  if (hasTests || /junit|jest|vitest|mocha|pytest|playwright|cypress|karma|jasmine|testng|mockito/.test(manifestText)) features.push('tests');
  if (hasAny([folder], CI_MARKERS)) features.push('ci');
  const ui = UI_PATTERN.test(manifestText) || hasAny(folders, ['angular.json', 'index.html']);
  return { sourceFiles, modules, tier: tierOf(sourceFiles, modules), ui, features };
}

// Returns the cached profile right away (null on first sight) and refreshes it in the background.
function profileOf(folder) {
  if (!folder) return null;
  const cached = profiles.get(folder);
  if (!cached || Date.now() - cached.at > PROFILE_TTL_MS) queueProfile(folder);
  return cached ? cached.profile : null;
}

function queueProfile(folder) {
  if (profileQueue.has(folder)) return;
  profileQueue.add(folder);
  if (profileQueue.size === 1) setImmediate(refreshNextProfile);
}

function refreshNextProfile() {
  const [folder] = profileQueue;
  let profile = null;
  try { profile = readProfile(folder); } catch (error) { console.warn(`Profile failed for ${folder}: ${error.message}`); }
  profiles.set(folder, { profile, at: Date.now() });
  profileQueue.delete(folder);
  if (profileQueue.size) setImmediate(refreshNextProfile);
}

// Which part of a building an edited file belongs to; checked in order, first match wins.
const EDIT_LAYERS = [
  ['tests', /(^|\/)(test|tests|__tests__|e2e)\/|[._](spec|test)\.|(^|\/)test_[^/]*$|Tests?\.java$/],
  ['ci', /(^|\/)\.github\/|jenkinsfile|gitlab-ci|pipelines\.ya?ml$/i],
  ['containers', /dockerfile|compose\.ya?ml$|(^|\/)(k8s|helm|charts)\//i],
  ['messaging', /kafka|rabbit|amqp|websocket|socket|listener|consumer|producer|queue|stomp/i],
  ['security', /auth|security|jwt|oauth|login|permission|rbac/i],
  ['jobs', /schedul|cron|(^|\/)jobs?\//i],
  ['db', /repositor|migration|flyway|liquibase|\.sql$|entity|entities|schema|prisma|(^|\/)models?\/|dao/i],
  ['api', /controller|route|(^|\/)api\/|handler|endpoint/i],
  ['ai', /anthropic|openai|llm|prompt/i],
  ['ui', /\.(html|css|scss|tsx|jsx|vue|svelte)$|\.component\.ts$|(^|\/)(components?|pages?)\//i],
];
const LIVE_LAYER_MS = 2 * MIN;

function layerOf(agent, file) {
  const relative = file.replace(/^.*\/\.claude\/worktrees\/[^/]+\//, '').replace(`${agent.cwd}/`, '');
  const match = EDIT_LAYERS.find(([, pattern]) => pattern.test(relative));
  return match ? match[0] : '';
}

function projectRoot(cwd) {
  return cwd.split('/.claude/worktrees/')[0];
}

function projectName(cwd) {
  if (!cwd) return 'unknown';
  const name = path.basename(projectRoot(cwd));
  if (cwd.includes('scratch-workspaces') && /^scratch-\d/.test(name)) return 'scratch';
  return name || 'unknown';
}

function setProject(agent, cwd) {
  agent.project = projectName(cwd);
  agent.cwd = projectRoot(cwd);
}

function getAgent(id, kind) {
  let agent = agents.get(id);
  if (agent) return agent;
  agent = {
    id, kind, parentId: null, project: 'unknown', cwd: '', title: '', model: '',
    firstTs: 0, lastTs: 0, streakStart: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, context: 0, cost: 0,
    toolCalls: 0, toolErrors: 0, edits: 0, linesAdded: 0, linesRemoved: 0,
    files: new Set(), lastFile: '', lastAction: '', seenMsgIds: new Set(), layerTs: {},
    recent: [], daily: new Map(),
    lastHumanTs: 0, humanMsgs: 0, interrupts: 0,
    waiting: false, waitingSince: 0, waitingAsk: '', pendingAsk: '', lastText: '',
  };
  agents.set(id, agent);
  return agent;
}

function dayStats(agent, ts) {
  const key = dayKey(ts);
  let stats = agent.daily.get(key);
  if (!stats) {
    stats = { cost: 0, lines: 0, edits: 0, humanMsgs: 0, minutes: new Set(), firstTs: ts };
    agent.daily.set(key, stats);
  }
  return stats;
}

function touch(agent, ts) {
  if (!ts) return;
  const today = dayStats(agent, ts);
  today.minutes.add(Math.floor(ts / MIN));
  if (ts < today.firstTs) today.firstTs = ts;
  if (!agent.firstTs || ts < agent.firstTs) agent.firstTs = ts;
  if (ts - agent.lastTs > 30 * MIN) agent.streakStart = ts;
  if (ts > agent.lastTs) agent.lastTs = ts;
}

function pushRecent(agent, entry) {
  agent.recent.push(entry);
  const cutoff = Date.now() - 20 * MIN;
  while (agent.recent.length && agent.recent[0].ts < cutoff) agent.recent.shift();
}

function addEvent(agent, ts, kind, text) {
  if (Date.now() - ts > 24 * 60 * MIN) return;
  events.push({ ts, kind, agentId: agent.id, project: agent.project, text });
  // Files are read in arbitrary order, so sort before trimming to keep the newest events.
  if (events.length > 600) {
    events.sort((a, b) => a.ts - b.ts);
    events.splice(0, events.length - 400);
  }
}

function addCost(agent, ts, cost) {
  agent.cost += cost;
  dayStats(agent, ts).cost += cost;
  const key = dayKey(ts);
  dailyCost.set(key, (dailyCost.get(key) || 0) + cost);
  pushRecent(agent, { ts, cost, err: 0 });
}

function addLines(agent, ts, added, removed, file, verb) {
  agent.edits += 1;
  agent.linesAdded += added;
  agent.linesRemoved += removed;
  const today = dayStats(agent, ts);
  today.lines += added + removed;
  today.edits += 1;
  if (file) {
    agent.files.add(file);
    agent.lastFile = file;
    const layer = layerOf(agent, file);
    if (layer) agent.layerTs[layer] = Math.max(agent.layerTs[layer] || 0, ts);
  }
  const key = dayKey(ts);
  dailyLines.set(key, (dailyLines.get(key) || 0) + added + removed);
  const fileName = path.basename(file || 'a file');
  addEvent(agent, ts, 'build', `${verb} ${fileName} (+${added} −${removed})`);
}

// ---- you, the reviewer: your messages, interrupts, and turns that end waiting on you ----
function markHuman(agent, ts) {
  if (!ts) return;
  agent.lastHumanTs = Math.max(agent.lastHumanTs, ts);
  agent.humanMsgs += 1;
  dayStats(agent, ts).humanMsgs += 1;
  agent.waiting = false;
  agent.pendingAsk = '';
  addEvent(agent, ts, 'review', 'got new orders from you');
}

function markInterrupted(agent, ts) {
  agent.interrupts += 1;
  agent.waiting = false;
  addEvent(agent, ts, 'alarm', 'was stopped by you');
}

function startWaiting(agent, ts, ask) {
  agent.waiting = true;
  agent.waitingSince = ts;
  agent.waitingAsk = String(ask).replace(/\s+/g, ' ').slice(0, 160);
  addEvent(agent, ts, 'waiting', `is waiting for your review: ${agent.waitingAsk.slice(0, 60)}`);
}

// A turn that ends on a pending question (desktop wrap-up "ask", or a closing "?") is blocked on you.
function endTurn(agent, ts) {
  const closingText = agent.lastText.trim();
  const ask = agent.pendingAsk || (closingText.endsWith('?') ? closingText.split(/(?<=[.!\n])\s+/).pop() : '');
  agent.pendingAsk = '';
  if (ask) startWaiting(agent, ts, ask);
  else agent.waiting = false;
}

function humanText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function countLines(text) {
  if (!text) return 0;
  return String(text).split('\n').length;
}

function shortTarget(rawName, input) {
  const name = rawName.split('__').pop();
  if (!input) return name;
  const target = input.file_path || input.path || input.command || input.pattern || input.url || input.description || '';
  const clean = String(target).replace(/\s+/g, ' ').slice(0, 60);
  return clean ? `${name}: ${clean}` : name;
}

function handleClaudeTool(agent, ts, block) {
  agent.toolCalls += 1;
  const input = block.input || {};
  agent.lastAction = shortTarget(block.name, input);
  agent.waiting = false;
  if (block.name.endsWith('wrap_up') && input.ask) {
    agent.pendingAsk = input.ask;
  } else if (block.name === 'AskUserQuestion') {
    startWaiting(agent, ts, input.questions?.[0]?.question || 'a question for you');
  } else if (block.name === 'ExitPlanMode') {
    startWaiting(agent, ts, 'plan approval');
  } else if (block.name === 'Edit') {
    addLines(agent, ts, countLines(input.new_string), countLines(input.old_string), input.file_path, 'Rebuilt');
  } else if (block.name === 'MultiEdit') {
    const editsList = input.edits || [];
    const added = editsList.reduce((sum, e) => sum + countLines(e.new_string), 0);
    const removed = editsList.reduce((sum, e) => sum + countLines(e.old_string), 0);
    addLines(agent, ts, added, removed, input.file_path, 'Rebuilt');
  } else if (block.name === 'Write') {
    addLines(agent, ts, countLines(input.content), 0, input.file_path, 'Built');
  } else if (block.name === 'Agent' || block.name === 'Task') {
    addEvent(agent, ts, 'hire', `hired a helper: ${String(input.description || 'subagent').slice(0, 50)}`);
  }
}

function handleClaudeLine(agent, line) {
  const isUsage = line.includes('"usage"');
  const isTool = line.includes('"tool_use"') || line.includes('"tool_result"');
  const isMeta = line.includes('"custom-title"') || line.includes('"agent-name"') || (!agent.project || agent.project === 'unknown');
  const isHuman = line.includes('"kind":"human"') || line.includes('Request interrupted by user') || line.includes('"absorbed_mid_turn"');
  if (!isUsage && !isTool && !isMeta && !isHuman) return;
  let record;
  try { record = JSON.parse(line); } catch { return; }
  const ts = record.timestamp ? Date.parse(record.timestamp) : 0;
  if (record.cwd && !agent.cwd) setProject(agent, record.cwd);
  if (record.type === 'custom-title' && record.customTitle) agent.title = record.customTitle;
  if (record.type === 'agent-name' && record.agentName && !agent.title) agent.title = record.agentName;
  // A message you type while the agent is mid-turn is logged only as an absorbed queue entry.
  if (record.type === 'queue-operation' && record.reason === 'absorbed_mid_turn') {
    touch(agent, ts);
    markHuman(agent, ts);
    return;
  }
  const message = record.message;
  if (!message || typeof message !== 'object') return;
  touch(agent, ts);

  if (record.type === 'user' && !record.isMeta) {
    const text = humanText(message.content);
    if (text.includes('[Request interrupted by user')) markInterrupted(agent, ts);
    else if (record.origin?.kind === 'human' && !text.trimStart().startsWith('<')) markHuman(agent, ts);
  }

  if (record.type === 'assistant' && Array.isArray(message.content)) {
    const text = humanText(message.content);
    if (text) agent.lastText = text;
  }

  if (record.type === 'assistant' && message.usage && message.model !== '<synthetic>') {
    agent.model = message.model || agent.model;
    const msgId = message.id || record.uuid;
    if (!agent.seenMsgIds.has(msgId)) {
      agent.seenMsgIds.add(msgId);
      const usage = message.usage;
      const write1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
      const write5m = (usage.cache_creation_input_tokens || 0) - write1h;
      const price = priceFor(agent.model);
      const cost = ((usage.input_tokens || 0) * price.input
        + (usage.output_tokens || 0) * price.output
        + (usage.cache_read_input_tokens || 0) * price.cacheRead
        + write5m * price.input * 1.25
        + write1h * price.input * 2) / 1e6;
      agent.tokens.input += usage.input_tokens || 0;
      agent.tokens.output += usage.output_tokens || 0;
      agent.tokens.cacheRead += usage.cache_read_input_tokens || 0;
      agent.tokens.cacheWrite += usage.cache_creation_input_tokens || 0;
      agent.context = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      addCost(agent, ts, cost);
    }
  }

  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (block.type === 'tool_use') handleClaudeTool(agent, ts, block);
    if (block.type === 'tool_result' && block.is_error) {
      agent.toolErrors += 1;
      pushRecent(agent, { ts, cost: 0, err: 1 });
      const reason = (typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')).slice(0, 70);
      addEvent(agent, ts, 'error', `tripped: ${reason}`);
    }
  }
  if (record.type === 'assistant' && message.stop_reason === 'end_turn') endTurn(agent, ts);
}

function patchStats(patch) {
  let added = 0;
  let removed = 0;
  let file = '';
  for (const row of String(patch).split('\n')) {
    if (row.startsWith('*** ') && row.includes('File: ')) file = row.split('File: ')[1];
    else if (row.startsWith('+') && !row.startsWith('+++')) added += 1;
    else if (row.startsWith('-') && !row.startsWith('---')) removed += 1;
  }
  return { added, removed, file };
}

function handleCodexLine(agent, line) {
  let record;
  try { record = JSON.parse(line); } catch { return; }
  const ts = record.timestamp ? Date.parse(record.timestamp) : 0;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return;
  touch(agent, ts);
  if (record.type === 'session_meta' && payload.cwd) setProject(agent, payload.cwd);
  if (record.type === 'turn_context' && payload.model) agent.model = payload.model;
  if (payload.type === 'thread_settings_applied' && payload.thread_settings?.model) agent.model = payload.thread_settings.model;
  const isUserMessage = payload.type === 'user_message' || (payload.type === 'item_completed' && payload.item?.type === 'UserMessage');
  if (isUserMessage) markHuman(agent, ts);
  if (payload.type === 'turn_aborted') markInterrupted(agent, ts);
  if (payload.type === 'task_complete') {
    agent.lastText = String(payload.last_agent_message || '');
    endTurn(agent, ts);
  }

  if (payload.type === 'token_count' && payload.info?.total_token_usage) {
    const total = payload.info.total_token_usage;
    const cached = total.cached_input_tokens || 0;
    const uncached = (total.input_tokens || 0) - cached;
    const price = priceFor(agent.model || 'gpt');
    const totalCost = (uncached * price.input + cached * price.cacheRead + (total.output_tokens || 0) * price.output) / 1e6;
    agent.tokens.input = uncached;
    agent.tokens.cacheRead = cached;
    agent.tokens.output = total.output_tokens || 0;
    agent.context = payload.info.last_token_usage?.input_tokens || agent.context;
    const delta = totalCost - agent.cost;
    if (delta > 0) addCost(agent, ts, delta);
  }

  const isCall = payload.type === 'function_call' || payload.type === 'custom_tool_call';
  if (isCall) {
    agent.toolCalls += 1;
    agent.waiting = false;
    const body = payload.input || payload.arguments || '';
    agent.lastAction = shortTarget(payload.name, { command: body });
    if (String(body).includes('*** Begin Patch')) {
      const stats = patchStats(body);
      addLines(agent, ts, stats.added, stats.removed, stats.file, 'Patched');
    }
  }

  const isOutput = payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output';
  if (isOutput) {
    const output = String(typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output));
    if (/Exit code: [1-9]|"exit_code":[1-9]/.test(output)) {
      agent.toolErrors += 1;
      pushRecent(agent, { ts, cost: 0, err: 1 });
      addEvent(agent, ts, 'error', 'a command failed');
    }
  }
}

function readNewBytes(file) {
  const state = files.get(file);
  let stat;
  try { stat = fs.statSync(file); } catch { return; }
  if (stat.size < state.offset) state.offset = 0;
  if (stat.size === state.offset) return;
  const fd = fs.openSync(file, 'r');
  const chunkSize = 8 * 1024 * 1024;
  const buffer = Buffer.alloc(chunkSize);
  try {
    while (state.offset < stat.size) {
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, state.offset);
      if (bytesRead <= 0) break;
      state.offset += bytesRead;
      const text = state.partial + buffer.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      state.partial = lines.pop();
      for (const line of lines) {
        if (line) state.handler(line);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir, out, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 5) walk(full, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

function registerFile(file) {
  if (files.has(file)) return;
  let stat;
  try { stat = fs.statSync(file); } catch { return; }
  if (Date.now() - stat.mtimeMs > HISTORY_DAYS * 24 * 60 * MIN) return;

  let agent;
  if (file.startsWith(CODEX_DIR)) {
    agent = getAgent(`codex:${path.basename(file, '.jsonl')}`, 'codex');
  } else if (file.includes(`${path.sep}subagents${path.sep}`)) {
    const sessionDir = path.dirname(path.dirname(file));
    agent = getAgent(`sub:${path.basename(file, '.jsonl')}`, 'subagent');
    agent.parentId = `claude:${path.basename(sessionDir)}`;
    try {
      const meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      agent.title = meta.description || meta.agentType || 'helper';
    } catch { /* meta file is optional */ }
  } else {
    agent = getAgent(`claude:${path.basename(file, '.jsonl')}`, 'claude');
  }
  const handler = agent.kind === 'codex' ? (line) => handleCodexLine(agent, line) : (line) => handleClaudeLine(agent, line);
  files.set(file, { offset: 0, partial: '', handler });
}

function discover() {
  const found = [];
  walk(CLAUDE_DIR, found);
  walk(CODEX_DIR, found);
  found.forEach(registerFile);
}

function poll() {
  for (const file of files.keys()) readNewBytes(file);
  for (const agent of agents.values()) {
    if (agent.kind === 'subagent' && agent.project === 'unknown') {
      const parent = agents.get(agent.parentId);
      if (parent) agent.project = parent.project;
    }
  }
}

function stressOf(agent, now) {
  const recent = agent.recent.filter((r) => now - r.ts < 15 * MIN);
  const burnPerHour = recent.filter((r) => now - r.ts < 10 * MIN).reduce((sum, r) => sum + r.cost, 0) * 6;
  const recentErrors = recent.reduce((sum, r) => sum + r.err, 0);
  const shiftHours = (agent.lastTs - agent.streakStart) / (60 * MIN);
  const shiftScore = Math.min(40, shiftHours * 8);
  const burnScore = Math.min(30, burnPerHour * 3);
  const errorScore = Math.min(20, recentErrors * 4);
  const contextScore = Math.min(10, agent.context / 50_000);
  return { stress: Math.round(shiftScore + burnScore + errorScore + contextScore), burnPerHour, recentErrors, shiftHours };
}

function statusOf(agent, now, stress) {
  if (agent.waiting) return 'waiting';
  const quietMinutes = (now - agent.lastTs) / MIN;
  if (quietMinutes > 45) return 'sleeping';
  if (quietMinutes > 5) return 'idle';
  if (stress.recentErrors >= 3) return 'stuck';
  if (stress.stress >= 65) return 'overworked';
  return 'working';
}

function snapshot() {
  const now = Date.now();
  const today = dayKey(now);
  const projects = new Map();
  const roster = [];
  for (const agent of agents.values()) {
    if (!agent.lastTs) continue;
    const project = projects.get(agent.project)
      || { name: agent.project, path: '', lines: 0, linesToday: 0, cost: 0, agents: 0, active: 0, errors: 0, lastTs: 0, layers: [] };
    project.lines += agent.linesAdded + agent.linesRemoved;
    project.linesToday += agent.daily.get(today)?.lines || 0;
    project.cost += agent.cost;
    for (const [layer, ts] of Object.entries(agent.layerTs)) {
      if (now - ts < LIVE_LAYER_MS && !project.layers.includes(layer)) project.layers.push(layer);
    }
    if (agent.lastTs >= project.lastTs && agent.cwd) project.path = agent.cwd;
    project.lastTs = Math.max(project.lastTs, agent.lastTs);
    projects.set(agent.project, project);
    if (now - agent.lastTs > 24 * 60 * MIN) continue;
    const stress = stressOf(agent, now);
    let status = statusOf(agent, now, stress);
    // For portal-hired agents we know exactly whether the process is running.
    if (portalAgents[agent.id]) {
      const running = runningProcesses.has(agent.id);
      if (running && (status === 'idle' || status === 'sleeping' || status === 'waiting')) status = 'working';
      if (!running && ['working', 'overworked', 'stuck'].includes(status)) status = 'idle';
    }
    project.agents += 1;
    project.errors += stress.recentErrors;
    if (status !== 'sleeping' && status !== 'idle') project.active += 1;
    const todayStats = agent.daily.get(today);
    const todaySummary = todayStats && {
      cost: todayStats.cost, lines: todayStats.lines, edits: todayStats.edits, humanMsgs: todayStats.humanMsgs,
      activeMinutes: todayStats.minutes.size, firstTs: todayStats.firstTs,
    };
    roster.push({
      today: todaySummary || null,
      id: agent.id, kind: agent.kind, parentId: agent.parentId, project: agent.project,
      title: agent.title, model: agent.model, firstTs: agent.firstTs, lastTs: agent.lastTs,
      tokens: agent.tokens, context: agent.context, cost: agent.cost,
      toolCalls: agent.toolCalls, toolErrors: agent.toolErrors, edits: agent.edits,
      linesAdded: agent.linesAdded, linesRemoved: agent.linesRemoved,
      filesTouched: agent.files.size, lastFile: agent.lastFile, lastAction: agent.lastAction,
      lastHumanTs: agent.lastHumanTs, humanMsgs: agent.humanMsgs, interrupts: agent.interrupts,
      waiting: agent.waiting, waitingSince: agent.waitingSince, waitingAsk: agent.waitingAsk,
      portal: portalStatus(agent.id),
      status, ...stress,
    });
  }
  const sortedProjects = [...projects.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, 12);
  for (const project of sortedProjects) {
    project.stack = stackOf(project.path);
    project.profile = profileOf(project.path);
  }
  const sortedEvents = events.slice().sort((a, b) => a.ts - b.ts).slice(-80);
  return {
    now, ready: initialScanDone, agents: roster, projects: sortedProjects, events: sortedEvents,
    defaults: { projectsFolder: DEFAULT_PROJECTS_FOLDER },
    layoutSeed: townSeed,
    totals: {
      costToday: dailyCost.get(today) || 0,
      linesToday: dailyLines.get(today) || 0,
      costAllTime: [...dailyCost.values()].reduce((a, b) => a + b, 0),
      historyDays: HISTORY_DAYS,
    },
  };
}

// ---- portal-hired agents: started, continued and stopped from the game ----
const portalAgents = loadPortalAgents();
const runningProcesses = new Map();

function loadPortalAgents() {
  try { return JSON.parse(fs.readFileSync(PORTAL_FILE, 'utf8')); } catch { return {}; }
}

function savePortalAgents() {
  fs.writeFileSync(PORTAL_FILE, JSON.stringify(portalAgents, null, 2));
}

function portalStatus(agentId) {
  if (!portalAgents[agentId]) return null;
  return { running: runningProcesses.has(agentId) };
}

function runClaude(agentId, args, cwd) {
  const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-500); });
  runningProcesses.set(agentId, child);
  child.on('error', (err) => console.error(`[portal] ${agentId} failed to start: ${err.message}`));
  child.on('close', (code) => {
    runningProcesses.delete(agentId);
    const agent = agents.get(agentId);
    if (code && agent) addEvent(agent, Date.now(), 'error', `stopped (exit ${code}) ${stderr.trim().slice(0, 60)}`);
    console.log(`[portal] ${agentId} finished with exit code ${code}`);
    discover();
  });
}

function claudeArgs(prompt, model) {
  return ['-p', prompt, '--model', model, '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS.join(',')];
}

function hireAgent({ project, model, brief }) {
  const cwd = [...agents.values()].filter((a) => a.project === project && a.cwd).sort((a, b) => b.lastTs - a.lastTs)[0]?.cwd;
  if (!cwd || !fs.existsSync(cwd)) throw new ApiError(400, `No folder known for project "${project}".`);
  return startAgent(cwd, model, brief);
}

function isInsideHome(folder) {
  const relative = path.relative(os.homedir(), folder);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// New app: create <parent>/<name>. New chat: use an existing folder. Both must sit inside your home folder.
function foundProject({ mode, parent, name, folder, model, brief }) {
  let cwd;
  if (mode === 'new') {
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(name || '')) throw new ApiError(400, 'Name the app with letters, numbers, dots, dashes or underscores.');
    const parentDir = path.resolve(parent || '');
    if (!isInsideHome(parentDir) || !fs.statSync(parentDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new ApiError(400, 'The parent folder must be an existing folder inside your home folder.');
    }
    cwd = path.join(parentDir, name);
    if (fs.existsSync(cwd)) throw new ApiError(409, `${cwd} already exists. Use "Existing folder" to start a chat there.`);
    validateStart(model, brief);
    fs.mkdirSync(cwd);
    console.log(`[portal] created ${cwd}`);
  } else {
    cwd = path.resolve(folder || '');
    if (!isInsideHome(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new ApiError(400, 'Pick an existing folder inside your home folder.');
    }
  }
  return startAgent(cwd, model, brief);
}

function validateStart(model, brief) {
  if (!brief || !brief.trim()) throw new ApiError(400, 'Write a brief for the new agent.');
  if (!MODELS.includes(model)) throw new ApiError(400, `Model must be one of ${MODELS.join(', ')}.`);
}

function startAgent(cwd, model, brief) {
  validateStart(model, brief);
  const sessionId = crypto.randomUUID();
  const agentId = `claude:${sessionId}`;
  portalAgents[agentId] = { sessionId, cwd, model, hiredAt: Date.now() };
  savePortalAgents();

  // Show the new worker straight away; its log file is picked up by discover() once Claude writes it.
  const agent = getAgent(agentId, 'claude');
  setProject(agent, cwd);
  agent.title = brief.trim().replace(/\s+/g, ' ').slice(0, 60);
  agent.model = model;
  touch(agent, Date.now());
  markHuman(agent, Date.now());
  addEvent(agent, Date.now(), 'hire', `was hired from the portal (${model})`);

  runClaude(agentId, [...claudeArgs(brief, model), '--session-id', sessionId], cwd);
  setTimeout(discover, 3000);
  console.log(`[portal] hired ${agentId} in ${cwd}`);
  return agentId;
}

function sendOrders(agentId, message) {
  const record = portalAgents[agentId];
  if (!record) throw new ApiError(403, 'Only agents hired from the portal can take orders here. Reply to this one in the Claude app.');
  if (runningProcesses.has(agentId)) throw new ApiError(409, 'This agent is still working. Send orders once it finishes, or stop it first.');
  if (!message || !message.trim()) throw new ApiError(400, 'Write your orders first.');
  const agent = getAgent(agentId, 'claude');
  markHuman(agent, Date.now());
  runClaude(agentId, [...claudeArgs(message, record.model), '--resume', record.sessionId], record.cwd);
}

function stopAgent(agentId) {
  const child = runningProcesses.get(agentId);
  if (!portalAgents[agentId]) throw new ApiError(403, 'Only agents hired from the portal can be stopped here.');
  if (!child) throw new ApiError(409, 'This agent is not running.');
  child.kill('SIGINT');
  setTimeout(() => { if (runningProcesses.get(agentId) === child) child.kill('SIGTERM'); }, 5000);
  markInterrupted(getAgent(agentId, 'claude'), Date.now());
}

// ---- town layout: one seed for every screen, kept until you rebuild the town ----
function newTownSeed() {
  return crypto.randomInt(1, 2 ** 31 - 1);
}

function loadTownSeed() {
  try {
    const seed = JSON.parse(fs.readFileSync(TOWN_FILE, 'utf8')).seed;
    if (Number.isInteger(seed) && seed > 0) return seed;
  } catch { /* first run */ }
  const seed = newTownSeed();
  fs.writeFileSync(TOWN_FILE, JSON.stringify({ seed }, null, 2));
  return seed;
}

let townSeed = loadTownSeed();

// Several screens may ask at once; only a request that still names the current seed rebuilds.
function rebuildTown(currentSeed) {
  if (currentSeed !== townSeed) return;
  townSeed = newTownSeed();
  fs.writeFileSync(TOWN_FILE, JSON.stringify({ seed: townSeed }, null, 2));
  console.log('Town layout rebuilt');
}

const SESSION_ID = /^[0-9a-f-]{36}$/;
const TERMINAL_SCRIPT = ['on run argv', 'tell application "Terminal"', 'do script (item 1 of argv)', 'activate', 'end tell', 'end run'];

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

// Opens a hired agent's own Claude session in Terminal, so you can talk to it directly instead of through the town.
function openInTerminal(agentId) {
  const record = portalAgents[agentId];
  if (!record) throw new ApiError(403, 'Only agents hired from the town can be opened in Terminal.');
  if (runningProcesses.has(agentId)) throw new ApiError(409, 'This agent is still working. Open it once it finishes, or stop it first.');
  if (!SESSION_ID.test(record.sessionId)) throw new ApiError(400, 'This agent has no valid session to open.');
  if (!fs.existsSync(record.cwd)) throw new ApiError(410, "This agent's folder no longer exists.");
  const folder = shellQuote(record.cwd);
  const claude = shellQuote(CLAUDE_BIN);
  const command = `cd ${folder} && ${claude} --resume ${record.sessionId}`;
  const scriptArgs = TERMINAL_SCRIPT.flatMap((line) => ['-e', line]);
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', [...scriptArgs, command], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => reject(new ApiError(500, `Could not open Terminal: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[portal] ${agentId} opened in Terminal`);
        resolve();
        return;
      }
      console.warn(`[portal] Terminal open failed for ${agentId}: ${stderr.trim()}`);
      reject(new ApiError(500, 'macOS blocked opening Terminal. Allow it in System Settings → Privacy & Security → Automation.'));
    });
  });
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- http ----
const clients = new Set();
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(payload);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20_000) reject(new ApiError(413, 'Message too long.'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new ApiError(400, 'Invalid JSON.')); }
    });
  });
}

function isTrustedApiCall(req) {
  const origin = req.headers.origin;
  const sameOrigin = !origin || ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''));
  return sameOrigin && req.headers['x-colony-token'] === API_TOKEN && req.headers['content-type'] === 'application/json';
}

async function handleApi(req, res) {
  if (req.method !== 'POST' || !isTrustedApiCall(req)) throw new ApiError(403, 'Not allowed.');
  const body = await readJson(req);
  if (req.url === '/api/hire') {
    const agentId = hireAgent(body);
    return sendJson(res, 200, { ok: true, message: 'Agent hired.', agentId });
  }
  if (req.url === '/api/found') {
    const agentId = foundProject(body);
    return sendJson(res, 200, { ok: true, message: 'Project started.', agentId });
  }
  if (req.url === '/api/town/rebuild') {
    rebuildTown(body.seed);
    broadcast();
    return sendJson(res, 200, { ok: true, message: 'Town rebuilt.' });
  }
  const match = req.url.match(/^\/api\/agents\/([^/]+)\/(orders|stop|terminal)$/);
  if (!match) throw new ApiError(404, 'Unknown endpoint.');
  const agentId = decodeURIComponent(match[1]);
  const action = match[2];
  if (action === 'terminal') {
    await openInTerminal(agentId);
    return sendJson(res, 200, { ok: true, message: 'Opened in Terminal.', agentId });
  }
  if (action === 'orders') sendOrders(agentId, body.message);
  else stopAgent(agentId);
  broadcast();
  return sendJson(res, 200, { ok: true, message: action === 'orders' ? 'Orders sent.' : 'Agent stopped.', agentId });
}

const server = http.createServer((req, res) => {
  // Reject requests addressed to any other host name (guards against DNS rebinding).
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (req.url.startsWith('/api/')) {
    handleApi(req, res).catch((err) => sendJson(res, err.status || 500, { ok: false, message: err.message, agentId: null }));
    return;
  }
  // Small read-only summary for the menu-bar wallpaper app's badge.
  if (req.url === '/status') {
    const current = snapshot();
    const status = { waiting: 0, working: 0, overworked: 0, stuck: 0, idle: 0, sleeping: 0, costToday: current.totals.costToday, waitingAgents: [] };
    for (const agent of current.agents) {
      status[agent.status] += 1;
      if (agent.status === 'waiting') {
        status.waitingAgents.push({ id: agent.id, project: agent.project, ask: agent.waitingAsk, waitingSince: agent.waitingSince });
      }
    }
    status.waitingAgents.sort((a, b) => a.waitingSince - b.waitingSince);
    return sendJson(res, 200, status);
  }
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res);
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }
  const pathname = req.url.split('?')[0];
  if (pathname === '/' || pathname === '/index.html') {
    const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
      .replace('__COLONY_TOKEN__', API_TOKEN)
      .replace('__COLONY_LAYOUT__', String(townSeed));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Colony running at http://localhost:${PORT}`);
  const started = Date.now();
  discover();
  poll();
  initialScanDone = true;
  console.log(`Scanned ${files.size} logs (${agents.size} agents) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  setInterval(() => { poll(); broadcast(); }, 2000);
  setInterval(discover, 15000);
});
