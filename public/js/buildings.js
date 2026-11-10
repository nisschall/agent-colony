// Buildings: shape from the project's size, add-ons from its features, glow where agents are editing.
import { OUTLINE, ctx, rect, shade } from './canvas.js';
import { BUILDING_W, FLOOR_H, MAX_FLOORS } from './config.js';
import { currentHour, daylight, drawSunShadow } from './lighting.js';
import { state } from './state.js';
import { duration, hash, seeded, siteOf } from './utils.js';

export const TIERS = {
  cottage: { label: 'Cottage', article: 'a', w: 56, floors: [1, 1] },
  house: { label: 'House', article: 'a', w: 72, floors: [2, 2] },
  office: { label: 'Office block', article: 'an', w: 96, floors: [3, 6] },
  tower: { label: 'Tower', article: 'a', w: 76, floors: [7, 12] },
  campus: { label: 'Campus', article: 'a', w: 120, floors: [3, 7] },
};
// In display priority; each feature lists the spots it may take, and a building shows at most MAX_ADDONS.
export const FEATURES = {
  api: { label: 'REST API', slots: ['roofRight'], width: 0 },
  db: { label: 'Database', slots: ['left', 'right'], width: 16 },
  messaging: { label: 'Messaging', slots: ['right', 'left'], width: 12 },
  ai: { label: 'AI', slots: ['roofLeft', 'roofRight'], width: 0 },
  security: { label: 'Login & security', slots: ['door'], width: 0 },
  jobs: { label: 'Scheduled jobs', slots: ['right', 'left'], width: 14 },
  containers: { label: 'Docker', slots: ['left', 'right'], width: 22 },
  tests: { label: 'Tests', slots: ['left', 'right'], width: 18 },
  ci: { label: 'CI', slots: ['roofLeft', 'roofRight'], width: 0 },
};
export const LAYER_LABELS = {
  ui: 'screens', api: 'the API', db: 'the database', messaging: 'messaging', security: 'login & security',
  jobs: 'scheduled jobs', containers: 'Docker setup', tests: 'tests', ci: 'the CI pipeline', ai: 'AI calls',
};
// Bigger buildings show more of their project's features; a landmark gets one more.
const ADDON_LIMITS = { cottage: 1, house: 2, office: 3, tower: 4, campus: 5 };
const MAX_ADDONS = 5;
// Complexity (0–100, from the server) at which a project becomes the town's landmark: glass front, gold trim, beacon.
export const LANDMARK_COMPLEXITY = 75;
const STAR_STEPS = [20, 40, 60, LANDMARK_COMPLEXITY];
const LANDMARK_MAST = 24;
const UNMEASURED_MAX_FLOORS = 4;
const HEAVY_LINES_TODAY = 300;
const ERROR_SMOKE_THRESHOLD = 2;
const HEAVY_SMOKE_THRESHOLD = 6;
const QUIET_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNAL = '#7ee0ff';

const WINDOW_STYLES = [
  { w: 8, h: 6, gap: 14 },
  { w: 5, h: 7, gap: 10 },
  { w: 11, h: 5, gap: 16 },
];
const MIRRORED_SLOT = { left: 'right', right: 'left', roofLeft: 'roofRight', roofRight: 'roofLeft' };
// Animations run on a per-building clock so neighbours don't blink and spin in sync.
let buildingClock = 0;

// Small per-project quirks, drawn from the project's name so they stay the same on every reload.
export function varietyFor(seed) {
  const rand = seeded(seed);
  const scatter = (kinds) => Array.from({ length: Math.floor(rand() * 3) }, () => ({ kind: Math.floor(rand() * kinds), spot: rand() }));
  return {
    stretch: 2 * Math.round(rand() * 6 - 3),
    floorWobble: Math.floor(rand() * 3) - 1,
    windows: WINDOW_STYLES[Math.floor(rand() * WINDOW_STYLES.length)],
    mirrored: rand() < 0.5,
    addonScale: 0.85 + rand() * 0.3,
    clockOffset: rand() * 100,
    wingWidths: [32 + 2 * Math.floor(rand() * 5), 32 + 2 * Math.floor(rand() * 5)],
    wingDrops: [1 + Math.floor(rand() * 2), 1 + Math.floor(rand() * 2)],
    roofClutter: [scatter(ROOF_CLUTTER.length), scatter(ROOF_CLUTTER.length), scatter(ROOF_CLUTTER.length)],
    yard: scatter(YARD_ITEMS.length),
  };
}

// 1–5 stars from the project's complexity score.
export function starsOf(profile) {
  if (!profile || profile.complexity === undefined) return 0;
  return 1 + STAR_STEPS.filter((step) => profile.complexity >= step).length;
}

export function floorsFor(project, wobble) {
  const profile = project.profile;
  // A folder we can't measure stays modest rather than out-growing projects we know are complex.
  if (!profile) return Math.max(1, Math.min(UNMEASURED_MAX_FLOORS, Math.round(1 + Math.log2(1 + project.lines / 600))));
  // Height follows complexity exactly, so a taller building is always the more complex project.
  if (profile.complexity !== undefined) return Math.max(1, Math.round(1 + (profile.complexity * (MAX_FLOORS - 1)) / 100));
  const [fewest, most] = TIERS[profile.tier].floors;
  const bySize = Math.round(Math.log2(Math.max(1, profile.sourceFiles) / 10)) + wobble;
  return Math.max(fewest, Math.min(most, bySize));
}

