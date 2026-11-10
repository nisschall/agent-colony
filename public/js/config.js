// Fixed settings: page parameters, map size, palettes and the town's base geometry.

// The server writes these into the page's <meta> tags each time it serves it.
export const API_TOKEN = document.querySelector('meta[name="colony-token"]').content;
// Set when a clan hub serves this page as that clan's shared town, instead of this Mac's own town.
export const CLAN_ID = document.querySelector('meta[name="colony-clan"]').content;
export const PARAMS = new URLSearchParams(location.search);
export const WALLPAPER = PARAMS.has('wallpaper');
export const WALLPAPER_FRAME_MS = 66;
export const TILE = 16;
export const MAP_W = 64;
export const MAP_H = 46;
export const FLOOR_H = 10;
export const BUILDING_W = 96;
export const MAX_FLOORS = 12;
export const WALK_SPEED = 26;
export const BUDGET_KEY = 'agentColony.budget';
export const NAMES = ['Ada', 'Bolt', 'Cog', 'Dot', 'Echo', 'Fizz', 'Gus', 'Hex', 'Ivy', 'Jinx', 'Kip', 'Lux', 'Moxie', 'Nib',
  'Oz', 'Pip', 'Quill', 'Rex', 'Sprocket', 'Tink', 'Uno', 'Vex', 'Wren', 'Zed', 'Byte', 'Gizmo', 'Nova', 'Rivet', 'Sable', 'Tally'];
export const SKINS = ['#f2c7a5', '#e0a982', '#c68b62', '#8d5a3b', '#f7d9bd'];
export const HAIRS = ['#2b1d14', '#5a3a1e', '#c9852e', '#e5d06a', '#1a1a1a', '#8a2f2f', '#d9d9d9'];
export const WALLS = ['#c96b4b', '#5b8fb0', '#d9a441', '#7a9e5a', '#9a6fb0', '#c0c4c9', '#b5765b', '#4f7f7a', '#d47f9c', '#8a8f5a', '#6f7fb8', '#c2a27a'];
export const CODE_GLYPHS = ['{}', '</>', 'fn', ';', '=>', '++', '[]', '#'];

export const ROAD_ROWS = [13, 43];
export const ROAD_COLUMNS = [15, 50];
export const PARK = { x0: 17 * TILE, y0: 16 * TILE, x1: 49 * TILE, y1: 33 * TILE };
export const FOUNTAIN = { x: 33 * TILE, y: 24.5 * TILE };
// 12 building lots before the layout shifts them: [tileX, tileY of the lot's ground line]
export const BASE_LOTS = [
  [6, 11], [19, 11], [32, 11], [45, 11], [56, 11],
  [6, 41], [19, 41], [32, 41], [45, 41], [56, 41],
  [6, 26], [56, 26],
];
export const LOT_ROWS = [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]];
export const MIN_LOT_GAP_TILES = 11;
export const PARK_DESIGNS = ['cross', 'diagonal', 'ring', 'winding'];
export const CENTREPIECES = ['fountain', 'pond', 'statue'];
export const TOWN_EDGES = [
  { kind: 'none', weight: 25 },
  { kind: 'river', weight: 30 },
  { kind: 'pond', weight: 25 },
  { kind: 'treeline', weight: 20 },
];
