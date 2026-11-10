// Sharing this colony with clans on a hub: linking this Mac to your GitHub account, choosing which projects
// each clan sees, and sending the hub a short summary every few seconds.
// Only that summary leaves the Mac: no transcripts, prompts, code, commands or folder paths. Agents' own
// end-of-turn summaries and the questions they ask you are added only if you turn on "share updates".
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApiError } = require('./api-error');
const { CLAN_FILE, PORT } = require('./config');
const { WAITING_PREFIX } = require('./agents');
const { snapshot } = require('./snapshot');

const PUSH_MS = 5000;
const STATUS_CACHE_MS = 30_000;
const LINK_MS = 30 * 60 * 1000;
const MAX_PENDING_LINKS = 10;
const REQUEST_TIMEOUT_MS = 10_000;
const REMOTE_CACHE_MS = 10 * 60 * 1000;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const BUILD_TEXT = /^(Built|Rebuilt|Patched) /;
const EVENT_TEXT = { review: 'got new orders', alarm: 'was stopped', waiting: 'is waiting for review', error: 'hit an error', hire: 'hired a helper' };
const NOT_LINKED = 'This Mac is not linked to a hub yet.';
const PORTAL_WAITING_PREFIX = 'needs you: ';

let state = readState();
// Links started from the town (the wallpaper and a browser tab can each have one ready), by their state.
const pendingLinks = new Map();
let cachedStatus = null;
let lastPush = { ok: false, at: 0, message: '' };
const remotes = new Map();