export function addonsFor(project) {
  const profile = project.profile;
  const features = profile ? profile.features : [];
  const landmarkBonus = profile && profile.complexity >= LANDMARK_COMPLEXITY ? 1 : 0;
  const limit = Math.min(MAX_ADDONS, (profile ? ADDON_LIMITS[profile.tier] : 3) + landmarkBonus);
  const taken = new Set();
  const addons = [];
  for (const [feature, info] of Object.entries(FEATURES)) {
    if (addons.length === limit) break;
    if (!features.includes(feature)) continue;
    const slot = info.slots.find((s) => !taken.has(s));
    if (!slot) continue;
    taken.add(slot);
    addons.push({ feature, slot });
  }
  return addons;
}

// A campus is a main hall with two lower wings; everything else is one block.
function wingsFor(b) {
  const tier = b.project.profile ? b.project.profile.tier : '';
  const { stretch, wingWidths, wingDrops } = b.variety;
  if (tier !== 'campus') {
    const w = (tier ? TIERS[tier].w : BUILDING_W) + stretch;
    return [{ x: b.x - w / 2, w, floors: b.floors }];
  }
  const [leftWidth, rightWidth] = wingWidths;
  return [
    { x: b.x - 26 - leftWidth + 2, w: leftWidth, floors: Math.max(2, b.floors - wingDrops[0]) },
    { x: b.x + 24, w: rightWidth, floors: Math.max(2, b.floors - wingDrops[1]) },
    { x: b.x - 26, w: 52, floors: b.floors },
  ];
}

export function buildingHealth(b) {
  const project = b.project;
  const problems = project.problems || { failing: [], errorsLastHour: 0 };
  return {
    active: project.active > 0,
    heavy: (project.linesToday || 0) >= HEAVY_LINES_TODAY,
    failing: problems.failing,
    errors: problems.errorsLastHour,
    smoking: problems.errorsLastHour >= ERROR_SMOKE_THRESHOLD,
    heavySmoke: problems.errorsLastHour >= HEAVY_SMOKE_THRESHOLD,
    waiting: (project.waitingIds || []).length,
    landmark: Boolean(project.profile && project.profile.complexity >= LANDMARK_COMPLEXITY),
    quiet: Date.now() - project.lastTs > QUIET_DAYS * DAY_MS,
    live: new Set(project.layers || []),
  };
}

function agentName(agentId) {
  const worker = state.workers.get(agentId);
  return worker ? worker.look.name : 'an agent';
}

// What's wrong in a building, worst first. Lines with an agentId can take you to that agent.
export function problemLines(b) {
  const health = buildingHealth(b);
  // In a clan's town a check names the member it belongs to, and carries no command.
  const lines = health.failing.map((check) => {
    const parts = [`${check.kind === 'tests' ? 'Tests' : 'Build'} failing`, check.command, `${duration(Date.now() - check.ts)} ago`, check.owner || agentName(check.agentId)];
    return { tone: 'bad', icon: 'warning-diamond', agentId: check.agentId, text: parts.filter(Boolean).join(' · ') };
  });
  if (health.errors) lines.push({ tone: health.smoking ? 'bad' : 'muted', icon: 'bug', text: `${health.errors} tool error${health.errors > 1 ? 's' : ''} in the last hour` });
  for (const agentId of b.project.waitingIds || []) {
    const owner = state.workers.get(agentId)?.agent.owner;
    lines.push({ tone: 'wait', icon: 'circle-question', agentId, text: `${agentName(agentId)} is waiting on ${owner || 'you'}` });
  }
  return lines;
}

