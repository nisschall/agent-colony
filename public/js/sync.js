// Live data from the server: applying snapshots, placing buildings and reacting to changes.
import { TIERS, addonsFor, floorsFor, varietyFor } from './buildings.js';
import { clanSnapshot } from './clan.js';
import { CLAN_ID, CODE_GLYPHS, FLOOR_H, FOUNTAIN, PARK, TILE, WALLPAPER, WALLS } from './config.js';
import { addChronicle, addToast, ingestEvents, renderHud } from './hud.js';
import { identity } from './identity.js';
import { LAYOUT_SEED, LOTS, YOU } from './layout.js';
import { targetFor } from './simulation.js';
import { state } from './state.js';
import { BUSY_STATUSES } from './ui/boards.js';
import { renderSheet, selectWorker } from './ui/sheet.js';
import { hash, money, pick, siteOf } from './utils.js';
import { sendDeliveryVan } from './visitors.js';

// Buildings keep their lot across reloads (remembered per browser) so the town layout stays familiar.
const LOTS_KEY = 'agentColony.lots';
const rememberedLots = (() => {
  try { return JSON.parse(localStorage.getItem(LOTS_KEY)) || {}; } catch { return {}; }
})();

function freeLot(projectName) {
  const used = new Set([...state.buildings.values()].map((b) => b.lot));
  const remembered = rememberedLots[projectName];
  if (remembered !== undefined && !used.has(remembered)) return remembered;
  const claimed = new Set(Object.values(rememberedLots));
  const fresh = LOTS.findIndex((_, index) => !used.has(index) && !claimed.has(index));
  const lot = fresh >= 0 ? fresh : LOTS.findIndex((_, index) => !used.has(index));
  rememberedLots[projectName] = lot;
  try { localStorage.setItem(LOTS_KEY, JSON.stringify(rememberedLots)); } catch { /* storage unavailable */ }
  return lot;
}

function syncBuildings(projects) {
  const live = new Set(projects.slice(0, LOTS.length).map((p) => p.name));
  for (const name of [...state.buildings.keys()]) {
    if (!live.has(name)) state.buildings.delete(name);
  }
  projects.slice(0, LOTS.length).forEach((project) => {
    const existing = state.buildings.get(project.name);
    const index = existing ? existing.lot : freeLot(project.name);
    const [lx, ly] = LOTS[index];
    const seed = existing ? existing.seed : hash(project.name);
    const variety = existing ? existing.variety : varietyFor(seed);
    const floors = floorsFor(project, variety.floorWobble);
    const tier = project.profile ? project.profile.tier : '';
    let building = existing;
    if (!building) {
      building = { name: project.name, seed, variety, wall: pick(WALLS, seed), floors, tier, shownFloors: floors, bump: 0 };
      state.buildings.set(project.name, building);
    }
    // Only celebrate real growth, not the switch from the first rough estimate to the measured size.
    const measuredBefore = building.tier !== '';
    if (measuredBefore && tier && tier !== building.tier) {
      building.bump = 1;
      addToast(`🏗 ${project.name} became ${TIERS[tier].article} ${TIERS[tier].label.toLowerCase()}!`, 'info');
    } else if (measuredBefore && floors > building.floors) {
      building.bump = 1;
      addToast(`🏗 ${project.name} grew to ${floors} floors!`, 'info');
    }
    building.tier = tier;
    building.addons = addonsFor(project);
    Object.assign(building, { floors, x: lx * TILE, y: ly * TILE, lot: index, project });
  });
}

function spawnPoint(agent) {
  const building = state.buildings.get(siteOf(agent));
  if (building) return { x: building.x, y: building.y + 4 };
  return { x: FOUNTAIN.x, y: PARK.y1 };
}

function onSnapshot(data) {
  if (data.layoutSeed && data.layoutSeed !== LAYOUT_SEED) {
    location.reload();
    return;
  }
  const first = !state.data;
  state.data = data;
  syncBuildings(data.projects);
  const live = new Set();
  for (const agent of data.agents) {
    live.add(agent.id);
    let worker = state.workers.get(agent.id);
    if (worker && worker.leaving) continue;
    if (!worker) {
      const start = spawnPoint(agent);
      worker = { agent, look: identity(agent), x: start.x, y: start.y, target: null, wait: 0, phase: Math.random() * 10, shake: 0 };
      state.workers.set(agent.id, worker);
      if (!first) addChronicle({ ts: Date.now(), kind: 'hire', agentId: agent.id, text: 'clocked in for a new shift' });
    } else {
      reactToChanges(worker, worker.agent, agent);
    }
    const statusChanged = worker.agent.status !== agent.status;
    worker.agent = agent;
    worker.look = identity(agent);
    if (statusChanged || agent.status === 'waiting') worker.target = null;
    if (first) {
      worker.target = targetFor(worker, data);
      worker.x = worker.target.x;
      worker.y = worker.target.y;
    }
  }
  for (const id of [...state.workers.keys()]) {
    if (!live.has(id) && !state.workers.get(id).leaving) state.workers.delete(id);
  }
  if (first) YOU.snap = true;
  ingestEvents(data.events, first);
  if (state.pendingSelect && state.workers.has(state.pendingSelect)) {
    selectWorker(state.pendingSelect, true);
    state.pendingSelect = null;
  }
  renderHud();
  if (state.selectedId) renderSheet();
  document.getElementById('loading').style.display = 'none';
}

