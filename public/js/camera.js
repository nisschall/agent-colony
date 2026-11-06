// The camera: canvas size, fitting the town on screen, and world/screen coordinates.
import { canvas } from './canvas.js';
import { MAP_H, MAP_W, PARAMS, TILE, WALLPAPER } from './config.js';
import { liteMode, state } from './state.js';

export function resize() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(innerWidth * ratio);
  canvas.height = Math.floor(innerHeight * ratio);
}

// The whole town including rooftops, kept clear of the menu bar, Dock and the corner panels.
const TOWN_BOX = { x0: 0, x1: MAP_W * TILE, y0: -50, y1: MAP_H * TILE };
const STATUS_BAR_CLEARANCE = 58;
const TOOLBAR_CLEARANCE = 64;

export function inset(side) {
  return Number(PARAMS.get(side)) || 0;
}

export function fitCamera() {
  if (!WALLPAPER) {
    state.camera.x = MAP_W * TILE / 2;
    state.camera.y = MAP_H * TILE / 2 - 20;
    const fit = Math.min(innerWidth / (MAP_W * TILE), innerHeight / (MAP_H * TILE)) * 1.15;
    state.camera.zoom = Math.max(0.6, Math.min(3, fit));
    return;
  }
  const top = inset('top') + STATUS_BAR_CLEARANCE;
  const bottom = inset('bottom') + (liteMode ? 16 : TOOLBAR_CLEARANCE);
  const left = inset('left') + 16;
  const right = inset('right') + 16;
  const availableWidth = innerWidth - left - right;
  const availableHeight = innerHeight - top - bottom;
  const zoom = Math.min(availableWidth / (TOWN_BOX.x1 - TOWN_BOX.x0), availableHeight / (TOWN_BOX.y1 - TOWN_BOX.y0));
  const centerX = (TOWN_BOX.x0 + TOWN_BOX.x1) / 2;
  const centerY = (TOWN_BOX.y0 + TOWN_BOX.y1) / 2;
  state.camera.zoom = zoom;
  state.camera.x = centerX - (left + availableWidth / 2 - innerWidth / 2) / zoom;
  state.camera.y = centerY - (top + availableHeight / 2 - innerHeight / 2) / zoom;
}

export function worldToScreenMatrix() {
  const ratio = window.devicePixelRatio || 1;
  const zoom = state.camera.zoom * ratio;
  return { zoom, ox: canvas.width / 2 - state.camera.x * zoom, oy: canvas.height / 2 - state.camera.y * zoom };
}

export function screenToWorld(sx, sy) {
  const ratio = window.devicePixelRatio || 1;
  const m = worldToScreenMatrix();
  return { x: (sx * ratio - m.ox) / m.zoom, y: (sy * ratio - m.oy) / m.zoom };
}