export function drawBuilding(b) {
  buildingClock = state.time + b.variety.clockOffset;
  const style = styleFor(b);
  // Same stack shares a look; a small per-project shift keeps neighbours apart.
  const wall = style.wall ? shade(style.wall, (b.seed % 31) - 15) : b.wall;
  const health = buildingHealth(b);
  const storefront = Boolean(b.project.profile && b.project.profile.ui);
  const wings = wingsFor(b);
  const main = wings[wings.length - 1];
  const tops = wings.map((wing) => drawWing(b, wing, wall, health, storefront, wing === main));
  const top = tops[tops.length - 1];

  rect(b.x - 7, b.y - 14, 14, 14, shade(wall, -55));
  rect(b.x - 5, b.y - 12, 10, 12, '#5a3a22');
  rect(b.x + 2, b.y - 7, 1, 2, '#ffcc33');
  const roofY = top - 4;
  const roofTop = drawRoof(b, style, main.x, roofY, main.w, wall);
  wings.forEach((wing, i) => {
    const flatRoof = wing !== main || style.roof === 'flat';
    if (flatRoof) drawRoofClutter(wing, tops[i] - 4, b.variety.roofClutter[i], wing === main);
  });
  if (health.quiet) wings.forEach((wing, i) => drawVines(wing, b.y, tops[i], b.seed + i));
  if (health.landmark) drawLandmark(main, top, roofTop, b.y);
  if (health.smoking) drawErrorSmoke(b.x, roofTop, health.heavySmoke);
  if (health.failing.length) drawAlarm(b, main, roofTop);

  const left = Math.min(...wings.map((wing) => wing.x)) - 1;
  const right = Math.max(...wings.map((wing) => wing.x + wing.w)) + 1;
  const hasBooth = (b.addons || []).some((addon) => addon.slot === 'door');
  drawYard(b, left, right, hasBooth);
  const mainHeight = (b.y - top) * b.variety.addonScale;
  // The landmark's beacon stands above the roof, so its label goes above the beacon.
  let highest = health.landmark ? roofTop - LANDMARK_MAST : roofTop;
  for (const addon of b.addons || []) {
    const feature = addon.feature;
    const slot = b.variety.mirrored ? MIRRORED_SLOT[addon.slot] || addon.slot : addon.slot;
    const live = health.live.has(feature);
    let addonTop = b.y;
    if (slot === 'roofLeft' || slot === 'roofRight') {
      const cx = slot === 'roofLeft' ? main.x + main.w * 0.25 : main.x + main.w * 0.75;
      const base = roofBaseAt(style, main.x, roofY, main.w, cx);
      addonTop = ROOF_ADDONS[feature](cx, base, live);
    } else if (slot === 'door') {
      drawGuardBooth(b, live);
    } else {
      const width = FEATURES[feature].width;
      const x0 = slot === 'left' ? left - 4 - width : right + 4;
      addonTop = SIDE_ADDONS[feature](x0, b.y, mainHeight, live, b);
    }
    highest = Math.min(highest, addonTop);
  }

  if (health.heavy) drawScaffolding(main.x, top, main.w);
  drawWorkbenches(b);
  b.labelY = Math.min(highest, health.heavy ? top - 44 : highest) - 6;
  b.hit = { x0: left, y0: roofTop, x1: right, y1: b.y };
}

function drawWing(b, wing, wall, health, storefront, isMain) {
  const { x, w, floors } = wing;
  const height = floors * FLOOR_H + 8;
  const top = b.y - height - b.bump * 2;
  const tick = Math.floor(buildingClock / 8);
  drawSunShadow(x, b.y, w, height + 12);
  rect(x + 4, b.y - 2, w, 6, 'rgba(0,0,0,.25)');
  rect(x, top, w, height, wall);
  rect(x + w - 8, top, 8, height, shade(wall, -35));
  rect(x, top, w, 2, shade(wall, 40));
  rect(x - 1, top, 1, height, OUTLINE);
  rect(x + w, top, 1, height, OUTLINE);
  rect(x - 1, b.y, w + 2, 1, OUTLINE);
  const windows = b.variety.windows;
  const columns = Math.max(1, Math.floor((w - 14 - windows.w) / windows.gap) + 1);
  const cracked = isMain && health.smoking ? `${b.seed % floors}|${b.seed % columns}` : '';
  for (let f = 0; f < floors; f++) {
    const fy = b.y - 8 - (f + 1) * FLOOR_H + 2;
    rect(x, fy + FLOOR_H - 2, w - 8, 1, shade(wall, -20));
    if (f === 0 && storefront) {
      drawStorefront(x, w, fy, health.live.has('ui'));
      continue;
    }
    for (let i = 0; i < columns; i++) {
      const wx = x + 5 + i * windows.gap;
      if (`${f}|${i}` === cracked) {
        drawCrackedWindow(wx, fy);
        continue;
      }
      const roll = (hash(`${b.name}|${x}|${f}|${i}|${tick}`) % 100) / 100;
      const lit = !health.quiet && roll < (health.active ? 0.7 : 0.18) + daylight() * 0.15;
      const glass = health.landmark ? '#4d7ea8' : '#3a4a66';
      rect(wx, fy, windows.w, windows.h, lit ? '#ffe08a' : glass);
      rect(wx, fy, windows.w, 1, lit ? '#fff3c4' : '#58709a');
      if (lit) state.lights.push({ x: wx + windows.w / 2, y: fy + 3, r: 6 });
    }
  }
  rect(x - 2, top - 4, w + 4, 5, shade(wall, -45));
  return top;
}

// Water tanks, AC units, planters and vents on flat roofs. On the main roof they keep to the middle, clear of the add-ons.
function drawRoofClutter(wing, roofY, items, isMain) {
  for (const { kind, spot } of items) {
    const share = isMain ? 0.4 + spot * 0.2 : 0.15 + spot * 0.7;
    const cx = Math.round(wing.x + wing.w * share);
    ROOF_CLUTTER[kind](cx, roofY);
  }
}

function drawWaterTank(cx, y) {
  rect(cx - 4, y - 4, 1, 4, '#5c4a3a');
  rect(cx + 3, y - 4, 1, 4, '#5c4a3a');
  rect(cx - 5, y - 12, 10, 8, '#8a6a4a');
  rect(cx - 5, y - 9, 10, 1, '#6b4f36');
  rect(cx + 2, y - 12, 3, 8, '#6b4f36');
  rect(cx - 4, y - 14, 8, 2, '#6b4f36');
}

