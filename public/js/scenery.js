// The static world: ground, roads, park, centrepiece, town edge, trees, rec center, review office,
// and in a clan's town the town hall and the districts east of downtown.
import { rainAmount, windFactor } from './ambient.js';
import { OUTLINE, canvas, ctx, rect, shade } from './canvas.js';
import { FOUNTAIN, MAP_W, PARK, TILE, WALLS } from './config.js';
import {
  DISTRICTS, FOOD_TRUCK, LAYOUT, LOTS, NAP_SLOTS, OFFICE, REC, emptyBlocks, roadColumns, roadRows, setDistricts, townHeight, townWidth,
} from './layout.js';
import { daylight, drawSunShadow } from './lighting.js';
import { reviewQueue } from './simulation.js';
import { state } from './state.js';
import { hash, pick, seeded } from './utils.js';

export const ground = document.createElement('canvas');
const SQUARE_HALF_W = 9 * TILE;
const SQUARE_HALF_H = 4 * TILE;

// Avenues run from the first east-west road to the last one.
function avenueSpan() {
  const rows = roadRows();
  return { top: rows[0] * TILE, bottom: (rows[rows.length - 1] + 2) * TILE };
}

export function paintGround() {
  ground.width = townWidth();
  ground.height = townHeight();
  const g = ground.getContext('2d');
  const rand = seeded(42);
  const widthTiles = ground.width / TILE;
  const heightTiles = ground.height / TILE;
  for (let ty = 0; ty < heightTiles; ty++) {
    for (let tx = 0; tx < widthTiles; tx++) {
      const grass = rand() < 0.5 ? '#5b9a48' : '#60a04c';
      g.fillStyle = grass;
      g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      if (rand() < 0.35) {
        g.fillStyle = '#7bbd5c';
        g.fillRect(tx * TILE + Math.floor(rand() * 12), ty * TILE + Math.floor(rand() * 12), 2, 3);
      }
      if (rand() < 0.04) {
        g.fillStyle = rand() < 0.5 ? '#f2e46b' : '#f08bb4';
        g.fillRect(tx * TILE + Math.floor(rand() * 13), ty * TILE + Math.floor(rand() * 13), 2, 2);
      }
    }
  }
  paintSidewalks(g);
  paintRoads(g);
  paintPark(g);
  paintDistrictSquares(g);
  paintLotPads(g);
  paintGroundDetails(g);
}

function paintRoads(g) {
  const { top: roadTop, bottom: roadBottom } = avenueSpan();
  const width = townWidth();
  const rows = roadRows();
  const columns = roadColumns();
  g.fillStyle = '#5c5a66';
  for (const row of rows) g.fillRect(0, row * TILE, width, 2 * TILE);
  for (const col of columns) g.fillRect(col * TILE, roadTop, 2 * TILE, roadBottom - roadTop - 2 * TILE);
  g.fillStyle = '#e8d77a';
  for (const row of rows) {
    for (let x = 0; x < width; x += 16) g.fillRect(x + 2, row * TILE + 15, 8, 2);
  }
  for (const col of columns) {
    for (let y = roadTop; y < roadBottom; y += 16) g.fillRect(col * TILE + 15, y + 2, 2, 8);
  }
  g.fillStyle = '#f4f4f4';
  for (const crosswalk of LAYOUT.crosswalks) {
    for (let k = 0; k < 6; k++) {
      if (crosswalk.horizontal) g.fillRect(crosswalk.along - 8, crosswalk.road * TILE + 3 + k * 5, 16, 3);
      else g.fillRect(crosswalk.road * TILE + 3 + k * 5, crosswalk.along - 8, 3, 16);
    }
  }
}

function paintSidewalks(g) {
  for (const walk of LAYOUT.sidewalks) {
    g.fillStyle = '#a9a5b0';
    g.fillRect(walk.x0, walk.y, walk.x1 - walk.x0, 4);
    g.fillStyle = '#8f8b97';
    for (let x = walk.x0; x < walk.x1; x += 8) g.fillRect(x, walk.y, 1, 4);
  }
}

// Height of the winding park path at x; it crosses the plaza at the centrepiece.
function windingPathY(x) {
  return FOUNTAIN.y + Math.sin((x - FOUNTAIN.x) / 45) * 26 * Math.sign(Math.cos(LAYOUT.windingPhase) || 1);
}

