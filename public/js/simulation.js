// Moving agents: where each one should be, walking there, and you following your focus.
import { IDLE_WANDER_CHANCE, PARK_ACTIVITIES, foodTruckOpen, updateAmbient } from './ambient.js';
import { CLAN_ID, CODE_GLYPHS, FOUNTAIN, PARK, ROAD_ROWS, TILE, WALK_SPEED } from './config.js';
import { FOCUS_TIMEOUT_MS, FOOD_TRUCK, NAP_SLOTS, OFFICE, REC, REC_SLOTS, YOU, townWidth } from './layout.js';
import { BENCHES } from './scenery.js';
import { state } from './state.js';
import { addFloater } from './sync.js';
import { hash, siteOf } from './utils.js';

function workSpot(worker, data) {
  const site = siteOf(worker.agent);
  const building = state.buildings.get(site);
  if (!building) return parkSpot(worker);
  const crew = data.agents
    .filter((a) => siteOf(a) === site && ['working', 'overworked', 'stuck'].includes(a.status))
    .map((a) => a.id)
    .sort();
  const slot = Math.max(0, crew.indexOf(worker.agent.id));
  const column = slot % 5;
  const row = Math.floor(slot / 5);
  return { x: building.x - 40 + column * 20, y: building.y + 18 + row * 10 };
}

export function reviewQueue() {
  if (!state.data) return [];
  return state.data.agents.filter((a) => a.status === 'waiting').sort((a, b) => a.waitingSince - b.waitingSince);
}

// The town hall is wider than the review office, so a clan's queue starts further out.
const QUEUE_START_X = CLAN_ID ? 48 : 36;

function queueSpot(worker) {
  const index = Math.max(0, reviewQueue().findIndex((a) => a.id === worker.agent.id));
  return { x: OFFICE.x + QUEUE_START_X + (index % 6) * 13, y: OFFICE.y + 8 + Math.floor(index / 6) * 12 };
}

export function targetFor(worker, data) {
  const status = worker.agent.status;
  worker.slot = null;
  worker.indoors = false;
  if (status === 'waiting') return queueSpot(worker);
  if (['working', 'overworked', 'stuck'].includes(status)) return workSpot(worker, data);
  if (status === 'idle' && Math.random() < IDLE_WANDER_CHANCE) return wanderSpot();
  const slots = status === 'sleeping' ? NAP_SLOTS : REC_SLOTS;
  const sameStatus = data.agents.filter((a) => a.status === status).map((a) => a.id).sort();
  const slot = slots[sameStatus.indexOf(worker.agent.id)];
  if (slot) {
    worker.slot = slot;
    return { x: slot.x, y: slot.y };
  }
  // Extra sleepers walk into the rec center and stay out of sight, so the lawn stays clear.
  if (status === 'sleeping') {
    worker.indoors = true;
    return { x: REC.x0 + 60, y: REC.y1 + 4 };
  }
  return parkSpot(worker);
}

function parkSpot(worker) {
  const rand = Math.random;
  if (worker.agent.status === 'sleeping') {
    const seed = hash(worker.agent.id);
    return { x: PARK.x0 + 30 + (seed % 380), y: PARK.y1 - 30 - ((seed >>> 8) % 40) };
  }
  if (rand() < 0.4) {
    const bench = BENCHES[Math.floor(rand() * BENCHES.length)];
    return { x: bench.x + (rand() * 12 - 6), y: bench.y + 6 };
  }
  return { x: PARK.x0 + 30 + rand() * (PARK.x1 - PARK.x0 - 60), y: PARK.y0 + 30 + rand() * (PARK.y1 - PARK.y0 - 60) };
}

export function update(dt) {
  state.time += dt;
  for (const worker of state.workers.values()) updateWorker(worker, dt);
  updateInspector(dt);
  updateAmbient(dt);
  for (const particle of state.particles) particle.t += dt;
  state.particles = state.particles.filter((p) => {
    const done = p.t >= p.dur;
    if (done && p.label) {
      addFloater(p.ex, p.ey - 8, p.label, '#7ee07e');
      p.building.bump = 1;
    }
    return !done;
  });
  for (const floater of state.floaters) {
    floater.life -= dt;
    floater.y -= 14 * dt;
  }
  state.floaters = state.floaters.filter((f) => f.life > 0);
  for (const building of state.buildings.values()) building.bump = Math.max(0, building.bump - dt * 2);
}

