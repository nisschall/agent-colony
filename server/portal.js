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
const REPLY_LIMIT = 4000;
const BLOCKED_LIMIT = 5;

function loadPortalAgents() {
  try { return JSON.parse(fs.readFileSync(PORTAL_FILE, 'utf8')); } catch { return {}; }
}

function savePortalAgents() {
  fs.writeFileSync(PORTAL_FILE, JSON.stringify(portalAgents, null, 2));
}

// A released agent's record is kept (marked released) so it never comes back as a watch-only agent.
function hiredRecord(agentId) {
  const record = portalAgents[agentId];
  return record && !record.released ? record : null;
}

function isReleased(agentId) {
  return Boolean(portalAgents[agentId]?.released);
}

// A run's outcome stops counting once you talk to the agent again (here, or in Terminal).
function portalStatus(agent) {
  const record = hiredRecord(agent.id);
  if (!record) return null;
  const running = runningProcesses.has(agent.id);
  const outcome = record.outcome;
  const current = !running && outcome && agent.lastHumanTs <= outcome.ts;
  return { running, startedAt: record.startedAt || 0, outcome: current ? outcome : null };
}

const ABSOLUTE_PATH = /(?:^|[\s='"])((?:\/|~\/)[^\s'"`;|&<>()]+)/g;

function isWithin(folder, root) {
  const relative = path.relative(root, folder);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Folders outside its own that an action names: Claude Code blocks those even when the action itself is allowed.
function foldersOf(text, cwd) {
  const folders = new Set();
  for (const match of String(text).matchAll(ABSOLUTE_PATH)) {
    const target = path.resolve(match[1].replace(/^~(?=\/)/, os.homedir()));
    const isFolder = fs.statSync(target, { throwIfNoEntry: false })?.isDirectory();
    const folder = isFolder ? target : path.dirname(target);
    if (folder === path.parse(folder).root || folder.startsWith('/dev') || isWithin(folder, cwd)) continue;
    folders.add(folder);
  }
  return [...folders];
}

// The exact permission a blocked action needs, so a retry allows that one action and nothing wider.
function blockedAction(denial, cwd) {
  const input = denial.tool_input || {};
  if (denial.tool_name === 'Bash') return { text: input.command, rule: `Bash(${input.command})`, folders: foldersOf(input.command, cwd) };
  if (input.file_path) {
    return { text: `${denial.tool_name} ${input.file_path}`, rule: `${denial.tool_name}(/${input.file_path})`, folders: foldersOf(input.file_path, cwd) };
  }
  return { text: denial.tool_name, rule: denial.tool_name, folders: [] };
}

function firstSentence(text) {
  return text.split(/(?<=[.!?])\s+/)[0].replace(/\s+/g, ' ').slice(0, 160);
}

// A hired agent can't show you an approval prompt: a blocked action, an error or a closing question means it needs you.
function recordOutcome(agentId, output) {
  if (!hiredRecord(agentId)) return;
  let result;
  try { result = JSON.parse(output); } catch { return; }
  const reply = String(result.result || '').trim();
  const denials = result.permission_denials || [];
  const cwd = portalAgents[agentId].cwd;
  const actions = new Map(denials.map((denial) => blockedAction(denial, cwd)).map((action) => [action.rule, action]));
  const blocked = [...actions.values()].slice(0, BLOCKED_LIMIT);
  const question = reply.endsWith('?') ? reply.split(/(?<=[.!\n])\s+/).pop() : '';
  let summary = firstSentence(reply);
  if (blocked.length) summary = `Blocked from ${blocked[0].text.slice(0, 80)}${blocked.length > 1 ? ` and ${blocked.length - 1} more` : ''}`;
  else if (question) summary = question.slice(0, 160);
  const needsYou = Boolean(blocked.length || result.is_error || question);
  const outcome = { state: needsYou ? 'needs-you' : 'done', summary, reply: reply.slice(0, REPLY_LIMIT), blocked, ts: Date.now() };
  portalAgents[agentId].outcome = outcome;
  savePortalAgents();
  const agent = agents.get(agentId);
  if (!agent) return;
  if (needsYou) addEvent(agent, outcome.ts, 'waiting', `needs you: ${summary.slice(0, 60)}`);
  else addEvent(agent, outcome.ts, 'build', `finished: ${summary.slice(0, 60)}`);
}

function runClaude(agentId, args, cwd) {
  delete portalAgents[agentId].outcome;
  portalAgents[agentId].startedAt = Date.now();
  savePortalAgents();
  const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-500); });
  runningProcesses.set(agentId, child);
  child.on('error', (err) => console.error(`[portal] ${agentId} failed to start: ${err.message}`));
  child.on('close', (code) => {
    runningProcesses.delete(agentId);
    const agent = agents.get(agentId);
    if (code && agent) addEvent(agent, Date.now(), 'error', `stopped (exit ${code}) ${stderr.trim().slice(0, 60)}`);
    recordOutcome(agentId, stdout);
    console.log(`[portal] ${agentId} finished with exit code ${code}`);
    discover();
  });
}