function paintPark(g) {
  const { x0, y0, x1, y1 } = PARK;
  g.fillStyle = '#69ab53';
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.fillStyle = '#d8c39a';
  g.fillRect(x0 + 8, y0 + 8, x1 - x0 - 16, 6);
  g.fillRect(x0 + 8, y1 - 14, x1 - x0 - 16, 6);
  g.fillRect(x0 + 8, y0 + 8, 6, y1 - y0 - 16);
  g.fillRect(x1 - 14, y0 + 8, 6, y1 - y0 - 16);
  const design = LAYOUT.parkDesign;
  if (design === 'cross') {
    g.fillRect(x0 + 8, FOUNTAIN.y - 3, x1 - x0 - 16, 6);
    g.fillRect(FOUNTAIN.x - 3, y0 + 8, 6, y1 - y0 - 16);
  } else if (design === 'diagonal') {
    g.strokeStyle = '#d8c39a';
    g.lineWidth = 6;
    g.beginPath();
    for (const [cx, cy] of [[x0 + 11, y0 + 11], [x1 - 11, y0 + 11], [x0 + 11, y1 - 11], [x1 - 11, y1 - 11]]) {
      g.moveTo(cx, cy);
      g.lineTo(FOUNTAIN.x, FOUNTAIN.y);
    }
    g.stroke();
  } else if (design === 'winding') {
    for (let x = x0 + 8; x < x1 - 8; x += 2) g.fillRect(x, windingPathY(x) - 3, 3, 6);
  }
  g.fillStyle = '#cbb588';
  g.beginPath();
  g.arc(FOUNTAIN.x, FOUNTAIN.y, 34, 0, Math.PI * 2);
  g.fill();
}

