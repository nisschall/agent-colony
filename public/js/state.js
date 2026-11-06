// Shared game state.
import { MAP_H, MAP_W, TILE, WALLPAPER } from './config.js';
import { readBudget } from './utils.js';

// Lite mode = slim HUD at ~15 fps. The wallpaper app turns it off while you are in work mode.
export let liteMode = WALLPAPER;

export function setLiteMode(value) {
  liteMode = value;
}

export const state = {
  data: null,
  workers: new Map(),
  buildings: new Map(),
  visitors: [],
  particles: [],
  floaters: [],
  selectedId: null,
  following: false,
  paused: false,
  speed: 1,
  camera: { x: MAP_W * TILE / 2, y: MAP_H * TILE / 2, zoom: 2 },
  hover: null,
  time: 0,
  seenEventKeys: new Set(),
  lights: [],
  budget: readBudget(),
  timeOverride: null,
  light: null,
  timePreset: 0,
};
