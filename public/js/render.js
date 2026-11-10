// Drawing one frame of the town, plus labels, particles and floating text.
import { CARS, drawBirds, drawCar, drawClouds, drawWeather } from './ambient.js';
import { buildingHealth, drawBuilding, styleFor } from './buildings.js';
import { worldToScreenMatrix } from './camera.js';
import { GLOW, canvas, ctx, pill, rect, toScreen } from './canvas.js';
import { TILE } from './config.js';
import { LOTS, OFFICE, REC, YOU } from './layout.js';
import { drawFireflies, drawMist, lighting } from './lighting.js';
import { HIRED_MARK, HIRED_VEST, drawInspector, drawWorker, isOutOfSight } from './people.js';
import { BENCHES, GRASS_PATTERN, LAMPS, TREES, drawBench, drawCentrepiece, drawEmptyLot, drawLamp, drawOffice, drawPuddles, drawRecCenter, drawRecOverlay, drawTownEdge, drawTree, ground } from './scenery.js';
import { reviewQueue } from './simulation.js';
import { state } from './state.js';
import { drawBalloons, visitorDrawables } from './visitors.js';

export function render() {
  state.light = lighting();
  const m = worldToScreenMatrix();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(m.zoom, 0, 0, m.zoom, m.ox, m.oy);
  // Grass continues past the town's edge so the wallpaper has no hard border.
  const topLeft = { x: -m.ox / m.zoom, y: -m.oy / m.zoom };
  ctx.fillStyle = GRASS_PATTERN;
  ctx.fillRect(Math.floor(topLeft.x / TILE) * TILE, Math.floor(topLeft.y / TILE) * TILE, canvas.width / m.zoom + 2 * TILE, canvas.height / m.zoom + 2 * TILE);
  ctx.drawImage(ground, 0, 0);
  state.lights = [];

  drawTownEdge();
  drawCentrepiece();
  drawPuddles();
  const usedLots = new Set([...state.buildings.values()].map((b) => b.lot));
  LOTS.forEach(([lx, ly], index) => {
    if (!usedLots.has(index)) drawEmptyLot(lx * TILE, ly * TILE);
  });

  const drawables = [];
  for (const building of state.buildings.values()) drawables.push({ y: building.y, draw: () => drawBuilding(building) });
  for (const tree of TREES) drawables.push({ y: tree.y, draw: () => drawTree(tree) });
  for (const bench of BENCHES) drawables.push({ y: bench.y, draw: () => drawBench(bench) });
  for (const lamp of LAMPS) drawables.push({ y: lamp.y, draw: () => drawLamp(lamp) });
  for (const worker of state.workers.values()) {
    if (isOutOfSight(worker)) continue;
    drawables.push({ y: worker.y, draw: () => drawWorker(worker) });
  }
  drawables.push({ y: OFFICE.y, draw: drawOffice });
  drawables.push({ y: REC.y0, draw: drawRecCenter });
  drawables.push({ y: YOU.y, draw: drawInspector });
  for (const car of CARS) drawables.push({ y: car.y, draw: () => drawCar(car) });
  drawables.push(...visitorDrawables());
  drawables.sort((a, b) => a.y - b.y);
  for (const item of drawables) item.draw();
  drawRecOverlay();
  drawClouds();
  drawFireflies();

  drawParticles();
  drawBirds();
  drawBalloons();

  const light = state.light;
  const dark = light.dark;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (light.alpha > 0.005) {
    ctx.fillStyle = `rgba(${light.rgb.join(',')}, ${light.alpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  drawMist(light);
  ctx.setTransform(m.zoom, 0, 0, m.zoom, m.ox, m.oy);
  if (dark > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6 * dark;
    ctx.imageSmoothingEnabled = true;
    for (const light of state.lights) {
      ctx.drawImage(GLOW, light.x - light.r, light.y - light.r, light.r * 2, light.r * 2);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  drawBeacon();
  drawWeather(m);
  drawLabels();
  drawFloaters();
}

function drawParticles() {
  ctx.textAlign = 'center';
  for (const p of state.particles) {
    if (p.t < 0) continue;
    const k = p.t / p.dur;
    if (p.kind === 'brick' || p.kind === 'spark') {
      const x = p.sx + (p.ex - p.sx) * k;
      const lift = p.kind === 'brick' ? 40 : 8;
      const y = p.sy + (p.ey - p.sy) * k - Math.sin(k * Math.PI) * lift;
      ctx.font = '5px "Press Start 2P"';
      ctx.fillStyle = p.kind === 'brick' ? '#7ee07e' : `rgba(126,224,126,${1 - k})`;
      if (p.kind === 'brick') rect(x - 4, y - 5, 8, 6, 'rgba(20,40,20,.6)');
      ctx.fillStyle = p.kind === 'brick' ? '#7ee07e' : `rgba(126,224,126,${1 - k})`;
      ctx.fillText(p.glyph, x, y);
    } else if (p.kind === 'sweat') {
      rect(p.sx, p.sy + k * 6, 1, 2, `rgba(140,200,255,${1 - k})`);
    } else if (p.kind === 'smoke') {
      ctx.fillStyle = `rgba(90,90,90,${0.5 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(p.sx + Math.sin(k * 6) * 2, p.sy - k * 16, 2 + k * 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawFloaters() {
  ctx.textAlign = 'center';
  ctx.font = '5px "Press Start 2P"';
  for (const f of state.floaters) {
    const alpha = Math.min(1, f.life);
    ctx.fillStyle = `rgba(0,0,0,${0.6 * alpha})`;
    ctx.fillText(f.text, f.x + 0.6, f.y + 0.6);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
    ctx.globalAlpha = 1;
  }
}

// Name tags only for agents worth noticing; everyone else shows their name on hover.
function showsNameTag(worker) {
  if (isOutOfSight(worker)) return false;
  const noteworthy = Boolean(worker.agent.portal) || ['working', 'overworked', 'stuck', 'waiting'].includes(worker.agent.status);
  return noteworthy || worker.agent.id === state.selectedId || worker.agent.id === state.hoverId;
}

// In a clan's town the review queue belongs to several people, so the sign says whose it is.
function waitingLabel(queue) {
  const clan = state.data.clan;
  if (!clan) return `🙋 ${queue} WAITING ON YOU`;
  const whose = clan.waitingOn.slice(0, 3).map((w) => `${w.login} ${w.count}`).join(' · ');
  return `🙋 ${queue} WAITING · ${whose}`;
}

function drawLabels() {
  const m = worldToScreenMatrix();
  const zoom = state.camera.zoom;
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const pulse = Math.floor(state.time * 2) % 2 === 0;
  for (const building of state.buildings.values()) {
    const { emblem } = styleFor(building);
    const health = buildingHealth(building);
    const active = building.project.active;
    const name = building.name.length > 20 ? `${building.name.slice(0, 19)}…` : building.name;
    const failing = health.failing.map((check) => check.kind).join(' + ');
    const parts = [
      `${health.landmark ? '★ ' : ''}${emblem ? `${emblem} ` : ''}${name}`,
      active ? `${active}⚒` : '',
      failing ? `⚠ ${failing} failing` : health.smoking ? `⚠ ${health.errors} errors` : '',
      health.waiting ? `🙋 ${health.waiting}` : '',
      building.project.members?.length > 1 ? `👥 ${building.project.members.length}` : '',
    ];
    const text = parts.filter(Boolean).join(' · ');
    const at = toScreen(m, building.x, building.labelY);
    const color = failing || health.smoking ? '#ff8a8a' : active ? '#ffcc33' : '#f4e9c9';
    if (health.waiting && pulse) pill(text, at.x, at.y, 15, '#1b1428', '#ffcc33');
    else pill(text, at.x, at.y, 15, color, 'rgba(27,20,40,.8)');
  }

  const rec = toScreen(m, (REC.x0 + REC.x1) / 2, REC.y0 - 8);
  const inside = [...state.workers.values()].filter(isOutOfSight).length;
  pill(`🎮 REC CENTER${inside ? ` · 💤 ${inside} inside` : ''}`, rec.x, rec.y, 14, '#f4e9c9', 'rgba(27,20,40,.8)');
  const queue = reviewQueue().length;
  const office = toScreen(m, OFFICE.x, OFFICE.y - 48);
  if (queue) pill(waitingLabel(queue), office.x, office.y, 18, '#1b1428', '#ffcc33');

  if (zoom >= 0.8) {
    const nameSize = zoom >= 2 ? 15 : 13;
    for (const worker of state.workers.values()) {
      if (!showsNameTag(worker)) continue;
      const at = toScreen(m, worker.x, worker.y + 9);
      const owner = worker.agent.owner ? ` · ${worker.agent.owner}` : '';
      if (worker.agent.portal) pill(`${HIRED_MARK} ${worker.look.name}`, at.x, at.y, nameSize, HIRED_VEST, 'rgba(27,20,40,.8)');
      else pill(`${worker.look.name}${owner}`, at.x, at.y, nameSize, '#f4e9c9', 'rgba(27,20,40,.7)');
    }
  }
  const you = toScreen(m, YOU.x, YOU.y + 9);
  pill('YOU', you.x, you.y, 15, '#1b1428', '#ffcc33');
  ctx.setTransform(m.zoom, 0, 0, m.zoom, m.ox, m.oy);
}

// A pulsing beam of light over the Review Office whenever someone is waiting on you.
function drawBeacon() {
  if (!reviewQueue().length) return;
  const pulse = 0.55 + Math.sin(state.time * 3) * 0.25;
  const beamTop = OFFICE.y - 420;
  const gradient = ctx.createLinearGradient(0, OFFICE.y - 30, 0, beamTop);
  gradient.addColorStop(0, `rgba(255, 214, 90, ${0.55 * pulse})`);
  gradient.addColorStop(1, 'rgba(255, 214, 90, 0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(OFFICE.x - 6, OFFICE.y - 30);
  ctx.lineTo(OFFICE.x + 6, OFFICE.y - 30);
  ctx.lineTo(OFFICE.x + 22, beamTop);
  ctx.lineTo(OFFICE.x - 22, beamTop);
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}
