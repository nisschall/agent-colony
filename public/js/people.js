// Drawing people: agents, their props, and you, the inspector.
import { PERSON_OUTLINE, ctx, mixColor, rect, shade } from './canvas.js';
import { YOU } from './layout.js';
import { state } from './state.js';
import { hash } from './utils.js';

// A coffee cup or a glowing phone in hand while an idle agent hangs around the park.
function drawActivityProp(worker, activity) {
  const x = Math.round(worker.x);
  const y = Math.round(worker.y);
  if (activity === 'coffee') {
    rect(x + 3, y - 7, 3, 3, '#f4f4f4');
    rect(x + 3, y - 7, 3, 1, '#6b4a2b');
    const steam = (state.time * 0.8 + worker.phase) % 1;
    rect(x + 4, y - 9 - steam * 4, 1, 1, `rgba(255,255,255,${0.7 * (1 - steam)})`);
  } else if (activity === 'phone') {
    rect(x + 3, y - 8, 2, 3, '#1b1428');
    rect(x + 3, y - 8, 2, 2, '#7ee0ff');
    state.lights.push({ x: x + 4, y: y - 7, r: 4 });
  }
}

export function drawInspector() {
  drawOutlinedPerson(YOU.x, YOU.y, YOU, { pose: YOU.moving ? 'walk' : 'stand', dir: YOU.moving ? YOU.dir : 'down' });
  const x = Math.round(YOU.x);
  const y = Math.round(YOU.y);
  rect(x - 3, y - 15, 6, 2, '#c0392b');
  rect(x - 4, y - 14, 4, 1, '#a02d22');
  rect(x + 3, y - 8, 4, 5, '#8a5a32');
  rect(x + 4, y - 7, 2, 3, '#f4e9c9');
  if (YOU.arrived) {
    const dots = '.'.repeat(1 + (Math.floor(state.time * 3) % 3));
    rect(x - 7, y - 26, 14, 8, '#fff');
    rect(x - 2, y - 18, 2, 2, '#fff');
    ctx.fillStyle = '#1b1428';
    ctx.font = '4px "Press Start 2P"';
    ctx.textAlign = 'left';
    ctx.fillText(dots, x - 5, y - 20);
  }
}

export function isOutOfSight(worker) {
  return worker.indoors && !worker.moving;
}

export function drawWorker(worker) {
  const agent = worker.agent;
  let pose = 'stand';
  if (worker.moving) pose = 'walk';
  else if (agent.status === 'waiting') pose = 'wave';
  else if (agent.status === 'sleeping') pose = 'sleep';
  else if (['working', 'overworked', 'stuck'].includes(agent.status)) pose = 'type';
  else if (agent.status === 'idle') pose = 'sit';
  let dir = worker.moving ? worker.dir : 'down';
  if (!worker.moving && worker.slot) {
    pose = worker.slot.pose;
    dir = worker.slot.dir;
  }
  const activity = !worker.moving && agent.status === 'idle' && worker.target ? worker.target.activity : '';
  if (activity && activity !== 'sit') pose = activity === 'stretch' ? 'wave' : 'stand';
  const shakeX = worker.shake > 0 || agent.status === 'stuck' ? Math.round(Math.sin(state.time * 40) * 1) : 0;
  drawOutlinedPerson(worker.x + shakeX, worker.y, worker, { pose, dir });
  if (activity) drawActivityProp(worker, activity);

  if (state.selectedId === agent.id) {
    const bob = Math.round(Math.sin(state.time * 5) * 1.5);
    ctx.fillStyle = '#ffcc33';
    ctx.beginPath();
    ctx.moveTo(worker.x - 3, worker.y - 26 + bob);
    ctx.lineTo(worker.x + 3, worker.y - 26 + bob);
    ctx.lineTo(worker.x, worker.y - 22 + bob);
    ctx.fill();
  }
  const iconY = worker.y - (agent.kind === 'subagent' ? 20 : 25);
  if (agent.status === 'waiting') {
    const bob = Math.round(Math.sin(state.time * 4) * 1);
    rect(worker.x - 4, iconY - 6 + bob, 9, 9, '#fff');
    rect(worker.x - 1, iconY + 3 + bob, 2, 2, '#fff');
    ctx.fillStyle = '#3b6fb6';
    ctx.font = '6px "Press Start 2P"';
    ctx.textAlign = 'center';
    ctx.fillText('?', worker.x + 1, iconY + 2 + bob);
  } else if (agent.status === 'stuck') {
    rect(worker.x - 4, iconY - 6, 8, 9, '#fff');
    rect(worker.x - 1, iconY - 4, 2, 4, '#e33');
    rect(worker.x - 1, iconY + 1, 2, 1, '#e33');
  } else if (agent.status === 'overworked') {
    const flicker = Math.floor(state.time * 8) % 2;
    rect(worker.x - 2, iconY - 4 - flicker, 4, 5 + flicker, '#ff7a1a');
    rect(worker.x - 1, iconY - 2, 2, 3, '#ffe066');
  } else if (agent.status === 'sleeping') {
    const t = (state.time * 0.6 + (hash(agent.id) % 10) / 10) % 1;
    ctx.fillStyle = `rgba(255,255,255,${1 - t})`;
    ctx.font = '5px "Press Start 2P"';
    ctx.textAlign = 'left';
    ctx.fillText('z', worker.x + 4 + t * 6, worker.y - 8 - t * 10);
  }
}

