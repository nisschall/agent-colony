// The town layout, generated from the seed the server keeps.
import { BASE_LOTS, CENTREPIECES, FOUNTAIN, LOT_ROWS, MAP_H, MAP_W, MIN_LOT_GAP_TILES, PARK, PARK_DESIGNS, ROAD_COLUMNS, ROAD_ROWS, TILE, TOWN_EDGES } from './config.js';
import { hash, seeded, weightedPick } from './utils.js';

// The town's layout comes from a seed the server keeps, so every screen shows the same town until you rebuild it.
export const LAYOUT_SEED = Number(document.querySelector('meta[name="colony-layout"]').content) || 1;
export const LAYOUT = makeLayout(LAYOUT_SEED);
export const LOTS = LAYOUT.lots;
export const FOOD_TRUCK = { x: PARK.x0 + 70, y: PARK.y1 - 22 };
export const OFFICE = LAYOUT.mirrored
  ? { x: FOUNTAIN.x + 110, y: PARK.y0 + 52 }
  : { x: FOUNTAIN.x - 110, y: PARK.y0 + 52 };
export const FOCUS_TIMEOUT_MS = 30 * 60 * 1000;
// Recreation center in the park: idle agents relax here, sleeping ones use the nap pods.
export const REC = LAYOUT.mirrored
  ? { x0: 2 * FOUNTAIN.x - 760, y0: 282, x1: 2 * FOUNTAIN.x - 600, y1: 382 }
  : { x0: 600, y0: 282, x1: 760, y1: 382 };

// How much of a lot's dirt pad would sit on a vertical road, so shifting a lot never makes that worse.
function padRoadOverlap(tileX, tileY) {
  const left = tileX * TILE - 56;
  const right = tileX * TILE + 56;
  const top = tileY * TILE - 6;
  const bottom = tileY * TILE + 24;
  const besideRoads = bottom > ROAD_ROWS[0] * TILE && top < (ROAD_ROWS[1] + 2) * TILE;
  if (!besideRoads) return 0;
  return ROAD_COLUMNS.reduce((sum, col) => sum + Math.max(0, Math.min(right, (col + 2) * TILE) - Math.max(left, col * TILE)), 0);
}

function makeLayout(seed) {
  const rand = seeded(seed);
  const edgeRoll = rand();
  const edge = weightedPick(TOWN_EDGES, edgeRoll).kind;
  const edgeSide = rand() < 0.5 ? 'left' : 'right';
  const lots = BASE_LOTS.map(([tx, ty], index) => {
    const middle = index >= 10;
    let dx = rand() * 2 - 1;
    const dy = middle ? Math.round(rand() * 2 - 1) : 0;
    if (padRoadOverlap(tx + dx, ty + dy) > padRoadOverlap(tx, ty)) dx = -dx;
    if (padRoadOverlap(tx + dx, ty + dy) > padRoadOverlap(tx, ty)) dx = 0;
    return [tx + dx, ty + dy];
  });
  for (const row of LOT_ROWS) {
    for (let i = 1; i < row.length; i++) {
      const previous = lots[row[i - 1]];
      const lot = lots[row[i]];
      lot[0] = Math.max(lot[0], previous[0] + MIN_LOT_GAP_TILES);
    }
  }
  // Keep the right-hand buildings (and their side add-ons) clear of a river on that edge.
  if (edge === 'river') {
    for (const lot of lots) lot[0] = Math.min(lot[0], 56);
  }
  const pads = lots.map(() => ({ w: 104 + Math.round(rand() * 20), h: 28 + Math.round(rand() * 4) }));
  const driveways = lots.map((_, index) => index < 10 && rand() < 0.6);
  const crosswalks = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => {
    const horizontal = rand() < 0.6;
    const roadIndex = Math.floor(rand() * 2);
    const along = horizontal ? 2 + rand() * (MAP_W - 4) : ROAD_ROWS[0] + 3 + rand() * (ROAD_ROWS[1] - ROAD_ROWS[0] - 5);
    return { horizontal, road: horizontal ? ROAD_ROWS[roadIndex] : ROAD_COLUMNS[roadIndex], along: along * TILE };
  });
  const sidewalks = Array.from({ length: 3 + Math.floor(rand() * 4) }, () => {
    const roadIndex = Math.floor(rand() * 2);
    const above = rand() < 0.5;
    const start = rand() * (MAP_W * TILE - 200);
    return { y: ROAD_ROWS[roadIndex] * TILE + (above ? -4 : 2 * TILE), x0: start, x1: start + 80 + rand() * 160 };
  });
  return {
    lots,
    pads,
    driveways,
    crosswalks,
    sidewalks,
    parkDesign: PARK_DESIGNS[Math.floor(rand() * PARK_DESIGNS.length)],
    centrepiece: CENTREPIECES[Math.floor(rand() * CENTREPIECES.length)],
    mirrored: rand() < 0.5,
    edge,
    edgeSide: edge === 'river' ? 'right' : edgeSide,
    windingPhase: rand() * Math.PI * 2,
    treelineSeed: Math.floor(rand() * 100000) + 1,
  };
}