function reactToChanges(worker, before, after) {
  const linesBefore = before.linesAdded + before.linesRemoved;
  const linesAfter = after.linesAdded + after.linesRemoved;
  if (linesAfter > linesBefore) launchBrick(worker, after.linesAdded - before.linesAdded, after.linesRemoved - before.linesRemoved);
  const finishedTask = BUSY_STATUSES.includes(before.status) && ['waiting', 'idle'].includes(after.status);
  if (finishedTask) sendDeliveryVan(state.buildings.get(siteOf(after)));
  const spent = after.cost - before.cost;
  if (spent >= 0.01) {
    addFloater(worker.x, worker.y - 22, `-${money(spent)}`, '#ffcc33');
    const coin = document.getElementById('coin');
    coin.classList.remove('spin');
    void coin.offsetWidth;
    coin.classList.add('spin');
  }
  if (after.toolErrors > before.toolErrors) {
    worker.shake = 1;
    addFloater(worker.x, worker.y - 26, '✖ error', '#ff5a5a');
  }
  if (after.status !== before.status) {
    const look = identity(after);
    if (after.status === 'overworked') {
      addToast(`🔥 ${look.name} @ ${after.project} is burning out!`);
      addChronicle({ ts: Date.now(), kind: 'alarm', agentId: after.id, text: 'is overworked — consider a break' });
    }
    if (after.status === 'stuck') {
      addToast(`❗ ${look.name} @ ${after.project} is stuck on errors`);
      addChronicle({ ts: Date.now(), kind: 'alarm', agentId: after.id, text: 'keeps hitting errors' });
    }
    if (after.status === 'waiting') addToast(`🙋 ${look.name} @ ${after.project} ${after.owner ? `is waiting on ${after.owner}` : 'needs your review'}`, 'info');
  }
  if (after.lastHumanTs > before.lastHumanTs) {
    addFloater(worker.x, worker.y - 26, '📋 new orders', '#6cc4ff');
  }
}

function launchBrick(worker, added, removed) {
  const building = state.buildings.get(siteOf(worker.agent));
  if (!building) return;
  const count = Math.min(6, 1 + Math.floor((added + removed) / 40));
  for (let i = 0; i < count; i++) {
    state.particles.push({
      kind: 'brick', glyph: CODE_GLYPHS[Math.floor(Math.random() * CODE_GLYPHS.length)],
      sx: worker.x, sy: worker.y - 12, ex: building.x + (Math.random() * 60 - 30), ey: building.y - building.floors * FLOOR_H,
      t: -i * 0.15, dur: 0.9, building,
      label: i === 0 ? `+${added} −${removed}` : null,
    });
  }
}

export function addFloater(x, y, text, color) {
  state.floaters.push({ x, y, text, color, life: 1.6 });
}

// The server issues a new API token each time it starts, so after a restart the page reloads itself
// to pick up the new one (keeps a long-running wallpaper working).
export function connect() {
  if (CLAN_ID) {
    connectToClan();
    return;
  }
  const source = new EventSource('/events');
  let lostContact = false;
  source.onopen = () => {
    if (lostContact) location.reload();
  };
  source.onmessage = (e) => onSnapshot(JSON.parse(e.data));
  source.onerror = () => {
    lostContact = true;
    document.getElementById('loadingHint').textContent = 'Lost contact with the colony server — retrying…';
  };
}

function connectToClan() {
  document.getElementById('loadingHint').textContent = 'Gathering the clan';
  const source = new EventSource(`/api/clans/${encodeURIComponent(CLAN_ID)}/stream`);
  source.onmessage = (e) => onSnapshot(clanSnapshot(JSON.parse(e.data)));
  source.onerror = () => {
    document.getElementById('loadingHint').textContent = 'Lost contact with the hub — retrying…';
  };
}

if (WALLPAPER) document.body.classList.add('wallpaper');
