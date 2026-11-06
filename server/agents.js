// Agent records and everything that updates them: tokens, edits, your messages, stress and status.
const path = require('path');
const { MIN } = require('./config');
const { layerOf } = require('./projects');

const agents = new Map();

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

module.exports = { agents, events, dailyCost, dailyLines, dayKey, getAgent, touch, pushRecent, addEvent, addCost, addLines, markHuman, markInterrupted, startWaiting, endTurn, humanText, countLines, shortTarget, stressOf, statusOf };