function claudeArgs(prompt, model, extraRules = []) {
  const allowed = [...ALLOWED_TOOLS, ...extraRules].join(',');
  return ['-p', prompt, '--model', model, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', allowed];
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

function resumeWith(agentId, message, extraRules, extraFolders = []) {
  const record = hiredRecord(agentId);
  if (!record) throw new ApiError(403, 'Only agents hired from the portal can take orders here. Reply to this one in the Claude app.');
  if (runningProcesses.has(agentId)) throw new ApiError(409, 'This agent is still working. Send orders once it finishes, or stop it first.');
  markHuman(getAgent(agentId, 'claude'), Date.now());
  const folderArgs = extraFolders.flatMap((folder) => ['--add-dir', folder]);
  runClaude(agentId, [...claudeArgs(message, record.model, extraRules), ...folderArgs, '--resume', record.sessionId], record.cwd);
}

function sendOrders(agentId, message) {
  if (!message || !message.trim()) throw new ApiError(400, 'Write your orders first.');
  resumeWith(agentId, message, []);
}

// Your approval for what its last run was blocked from, for one more run only.
function retryBlocked(agentId) {
  const blocked = hiredRecord(agentId)?.outcome?.blocked;
  if (!Array.isArray(blocked) || !blocked.length || typeof blocked[0] !== 'object') throw new ApiError(409, 'Nothing was blocked in its last run.');
  const list = blocked.map((action) => `- ${action.text}`).join('\n');
  const message = `You now have my approval for what was blocked, for this run only:\n${list}\nRun each one exactly as written, as its own call, then carry on with the task.`;
  const folders = [...new Set(blocked.flatMap((action) => action.folders || []))];
  resumeWith(agentId, message, blocked.map((action) => action.rule), folders);
  console.log(`[portal] ${agentId} retrying ${blocked.length} blocked action(s)`);
}

function killRun(agentId, child) {
  child.kill('SIGINT');
  setTimeout(() => { if (runningProcesses.get(agentId) === child) child.kill('SIGTERM'); }, 5000);
}

function stopAgent(agentId) {
  const child = runningProcesses.get(agentId);
  if (!hiredRecord(agentId)) throw new ApiError(403, 'Only agents hired from the portal can be stopped here.');
  if (!child) throw new ApiError(409, 'This agent is not running.');
  killRun(agentId, child);
  markInterrupted(getAgent(agentId, 'claude'), Date.now());
}

// Sends a hired agent out of town for good, stopping it first if it is still working.
// Its conversation stays in Claude's history and its cost stays in the totals.
function releaseAgent(agentId) {
  const record = hiredRecord(agentId);
  if (!record) throw new ApiError(403, 'Only agents hired from the town can be released.');
  const child = runningProcesses.get(agentId);
  if (child) killRun(agentId, child);
  record.released = true;
  record.releasedAt = Date.now();
  savePortalAgents();
  console.log(`[portal] released ${agentId}`);
}

const SESSION_ID = /^[0-9a-f-]{36}$/;
const TERMINAL_SCRIPT = ['on run argv', 'tell application "Terminal"', 'do script (item 1 of argv)', 'activate', 'end tell', 'end run'];

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

const MAX_COMMAND = 500;

// Runs a shell command in a new Terminal window, where you can watch it and stop it with Ctrl+C.
function runInTerminal(command, label) {
  const scriptArgs = TERMINAL_SCRIPT.flatMap((line) => ['-e', line]);
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', [...scriptArgs, command], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => reject(new ApiError(500, `Could not open Terminal: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[portal] opened Terminal for ${label}`);
        resolve();
        return;
      }
      console.warn(`[portal] Terminal open failed for ${label}: ${stderr.trim()}`);
      reject(new ApiError(500, 'macOS blocked opening Terminal. Allow it in System Settings → Privacy & Security → Automation.'));
    });
  });
}

// Opens a hired agent's own Claude session in Terminal, so you can talk to it directly instead of through the town.
function openInTerminal(agentId) {
  const record = hiredRecord(agentId);
  if (!record) throw new ApiError(403, 'Only agents hired from the town can be opened in Terminal.');
  if (runningProcesses.has(agentId)) throw new ApiError(409, 'This agent is still working. Open it once it finishes, or stop it first.');
  if (!SESSION_ID.test(record.sessionId)) throw new ApiError(400, 'This agent has no valid session to open.');
  if (!fs.existsSync(record.cwd)) throw new ApiError(410, "This agent's folder no longer exists.");
  return runInTerminal(`cd ${shellQuote(record.cwd)} && ${shellQuote(CLAUDE_BIN)} --resume ${record.sessionId}`, agentId);
}

// A shell in a project's folder, optionally running one command you typed. It runs in Terminal, never
// hidden inside the server, so every command is visible and can be stopped.
function openProjectTerminal(folder, rawCommand) {
  if (!folder || !fs.existsSync(folder)) throw new ApiError(410, "This project's folder can't be found.");
  const command = String(rawCommand || '').trim();
  if (command.length > MAX_COMMAND) throw new ApiError(400, `Keep the command under ${MAX_COMMAND} characters.`);
  if (/[\r\n]/.test(command)) throw new ApiError(400, 'Run one command at a time (join steps with &&).');
  const cd = `cd ${shellQuote(folder)}`;
  return runInTerminal(command ? `${cd} && ${command}` : cd, folder);
}

module.exports = { portalAgents, runningProcesses, portalStatus, isReleased, hireAgent, foundProject, sendOrders, retryBlocked, stopAgent, releaseAgent, openInTerminal, openProjectTerminal };