// Distance-based check so trees never grow on the park's paths, whichever design the town has.
function onParkPath(x, y) {
  const design = LAYOUT.parkDesign;
  if (design === 'cross') return Math.abs(x - FOUNTAIN.x) < 10 || Math.abs(y - FOUNTAIN.y) < 10;
  if (design === 'winding') return Math.abs(y - windingPathY(x)) < 14;
  if (design !== 'diagonal') return false;
  const corners = [[PARK.x0 + 11, PARK.y0 + 11], [PARK.x1 - 11, PARK.y0 + 11], [PARK.x0 + 11, PARK.y1 - 11], [PARK.x1 - 11, PARK.y1 - 11]];
  return corners.some(([cx, cy]) => distanceToSegment(x, y, cx, cy, FOUNTAIN.x, FOUNTAIN.y) < 12);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Each district's square: a lawn ringed by a path, with a paved circle for its flag in the middle.
function paintDistrictSquares(g) {
  for (const { square } of DISTRICTS) {
    const x0 = square.x - SQUARE_HALF_W;
    const y0 = square.y - SQUARE_HALF_H;
    g.fillStyle = '#69ab53';
    g.fillRect(x0, y0, SQUARE_HALF_W * 2, SQUARE_HALF_H * 2);
    g.fillStyle = '#d8c39a';
    g.fillRect(x0 + 6, y0 + 6, SQUARE_HALF_W * 2 - 12, 5);
    g.fillRect(x0 + 6, y0 + SQUARE_HALF_H * 2 - 11, SQUARE_HALF_W * 2 - 12, 5);
    g.fillRect(x0 + 6, y0 + 6, 5, SQUARE_HALF_H * 2 - 12);
    g.fillRect(x0 + SQUARE_HALF_W * 2 - 11, y0 + 6, 5, SQUARE_HALF_H * 2 - 12);
    g.fillRect(x0 + 6, square.y - 2, SQUARE_HALF_W * 2 - 12, 5);
    g.fillStyle = '#cbb588';
    g.beginPath();
    g.arc(square.x, square.y, 20, 0, Math.PI * 2);
    g.fill();
  }
}

function inDistrictSquare(x, y, margin) {
  return DISTRICTS.some(({ square }) => Math.abs(x - square.x) < SQUARE_HALF_W + margin && Math.abs(y - square.y) < SQUARE_HALF_H + margin);
}

function paintLotPads(g) {
  LOTS.forEach(([lx, ly], index) => {
    const pad = LAYOUT.pads[index];
    const centerX = lx * TILE;
    g.fillStyle = '#7a6448';
    g.fillRect(centerX - pad.w / 2, ly * TILE - 6, pad.w, pad.h);
    g.fillStyle = '#8a7456';
    g.fillRect(centerX - pad.w / 2 + 2, ly * TILE - 4, pad.w - 4, 4);
    if (!LAYOUT.driveways[index]) return;
    const padBottom = ly * TILE - 6 + pad.h;
    const roadTop = roadRows().map((row) => row * TILE).find((top) => top >= padBottom);
    if (roadTop === undefined) return;
    g.fillStyle = '#9a96a3';
    g.fillRect(centerX - 5, padBottom, 10, roadTop - padBottom);
  });
}

export const TREES = [];
export const BENCHES = [];
export const LAMPS = [];

// Trees scattered over part of a block (tile rows `top` to `top + span` of it), clear of roads and its square.
function plantTrees(rand, block, count, top, span) {
  const columns = roadColumns();
  const rows = roadRows();
  for (let placed = 0, tries = 0; placed < count && tries < count * 6; tries++) {
    const x = (block.x0 + 3 + rand() * (block.w - 6)) * TILE;
    const y = (block.y0 + top + rand() * span) * TILE;
    const onAvenue = columns.some((col) => x > col * TILE - 12 && x < (col + 2) * TILE + 12);
    const onRoad = rows.some((row) => y > row * TILE - 4 && y < (row + 2) * TILE + 16);
    if (onAvenue || onRoad || inDistrictSquare(x, y, 12)) continue;
    placed += 1;
    TREES.push({ x, y, r: 9 + rand() * 5, hue: rand(), district: true });
  }
}

// Trees, benches and lamps for the districts, and a wood in any empty block, rebuilt whenever they change.
function placeDistrictScenery() {
  for (const list of [TREES, BENCHES, LAMPS]) {
    const downtown = list.filter((item) => !item.district);
    list.splice(0, list.length, ...downtown);
  }
  for (const district of DISTRICTS) {
    const rand = seeded(district.seed || 1);
    const { square } = district;
    plantTrees(rand, district, 14, 16, 17);
    BENCHES.push({ x: square.x - 44, y: square.y + 16, district: true }, { x: square.x + 44, y: square.y + 16, district: true });
    LAMPS.push({ x: square.x - 30, y: square.y - 22, district: true }, { x: square.x + 30, y: square.y - 22, district: true });
  }
  emptyBlocks().forEach((block, index) => plantTrees(seeded(900 + index), block, 45, 1, 44));
}

// Lays out a clan's districts and repaints the ground when they change.
export function growTown(owners) {
  if (!setDistricts(owners)) return;
  paintGround();
  placeDistrictScenery();
}

export function drawDistrictFlag(district) {
  const { x, y } = district.square;
  const color = pick(WALLS, district.seed);
  rect(x - 1, y - 30, 2, 30, '#8f8a99');
  rect(x - 2, y - 32, 4, 2, '#d9a441');
  const wave = Math.round(Math.sin(state.time * 2 * windFactor() + district.seed) * 1.5);
  for (let i = 0; i < 4; i++) rect(x + 1 + i * 4, y - 29 + (i % 2 ? wave : 0), 4, 9, i % 2 ? shade(color, -20) : color);
  rect(x - 4, y - 2, 8, 3, '#7a7484');
}

export function placeScenery() {
  const rand = seeded(7);
  for (let i = 0; i < 26; i++) {
    const x = PARK.x0 + 24 + rand() * (PARK.x1 - PARK.x0 - 48);
    const y = PARK.y0 + 24 + rand() * (PARK.y1 - PARK.y0 - 40);
    const nearFountain = Math.hypot(x - FOUNTAIN.x, y - FOUNTAIN.y) < 70;
    const onPath = onParkPath(x, y);
    const nearOffice = x > OFFICE.x - 45 && x < OFFICE.x + 140 && y > OFFICE.y - 45 && y < OFFICE.y + 35;
    const nearRec = x > REC.x0 - 20 && x < REC.x1 + 20 && y > REC.y0 - 30 && y < REC.y1 + 25;
    const nearTruck = Math.abs(x - FOOD_TRUCK.x) < 34 && Math.abs(y - FOOD_TRUCK.y) < 30;
    if (!nearFountain && !onPath && !nearOffice && !nearRec && !nearTruck) TREES.push({ x, y, r: 9 + rand() * 5, hue: rand() });
  }
  for (const [x, y] of [[2, 4], [60, 4], [2, 37], [60, 37], [28, 2], [36, 44]]) {
    TREES.push({ x: x * TILE + 8, y: y * TILE + 8, r: 10, hue: 0.4 });
  }
  if (LAYOUT.edge === 'treeline') {
    const edgeRand = seeded(LAYOUT.treelineSeed);
    for (let x = 6; x < MAP_W * TILE; x += 20 + edgeRand() * 14) {
      TREES.push({ x, y: -6 - edgeRand() * 16, r: 9 + edgeRand() * 6, hue: edgeRand() });
    }
  }
  BENCHES.push({ x: FOUNTAIN.x - 60, y: FOUNTAIN.y - 18 }, { x: FOUNTAIN.x + 60, y: FOUNTAIN.y - 18 },
    { x: FOUNTAIN.x - 60, y: FOUNTAIN.y + 30 }, { x: FOUNTAIN.x + 60, y: FOUNTAIN.y + 30 });
  LAMPS.push({ x: FOUNTAIN.x - 40, y: FOUNTAIN.y - 40 }, { x: FOUNTAIN.x + 40, y: FOUNTAIN.y - 40 },
    { x: FOUNTAIN.x - 40, y: FOUNTAIN.y + 46 }, { x: FOUNTAIN.x + 40, y: FOUNTAIN.y + 46 },
    { x: 16 * TILE, y: 12.5 * TILE }, { x: 50 * TILE, y: 12.5 * TILE }, { x: 16 * TILE, y: 45.5 * TILE }, { x: 50 * TILE, y: 45.5 * TILE });
}

export const GRASS_PATTERN = (() => {
  const tile = document.createElement('canvas');
  tile.width = TILE * 4;
  tile.height = TILE * 4;
  const g = tile.getContext('2d');
  const rand = seeded(99);
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      g.fillStyle = rand() < 0.5 ? '#5b9a48' : '#60a04c';
      g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      if (rand() < 0.4) {
        g.fillStyle = '#7bbd5c';
        g.fillRect(tx * TILE + Math.floor(rand() * 12), ty * TILE + Math.floor(rand() * 12), 2, 3);
      }
    }
  }
  return ctx.createPattern(tile, 'repeat');
})();

