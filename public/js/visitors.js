// Visitors: delivery vans, dog walkers, kids at the fountain, the food truck and hot-air balloons.
import { DELIVERY_COOLDOWN_MS, VEHICLE_COLORS, VISITOR_LOOKS, dayMood, foodTruckOpen, isDaytime } from './ambient.js';
import { ctx, rect } from './canvas.js';
import { FOUNTAIN, MAP_W, PARK, TILE } from './config.js';
import { FOOD_TRUCK } from './layout.js';
import { daylight } from './lighting.js';
import { drawOutlinedPerson } from './people.js';
import { directionOf } from './simulation.js';
import { state } from './state.js';
import { addFloater } from './sync.js';

// ---- visitors: delivery vans, dog walkers, kids at the fountain, a hot-air balloon ----
function visitorPerson(look, small) {
  return { look, agent: { kind: small ? 'subagent' : 'visitor', status: 'idle', stress: 0 }, phase: Math.random() * 10 };
}

export function sendDeliveryVan(building) {
  const now = Date.now();
  if (!building || now - (state.lastDeliveryAt || 0) < DELIVERY_COOLDOWN_MS) return;
  if (state.visitors.some((v) => v.kind === 'van')) return;
  const row = building.y < 20 * TILE ? 13 : building.y > 35 * TILE ? 43 : 0;
  if (!row) return;
  state.lastDeliveryAt = now;
  const lane = { y: row * TILE + 11, dir: -1 };
  state.visitors.push({ kind: 'van', x: MAP_W * TILE + 30, y: lane.y, dir: lane.dir, stopX: building.x, stage: 'arrive', timer: 0, project: building.name });
}

function spawnVisitors(dt) {
  const worldWidth = MAP_W * TILE;
  const day = daylight() < 0.5;
  if (day && isDaytime(7, 20) && !state.visitors.some((v) => v.kind === 'dog') && Math.random() < dt / 45) {
    const top = PARK.y0 + 11;
    const bottom = PARK.y1 - 11;
    const left = PARK.x0 + 11;
    const right = PARK.x1 - 11;
    const clockwise = Math.random() < 0.5;
    const route = clockwise
      ? [[left, bottom], [left, top], [right, top], [right, bottom]]
      : [[right, top], [right, bottom], [left, bottom], [left, top]];
    const look = VISITOR_LOOKS[Math.floor(Math.random() * VISITOR_LOOKS.length)];
    state.visitors.push({ kind: 'dog', person: visitorPerson(look), x: route[0][0], y: route[0][1], route: route.slice(1), dogColor: Math.random() < 0.5 ? '#8a5a32' : '#f4e9c9' });
  }
  const wantKids = Boolean(dayMood && dayMood.kids && day && isDaytime(8, 18));
  const kids = state.visitors.filter((v) => v.kind === 'kid');
  if (wantKids && !kids.length) {
    for (let i = 0; i < 2; i++) {
      state.visitors.push({ kind: 'kid', person: visitorPerson(VISITOR_LOOKS[(i + 1) % VISITOR_LOOKS.length], true), angle: i * 2.4, speed: 0.9 + i * 0.25, x: FOUNTAIN.x, y: FOUNTAIN.y });
    }
  } else if (!wantKids && kids.length) {
    state.visitors = state.visitors.filter((v) => v.kind !== 'kid');
  }
  const wantBalloon = Boolean(dayMood && dayMood.balloon && day);
  if (wantBalloon && !state.visitors.some((v) => v.kind === 'balloon') && Math.random() < dt / 300) {
    state.visitors.push({ kind: 'balloon', x: -40, y: 80 + Math.random() * 260, speed: 6 + Math.random() * 4, color: VEHICLE_COLORS[Math.floor(Math.random() * VEHICLE_COLORS.length)] });
  }
  state.visitors = state.visitors.filter((v) => !v.done && v.x < worldWidth + 60 && v.x > -80);
}

export function updateVisitors(dt) {
  spawnVisitors(dt);
  for (const visitor of state.visitors) VISITOR_UPDATES[visitor.kind](visitor, dt);
}

function updateVan(van, dt) {
  if (van.stage === 'stop') {
    van.timer += dt;
    if (van.timer > 4) van.stage = 'leave';
    return;
  }
  van.x += van.dir * 40 * dt;
  if (van.stage === 'arrive' && van.x <= van.stopX + 14) {
    van.stage = 'stop';
    addFloater(van.x, van.y - 16, '📦', '#f4e9c9');
  }
  if (van.x < -60) van.done = true;
}

function updateDogWalker(walker, dt) {
  const next = walker.route[0];
  if (!next) {
    walker.done = true;
    return;
  }
  const dx = next[0] - walker.x;
  const dy = next[1] - walker.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) {
    walker.route.shift();
    return;
  }
  const step = Math.min(distance, 18 * dt);
  walker.x += (dx / distance) * step;
  walker.y += (dy / distance) * step;
  walker.dir = directionOf(dx, dy);
}

function updateKid(kid, dt) {
  kid.angle += kid.speed * dt;
  const newX = FOUNTAIN.x + Math.cos(kid.angle) * 30;
  const newY = FOUNTAIN.y + 2 + Math.sin(kid.angle) * 17;
  kid.dir = directionOf(newX - kid.x, newY - kid.y);
  kid.x = newX;
  kid.y = newY;
}