function drawAcUnit(cx, y) {
  rect(cx - 5, y - 6, 10, 6, '#c3c8cf');
  rect(cx + 2, y - 6, 3, 6, '#a3aab3');
  rect(cx - 3, y - 5, 4, 4, '#5c6672');
  const blade = Math.floor(buildingClock * 10) % 2;
  rect(cx - 2 + blade, y - 4, 2 - blade, 2, '#c3c8cf');
}

function drawPlanter(cx, y) {
  rect(cx - 3, y - 3, 6, 3, '#8a5a32');
  rect(cx - 3, y - 6, 6, 3, '#4f9a45');
  rect(cx - 1, y - 8, 2, 2, '#6fbf5a');
}

function drawVent(cx, y) {
  rect(cx - 1, y - 7, 3, 7, '#9aa4b2');
  rect(cx - 2, y - 9, 5, 2, '#7d8794');
}

// A bush, flower box, bike or mailbox in front of the building, never on the door or the guard booth.
function drawYard(b, left, right, hasBooth) {
  for (const { kind, spot } of b.variety.yard) {
    const onRight = spot >= 0.5 && !hasBooth;
    const share = (spot % 0.5) * 2;
    const x = onRight ? b.x + 13 + share * (right - b.x - 22) : left + 6 + share * (b.x - left - 22);
    YARD_ITEMS[kind](Math.round(x), b.y);
  }
}

function drawBush(x, groundY) {
  ctx.fillStyle = '#3f7a3a';
  ctx.beginPath();
  ctx.ellipse(x, groundY - 3, 5, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  rect(x - 2, groundY - 6, 2, 2, '#6fbf5a');
}

function drawFlowerBox(x, groundY) {
  rect(x - 5, groundY - 3, 10, 3, '#8a5a32');
  const petals = ['#f2c94c', '#e86f9c', '#f4e9c9', '#9b7bff'];
  for (let i = 0; i < 4; i++) rect(x - 4 + i * 2.5, groundY - 5, 2, 2, petals[(i + x) % petals.length]);
}

function drawBike(x, groundY) {
  ctx.strokeStyle = '#2b2b38';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x - 3, groundY - 3, 2.5, 0, Math.PI * 2);
  ctx.moveTo(x + 5.5, groundY - 3);
  ctx.arc(x + 3, groundY - 3, 2.5, 0, Math.PI * 2);
  ctx.moveTo(x - 3, groundY - 3);
  ctx.lineTo(x, groundY - 6);
  ctx.lineTo(x + 3, groundY - 3);
  ctx.stroke();
  rect(x - 1, groundY - 7, 3, 1, '#c96b4b');
}

function drawMailbox(x, groundY) {
  rect(x, groundY - 6, 1, 6, '#5c4a3a');
  rect(x - 2, groundY - 9, 5, 4, '#3b6ea5');
  rect(x + 3, groundY - 9, 1, 2, '#f2c94c');
}

const ROOF_CLUTTER = [drawWaterTank, drawAcUnit, drawPlanter, drawVent];
const YARD_ITEMS = [drawBush, drawFlowerBox, drawBike, drawMailbox];

// Glass shop front on the ground floor of projects with a user interface; it lights up while screens are edited.
function drawStorefront(x, w, fy, live) {
  rect(x + 2, fy - 2, w - 12, 9, '#2c3e50');
  const glass = live ? '#c9f6ff' : '#7fc8d8';
  for (let gx = x + 3; gx + 8 <= x + w - 10; gx += 9) {
    rect(gx, fy - 1, 8, 7, glass);
    rect(gx, fy - 1, 2, 7, 'rgba(255,255,255,.35)');
  }
  if (live) {
    const sweep = (buildingClock * 40) % Math.max(1, w - 16);
    rect(x + 4 + sweep, fy, 2, 5, '#ffffff');
    state.lights.push({ x: x + w / 2 - 4, y: fy + 3, r: w / 3 });
  } else if (daylight() < 0.5) {
    state.lights.push({ x: x + w / 2 - 4, y: fy + 3, r: 10 });
  }
}

function drawCrackedWindow(wx, fy) {
  rect(wx, fy, 8, 6, '#1a1f2b');
  rect(wx + 2, fy + 1, 1, 2, '#cfd6e0');
  rect(wx + 3, fy + 3, 1, 1, '#cfd6e0');
  rect(wx + 4, fy + 2, 2, 1, '#cfd6e0');
  rect(wx + 5, fy + 4, 1, 1, '#cfd6e0');
}

function drawErrorSmoke(cx, y, heavy) {
  const puffs = heavy ? 9 : 5;
  const reach = heavy ? 50 : 34;
  for (let i = 0; i < puffs; i++) {
    const t = (buildingClock * 0.35 + i / puffs) % 1;
    ctx.fillStyle = `rgba(55, 55, 65, ${(heavy ? 0.7 : 0.55) * (1 - t)})`;
    ctx.beginPath();
    ctx.arc(cx + Math.sin(t * 5 + i) * 4 + t * 8, y - 2 - t * reach, 3 + t * (heavy ? 10 : 7), 0, Math.PI * 2);
    ctx.fill();
  }
}