export function drawCentrepiece() {
  if (LAYOUT.centrepiece === 'pond') drawPond(FOUNTAIN.x, FOUNTAIN.y, 25, 13);
  else if (LAYOUT.centrepiece === 'statue') drawStatue();
  else drawFountain();
}

function drawPond(x, y, rx, ry) {
  ctx.fillStyle = '#7a9a5a';
  ctx.beginPath();
  ctx.ellipse(x, y, rx + 3, ry + 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#4aa3df';
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3b8fcc';
  ctx.beginPath();
  ctx.ellipse(x + 2, y + 1, rx * 0.6, ry * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const [dx, dy, flower] of [[-0.6, -0.3, false], [0.5, 0.35, true], [0.2, -0.55, false]]) {
    rect(x + dx * rx - 2, y + dy * ry - 1, 4, 2, '#4f9a45');
    if (flower) rect(x + dx * rx, y + dy * ry - 2, 2, 1, '#f08bb4');
  }
  for (let i = 0; i < 2; i++) {
    const angle = state.time * 0.25 + i * Math.PI;
    const dx = Math.cos(angle) * rx * 0.65;
    const dy = Math.sin(angle) * ry * 0.6;
    const facing = Math.sin(angle) > 0 ? -1 : 1;
    rect(x + dx - 2, y + dy - 2, 5, 3, i ? '#8a5a32' : '#f4f4f4');
    rect(x + dx + facing * 2, y + dy - 4, 2, 2, i ? '#2f6b2a' : '#f4f4f4');
    rect(x + dx + facing * 4, y + dy - 3, 1, 1, '#f2a03c');
  }
  // Reeds on the rim, swaying with the day's wind.
  for (let i = 0; i < 4; i++) {
    const rx2 = x - rx + 2 + i * 3;
    const sway = Math.round(Math.sin(state.time * windFactor() + i));
    rect(rx2 + sway, y - 6, 1, 6, '#3f7a3a');
    rect(rx2 + sway, y - 7, 1, 2, '#8a5a32');
  }
}

// A golden agent on a stone plinth, wrench raised.
function drawStatue() {
  const { x, y } = FOUNTAIN;
  for (const [dx, dy] of [[-22, -6], [18, -6], [-22, 8], [18, 8]]) {
    rect(x + dx, y + dy, 5, 3, '#4f9a45');
    rect(x + dx + 1, y + dy - 1, 1, 1, '#f2e46b');
    rect(x + dx + 3, y + dy - 1, 1, 1, '#f08bb4');
  }
  rect(x - 9, y - 4, 18, 8, '#8f8a99');
  rect(x - 9, y - 4, 18, 2, '#b0aab8');
  rect(x - 7, y - 8, 14, 4, '#a39eac');
  const gold = '#d9a441';
  rect(x - 3, y - 14, 2, 6, shade(gold, -30));
  rect(x + 1, y - 14, 2, 6, shade(gold, -30));
  rect(x - 3, y - 20, 6, 6, gold);
  rect(x - 2, y - 25, 4, 5, shade(gold, 20));
  rect(x + 3, y - 26, 1, 7, gold);
  rect(x + 2, y - 28, 3, 2, '#c0c4c9');
  rect(x - 4, y - 19, 1, 4, gold);
  if (daylight() > 0.4) state.lights.push({ x, y: y - 18, r: 14 });
}

// River, side pond or nothing along the town's edge; drawn at ground level under everything else.
export function drawTownEdge() {
  if (LAYOUT.edge === 'river') drawRiver();
  if (LAYOUT.edge === 'pond') drawPond(LAYOUT.edgeSide === 'left' ? 40 : MAP_W * TILE - 40, 532, 30, 16);
}

function drawRiver() {
  const center = MAP_W * TILE - 12;
  const top = -400;
  const bottom = townHeight() + 400;
  for (let y = top; y < bottom; y += 8) {
    const bend = Math.round(Math.sin(y / 60) * 3);
    rect(center - 13 + bend, y, 26, 8, '#c9b27a');
    rect(center - 11 + bend, y, 22, 8, '#3f8fcf');
    rect(center - 4 + bend, y, 8, 8, '#4aa3df');
  }
  for (let i = 0; i < 24; i++) {
    const y = top + ((i * 61 + state.time * 18) % (bottom - top));
    const bend = Math.round(Math.sin(y / 60) * 3);
    rect(center - 6 + ((i * 7) % 12) + bend, y, 2, 1, 'rgba(255,255,255,.6)');
  }
  for (const row of roadRows()) {
    const deckTop = row * TILE;
    rect(center - 16, deckTop - 2, 32, 2 * TILE + 4, '#8f8a99');
    rect(center - 16, deckTop, 32, 2 * TILE, '#5c5a66');
    rect(center - 16, deckTop - 2, 32, 1, '#b0aab8');
    rect(center - 16, deckTop + 2 * TILE + 1, 32, 1, '#b0aab8');
    for (let x = center - 14; x < center + 16; x += 16) rect(x, deckTop + 15, 8, 2, '#e8d77a');
  }
}

function drawFountain() {
  const { x, y } = FOUNTAIN;
  ctx.fillStyle = '#8f8a99';
  ctx.beginPath();
  ctx.ellipse(x, y, 22, 13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#4aa3df';
  ctx.beginPath();
  ctx.ellipse(x, y, 18, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  const ripple = (state.time * 6) % 10;
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(x, y, 4 + ripple, 2 + ripple / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  rect(x - 2, y - 14, 4, 12, '#b0aab8');
  for (let i = 0; i < 6; i++) {
    const t = (state.time * 1.5 + i / 6) % 1;
    const side = i % 2 ? 1 : -1;
    rect(x + side * t * 10, y - 16 + t * t * 14 - t * 6, 2, 2, '#bfe6ff');
  }
}

// The clan's town hall: one window per member, lit while they are online.
const TOWN_HALL_WINDOWS = 8;
export const TOWN_HALL = { x0: OFFICE.x - 36, x1: OFFICE.x + 36, y0: OFFICE.y - 58, y1: OFFICE.y + 4 };

export function drawTownHall() {
  const { x, y } = OFFICE;
  const members = state.data && state.data.clan ? state.data.clan.members.slice(0, TOWN_HALL_WINDOWS) : [];
  rect(x - 38, y - 1, 76, 6, 'rgba(0,0,0,.25)');
  rect(x - 36, y - 4, 72, 4, '#a39eac');
  rect(x - 32, y - 8, 64, 4, '#c0bac8');
  rect(x - 28, y - 36, 56, 28, '#ece4cf');
  rect(x + 22, y - 36, 6, 28, '#d8cfb6');
  for (const dx of [-24, -14, 10, 20]) {
    rect(dx + x, y - 34, 4, 26, '#fff8e6');
    rect(dx + x + 3, y - 34, 1, 26, '#d8cfb6');
  }
  rect(x - 6, y - 22, 12, 14, '#5a3a22');
  rect(x - 6, y - 24, 12, 2, '#3a2a1a');
  // A window per member above the door, lit while that member is online.
  const span = members.length * 6;
  members.forEach((member, i) => {
    const wx = x - span / 2 + i * 6 + 1;
    rect(wx, y - 32, 4, 5, member.online ? '#ffe08a' : '#3a4a66');
    if (member.online) state.lights.push({ x: wx + 2, y: y - 30, r: 8 });
  });
  ctx.fillStyle = '#d8cfb6';
  ctx.beginPath();
  ctx.moveTo(x - 32, y - 37);
  ctx.lineTo(x + 32, y - 37);
  ctx.lineTo(x, y - 50);
  ctx.closePath();
  ctx.fill();
  rect(x - 32, y - 38, 64, 2, '#b8ae94');
  rect(x - 3, y - 45, 6, 5, '#d9a441');
  rect(x - 1, y - 62, 1, 13, '#5a5466');
  const wave = Math.round(Math.sin(state.time * 2 * windFactor()) * 1);
  rect(x, y - 62, 5, 4, '#ffcc33');
  rect(x + 5, y - 61 + wave, 4, 4, '#f2b62c');
}

// An unused lot in a clan's town: a lawn with a low hedge and a few flowers.
export function drawGardenLot(x, y, pad) {
  const left = x - pad.w / 2;
  const top = y - 6;
  rect(left, top, pad.w, pad.h, '#69ab53');
  rect(left, top, pad.w, 3, '#3f7a3a');
  rect(left, top + pad.h - 3, pad.w, 3, '#3f7a3a');
  for (let i = 0; i < 6; i++) {
    const fx = left + 10 + ((i * 37) % (pad.w - 20));
    const fy = top + 8 + ((i * 11) % (pad.h - 16));
    rect(fx, fy, 2, 2, i % 2 ? '#f08bb4' : '#f2e46b');
  }
}

export function drawEmptyLot(x, y) {
  rect(x - 10, y - 18, 2, 18, '#6b4a2b');
  rect(x - 26, y - 30, 34, 13, '#e8dcb5');
  rect(x - 26, y - 30, 34, 1, '#6b4a2b');
  ctx.fillStyle = '#6b4a2b';
  ctx.font = '4px "Press Start 2P"';
  ctx.textAlign = 'center';
  ctx.fillText('FREE', x - 9, y - 24);
  ctx.fillText('PLOT', x - 9, y - 19);
}

// ---- ground details, painted once into the ground canvas ----
function isOpenGrass(x, y) {
  const span = avenueSpan();
  const onRoadRow = roadRows().some((row) => y > row * TILE - 4 && y < (row + 2) * TILE + 4);
  const onRoadColumn = roadColumns().some((col) => x > col * TILE - 4 && x < (col + 2) * TILE + 4) && y > span.top && y < span.bottom;
  const onLot = LOTS.some(([lx, ly]) => Math.abs(x - lx * TILE) < 64 && y > ly * TILE - 160 && y < ly * TILE + 28);
  const inPark = x > PARK.x0 - 4 && x < PARK.x1 + 4 && y > PARK.y0 - 4 && y < PARK.y1 + 4;
  return !onRoadRow && !onRoadColumn && !onLot && !inPark && !inDistrictSquare(x, y, 4);
}

function paintGroundDetails(g) {
  const rand = seeded(7331);
  const petals = ['#f2e46b', '#f08bb4', '#f4f4f4', '#9b7bff', '#ff9a5a'];
  const width = townWidth();
  const height = townHeight();
  const target = Math.round((90 * width * height) / (MAP_W * TILE * 46 * TILE));
  for (let placed = 0, tries = 0; placed < target && tries < target * 7; tries++) {
    const x = Math.floor(rand() * width);
    const y = Math.floor(rand() * height);
    const kind = rand();
    if (!isOpenGrass(x, y)) continue;
    placed += 1;
    if (kind < 0.45) {
      g.fillStyle = petals[Math.floor(rand() * petals.length)];
      for (let i = 0; i < 6; i++) g.fillRect(x + Math.floor(rand() * 10), y + Math.floor(rand() * 6), 2, 2);
    } else if (kind < 0.7) {
      g.fillStyle = '#8f8a99';
      g.fillRect(x, y, 4, 3);
      g.fillStyle = '#b0aab8';
      g.fillRect(x, y, 2, 1);
    } else {
      g.fillStyle = '#467f37';
      g.fillRect(x, y, 1, 4);
      g.fillRect(x + 2, y - 1, 1, 5);
      g.fillRect(x + 4, y + 1, 1, 3);
    }
  }
}

// Puddles sit on roads and park paths and dry out over about 20 minutes after a shower.
const PUDDLES = (() => {
  const rand = seeded(5150);
  const puddles = [];
  for (let i = 0; i < 8; i++) {
    const row = [13, 43][i % 2];
    puddles.push({ x: 40 + rand() * (MAP_W * TILE - 80), y: row * TILE + 6 + rand() * 20, r: 5 + rand() * 6 });
  }
  for (let i = 0; i < 4; i++) puddles.push({ x: PARK.x0 + 30 + rand() * (PARK.x1 - PARK.x0 - 60), y: PARK.y0 + 11, r: 4 + rand() * 4 });
  return puddles;
})();

export function drawPuddles() {
  if (rainAmount() > 0.2) state.lastRainTime = state.time;
  const since = state.time - (state.lastRainTime ?? -Infinity);
  const wetness = Math.max(0, 1 - since / 1200);
  if (wetness <= 0) return;
  for (const puddle of PUDDLES) {
    ctx.fillStyle = `rgba(90, 120, 160, ${0.45 * wetness})`;
    ctx.beginPath();
    ctx.ellipse(puddle.x, puddle.y, puddle.r * wetness + 2, (puddle.r * wetness + 2) / 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    rect(puddle.x - 2, puddle.y - 1, 2, 1, `rgba(255, 255, 255, ${0.5 * wetness})`);
  }
}

export function drawRecCenter() {
  const { x0, y0, x1, y1 } = REC;
  const width = x1 - x0;
  const height = y1 - y0;
  rect(x0 + 3, y1, width, 5, 'rgba(0,0,0,.2)');
  rect(x0, y0, width, height, '#c9a477');
  for (let y = y0 + 8; y < y1; y += 8) rect(x0, y, width, 1, '#b8936a');
  // low walls with a doorway facing the fountain
  rect(x0 - 3, y0 - 6, width + 6, 6, '#efe4c4');
  rect(x0 - 3, y0 - 6, width + 6, 1, OUTLINE);
  rect(x0 - 3, y0, 3, height, '#efe4c4');
  rect(x1, y0, 3, height, '#efe4c4');
  rect(x0 - 3, y1, 50, 3, '#efe4c4');
  rect(x0 + 75, y1, width - 72, 3, '#efe4c4');
  // ping-pong table
  rect(x0 + 28, y0 + 30, 36, 18, '#2f8f5b');
  rect(x0 + 28, y0 + 30, 36, 1, '#f4f4f4');
  rect(x0 + 28, y0 + 47, 36, 1, '#f4f4f4');
  rect(x0 + 45, y0 + 28, 2, 22, '#f4f4f4');
  // coffee bar
  rect(x0 + 104, y0 + 10, 50, 10, '#7a4a2a');
  rect(x0 + 104, y0 + 10, 50, 2, '#9a6a44');
  rect(x0 + 140, y0 + 2, 10, 9, '#3a3a44');
  rect(x0 + 142, y0 + 4, 3, 2, '#ff6a4a');
  for (let i = 0; i < 3; i++) rect(x0 + 110 + i * 8, y0 + 8, 3, 3, '#f4f4f4');
  // arcade cabinet
  rect(x0 + 140, y0 + 44, 14, 16, '#4a2a7a');
  rect(x0 + 142, y0 + 46, 10, 7, ['#4ad7ff', '#ff4ad7', '#7eff4a'][Math.floor(state.time * 2) % 3]);
  state.lights.push({ x: x0 + 147, y: y0 + 50, r: 10 });
  // sofas
  for (let i = 0; i < 3; i++) {
    rect(x0 + 15 + i * 16, y0 + 72, 14, 6, '#9a3b4a');
    rect(x0 + 15 + i * 16, y0 + 78, 14, 6, '#b84a5a');
  }
  rect(x0 + 24, y0 + 62, 30, 6, '#5a3a22');
  // nap pods
  for (const pod of NAP_SLOTS) {
    // A sleeper lies to the left of their slot point, so the capsule sits there.
    rect(pod.x - 18, pod.y - 9, 23, 12, '#dfe7f2');
    rect(pod.x - 16, pod.y - 7, 19, 8, '#9cc3e6');
  }
  state.lights.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: 50 });
}

// Things drawn over the people inside: the ping-pong ball and coffee steam.
export function drawRecOverlay() {
  const atSlot = (kind) => [...state.workers.values()].filter((w) => !w.moving && w.slot && w.slot.kind === kind);
  if (atSlot('pingpong').length >= 2) {
    const t = (state.time * 0.9) % 2;
    const k = t < 1 ? t : 2 - t;
    const x = REC.x0 + 26 + k * 40;
    const y = REC.y0 + 36 - Math.sin(k * Math.PI) * 10;
    rect(x, y, 2, 2, '#ffffff');
  }
  for (const drinker of atSlot('coffee')) {
    const t = (state.time * 0.8 + drinker.x) % 1;
    ctx.fillStyle = `rgba(240,240,250,${0.6 * (1 - t)})`;
    ctx.fillRect(Math.round(drinker.x + 3), Math.round(drinker.y - 16 - t * 8), 1, 2);
  }
}

export function drawOffice() {
  const x = OFFICE.x;
  const y = OFFICE.y;
  const queueLength = reviewQueue().length;
  rect(x - 26, y - 2, 56, 5, 'rgba(0,0,0,.25)');
  rect(x - 24, y - 26, 48, 26, '#e8dcb5');
  rect(x + 18, y - 26, 6, 26, '#cbbd96');
  rect(x - 28, y - 32, 56, 7, '#b5452f');
  rect(x - 26, y - 34, 52, 3, '#d0603f');
  rect(x - 5, y - 13, 10, 13, '#5a3a22');
  rect(x + 3, y - 7, 1, 2, '#ffcc33');
  rect(x - 19, y - 20, 9, 7, queueLength ? '#ffe08a' : '#3a4a66');
  rect(x + 8, y - 20, 9, 7, queueLength ? '#ffe08a' : '#3a4a66');
  if (queueLength) state.lights.push({ x, y: y - 16, r: 14 });
  for (let i = 0; i < 6; i++) rect(x + 33 + i * 13, y + 9, 7, 1, 'rgba(255,255,255,.35)');
}

const TREE_GREENS = ['#2f6b2a', '#3b7d31', '#4a8a3a', '#2d5e3a', '#56913c'];

export function drawTree(tree) {
  const sway = Math.sin(state.time * 0.8 * windFactor() + tree.x) * 0.6 * windFactor();
  drawSunShadow(tree.x - tree.r * 0.7, tree.y, tree.r * 1.4, tree.r * 2);
  rect(tree.x - 2, tree.y - 8, 4, 8, '#6b4a2b');
  ctx.fillStyle = 'rgba(0,0,0,.2)';
  ctx.beginPath();
  ctx.ellipse(tree.x + 2, tree.y, tree.r * 0.7, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  // Shape comes from the tree's position, so the park keeps the same mix of pines, round trees and bushy pairs.
  const shapeRoll = (hash(`${Math.round(tree.x)}|${Math.round(tree.y)}`) % 100) / 100;
  ctx.fillStyle = tree.hue > 0.93 ? '#c0862f' : TREE_GREENS[Math.floor(tree.hue * TREE_GREENS.length) % TREE_GREENS.length];
  if (shapeRoll < 0.25) {
    for (let tier = 0; tier < 3; tier++) {
      const halfWidth = tree.r * (1 - tier * 0.25);
      const baseY = tree.y - 6 - tier * tree.r * 0.55;
      ctx.beginPath();
      ctx.moveTo(tree.x - halfWidth + sway * tier, baseY);
      ctx.lineTo(tree.x + sway * (tier + 1), baseY - tree.r * 0.9);
      ctx.lineTo(tree.x + halfWidth + sway * tier, baseY);
      ctx.closePath();
      ctx.fill();
    }
    return;
  }
  ctx.beginPath();
  ctx.arc(tree.x + sway, tree.y - 8 - tree.r * 0.6, tree.r, 0, Math.PI * 2);
  if (shapeRoll > 0.75) ctx.arc(tree.x + sway + tree.r * 0.6, tree.y - 6 - tree.r * 0.3, tree.r * 0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.12)';
  ctx.beginPath();
  ctx.arc(tree.x + sway - tree.r * 0.3, tree.y - 10 - tree.r * 0.8, tree.r * 0.45, 0, Math.PI * 2);
  ctx.fill();
}

export function drawBench(bench) {
  rect(bench.x - 9, bench.y - 6, 18, 3, '#8a5a32');
  rect(bench.x - 9, bench.y - 2, 18, 2, '#a06a3c');
  rect(bench.x - 8, bench.y, 2, 3, '#3a2a1a');
  rect(bench.x + 6, bench.y, 2, 3, '#3a2a1a');
}

export function drawLamp(lamp) {
  rect(lamp.x - 1, lamp.y - 18, 2, 18, '#333');
  rect(lamp.x - 3, lamp.y - 21, 6, 4, daylight() > 0.2 ? '#ffe08a' : '#ccc');
  state.lights.push({ x: lamp.x, y: lamp.y - 19, r: 18 });
}