// A clan's town is built to fit what is in it. Lots fill downtown's two rows, then streets added south of
// downtown one row at a time; a big clan's rows also run east of downtown, so the town keeps roughly the shape
// of a screen. Your own town is downtown only.
export const DOWNTOWN_LOTS = BASE_LOTS.length;
const DOWNTOWN_ROWS = [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]];
const LOTS_PER_GROUP = 5;
const GROUP_W = 56;
const STREET_H = 16;
const MAX_GROUPS = 3;
const MAX_ROWS = 12;
const TARGET_ASPECT = 1.6;
const EAST_LOT_XS = [6, 17, 28, 39, 50];
// Below downtown, lots sit clear of its two avenues (columns 15 and 50).
const SOUTH_LOT_XS = [7, 25, 34, 43, 58];
// `groups` of 5 lots across, `rows` of lots down, the lot indices in the order they fill, and where each
// member's run of buildings starts.
export const CITY = { groups: 1, rows: 2, order: [], signs: [] };

// The tile row a row of lots stands on; its road runs just below.
function lotRowY(row) {
  return row === 0 ? 11 : 41 + (row - 1) * STREET_H;
}

function groupX(group) {
  return group === 0 ? 0 : MAP_W + (group - 1) * GROUP_W;
}

export function cityGrown() {
  return CITY.groups > 1 || CITY.rows > 2;
}

export function townWidth() {
  return groupX(CITY.groups) * TILE;
}

export function townHeight() {
  return (MAP_H + (CITY.rows - 2) * STREET_H) * TILE;
}

// Every east-west road, in tile rows, each running the full width of the town.
export function roadRows() {
  return Array.from({ length: CITY.rows }, (_, row) => lotRowY(row) + 2);
}

// Downtown's two avenues, plus one on the west side of each group of lots east of it.
export function roadColumns() {
  const east = Array.from({ length: CITY.groups - 1 }, (_, i) => groupX(i + 1));
  return [...ROAD_COLUMNS, ...east];
}

// The east part of downtown's band between its two roads, where a wide town plants trees.
export function greenBelts() {
  return Array.from({ length: CITY.groups - 1 }, (_, i) => ({ x0: groupX(i + 1), y0: 0, w: GROUP_W }));
}

// The fewest rows and groups that hold `count` lots while staying closest to a screen's shape.
function citySize(count) {
  let best = null;
  for (let groups = 1; groups <= MAX_GROUPS; groups++) {
    const rows = Math.min(MAX_ROWS, Math.max(2, Math.ceil(count / (groups * LOTS_PER_GROUP))));
    const aspect = (MAP_W + (groups - 1) * GROUP_W) / (MAP_H + (rows - 2) * STREET_H);
    const short = rows * groups * LOTS_PER_GROUP < count ? 10 : 0;
    const score = Math.abs(Math.log(aspect / TARGET_ASPECT)) + short;
    if (!best || score < best.score) best = { groups, rows, score };
  }
  return best;
}

// Sizes a clan's town for `count` buildings and lists its lots in filling order. Returns whether it changed.
export function buildCity(count) {
  const { groups, rows } = citySize(count);
  if (CITY.order.length && groups === CITY.groups && rows === CITY.rows) return false;
  LOTS.length = DOWNTOWN_LOTS;
  LAYOUT.pads.length = DOWNTOWN_LOTS;
  LAYOUT.driveways.length = DOWNTOWN_LOTS;
  const order = [];
  for (let row = 0; row < rows; row++) {
    for (let group = 0; group < groups; group++) {
      if (group === 0 && row < 2) {
        order.push(...DOWNTOWN_ROWS[row]);
        continue;
      }
      const seed = hash(`${row}|${group}`);
      const xs = group === 0 ? SOUTH_LOT_XS : EAST_LOT_XS;
      xs.forEach((x, k) => {
        order.push(LOTS.length);
        LOTS.push([groupX(group) + x, lotRowY(row)]);
        LAYOUT.pads.push({ w: 104 + ((seed >>> k) % 20), h: 30 });
        LAYOUT.driveways.push(((seed >>> (k + 5)) & 1) === 1);
      });
    }
  }
  Object.assign(CITY, { groups, rows, order });
  return true;
}

export const REC_SLOTS = [
  { kind: 'pingpong', x: REC.x0 + 22, y: REC.y0 + 42, pose: 'wave', dir: 'right' },
  { kind: 'pingpong', x: REC.x0 + 70, y: REC.y0 + 42, pose: 'wave', dir: 'left' },
  { kind: 'sofa', x: REC.x0 + 22, y: REC.y0 + 86, pose: 'sit', dir: 'down' },
  { kind: 'coffee', x: REC.x0 + 116, y: REC.y0 + 34, pose: 'stand', dir: 'up' },
  { kind: 'arcade', x: REC.x0 + 146, y: REC.y0 + 66, pose: 'type', dir: 'up' },
  { kind: 'sofa', x: REC.x0 + 38, y: REC.y0 + 86, pose: 'sit', dir: 'down' },
  { kind: 'coffee', x: REC.x0 + 132, y: REC.y0 + 34, pose: 'stand', dir: 'up' },
  { kind: 'sofa', x: REC.x0 + 54, y: REC.y0 + 86, pose: 'sit', dir: 'down' },
];
export const NAP_SLOTS = [0, 1, 2].map((i) => ({ kind: 'nap', x: REC.x0 + 103 + i * 24, y: REC.y0 + 90, pose: 'sleep', dir: 'down' }));
export const YOU = {
  look: { name: 'YOU', skin: '#f2c7a5', hair: '#2b1d14', shirt: '#f2b62c', pants: '#2f3a56', family: 'you' },
  agent: { id: 'you', kind: 'you', status: 'working', stress: 0 },
  x: OFFICE.x, y: OFFICE.y + 8, target: null, phase: 0, revieweeId: null,
};