// A failing build or test run: a warning sign by the door and a flashing red light on the roof, until a run passes.
function drawAlarm(b, main, roofTop) {
  const flash = Math.floor(buildingClock * 3) % 2 === 0;
  // Left of the door: the security booth, when there is one, takes the right.
  const sx = b.x - 16;
  rect(sx, b.y - 9, 1, 9, '#5a3a22');
  ctx.fillStyle = '#ffcc33';
  ctx.beginPath();
  ctx.moveTo(sx + 0.5, b.y - 19);
  ctx.lineTo(sx + 6, b.y - 9);
  ctx.lineTo(sx - 5, b.y - 9);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#c62828';
  ctx.lineWidth = 1;
  ctx.stroke();
  rect(sx, b.y - 16, 1, 4, '#1b1428');
  rect(sx, b.y - 11, 1, 1, '#1b1428');
  const lx = main.x + 6;
  rect(lx - 1, roofTop - 2, 8, 3, '#3a3a44');
  rect(lx, roofTop - 7, 6, 5, flash ? '#ff3b3b' : '#7a1d1d');
  rect(lx + 1, roofTop - 6, 2, 1, flash ? '#ffc4c4' : '#a33');
  if (flash) state.lights.push({ x: lx + 3, y: roofTop - 5, r: 14 });
}

// The most complex project in town: a glass front, a gold cornice and a beacon on a mast.
function drawLandmark(main, top, roofTop, groundY) {
  ctx.fillStyle = 'rgba(190, 230, 255, 0.16)';
  for (const share of [0.15, 0.55]) {
    const x0 = main.x + main.w * share;
    ctx.beginPath();
    ctx.moveTo(x0, top + 2);
    ctx.lineTo(x0 + 10, top + 2);
    ctx.lineTo(x0 - 6, groundY - 2);
    ctx.lineTo(x0 - 16, groundY - 2);
    ctx.closePath();
    ctx.fill();
  }
  rect(main.x - 3, top - 6, main.w + 6, 3, '#ffd75e');
  rect(main.x - 3, top - 3, main.w + 6, 1, '#b8860b');
  const mx = Math.round(main.x + main.w / 2);
  rect(mx, roofTop - 18, 1, 16, '#9aa3ad');
  rect(mx - 2, roofTop - 6, 5, 1, '#9aa3ad');
  const blink = Math.floor(buildingClock * 1.5) % 2 === 0;
  rect(mx - 1, roofTop - 21, 3, 3, blink ? '#ff5a5a' : '#ffd0d0');
  if (blink) state.lights.push({ x: mx, y: roofTop - 20, r: 9 });
}

function drawVines(wing, groundY, top, seed) {
  const reachLimit = Math.max(8, Math.min(60, groundY - top - 4));
  for (let i = 0; i < Math.ceil(wing.w / 16); i++) {
    const vx = wing.x + 2 + (hash(`${seed}|vine|${i}`) % Math.max(1, wing.w - 12));
    const reach = 8 + (hash(`${seed}|reach|${i}`) % reachLimit);
    for (let y = 0; y < reach; y += 3) {
      const wobble = Math.round(Math.sin((y + i * 7) * 0.5));
      rect(vx + wobble, groundY - y - 3, 2, 3, y % 6 ? '#3f7a3a' : '#5fa24f');
      if (y % 9 === 0) rect(vx + wobble + 2, groundY - y - 2, 2, 2, '#6fbf5a');
    }
  }
}

function drawScaffolding(x, top, w) {
  ctx.strokeStyle = '#d9a441';
  ctx.lineWidth = 1;
  for (let sx = x - 4; sx <= x + w + 4; sx += 26) {
    ctx.beginPath();
    ctx.moveTo(sx, top - 4);
    ctx.lineTo(sx, top + 2 * FLOOR_H);
    ctx.stroke();
  }
  const mastX = x + 14;
  rect(mastX, top - 40, 3, 36, '#f2b62c');
  rect(mastX - 12, top - 40, 46, 3, '#f2b62c');
  rect(mastX - 10, top - 38, 6, 5, '#555');
  const swing = Math.sin(buildingClock * 1.4) * 4;
  const hookX = mastX + 26 + swing;
  ctx.strokeStyle = '#222';
  ctx.beginPath();
  ctx.moveTo(mastX + 26, top - 37);
  ctx.lineTo(hookX, top - 18);
  ctx.stroke();
  rect(hookX - 3, top - 18, 6, 4, '#c96b4b');
}

function drawWorkbenches(b) {
  const crew = state.data.agents.filter((a) => siteOf(a) === b.name && ['working', 'overworked', 'stuck'].includes(a.status)).length;
  for (let i = 0; i < Math.min(crew, 5); i++) {
    const bx = b.x - 40 + i * 20;
    const by = b.y + 10;
    rect(bx - 7, by, 14, 5, '#8a5a32');
    rect(bx - 6, by + 5, 2, 3, '#5a3a22');
    rect(bx + 4, by + 5, 2, 3, '#5a3a22');
    rect(bx - 4, by - 6, 8, 6, '#222');
    const glow = (Math.floor(buildingClock * 4) + i) % 3;
    rect(bx - 3, by - 5, 6, 4, '#123');
    rect(bx - 3, by - 5 + glow, 3 + glow, 1, '#7ee07e');
    state.lights.push({ x: bx, y: by - 3, r: 4 });
  }
}

