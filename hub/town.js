// Each linked Mac's latest report, and the combined town a clan sees: everyone's shared projects
// (one building per repo, however many members work on it), their agents, who is waiting on whom, and updates.
// Reports come from other people's machines, so every field is checked and trimmed before it is kept.

const ONLINE_MS = 30 * 1000;
const STALE_MS = 2 * 60 * 1000;
const MAX_PROJECTS = 200;
const MAX_AGENTS = 500;
const MAX_EVENTS = 200;
const TOWN_EVENTS = 100;
const PROJECT_KEY = /^(git|local):[0-9a-f]{20}$/;
const STATUSES = new Set(['working', 'overworked', 'stuck', 'waiting', 'idle', 'sleeping']);
const AGENT_KINDS = new Set(['claude', 'codex', 'subagent']);
// Older Macs still send edits, titles, models and tool errors; the hub drops them so the clan sees only these.
const EVENT_KINDS = new Set(['waiting', 'update', 'broke', 'fixed']);
const CHECK_KINDS = new Set(['build', 'tests']);
const TIERS = new Set(['cottage', 'house', 'office', 'tower', 'campus']);
const RESTING = new Set(['idle', 'sleeping']);

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function list(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function cleanProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    complexity: Math.min(100, number(profile.complexity)),
    tier: TIERS.has(profile.tier) ? profile.tier : 'cottage',
    codeLines: number(profile.codeLines),
    sourceFiles: number(profile.sourceFiles),
    modules: number(profile.modules),
    dependencies: number(profile.dependencies),
    languages: list(profile.languages, 8).map((l) => text(l, 20)),
    features: list(profile.features, 16).map((f) => text(f, 20)),
    ui: Boolean(profile.ui),
  };
}

function cleanProject(raw, clanIds) {
  if (!raw || !PROJECT_KEY.test(raw.key)) return null;
  const problems = raw.problems || {};
  return {
    key: raw.key,
    name: text(raw.name, 60) || 'project',
    clans: list(raw.clans, 50).filter((id) => clanIds.has(id)),
    profile: cleanProfile(raw.profile),
    failing: list(problems.failing, 2).filter((f) => CHECK_KINDS.has(f?.kind)).map((f) => ({ kind: f.kind, ts: number(f.ts) })),
    lastTs: number(raw.lastTs),
  };
}

function cleanAgent(raw, projectKeys) {
  if (!raw || !projectKeys.has(raw.project) || !STATUSES.has(raw.status)) return null;
  return {
    id: text(raw.id, 80),
    kind: AGENT_KINDS.has(raw.kind) ? raw.kind : 'claude',
    project: raw.project,
    status: raw.status,
    waitingSince: number(raw.waitingSince),
    lastTs: number(raw.lastTs),
    // Only sent when the member chose to share their agents' updates.
    summary: raw.summary && raw.summary.text ? { text: text(raw.summary.text, 200), ts: number(raw.summary.ts) } : null,
    ask: raw.status === 'waiting' ? text(raw.ask, 200) : '',
  };
}

function cleanEvent(raw, projectKeys) {
  if (!raw || !projectKeys.has(raw.project) || !EVENT_KINDS.has(raw.kind)) return null;
  return { ts: number(raw.ts), kind: raw.kind, project: raw.project, agent: text(raw.agent, 80), text: text(raw.text, 200) };
}

// Only clans the sender belongs to survive, so a report can't place projects in someone else's clan.
function cleanReport(raw, clanIds) {
  const projects = list(raw?.projects, MAX_PROJECTS).map((p) => cleanProject(p, clanIds)).filter(Boolean);
  const projectKeys = new Set(projects.map((p) => p.key));
  const agents = list(raw?.agents, MAX_AGENTS).map((a) => cleanAgent(a, projectKeys)).filter(Boolean);
  const events = list(raw?.events, MAX_EVENTS).map((e) => cleanEvent(e, projectKeys)).filter(Boolean);
  return { projects, agents, events };
}

function createTown(store) {
  const reports = new Map();

  function receiveReport(userId, raw) {
    const clanIds = new Set(store.clansOf(userId).map((clan) => clan.id));
    const report = cleanReport(raw, clanIds);
    reports.set(userId, { at: Date.now(), report });
    return { projects: report.projects.length, agents: report.agents.length };
  }

  function townProject(projects, key, name) {
    let project = projects.get(key);
    if (!project) {
      project = { key, name, members: [], profile: null, failing: [], agents: 0, active: 0, waiting: 0, lastTs: 0 };
      projects.set(key, project);
    }
    return project;
  }

  function townOf(clan) {
    const now = Date.now();
    const projects = new Map();
    const agents = [];
    const events = [];
    const members = [];
    const waitingOn = [];
    const memberIds = Object.keys(clan.members).sort();
    for (const userId of memberIds) {
      const user = store.userOf(userId);
      if (!user) continue;
      const entry = reports.get(userId);
      const fresh = entry && now - entry.at < STALE_MS;
      const member = {
        login: user.login, name: user.name, avatarUrl: user.avatarUrl, role: clan.members[userId].role,
        online: Boolean(entry && now - entry.at < ONLINE_MS), lastSeen: entry ? entry.at : 0, agents: 0, waiting: 0,
      };
      members.push(member);
      if (!fresh) continue;

      // Projects without a git remote are this member's own; only the same repo merges across members.
      const townKey = new Map();
      for (const shared of entry.report.projects.filter((p) => p.clans.includes(clan.id))) {
        const key = shared.key.startsWith('git:') ? shared.key : `${user.login}/${shared.key}`;
        townKey.set(shared.key, key);
        const project = townProject(projects, key, shared.name);
        // A member can report one repo from several folders (say one per branch); they still count once.
        if (!project.members.includes(user.login)) project.members.push(user.login);
        if (shared.profile && (!project.profile || shared.profile.complexity > project.profile.complexity)) project.profile = shared.profile;
        project.failing.push(...shared.failing.map((f) => ({ ...f, owner: user.login })));
        project.lastTs = Math.max(project.lastTs, shared.lastTs);
      }

      let oldestWait = 0;
      for (const agent of entry.report.agents) {
        const key = townKey.get(agent.project);
        if (!key) continue;
        const project = projects.get(key);
        agents.push({ ...agent, id: `${user.login}/${agent.id}`, owner: user.login, project: key });
        project.agents += 1;
        member.agents += 1;
        if (!RESTING.has(agent.status)) project.active += 1;
        if (agent.status === 'waiting') {
          project.waiting += 1;
          member.waiting += 1;
          oldestWait = oldestWait ? Math.min(oldestWait, agent.waitingSince) : agent.waitingSince;
        }
      }
      if (member.waiting) waitingOn.push({ login: user.login, count: member.waiting, oldestSince: oldestWait });

      for (const event of entry.report.events) {
        const key = townKey.get(event.project);
        if (key) events.push({ ...event, owner: user.login, project: key, agent: event.agent && `${user.login}/${event.agent}` });
      }
    }

    const sortedProjects = [...projects.values()].sort((a, b) => b.active - a.active || b.lastTs - a.lastTs);
    const recentEvents = events.sort((a, b) => a.ts - b.ts).slice(-TOWN_EVENTS);
    waitingOn.sort((a, b) => b.count - a.count);
    return { now, clan: { id: clan.id, name: clan.name }, members, projects: sortedProjects, agents, waitingOn, events: recentEvents };
  }

  return { receiveReport, townOf };
}

module.exports = { createTown, cleanReport };
