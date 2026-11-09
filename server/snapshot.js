// The colony state sent to every open page.
const { agents, dailyCost, dailyLines, dayKey, events, projectPaths, statusOf, stressOf } = require('./agents');
const { DEFAULT_PROJECTS_FOLDER, HISTORY_DAYS, MIN } = require('./config');
const { isReleased, portalStatus } = require('./portal');
const { problemsOf } = require('./checks');
const { LIVE_LAYER_MS, isAppInternal, profileOf, stackOf } = require('./projects');
const { currentTownSeed } = require('./town');

const BUILDING_PLOTS = 12;
const IMPORTANCE_DAYS = 7;
// One message from you counts like ten minutes of agent work: projects you are engaged with matter more.
const MESSAGE_WEIGHT = 10;

function recentDayKeys(now) {
  return Array.from({ length: IMPORTANCE_DAYS }, (_, i) => dayKey(now - i * 24 * 60 * MIN));
}

// An agent stands at the building of the project it edited in the last quarter hour, else at its own.
const WORK_HERE_MS = 15 * MIN;

function projectEntry(projects, name) {
  let project = projects.get(name);
  if (!project) {
    project = { name, path: '', lines: 0, linesToday: 0, cost: 0, agents: 0, active: 0, errors: 0, lastTs: 0, weekScore: 0, layers: [], waitingIds: [] };
    projects.set(name, project);
  }
  return project;
}

// Lines, this week's work and live edits go to the project each edit touched; the rest stays with the agent's own.
function tallyWork(projects, agent, home, today, weekKeys, now) {
  let creditedLines = 0;
  for (const [name, credit] of agent.credited) {
    const project = projectEntry(projects, name);
    project.lines += credit.lines;
    project.lastTs = Math.max(project.lastTs, credit.lastTs);
    project.path = project.path || projectPaths.get(name);
    creditedLines += credit.lines;
  }
  home.lines += agent.linesAdded + agent.linesRemoved - creditedLines;

  const todayStats = agent.daily.get(today);
  let creditedToday = 0;
  for (const [name, day] of todayStats ? todayStats.projects : []) {
    projectEntry(projects, name).linesToday += day.lines;
    creditedToday += day.lines;
  }
  home.linesToday += (todayStats ? todayStats.lines : 0) - creditedToday;

  for (const key of weekKeys) {
    const day = agent.daily.get(key);
    if (!day) continue;
    let movedMinutes = 0;
    for (const [name, credit] of day.projects) {
      projectEntry(projects, name).weekScore += credit.minutes.size;
      movedMinutes += credit.minutes.size;
    }
    home.weekScore += Math.max(0, day.minutes.size - movedMinutes) + day.humanMsgs * MESSAGE_WEIGHT;
  }

  for (const [layer, edit] of Object.entries(agent.layerTs)) {
    const project = edit.project ? projectEntry(projects, edit.project) : home;
    if (now - edit.ts < LIVE_LAYER_MS && !project.layers.includes(layer)) project.layers.push(layer);
  }
}

// Plots go first to projects with an agent working or waiting now, then to this week's busiest, then the most recent.
function byImportance(a, b) {
  const liveFirst = (b.active > 0) - (a.active > 0);
  return liveFirst || b.weekScore - a.weekScore || b.lastTs - a.lastTs;
}

// `ready` is false until the first full scan of the logs has finished.
function snapshot(ready) {
  const now = Date.now();
  const today = dayKey(now);
  const weekKeys = recentDayKeys(now);
  const projects = new Map();
  const roster = [];
  for (const agent of agents.values()) {
    if (!agent.lastTs) continue;
    const home = projectEntry(projects, agent.project);
    home.cost += agent.cost;
    tallyWork(projects, agent, home, today, weekKeys, now);
    if (agent.lastTs >= home.lastTs && agent.cwd) home.path = agent.cwd;
    home.lastTs = Math.max(home.lastTs, agent.lastTs);
    if (now - agent.lastTs > 24 * 60 * MIN || isReleased(agent.id)) continue;
    const stress = stressOf(agent, now);
    let status = statusOf(agent, now, stress);
    let { waitingAsk, waitingSince } = agent;
    // For portal-hired agents we know exactly whether the process is running, and how its last run ended.
    const portal = portalStatus(agent);
    if (portal) {
      if (portal.running && (status === 'idle' || status === 'sleeping' || status === 'waiting')) status = 'working';
      if (!portal.running && ['working', 'overworked', 'stuck'].includes(status)) status = 'idle';
      if (portal.outcome?.state === 'needs-you') {
        status = 'waiting';
        waitingAsk = portal.outcome.summary;
        waitingSince = portal.outcome.ts;
      }
    }
    const workingRecently = agent.workProject && now - agent.workProjectTs < WORK_HERE_MS;
    const workProject = workingRecently ? agent.workProject : agent.project;
    const here = projectEntry(projects, workProject);
    here.agents += 1;
    here.errors += stress.recentErrors;
    if (status !== 'sleeping' && status !== 'idle') here.active += 1;
    if (status === 'waiting') here.waitingIds.push(agent.id);
    const todayStats = agent.daily.get(today);
    const todaySummary = todayStats && {
      cost: todayStats.cost, lines: todayStats.lines, edits: todayStats.edits, humanMsgs: todayStats.humanMsgs,
      activeMinutes: todayStats.minutes.size, firstTs: todayStats.firstTs,
    };
    roster.push({
      today: todaySummary || null,
      id: agent.id, kind: agent.kind, parentId: agent.parentId, project: agent.project, workProject,
      title: agent.title, model: agent.model, firstTs: agent.firstTs, lastTs: agent.lastTs,
      tokens: agent.tokens, context: agent.context, cost: agent.cost,
      toolCalls: agent.toolCalls, toolErrors: agent.toolErrors, edits: agent.edits,
      linesAdded: agent.linesAdded, linesRemoved: agent.linesRemoved,
      filesTouched: agent.files.size, lastFile: agent.lastFile, lastAction: agent.lastAction,
      lastHumanTs: agent.lastHumanTs, humanMsgs: agent.humanMsgs, interrupts: agent.interrupts,
      waiting: status === 'waiting', waitingSince, waitingAsk,
      portal,
      status, ...stress,
    });
  }
  const sortedProjects = [...projects.values()]
    .filter((project) => !isAppInternal(project.path))
    .sort(byImportance)
    .slice(0, BUILDING_PLOTS);
  for (const project of sortedProjects) {
    project.stack = stackOf(project.path);
    project.profile = profileOf(project.path);
    project.problems = problemsOf(project.name, now);
  }
  const sortedEvents = events.slice().sort((a, b) => a.ts - b.ts).slice(-80);
  return {
    now, ready, agents: roster, projects: sortedProjects, events: sortedEvents,
    defaults: { projectsFolder: DEFAULT_PROJECTS_FOLDER },
    layoutSeed: currentTownSeed(),
    totals: {
      costToday: dailyCost.get(today) || 0,
      linesToday: dailyLines.get(today) || 0,
      costAllTime: [...dailyCost.values()].reduce((a, b) => a + b, 0),
      historyDays: HISTORY_DAYS,
    },
  };
}

module.exports = { snapshot };