// Height of the roof surface at px, so roof add-ons sit on the slope or dome instead of floating.
function roofBaseAt(style, x, y, w, px) {
  const offset = Math.abs(px - (x + w / 2));
  if (style.roof === 'gable') return y + 1 - 19 * Math.max(0, 1 - offset / (w / 2 + 4));
  if (style.roof === 'dome' && offset < w / 3) return y + 1 - 16 * Math.sqrt(1 - (offset / (w / 3)) ** 2);
  if (style.roof === 'twin' && offset > w / 2 - 26 && offset < w / 2 - 4) return y - 14;
  return y;
}

// ---- roof add-ons: (centre x, roof y, live) → top y ----
function drawDish(cx, base, live) {
  rect(cx - 1, base - 5, 2, 5, '#7d8794');
  const facing = live ? Math.cos(buildingClock * 4) : 0.85;
  ctx.fillStyle = '#e8edf3';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(cx, base - 9, Math.max(1.5, 7 * Math.abs(facing)), 5, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  rect(cx + 1, base - 13, 1, 4, '#7d8794');
  rect(cx + 1, base - 15, 2, 2, live ? SIGNAL : '#c9a227');
  if (live) {
    drawSignalArcs(cx + 2, base - 14, 1.5, 0.9);
    state.lights.push({ x: cx, y: base - 10, r: 10 });
  }
  return base - 16;
}

function drawAiDome(cx, base, live) {
  const pulse = 0.5 + 0.5 * Math.sin(buildingClock * (live ? 5 : 1.5));
  rect(cx - 8, base - 2, 16, 2, '#4a4a5a');
  ctx.fillStyle = 'rgba(170, 150, 255, .55)';
  ctx.strokeStyle = OUTLINE;
  ctx.beginPath();
  ctx.ellipse(cx, base - 2, 7, 8, 0, Math.PI, 0);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = `rgba(215, 190, 255, ${0.5 + 0.5 * pulse})`;
  ctx.beginPath();
  ctx.arc(cx, base - 5, 2 + pulse * 1.5, 0, Math.PI * 2);
  ctx.fill();
  rect(cx - 4, base - 8, 2, 2, 'rgba(255,255,255,.7)');
  state.lights.push({ x: cx, y: base - 5, r: live ? 12 : 6 });
  if (live) {
    for (let k = 0; k < 3; k++) rect(cx + Math.sin(buildingClock * 3 + k * 2) * 9, base - 6 + Math.cos(buildingClock * 3 + k * 2) * 5, 1, 1, '#ffffff');
  }
  return base - 11;
}

function drawCiFlag(cx, base, live) {
  rect(cx, base - 16, 1, 16, '#cfd6e0');
  const color = live ? '#7ee07e' : '#5b8def';
  for (let i = 0; i < 4; i++) {
    const wave = Math.round(Math.sin(buildingClock * (live ? 8 : 3) + i));
    rect(cx + 1 + i * 2, base - 16 + wave, 2, 5, color);
  }
  return base - 17;
}

// ---- side add-ons: (left x, ground y, main building height, live, building) → top y ----
function drawSilo(x0, groundY, buildingHeight, live) {
  const h = Math.max(22, Math.min(56, buildingHeight * 0.6));
  const top = groundY - h;
  rect(x0 + 3, groundY - 2, 16, 4, 'rgba(0,0,0,.25)');
  rect(x0, top, 16, h, '#b9c3cf');
  rect(x0 + 11, top, 5, h, '#8d98a6');
  rect(x0 + 2, top, 2, h, '#dfe5ec');
  const bands = Math.floor((h - 4) / 7);
  const flowing = Math.floor(buildingClock * 6) % 3;
  for (let k = 0; k < bands; k++) {
    const lit = live && k % 3 === flowing;
    rect(x0, groundY - 4 - k * 7, 16, 1, lit ? SIGNAL : '#7a8594');
  }
  ctx.fillStyle = '#a7b2bf';
  ctx.beginPath();
  ctx.ellipse(x0 + 8, top, 8, 4, 0, Math.PI, 0);
  ctx.fill();
  rect(x0 - 1, top, 1, h, OUTLINE);
  rect(x0 + 16, top, 1, h, OUTLINE);
  rect(x0 + 13, top + 2, 1, h - 2, '#5c6672');
  if (live) state.lights.push({ x: x0 + 8, y: top + h / 2, r: 12 });
  return top - 4;
}

function drawMast(x0, groundY, buildingHeight, live, b) {
  const cx = x0 + 6;
  const h = Math.max(34, Math.min(90, buildingHeight * 0.9 + 10));
  const top = groundY - h;
  ctx.strokeStyle = '#9aa4b2';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 5, groundY);
  ctx.lineTo(cx - 1, top);
  ctx.moveTo(cx + 5, groundY);
  ctx.lineTo(cx + 1, top);
  for (let y = groundY; y > top + 8; y -= 8) {
    const spread = 1 + (4 * (y - top)) / h;
    ctx.moveTo(cx - spread, y);
    ctx.lineTo(cx + spread * 0.8, y - 8);
  }
  ctx.stroke();
  const blink = Math.floor(buildingClock * 1.5) % 2 === 0;
  rect(cx - 2, top - 3, 4, 3, blink ? '#ffd27a' : '#6b5a3a');
  if (blink) state.lights.push({ x: cx, y: top - 2, r: 7 });
  if (live) drawSignalArcs(cx, top - 2, 1.2, 0.9);
  else if (b.project.active > 0) drawSignalArcs(cx, top - 2, 0.5, 0.3);
  return top - 6;
}

