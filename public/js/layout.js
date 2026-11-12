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

// A clan's town grows as a grid of blocks around downtown, keeping roughly the shape of a screen.
// Each district is a block of 10 lots along its own two roads, with a small square in the middle.
// Blocks east of downtown have an avenue on their west side; blocks south of it share downtown's avenues.
export const DOWNTOWN_LOTS = BASE_LOTS.length;
export const DISTRICT_LOTS = 10;
export const DISTRICT_W = 56;
export const MAX_DISTRICTS = 8;
const BLOCK_H = MAP_H;
// [column, row] of each district in turn; downtown is [0, 0].
const GRID = [[1, 0], [0, 1], [1, 1], [2, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
const EAST_LOT_XS = [6, 17, 28, 39, 50];
// Below downtown, lots sit clear of its two avenues (columns 15 and 50).
const SOUTH_LOT_XS = [7, 25, 34, 43, 58];
const BLOCK_LOT_ROWS = [11, 41];
const BLOCK_ROAD_ROWS = [13, 43];
export const DISTRICTS = [];

function columnX(column) {
  return column === 0 ? 0 : MAP_W + (column - 1) * DISTRICT_W;
}

function gridSize() {
  const columns = Math.max(1, ...DISTRICTS.map((d) => d.column + 1));
  const rows = Math.max(1, ...DISTRICTS.map((d) => d.row + 1));
  return { columns, rows };
}

export function townWidth() {
  return columnX(gridSize().columns) * TILE;
}

export function townHeight() {
  return gridSize().rows * BLOCK_H * TILE;
}

// Every east-west road, in tile rows: two per row of blocks, running the full width of the town.
export function roadRows() {
  const rows = [];
  for (let row = 0; row < gridSize().rows; row++) rows.push(...BLOCK_ROAD_ROWS.map((r) => r + row * BLOCK_H));
  return rows;
}

// Downtown's two avenues, plus one on the west side of each column of blocks east of it.
export function roadColumns() {
  const east = Array.from({ length: gridSize().columns - 1 }, (_, i) => columnX(i + 1));
  return [...ROAD_COLUMNS, ...east];
}

// Grid cells inside the town that hold neither downtown nor a district.
export function emptyBlocks() {
  const { columns, rows } = gridSize();
  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const taken = (row === 0 && column === 0) || DISTRICTS.some((d) => d.column === column && d.row === row);
      if (!taken) cells.push({ x0: columnX(column), y0: row * BLOCK_H, w: column === 0 ? MAP_W : DISTRICT_W });
    }
  }
  return cells;
}

export function districtLots(index) {
  const first = DOWNTOWN_LOTS + index * DISTRICT_LOTS;
  return Array.from({ length: DISTRICT_LOTS }, (_, k) => first + k);
}

// Lays out one district per owner ('' for shared repos that overflow downtown). Returns whether anything moved.
export function setDistricts(owners) {
  if (owners.join('\n') === DISTRICTS.map((d) => d.owner).join('\n')) return false;
  DISTRICTS.length = 0;
  LOTS.length = DOWNTOWN_LOTS;
  LAYOUT.pads.length = DOWNTOWN_LOTS;
  LAYOUT.driveways.length = DOWNTOWN_LOTS;
  owners.slice(0, MAX_DISTRICTS).forEach((owner, index) => {
    const [column, row] = GRID[index];
    const x0 = columnX(column);
    const y0 = row * BLOCK_H;
    const w = column === 0 ? MAP_W : DISTRICT_W;
    const seed = hash(`${owner}|${index}`);
    DISTRICTS.push({ owner, column, row, x0, y0, w, seed, square: { x: (x0 + w / 2) * TILE, y: (y0 + 27) * TILE } });
    const xs = column === 0 ? SOUTH_LOT_XS : EAST_LOT_XS;
    for (const lotRow of BLOCK_LOT_ROWS) {
      xs.forEach((x, k) => {
        LOTS.push([x0 + x, y0 + lotRow]);
        LAYOUT.pads.push({ w: 104 + ((seed >>> k) % 20), h: 30 });
        LAYOUT.driveways.push(((seed >>> (k + 5)) & 1) === 1);
      });
    }
  });
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
