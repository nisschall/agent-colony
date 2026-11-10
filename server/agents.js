// Agent records and everything that updates them: tokens, edits, your messages, stress and status.
const path = require('path');
const { MIN } = require('./config');
const { fileProjectRoot, layerOf, projectName } = require('./projects');

const agents = new Map();
// Where each project credited from edits lives, so the town can find it (say, to hire an agent there).
const projectPaths = new Map();

const events = [];
const dailyCost = new Map();
const dailyLines = new Map();

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function getAgent(id, kind) {
  let agent = agents.get(id);
  if (agent) return agent;
  agent = {
    id, kind, parentId: null, project: 'unknown', cwd: '', title: '', model: '', logFile: '',
    firstTs: 0, lastTs: 0, streakStart: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, context: 0, cost: 0,
    toolCalls: 0, toolErrors: 0, edits: 0, linesAdded: 0, linesRemoved: 0,
    files: new Set(), lastFile: '', lastAction: '', seenMsgIds: new Set(), layerTs: {},
    credited: new Map(), workProject: '', workProjectTs: 0, pendingChecks: new Map(),
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
    stats = { cost: 0, lines: 0, edits: 0, humanMsgs: 0, minutes: new Set(), firstTs: ts, projects: new Map() };
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

// Edits to files in another project's folder count toward that project, not the one the session started in.
// Files inside the session's own folder always stay with it, so sub-repos of a workspace don't split off.
function creditedProject(agent, file) {
  const normalized = file.replace(/\/\.claude\/worktrees\/[^/]+/, '');
  if (!agent.cwd || normalized.startsWith(agent.cwd + path.sep)) return '';
  const root = fileProjectRoot(normalized);
  if (!root || root === agent.cwd) return '';
  const name = projectName(root);
  projectPaths.set(name, root);
  return name;
}

function creditEdit(agent, ts, lines, project, today) {
  const total = agent.credited.get(project) || { lines: 0, lastTs: 0 };
  total.lines += lines;
  total.lastTs = Math.max(total.lastTs, ts);
  agent.credited.set(project, total);
  const day = today.projects.get(project) || { lines: 0, minutes: new Set() };
  day.lines += lines;
  day.minutes.add(Math.floor(ts / MIN));
  today.projects.set(project, day);
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
    const project = creditedProject(agent, file);
    if (project) creditEdit(agent, ts, added + removed, project, today);
    if (ts >= agent.workProjectTs) {
      agent.workProject = project;
      agent.workProjectTs = ts;
    }
    const layer = layerOf(agent, file);
    if (layer) agent.layerTs[layer] = { ts, project: project || '' };
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

const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s+|^\s{2,}\S/;

// The question a closing message ends on, if any. Options listed after the question (1. … 2. …) don't hide it;
// a question only quoted mid-message, with a statement after it, doesn't count.
function closingQuestion(text) {
  const lines = text.trim().split('\n');
  while (lines.length && (LIST_LINE.test(lines[lines.length - 1]) || !lines[lines.length - 1].trim())) lines.pop();
  const last = lines.join('\n').trim().replace(/[*_`]+$/, '');
  if (!last.endsWith('?')) return '';
  return last.split(/(?<=[.!:\n])\s+/).pop().replace(/^[*_`]+/, '');
}

// A turn that ends on a pending question (desktop wrap-up "ask", or a closing question) is blocked on you.
function endTurn(agent, ts) {
  const ask = agent.pendingAsk || closingQuestion(agent.lastText);
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

module.exports = { creditedProject, agents, projectPaths, events, dailyCost, dailyLines, dayKey, getAgent, touch, pushRecent, addEvent, addCost, addLines, markHuman, markInterrupted, startWaiting, endTurn, humanText, countLines, shortTarget, stressOf, statusOf };