function readState() {
  try {
    return JSON.parse(fs.readFileSync(CLAN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState() {
  if (!state) {
    fs.rmSync(CLAN_FILE, { force: true });
    return;
  }
  fs.writeFileSync(CLAN_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// https only, except a hub on this Mac (for trying one out).
function hubOrigin(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { throw new ApiError(400, 'Enter the hub address, like https://colony.example.com'); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new ApiError(400, 'The hub address must start with https://');
  return url.origin;
}

// github.com/org/repo for any clone URL, without credentials, so the same repo matches across Macs.
function normalizeRemote(remote) {
  const value = String(remote || '').trim();
  const scp = value.match(/^[^@/]+@([^:/]+):(.+)$/);
  let hostAndPath;
  if (scp) {
    hostAndPath = `${scp[1]}/${scp[2]}`;
  } else {
    try {
      const url = new URL(value);
      hostAndPath = `${url.hostname}${url.pathname}`;
    } catch {
      return '';
    }
  }
  return hostAndPath.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function originUrl(folder) {
  try {
    return execFileSync('git', ['-C', folder, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

// The hub sees a hash of the repo, not its address or the folder it is in.
function projectKey(folder) {
  const cached = remotes.get(folder);
  if (cached && Date.now() - cached.at < REMOTE_CACHE_MS) return cached.key;
  const remote = folder ? normalizeRemote(originUrl(folder)) : '';
  const key = remote ? `git:${shortHash(remote)}` : `local:${shortHash(folder || 'unknown')}`;
  remotes.set(folder, { key, at: Date.now() });
  return key;
}

function safeActivity(lastAction) {
  const [tool, ...rest] = String(lastAction || '').split(': ');
  const target = rest.join(': ');
  if (FILE_TOOLS.has(tool) && target) return `${tool}: ${path.basename(target)}`;
  return tool;
}

function waitingQuestion(text) {
  for (const prefix of [WAITING_PREFIX, PORTAL_WAITING_PREFIX]) {
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  }
  return '';
}

function safeEventText(event, shareUpdates) {
  if (event.kind === 'build') return BUILD_TEXT.test(event.text) ? event.text : 'finished a task';
  if (event.kind === 'hire' && event.text.startsWith('was hired')) return 'was hired';
  if (event.kind === 'broke' || event.kind === 'fixed') return event.text;
  if (event.kind === 'update') return shareUpdates ? event.text : '';
  if (event.kind === 'waiting' && shareUpdates) return waitingQuestion(event.text) || EVENT_TEXT.waiting;
  return EVENT_TEXT[event.kind] || '';
}

// `shares` maps a project name to the clan ids that see it; `keyOf` turns a project folder into its hub key.
// `shareUpdates` adds agents' end-of-turn summaries and the questions they ask.
function buildReport(snap, shares, keyOf, shareUpdates = false) {
  const projects = [];
  const keys = new Map();
  for (const project of snap.projects) {
    const clans = shares[project.name] || [];
    if (!clans.length) continue;
    const key = keyOf(project.path);
    keys.set(project.name, key);
    projects.push({ key, name: project.name, clans, profile: project.profile, lastTs: project.lastTs, problems: {
      failing: (project.problems?.failing || []).map((f) => ({ kind: f.kind, ts: f.ts })),
      errorsLastHour: project.problems?.errorsLastHour || 0,
    } });
  }
  const agents = snap.agents
    .filter((agent) => keys.has(agent.workProject))
    .map((agent) => ({
      id: agent.id, kind: agent.kind, project: keys.get(agent.workProject), status: agent.status,
      title: agent.title, model: agent.model, activity: safeActivity(agent.lastAction),
      waitingSince: agent.status === 'waiting' ? agent.waitingSince : 0, lastTs: agent.lastTs,
      summary: shareUpdates && agent.summary ? agent.summary : null,
      ask: shareUpdates && agent.status === 'waiting' ? agent.waitingAsk : '',
    }));
  const events = snap.events
    .filter((event) => keys.has(event.project))
    .map((event) => ({ ts: event.ts, kind: event.kind, project: keys.get(event.project), agent: event.agentId, text: safeEventText(event, shareUpdates) }))
    .filter((event) => event.text);
  return { version: 1, projects, agents, events };
}

async function hubRequest(method, pathname, body) {
  const response = await fetch(`${state.hub}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, result.message || `The hub answered ${response.status}.`);
  return result;
}

function startLink(rawHub) {
  const hub = hubOrigin(rawHub);
  const now = Date.now();
  for (const [key, link] of pendingLinks) {
    if (link.exp < now) pendingLinks.delete(key);
  }
  while (pendingLinks.size >= MAX_PENDING_LINKS) pendingLinks.delete(pendingLinks.keys().next().value);
  const linkState = crypto.randomBytes(16).toString('base64url');
  pendingLinks.set(linkState, { hub, exp: now + LINK_MS });
  const params = new URLSearchParams({ callback: `http://localhost:${PORT}/clan/linked`, state: linkState });
  return `${hub}/link?${params}`;
}

// The state check means only a link this town started can finish here.
async function finishLink(query) {
  const link = pendingLinks.get(query.get('state') || '');
  if (!link || link.exp < Date.now()) {
    throw new ApiError(400, 'This link was not started from your town, or it expired. Start again from the town.');
  }
  pendingLinks.clear();
  const response = await fetch(`${link.hub}/api/link/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: query.get('code'), label: os.hostname() }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, result.message || 'The hub refused the link.');
  state = { hub: link.hub, token: result.token, deviceId: result.deviceId, user: result.user, shares: state?.shares || {} };
  saveState();
  cachedStatus = null;
  console.log(`Linked to the clan hub at ${link.hub} as ${result.user.login}`);
  return result.user;
}

async function unlink() {
  if (!state) throw new ApiError(400, NOT_LINKED);
  try {
    await hubRequest('POST', '/api/devices/self/revoke', {});
  } catch (error) {
    console.warn(`Could not tell the hub this Mac is unlinked: ${error.message}`);
  }
  state = null;
  cachedStatus = null;
  saveState();
}

function setShares(project, clans) {
  if (!state) throw new ApiError(400, NOT_LINKED);
  const name = String(project || '');
  if (!name) throw new ApiError(400, 'Which project?');
  const ids = Array.isArray(clans) ? clans.map(String) : [];
  if (ids.length) state.shares[name] = ids;
  else delete state.shares[name];
  saveState();
  return state.shares;
}

function setShareUpdates(on) {
  if (!state) throw new ApiError(400, NOT_LINKED);
  state.shareUpdates = Boolean(on);
  saveState();
  return state.shareUpdates;
}

async function clanStatus() {
  if (!state) return { linked: false, broken: false, hub: '', user: null, clans: [], shares: {}, shareUpdates: false, lastPush };
  const shareUpdates = Boolean(state.shareUpdates);
  if (state.broken) return { linked: true, broken: true, hub: state.hub, user: state.user, clans: [], shares: state.shares, shareUpdates, lastPush };
  if (!cachedStatus || Date.now() - cachedStatus.at > STATUS_CACHE_MS) {
    try {
      const me = await hubRequest('GET', '/api/me');
      cachedStatus = { at: Date.now(), user: me.user, clans: me.clans };
    } catch (error) {
      if (error.status === 401) {
        state.broken = true;
        saveState();
        return clanStatus();
      }
      // Still linked: show the last clans we knew, and why the hub can't be reached.
      return { linked: true, broken: false, hub: state.hub, user: state.user, clans: cachedStatus?.clans || [], shares: state.shares, shareUpdates, lastPush, hubError: error.message };
    }
  }
  return { linked: true, broken: false, hub: state.hub, user: cachedStatus.user, clans: cachedStatus.clans, shares: state.shares, shareUpdates, lastPush, hubError: '' };
}

let pushing = false;

async function push() {
  if (!state || state.broken || pushing) return;
  pushing = true;
  try {
    const report = buildReport(snapshot(true, Object.keys(state.shares)), state.shares, projectKey, Boolean(state.shareUpdates));
    await hubRequest('POST', '/api/report', report);
    lastPush = { ok: true, at: Date.now(), message: '' };
  } catch (error) {
    // A revoked link stops pushing until you link again; anything else is retried on the next tick.
    if (error.status === 401) {
      state.broken = true;
      saveState();
    }
    if (lastPush.ok || lastPush.message !== error.message) console.warn(`Clan hub push failed: ${error.message}`);
    lastPush = { ok: false, at: Date.now(), message: error.message };
  } finally {
    pushing = false;
  }
}

function startPushing() {
  setInterval(push, PUSH_MS);
}

module.exports = { startLink, finishLink, unlink, setShares, setShareUpdates, clanStatus, startPushing, buildReport, normalizeRemote };
