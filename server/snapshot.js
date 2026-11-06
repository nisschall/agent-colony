// The colony state sent to every open page.
const { agents, dailyCost, dailyLines, dayKey, events, statusOf, stressOf } = require('./agents');
const { DEFAULT_PROJECTS_FOLDER, HISTORY_DAYS, MIN } = require('./config');
const { portalAgents, portalStatus, runningProcesses } = require('./portal');
const { LIVE_LAYER_MS, profileOf, stackOf } = require('./projects');
const { currentTownSeed } = require('./town');

// `ready` is false until the first full scan of the logs has finished.
function snapshot(ready) {
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
