// Project folders: names, stack, size and features, and which part of a project a file belongs to.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MIN } = require('./config');

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
const GENERATED_FILE = /\.min\.|bundle\.|\.map$|-lock\./;
// Markup and styles count towards lines but not towards languages.
const LANGUAGES = {
  java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  mjs: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust', swift: 'Swift', cs: 'C#', rb: 'Ruby', php: 'PHP', vue: 'Vue', svelte: 'Svelte', sql: 'SQL',
};
const LANGUAGE_MIN_FILES = 5;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
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

function countLines(file, budget) {
  let size;
  try { size = fs.statSync(file).size; } catch { return 0; }
  if (size > MAX_FILE_BYTES || size > budget.bytes) return 0;
  budget.bytes -= size;
  let buffer;
  try { buffer = fs.readFileSync(file); } catch { return 0; }
  let lines = 0;
  for (let at = buffer.indexOf(10); at !== -1; at = buffer.indexOf(10, at + 1)) lines += 1;
  return lines;
}

function walkSources(root) {
  let sourceFiles = 0;
  let codeLines = 0;
  let visited = 0;
  let hasTests = false;
  const filesByLanguage = new Map();
  const budget = { bytes: MAX_TOTAL_BYTES };
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
      } else if (SOURCE_FILE.test(entry.name) && !GENERATED_FILE.test(entry.name)) {
        sourceFiles += 1;
        if (TEST_FILE.test(entry.name)) hasTests = true;
        codeLines += countLines(path.join(dir, entry.name), budget);
        const language = LANGUAGES[path.extname(entry.name).slice(1)];
        if (language) filesByLanguage.set(language, (filesByLanguage.get(language) || 0) + 1);
      }
    }
  }
  const languages = [...filesByLanguage].filter(([, count]) => count >= LANGUAGE_MIN_FILES).map(([language]) => language);
  return { sourceFiles, codeLines, languages, hasTests };
}

// Rough count of declared dependencies across the build files we already read.
function dependencyCount(folders) {
  let count = 0;
  for (const dir of folders) {
    count += (readSmall(path.join(dir, 'pom.xml')).match(/<dependency>/g) || []).length;
    for (const gradle of ['build.gradle', 'build.gradle.kts']) {
      count += (readSmall(path.join(dir, gradle)).match(/^\s*(implementation|api|compileOnly|runtimeOnly|testImplementation)\b/gm) || []).length;
    }
    count += (readSmall(path.join(dir, 'requirements.txt')).match(/^\s*[A-Za-z]/gm) || []).length;
    count += (readSmall(path.join(dir, 'go.mod')).match(/^\s+\S+ v\d/gm) || []).length;
    try {
      const pkg = JSON.parse(readSmall(path.join(dir, 'package.json')) || '{}');
      count += Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
    } catch { /* not valid JSON */ }
  }
  return count;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// 0–100: how big and how involved a project is. Size counts most; features, modules, languages and dependencies add breadth.
function complexityOf({ codeLines, features, modules, languages, dependencies }) {
  const size = 40 * clamp01(Math.log10(Math.max(1, codeLines) / 500) / Math.log10(400));
  const breadth = 3 * Math.min(features.length, 9);
  const parts = 4 * Math.min(modules, 3);
  const polyglot = 3 * Math.min(Math.max(0, languages.length - 1), 3);
  const libraries = 12 * clamp01(Math.log10(Math.max(1, dependencies)) / 2);
  return Math.round(size + breadth + parts + polyglot + libraries);
}

function tierOf(complexity, modules) {
  if (modules >= 3 && complexity >= 45) return 'campus';
  if (complexity >= 65) return 'tower';
  if (complexity >= 40) return 'office';
  if (complexity >= 15) return 'house';
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
  const { sourceFiles, codeLines, languages, hasTests } = walkSources(folder);
  const features = FEATURE_PATTERNS.filter(([, pattern]) => pattern.test(manifestText)).map(([name]) => name);
  if (hasAny(folders, CONTAINER_MARKERS)) features.push('containers');
  if (hasTests || /junit|jest|vitest|mocha|pytest|playwright|cypress|karma|jasmine|testng|mockito/.test(manifestText)) features.push('tests');
  if (hasAny([folder], CI_MARKERS)) features.push('ci');
  const ui = UI_PATTERN.test(manifestText) || hasAny(folders, ['angular.json', 'index.html']);
  const dependencies = dependencyCount(folders);
  const complexity = complexityOf({ codeLines, features, modules, languages, dependencies });
  return { sourceFiles, codeLines, languages, dependencies, modules, complexity, tier: tierOf(complexity, modules), ui, features };
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

const MAX_LEVELS_UP = 6;
const rootCache = new Map();

// The folder a session belongs to. Worktrees fold into their repo, and a subfolder (say src/main/java) into the
// nearest folder above it with .git, or failing that a build file. Never climbs to or past the home folder.
function projectRoot(cwd) {
  const base = cwd.split('/.claude/worktrees/')[0];
  if (rootCache.has(base)) return rootCache.get(base);
  const root = nearestWith(base, ['.git']) || nearestWith(base, PROJECT_MANIFESTS) || base;
  rootCache.set(base, root);
  return root;
}

function nearestWith(start, markers) {
  const home = os.homedir() + path.sep;
  let dir = start;
  for (let level = 0; level <= MAX_LEVELS_UP && dir.startsWith(home); level++) {
    const current = dir;
    if (markers.some((marker) => fs.existsSync(path.join(current, marker)))) return current;
    dir = path.dirname(dir);
  }
  return '';
}

const fileRootCache = new Map();

// The project a file lives in: the nearest folder above it with .git, or failing that a build file.
// Empty when it has neither (scratch files, ~/.claude notes), so the edit stays with the session's own project.
function fileProjectRoot(file) {
  const dir = path.dirname(file.replace(/\/\.claude\/worktrees\/[^/]+/, ''));
  if (fileRootCache.has(dir)) return fileRootCache.get(dir);
  const root = nearestWith(dir, ['.git']) || nearestWith(dir, PROJECT_MANIFESTS);
  fileRootCache.set(dir, root);
  return root;
}

// Folders the Claude app keeps for itself (not scratch chats) never get a building.
function isAppInternal(cwd) {
  return cwd.includes('/Library/Application Support/Claude/') && !cwd.includes('/scratch-workspaces/');
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

module.exports = { stackOf, profileOf, LIVE_LAYER_MS, layerOf, setProject, isAppInternal, fileProjectRoot, projectName };