function drawSignalArcs(cx, cy, speed, strength) {
  ctx.lineWidth = 1;
  for (let k = 0; k < 3; k++) {
    const t = (buildingClock * speed + k / 3) % 1;
    ctx.strokeStyle = `rgba(126, 224, 255, ${strength * (1 - t)})`;
    const r = 3 + t * 14;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -0.6, 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI - 0.6, Math.PI + 0.6);
    ctx.stroke();
  }
}

function drawClockTower(x0, groundY, buildingHeight, live) {
  const cx = x0 + 7;
  const h = Math.max(30, Math.min(70, buildingHeight * 0.75));
  const top = groundY - h;
  rect(x0, top, 14, h, '#c9b48a');
  rect(x0 + 10, top, 4, h, '#a8946c');
  rect(x0 - 1, top, 1, h, OUTLINE);
  rect(x0 + 14, top, 1, h, OUTLINE);
  ctx.fillStyle = '#6b4a3a';
  ctx.beginPath();
  ctx.moveTo(x0 - 2, top);
  ctx.lineTo(cx, top - 12);
  ctx.lineTo(x0 + 16, top);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = live ? '#fff7d6' : '#f4ead0';
  ctx.strokeStyle = OUTLINE;
  ctx.beginPath();
  ctx.arc(cx, top + 8, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const hour = currentHour();
  const hourAngle = ((hour % 12) / 12) * Math.PI * 2 - Math.PI / 2;
  const minuteAngle = (hour % 1) * Math.PI * 2 - Math.PI / 2;
  ctx.strokeStyle = '#2b1d14';
  ctx.beginPath();
  ctx.moveTo(cx, top + 8);
  ctx.lineTo(cx + Math.cos(hourAngle) * 2.5, top + 8 + Math.sin(hourAngle) * 2.5);
  ctx.moveTo(cx, top + 8);
  ctx.lineTo(cx + Math.cos(minuteAngle) * 4, top + 8 + Math.sin(minuteAngle) * 4);
  ctx.stroke();
  for (let y = top + 18; y < groundY - 6; y += 10) rect(cx - 1, y, 2, 4, '#3a4a66');
  if (live || daylight() < 0.5) state.lights.push({ x: cx, y: top + 8, r: live ? 12 : 8 });
  return top - 12;
}

function drawContainers(x0, groundY, buildingHeight, live, b) {
  const colors = ['#2f8f9d', '#d9822b', '#5b8def', '#8a5ab0'];
  drawContainer(x0, groundY - 8, 22, colors[b.seed % 4]);
  drawContainer(x0 + 3, groundY - 16, 18, colors[(b.seed + 1) % 4]);
  const blink = live && Math.floor(buildingClock * 4) % 2 === 0;
  rect(x0 + 11, groundY - 18, 2, 2, blink ? SIGNAL : '#3a4a66');
  if (blink) state.lights.push({ x: x0 + 12, y: groundY - 17, r: 6 });
  return groundY - 18;
}

function drawContainer(x, y, w, color) {
  rect(x, y, w, 8, color);
  rect(x, y, w, 1, shade(color, 30));
  for (let rx = x + 2; rx < x + w - 1; rx += 3) rect(rx, y + 1, 1, 6, shade(color, -25));
  rect(x - 1, y, 1, 8, OUTLINE);
  rect(x + w, y, 1, 8, OUTLINE);
}

function drawLab(x0, groundY, buildingHeight, live) {
  rect(x0, groundY - 14, 18, 14, '#d8dfe6');
  rect(x0 + 14, groundY - 14, 4, 14, '#b4bdc7');
  rect(x0 - 1, groundY - 16, 20, 2, '#6a7480');
  rect(x0 - 1, groundY - 14, 1, 14, OUTLINE);
  rect(x0 + 18, groundY - 14, 1, 14, OUTLINE);
  rect(x0 + 3, groundY - 11, 5, 5, '#3a4a66');
  rect(x0 + 10, groundY - 12, 2, 3, '#7ee07e');
  rect(x0 + 9, groundY - 9, 4, 3, '#7ee07e');
  rect(x0 + 12, groundY - 22, 2, 6, '#9aa4b2');
  if (!live) return groundY - 24;
  for (let k = 0; k < 3; k++) {
    const t = (buildingClock * 0.8 + k / 3) % 1;
    rect(x0 + 12 + Math.sin(t * 6 + k) * 2, groundY - 24 - t * 14, 2, 2, `rgba(126, 224, 126, ${1 - t})`);
  }
  state.lights.push({ x: x0 + 11, y: groundY - 10, r: 8 });
  return groundY - 38;
}

// Guard booth by the door for projects with login or security; its barrier lifts while auth code is edited.
function drawGuardBooth(b, live) {
  const x0 = b.x + 10;
  const groundY = b.y;
  rect(x0, groundY - 12, 10, 12, '#e3e6ea');
  rect(x0 + 7, groundY - 12, 3, 12, '#c3c8cf');
  rect(x0 - 1, groundY - 14, 12, 2, '#3b4a5c');
  rect(x0 + 2, groundY - 9, 5, 4, live ? '#7ee07e' : '#7fc8d8');
  for (let i = 0; i < 8; i++) {
    const stripe = i % 2 ? '#222' : '#f2c94c';
    if (live) rect(x0 + 11 + i, groundY - 7 - i * 2, 2, 2, stripe);
    else rect(x0 + 11 + i * 2, groundY - 6, 2, 2, stripe);
  }
  if (!live) rect(x0 + 27, groundY - 5, 1, 5, '#555');
  rect(b.x - 13, groundY - 5, 3, 5, '#3b4a5c');
  rect(b.x - 19, groundY - 5, 3, 5, '#3b4a5c');
}

const ROOF_ADDONS = { api: drawDish, ai: drawAiDome, ci: drawCiFlag };
const SIDE_ADDONS = { db: drawSilo, messaging: drawMast, jobs: drawClockTower, containers: drawContainers, tests: drawLab };

function drawRoof(b, style, x, y, w, wall) {
  const dark = shade(wall, -60);
  if (style.roof === 'gable') {
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(x - 4, y + 1);
    ctx.lineTo(x + w / 2, y - 18);
    ctx.lineTo(x + w + 4, y + 1);
    ctx.closePath();
    ctx.fill();
    rect(x + w / 2 - 1, y - 18, 2, 19, shade(wall, -30));
    if (style.chimney) {
      rect(x + w - 26, y - 16, 8, 14, '#6b3a2a');
      rect(x + w - 27, y - 17, 10, 2, '#4a2a1f');
      for (let i = 0; i < 3; i++) {
        const t = (state.time * 0.5 + i / 3) % 1;
        ctx.fillStyle = `rgba(220,220,230,${0.45 * (1 - t)})`;
        ctx.beginPath();
        ctx.arc(x + w - 22 + Math.sin(t * 6 + i) * 3, y - 20 - t * 20, 2 + t * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return y - 18;
  }
  if (style.roof === 'dome') {
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + 1, w / 3, 16, 0, Math.PI, 0);
    ctx.fill();
    rect(x + w / 2 - 2, y - 21, 4, 6, '#f2c94c');
    return y - 21;
  }
  if (style.roof === 'spire') {
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(x + w / 2 - 10, y + 1);
    ctx.lineTo(x + w / 2, y - 26);
    ctx.lineTo(x + w / 2 + 10, y + 1);
    ctx.closePath();
    ctx.fill();
    return y - 26;
  }
  if (style.roof === 'antenna') {
    const ax = x + w / 2 - 1;
    rect(ax, y - 22, 2, 22, '#cfd6e0');
    rect(ax - 6, y - 14, 14, 1, '#cfd6e0');
    const blink = Math.floor(state.time * 1.5) % 2 === 0;
    rect(ax - 1, y - 25, 4, 3, blink ? '#ff4a4a' : '#7a2020');
    if (blink) state.lights.push({ x: ax + 1, y: y - 24, r: 8 });
    return y - 25;
  }
  if (style.roof === 'twin') {
    rect(x + 4, y - 14, 18, 14, dark);
    rect(x + w - 26, y - 14, 18, 14, dark);
    rect(x + 8, y - 10, 4, 4, '#ffe08a');
    rect(x + w - 22, y - 10, 4, 4, '#ffe08a');
    return y - 14;
  }
  if (style.roof === 'awning') {
    for (let i = 0; i < 8; i++) rect(b.x - 24 + i * 6, b.y - 20, 6, 5, i % 2 ? '#f4e9c9' : '#c0392b');
  }
  return y;
}

// Labels are drawn in screen pixels, so they stay crisp and readable at any zoom (and across the room).
const STACK_STYLES = {
  java: { wall: '#b5523b', roof: 'gable', emblem: '☕', chimney: true },
  fullstack: { wall: '#7a5ab0', roof: 'twin', emblem: '⚙' },
  angular: { wall: '#c8384a', roof: 'spire', emblem: '▲' },
  node: { wall: '#3f8f4a', roof: 'antenna', emblem: '⬢' },
  python: { wall: '#3b6ea5', roof: 'dome', emblem: '🐍' },
  go: { wall: '#3fb6c8', roof: 'antenna', emblem: '◆' },
  rust: { wall: '#b0603a', roof: 'gable', emblem: '⚙', chimney: true },
  web: { wall: '#d47f9c', roof: 'awning', emblem: '✦' },
  misc: { wall: null, roof: 'flat', emblem: '' },
};

export function styleFor(building) {
  return STACK_STYLES[building.project.stack] || STACK_STYLES.misc;
}
