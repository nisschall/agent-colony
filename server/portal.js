// Agents hired from the town: start, give orders, stop, open in Terminal.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { addEvent, agents, getAgent, markHuman, markInterrupted, projectPaths, touch } = require('./agents');
const { ApiError } = require('./api-error');
const { ALLOWED_TOOLS, CLAUDE_BIN, MODELS, PORTAL_FILE } = require('./config');
const { setProject } = require('./projects');
const { discover } = require('./scanner');

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
  const latestSession = [...agents.values()].filter((a) => a.project === project && a.cwd).sort((a, b) => b.lastTs - a.lastTs)[0];
  // A project known only from edits made by sessions elsewhere still has a folder.
  const cwd = latestSession ? latestSession.cwd : projectPaths.get(project);
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

module.exports = { portalAgents, runningProcesses, portalStatus, hireAgent, foundProject, sendOrders, stopAgent, openInTerminal };