export function directionOf(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

const LEAVE_SPEED = 3;

export function sendAway(agentId) {
  const worker = state.workers.get(agentId);
  if (!worker) return;
  const roadY = nearestRoadY(worker.y);
  worker.leaving = [{ x: worker.x, y: roadY }, { x: townWidth() + TILE, y: roadY }];
  worker.target = worker.leaving.shift();
}

function nearestRoadY(y) {
  const roads = ROAD_ROWS.map((row) => row * TILE + TILE / 2);
  return roads.reduce((best, road) => (Math.abs(road - y) < Math.abs(best - y) ? road : best));
}

function walkAway(worker, dt) {
  const dx = worker.target.x - worker.x;
  const dy = worker.target.y - worker.y;
  const distance = Math.hypot(dx, dy);
  worker.moving = distance > 1;
  if (worker.moving) {
    const step = Math.min(distance, WALK_SPEED * LEAVE_SPEED * dt);
    worker.x += (dx / distance) * step;
    worker.y += (dy / distance) * step;
    worker.dir = directionOf(dx, dy);
    return;
  }
  if (worker.leaving.length) worker.target = worker.leaving.shift();
  else state.workers.delete(worker.agent.id);
}

function updateWorker(worker, dt) {
  const agent = worker.agent;
  if (worker.leaving) {
    walkAway(worker, dt);
    return;
  }
  worker.phase += dt;
  worker.shake = Math.max(0, worker.shake - dt);
  const busy = ['working', 'overworked', 'stuck'].includes(agent.status);
  if (!worker.target) {
    worker.target = targetFor(worker, state.data);
    worker.wait = 0;
  }
  const dx = worker.target.x - worker.x;
  const dy = worker.target.y - worker.y;
  const distance = Math.hypot(dx, dy);
  const speed = WALK_SPEED * (agent.status === 'overworked' ? 1.5 : agent.status === 'sleeping' ? 0.7 : 1);
  worker.moving = distance > 1;
  if (worker.moving) {
    const step = Math.min(distance, speed * dt);
    worker.x += (dx / distance) * step;
    worker.y += (dy / distance) * step;
    worker.dir = directionOf(dx, dy);
    return;
  }
  if (busy) {
    if (Math.random() < dt * 0.5) {
      const building = state.buildings.get(siteOf(agent));
      if (building && agent.status !== 'stuck') {
        state.particles.push({ kind: 'spark', glyph: CODE_GLYPHS[Math.floor(Math.random() * CODE_GLYPHS.length)], sx: worker.x, sy: worker.y - 12, ex: worker.x + (Math.random() * 20 - 10), ey: worker.y - 34, t: 0, dur: 0.8 });
      }
    }
    if (agent.status === 'overworked' && Math.random() < dt * 3) {
      state.particles.push({ kind: 'sweat', sx: worker.x + (Math.random() < 0.5 ? -4 : 4), sy: worker.y - 12, ex: 0, ey: 0, t: 0, dur: 0.6 });
    }
    if (agent.stress >= 80 && Math.random() < dt * 4) {
      state.particles.push({ kind: 'smoke', sx: worker.x + (Math.random() * 6 - 3), sy: worker.y - 16, ex: 0, ey: 0, t: 0, dur: 1.4 });
    }
    return;
  }
  if (agent.status === 'idle') {
    worker.wait += dt;
    if (worker.wait > 6 + (hash(agent.id) % 8)) worker.target = null;
  }
}

// Your focus is the agent you messaged last. It stays there while that conversation is live
// (either of you active recently) and moves the moment you message someone else.
export function currentReviewee() {
  let latest = null;
  for (const worker of state.workers.values()) {
    if (!worker.agent.lastHumanTs) continue;
    if (!latest || worker.agent.lastHumanTs > latest.agent.lastHumanTs) latest = worker;
  }
  if (!latest) return null;
  const lastActivity = Math.max(latest.agent.lastHumanTs, latest.agent.lastTs);
  return Date.now() - lastActivity < FOCUS_TIMEOUT_MS ? latest : null;
}

function updateInspector(dt) {
  YOU.phase += dt;
  const reviewee = currentReviewee();
  YOU.revieweeId = reviewee ? reviewee.agent.id : null;
  const target = reviewee
    ? { x: reviewee.x + 18, y: reviewee.y + 1 }
    : { x: OFFICE.x, y: OFFICE.y + 9 };
  const dx = target.x - YOU.x;
  const dy = target.y - YOU.y;
  const distance = Math.hypot(dx, dy);
  if (YOU.snap) {
    YOU.snap = false;
    YOU.x = target.x;
    YOU.y = target.y;
    return;
  }
  YOU.moving = distance > 1;
  YOU.arrived = !YOU.moving && Boolean(reviewee);
  if (YOU.moving) {
    const runSpeed = distance > 120 ? 5 : 2.4;
    const step = Math.min(distance, WALK_SPEED * runSpeed * dt);
    YOU.dir = directionOf(dx, dy);
    YOU.x += (dx / distance) * step;
    YOU.y += (dy / distance) * step;
  }
}

// Idle agents sometimes leave the rec center for a walk: a bench, the fountain, or the food truck queue.
function wanderSpot() {
  const rand = Math.random;
  const roll = rand();
  if (foodTruckOpen() && roll < 0.25) {
    return { x: FOOD_TRUCK.x - 6 + rand() * 14, y: FOOD_TRUCK.y + 8 + rand() * 6, activity: 'coffee' };
  }
  if (roll < 0.5) {
    const bench = BENCHES[Math.floor(rand() * BENCHES.length)];
    return { x: bench.x + (rand() * 12 - 6), y: bench.y + 6, activity: 'sit' };
  }
  if (roll < 0.7) {
    const angle = rand() * Math.PI * 2;
    return { x: FOUNTAIN.x + Math.cos(angle) * 30, y: FOUNTAIN.y + 4 + Math.sin(angle) * 18, activity: 'look' };
  }
  const activity = PARK_ACTIVITIES[Math.floor(rand() * PARK_ACTIVITIES.length)];
  return { x: PARK.x0 + 30 + rand() * (PARK.x1 - PARK.x0 - 60), y: PARK.y0 + 30 + rand() * (PARK.y1 - PARK.y0 - 60), activity };
}
