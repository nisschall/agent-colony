// The world canvas and the drawing primitives everything else uses.

export const canvas = document.getElementById('world');
export const ctx = canvas.getContext('2d');
export const GLOW = (() => {
  const glow = document.createElement('canvas');
  glow.width = 64;
  glow.height = 64;
  const g = glow.getContext('2d');
  const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255, 210, 110, 0.9)');
  gradient.addColorStop(1, 'rgba(255, 210, 110, 0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 64, 64);
  return glow;
})();

export function rect(x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

export function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (n & 255) + amount));
  return `rgb(${r},${g},${b})`;
}

export const OUTLINE = 'rgba(20, 14, 30, .55)';
export const PERSON_OUTLINE = '#1d1630';
export function mixColor(a, b, amount) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const channel = (shift) => Math.round(((pa >> shift) & 255) * (1 - amount) + ((pb >> shift) & 255) * amount);
  return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
}

export function toScreen(m, x, y) {
  return { x: x * m.zoom + m.ox, y: y * m.zoom + m.oy };
}

export function pill(text, x, y, fontPx, color, background) {
  const ratio = window.devicePixelRatio || 1;
  ctx.font = `${Math.round(fontPx * ratio)}px VT323, monospace`;
  const padding = 5 * ratio;
  const width = ctx.measureText(text).width + padding * 2;
  const height = fontPx * ratio + 2 * ratio;
  ctx.fillStyle = background;
  ctx.fillRect(Math.round(x - width / 2), Math.round(y - height), Math.round(width), Math.round(height));
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(text, Math.round(x), Math.round(y));
  ctx.textBaseline = 'alphabetic';
}