function updateBalloon(balloon, dt) {
  balloon.x += balloon.speed * dt;
}

const VISITOR_UPDATES = { van: updateVan, dog: updateDogWalker, kid: updateKid, balloon: updateBalloon };

function drawVan(van) {
  const x = Math.round(van.x);
  const y = Math.round(van.y);
  rect(x - 12, y - 2, 24, 3, 'rgba(0,0,0,.25)');
  rect(x - 12, y - 11, 24, 9, '#f4f4f4');
  rect(x - 12, y - 11, 24, 1, '#ffffff');
  rect(x - 12, y - 11, 6, 6, '#a8d8ff');
  rect(x - 2, y - 9, 8, 4, '#d9822b');
  rect(x - 9, y - 3, 4, 2, '#222');
  rect(x + 5, y - 3, 4, 2, '#222');
  rect(x - 13, y - 7, 1, 2, '#fff6c4');
  if (van.stage === 'stop') {
    const blink = Math.floor(state.time * 3) % 2 === 0;
    rect(x + 11, y - 6, 1, 2, blink ? '#ffb347' : '#7a4a20');
  }
  state.lights.push({ x: x - 18, y: y - 6, r: 9 });
}

function drawDogWalk(walker) {
  const dir = walker.dir || 'right';
  drawOutlinedPerson(walker.x, walker.y, walker.person, { pose: 'walk', dir });
  const ahead = { right: [10, 2], left: [-10, 2], up: [3, -8], down: [3, 8] }[dir];
  const dogX = Math.round(walker.x + ahead[0]);
  const dogY = Math.round(walker.y + ahead[1]);
  const step = Math.floor(state.time * 10) % 2;
  const facing = dir === 'left' ? -1 : 1;
  ctx.strokeStyle = 'rgba(40, 30, 30, .6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(walker.x + 3, walker.y - 5);
  ctx.lineTo(dogX, dogY - 4);
  ctx.stroke();
  rect(dogX - 3, dogY - 4, 6, 3, walker.dogColor);
  rect(dogX + facing * 3 - (facing < 0 ? 2 : 0), dogY - 6, 3, 3, walker.dogColor);
  rect(dogX - 3 + step, dogY - 1, 1, 1, '#2b1d14');
  rect(dogX + 2 - step, dogY - 1, 1, 1, '#2b1d14');
  const wag = Math.floor(state.time * 12) % 2;
  rect(dogX - facing * 4, dogY - 5 - wag, 1, 2, walker.dogColor);
}

function drawKid(kid) {
  drawOutlinedPerson(kid.x, kid.y, kid.person, { pose: 'walk', dir: kid.dir || 'down' });
}

// Balloons fly above the town, so they are drawn in the sky layer with their shadow on the ground.
export function drawBalloons() {
  for (const balloon of state.visitors) {
    if (balloon.kind !== 'balloon') continue;
    const x = Math.round(balloon.x);
    const y = Math.round(balloon.y + Math.sin(state.time * 0.6) * 3);
    ctx.fillStyle = 'rgba(20, 30, 40, .12)';
    ctx.beginPath();
    ctx.ellipse(x + 20, y + 90, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = balloon.color;
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fill();
    rect(x - 2, y - 11, 4, 22, 'rgba(255,255,255,.35)');
    rect(x - 7, y - 8, 2, 14, 'rgba(0,0,0,.12)');
    ctx.strokeStyle = '#5c4a3a';
    ctx.beginPath();
    ctx.moveTo(x - 5, y + 9);
    ctx.lineTo(x - 3, y + 16);
    ctx.moveTo(x + 5, y + 9);
    ctx.lineTo(x + 3, y + 16);
    ctx.stroke();
    rect(x - 3, y + 16, 6, 4, '#8a5a32');
  }
}

function drawFoodTruck() {
  if (!foodTruckOpen()) return;
  const { x, y } = FOOD_TRUCK;
  rect(x - 16, y - 2, 32, 4, 'rgba(0,0,0,.25)');
  rect(x - 16, y - 16, 32, 14, '#f4e9c9');
  rect(x - 16, y - 16, 32, 1, '#ffffff');
  rect(x + 8, y - 14, 8, 7, '#a8d8ff');
  rect(x - 12, y - 13, 16, 6, '#3a2a1a');
  for (let i = 0; i < 6; i++) rect(x - 14 + i * 4, y - 19, 4, 3, i % 2 ? '#f4e9c9' : '#3fb68b');
  rect(x - 10, y - 12, 3, 3, '#f2c94c');
  rect(x - 5, y - 12, 3, 3, '#e86f9c');
  rect(x - 11, y - 3, 4, 3, '#222');
  rect(x + 6, y - 3, 4, 3, '#222');
  state.lights.push({ x: x - 4, y: y - 10, r: 10 });
}

export function visitorDrawables() {
  const list = [];
  for (const visitor of state.visitors) {
    if (visitor.kind === 'van') list.push({ y: visitor.y, draw: () => drawVan(visitor) });
    if (visitor.kind === 'dog') list.push({ y: visitor.y, draw: () => drawDogWalk(visitor) });
    if (visitor.kind === 'kid') list.push({ y: visitor.y, draw: () => drawKid(visitor) });
  }
  if (foodTruckOpen()) list.push({ y: FOOD_TRUCK.y, draw: drawFoodTruck });
  return list;
}