// A 1px dark outline (the person's silhouette drawn around them) makes sprites pop off the grass.
export function drawOutlinedPerson(x, y, worker, opts) {
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    drawPerson(ctx, x + dx, y + dy, worker, { ...opts, silhouette: PERSON_OUTLINE });
  }
  drawPerson(ctx, x, y, worker, opts);
}

export const HIRED_VEST = '#ff8c2a';
export const HIRED_MARK = '★';

export function drawPerson(c, px, py, worker, opts) {
  const look = worker.look;
  const agent = worker.agent;
  const small = agent.kind === 'subagent' && !opts.portrait;
  const x = Math.round(px);
  const y = Math.round(py);
  const box = (dx, dy, w, h, color) => {
    c.fillStyle = opts.silhouette || color;
    c.fillRect(x + dx, y + dy, w, h);
  };
  c.save();
  if (small) {
    c.translate(x, y);
    c.scale(0.75, 0.75);
    c.translate(-x, -y);
  }
  if (!opts.portrait && !opts.silhouette) {
    c.fillStyle = 'rgba(0,0,0,.25)';
    c.fillRect(x - 4, y - 1, 8, 2);
  }
  if (opts.pose === 'sleep') {
    c.translate(x, y - 2);
    c.rotate(-Math.PI / 2);
    c.translate(-x, -y);
  }
  const stress = agent.stress || 0;
  const face = agent.status === 'overworked' || agent.status === 'stuck' ? mixColor(look.skin, '#ff4a3a', Math.min(0.6, stress / 140)) : look.skin;
  const t = state.time + worker.phase;
  const walkFrame = opts.pose === 'walk' ? Math.floor(t * 8) % 2 : 0;
  const sitting = opts.pose === 'sit';

  if (sitting) {
    box(-3, -4, 6, 2, look.pants);
  } else {
    box(-3, -4 + (walkFrame ? -1 : 0), 2, 4 - (walkFrame ? 1 : 0), look.pants);
    box(1, -4 + (walkFrame ? 0 : -1), 2, 4 - (walkFrame ? 0 : 1), look.pants);
    box(-3, -1, 2, 1, '#222');
    box(1, -1, 2, 1, '#222');
  }
  const bodyY = sitting ? -9 : -9;
  box(-3, bodyY, 6, 5, look.shirt);
  box(-3, bodyY, 6, 1, shade(look.shirt, 30));
  // Agents hired from the town wear a hi-vis vest, so you can tell them from ones started in the Claude app or CLI.
  if (agent.portal) {
    box(-3, bodyY, 2, 5, HIRED_VEST);
    box(1, bodyY, 2, 5, HIRED_VEST);
    box(-3, bodyY + 3, 6, 1, '#f4f4f4');
  }
  const typing = opts.pose === 'type';
  const armBob = typing ? (Math.floor(t * (agent.status === 'overworked' ? 14 : 8)) % 2) : 0;
  box(-4, bodyY + 1 - armBob, 1, 3, look.shirt);
  box(-4, bodyY + 4 - armBob, 1, 1, face);
  if (opts.pose === 'wave') {
    const wave = Math.floor(t * 3) % 2;
    box(3 + wave, bodyY - 4, 1, 4, look.shirt);
    box(3 + wave, bodyY - 5, 1, 1, face);
  } else {
    box(3, bodyY + 1 - (typing ? 1 - armBob : 0), 1, 3, look.shirt);
    box(3, bodyY + 4 - (typing ? 1 - armBob : 0), 1, 1, face);
  }
  const blink = Math.floor(t * 1.3) % 7 === 0 || opts.pose === 'sleep';
  const eye = '#1b1428';
  // Typing at the desk shows the back of the head (the monitor is behind them); walking faces the way they go.
  const dir = opts.portrait ? 'down' : typing ? 'up' : opts.dir || 'down';
  if (dir === 'up') {
    box(-2, bodyY - 5, 4, 6, look.hair);
    box(-3, bodyY - 4, 1, 3, look.hair);
    box(2, bodyY - 4, 1, 3, look.hair);
  } else if (dir === 'left' || dir === 'right') {
    const back = dir === 'right' ? -3 : 1;
    box(-2, bodyY - 4, 4, 4, face);
    box(-2, bodyY - 5, 4, 2, look.hair);
    box(back, bodyY - 4, 2, 3, look.hair);
    if (!blink) box(dir === 'right' ? 1 : -2, bodyY - 3, 1, 1, eye);
  } else {
    box(-2, bodyY - 4, 4, 4, face);
    box(-2, bodyY - 5, 4, 2, look.hair);
    box(-3, bodyY - 4, 1, 2, look.hair);
    box(2, bodyY - 4, 1, 2, look.hair);
    if (!blink) {
      box(-1, bodyY - 3, 1, 1, eye);
      box(1, bodyY - 3, 1, 1, eye);
    }
  }
  if (agent.kind === 'subagent') {
    box(-3, bodyY - 6, 6, 2, '#ffd23f');
    box(-4, bodyY - 5, 8, 1, '#e0b020');
  } else if (look.family === 'codex') {
    box(-3, bodyY - 6, 6, 2, '#22a6a0');
    box(0, bodyY - 5, 4, 1, '#178a85');
  } else if (look.family === 'fable') {
    box(-2, bodyY - 7, 1, 2, '#ffcc33');
    box(0, bodyY - 7, 1, 2, '#ffcc33');
    box(2, bodyY - 7, 1, 2, '#ffcc33');
    box(-2, bodyY - 6, 5, 1, '#ffcc33');
  }
  c.restore();
}
