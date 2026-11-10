// A clan's shared town from a hub, reshaped into the snapshot this page draws, so the same town shows it.
// The hub only shares status, current tool and project facts, so per-agent stats and costs stay at zero.
import { LAYOUT_SEED } from './layout.js';

const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Two members can each have an unshared-remote project with the same name; buildings are keyed by name.
function buildingNames(projects) {
  const counts = new Map();
  for (const project of projects) counts.set(project.name, (counts.get(project.name) || 0) + 1);
  const names = new Map();
  for (const project of projects) {
    const clash = counts.get(project.name) > 1 && project.members.length === 1;
    names.set(project.key, clash ? `${project.name} (${project.members[0]})` : project.name);
  }
  return names;
}

function townAgent(agent, projectName) {
  return {
    id: agent.id, kind: agent.kind, parentId: null, owner: agent.owner,
    project: projectName, workProject: projectName, title: agent.title, model: agent.model,
    status: agent.status, waiting: agent.status === 'waiting', waitingSince: agent.waitingSince, waitingAsk: agent.ask, summary: agent.summary,
    lastAction: agent.activity, lastTs: agent.lastTs, firstTs: agent.lastTs,
    tokens: NO_TOKENS, context: 0, cost: 0, toolCalls: 0, toolErrors: 0, edits: 0, linesAdded: 0, linesRemoved: 0,
    filesTouched: 0, lastFile: '', lastHumanTs: 0, humanMsgs: 0, interrupts: 0, portal: null, today: null,
    stress: 0, burnPerHour: 0, recentErrors: 0, shiftHours: 0,
  };
}

function townProject(project, name, agents) {
  const here = agents.filter((agent) => agent.project === name);
  return {
    name, path: '', members: project.members, lines: 0, linesToday: 0, cost: 0, weekScore: 0, layers: [],
    agents: project.agents, active: project.active, errors: 0, lastTs: project.lastTs,
    waitingIds: here.filter((agent) => agent.waiting).map((agent) => agent.id),
    stack: '', profile: project.profile,
    problems: { failing: project.failing.map((check) => ({ ...check, ok: false })), errorsLastHour: project.errorsLastHour },
  };
}

export function clanSnapshot(town) {
  const names = buildingNames(town.projects);
  const agents = town.agents.map((agent) => townAgent(agent, names.get(agent.project)));
  const projects = town.projects.map((project) => townProject(project, names.get(project.key), agents));
  const events = town.events.map((event) => ({ ts: event.ts, kind: event.kind, agentId: event.agent, project: names.get(event.project), text: event.text }));
  return {
    now: town.now, ready: true, agents, projects, events, layoutSeed: LAYOUT_SEED,
    defaults: { projectsFolder: '' },
    totals: { costToday: 0, linesToday: 0, costAllTime: 0, historyDays: 0 },
    clan: { ...town.clan, members: town.members, waitingOn: town.waitingOn },
  };
}
