// Time of day: sky colour, sun shadows, mist and fireflies.
import { canvas, ctx, rect } from './canvas.js';
import { PARK } from './config.js';
import { state } from './state.js';

// Keyframes across the day: tint colour and strength laid over the town, and how dark it is (0 day … 1 night).
const SKY_KEYS = [
  { hour: 0, rgb: [18, 22, 64], alpha: 0.55, dark: 1, phase: 'Night', icon: 'moon' },
  { hour: 4.5, rgb: [18, 22, 64], alpha: 0.55, dark: 1, phase: 'Night', icon: 'moon' },
  { hour: 5.5, rgb: [70, 50, 110], alpha: 0.38, dark: 0.75, phase: 'Dawn', icon: 'cloud-moon' },
  { hour: 6.5, rgb: [255, 140, 100], alpha: 0.2, dark: 0.3, phase: 'Sunrise', icon: 'cloud-sun' },
  { hour: 8, rgb: [255, 225, 180], alpha: 0.07, dark: 0, phase: 'Morning', icon: 'cloud-sun' },
  { hour: 12, rgb: [255, 255, 255], alpha: 0, dark: 0, phase: 'Noon', icon: 'sun' },
  { hour: 15, rgb: [255, 215, 150], alpha: 0.06, dark: 0, phase: 'Afternoon', icon: 'cloud-sun' },
  { hour: 17.25, rgb: [255, 165, 80], alpha: 0.18, dark: 0.08, phase: 'Golden hour', icon: 'sun' },
  { hour: 18.5, rgb: [235, 95, 85], alpha: 0.24, dark: 0.35, phase: 'Sunset', icon: 'sun' },
  { hour: 19.5, rgb: [80, 55, 125], alpha: 0.4, dark: 0.7, phase: 'Dusk', icon: 'cloud-moon' },
  { hour: 21, rgb: [18, 22, 64], alpha: 0.55, dark: 1, phase: 'Night', icon: 'moon' },
  { hour: 24, rgb: [18, 22, 64], alpha: 0.55, dark: 1, phase: 'Night', icon: 'moon' },
];
export const TIME_PRESETS = [
  { label: 'LIVE', hour: null },
  { label: 'DAWN', hour: 5.8 },
  { label: 'NOON', hour: 12 },
  { label: 'GOLDEN', hour: 17.6 },
  { label: 'DUSK', hour: 19.6 },
  { label: 'NIGHT', hour: 23 },
];

export function currentHour() {
  if (state.timeOverride !== null && state.timeOverride !== undefined) return state.timeOverride;
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
}

export function lighting() {
  const hour = currentHour();
  const nextIndex = SKY_KEYS.findIndex((key) => key.hour > hour);
  const after = SKY_KEYS[Math.max(1, nextIndex)];
  const before = SKY_KEYS[Math.max(0, nextIndex - 1)];
  const k = (hour - before.hour) / (after.hour - before.hour || 1);
  const mix = (a, b) => a + (b - a) * k;
  const rgb = before.rgb.map((c, i) => Math.round(mix(c, after.rgb[i])));
  // The sun rises in the east (right) and sets in the west, so shadows swing from west to east.
  const sun = Math.max(-1, Math.min(1, (hour - 12) / 6));
  return { rgb, alpha: mix(before.alpha, after.alpha), dark: mix(before.dark, after.dark), phase: before.phase, icon: before.icon, sun, hour };
}

// Morning mist peaks just after sunrise.
export function drawMist(light) {
  const strength = Math.max(0, 1 - Math.abs(light.hour - 6.3) / 1.6) * 0.16;
  if (strength <= 0) return;
  ctx.fillStyle = `rgba(228, 232, 255, ${strength})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// Long, soft shadows in the morning and evening that swing with the sun; none at night.
export function drawSunShadow(x, baseY, width, height) {
  const light = state.light;
  const strength = 0.2 * (1 - light.dark);
  if (strength <= 0.01) return;
  const reach = height * (0.25 + Math.abs(light.sun) * 0.6) * Math.sign(light.sun || 0.01);
  const lift = height * 0.18;
  ctx.fillStyle = `rgba(20, 30, 40, ${strength})`;
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  ctx.lineTo(x + width, baseY);
  ctx.lineTo(x + width + reach, baseY - lift);
  ctx.lineTo(x + reach, baseY - lift);
  ctx.closePath();
  ctx.fill();
}

const FIREFLIES = Array.from({ length: 14 }, (_, i) => ({ seed: i * 1.7, x: 0, y: 0 }));

export function drawFireflies() {
  if (state.light.dark < 0.6) return;
  for (const fly of FIREFLIES) {
    fly.x = PARK.x0 + 40 + ((Math.sin(fly.seed * 3.1) + 1) / 2) * (PARK.x1 - PARK.x0 - 80) + Math.sin(state.time * 0.7 + fly.seed) * 18;
    fly.y = PARK.y0 + 40 + ((Math.cos(fly.seed * 2.3) + 1) / 2) * (PARK.y1 - PARK.y0 - 80) + Math.cos(state.time * 0.5 + fly.seed) * 12;
    const blink = (Math.sin(state.time * 2 + fly.seed * 5) + 1) / 2;
    if (blink < 0.3) continue;
    rect(fly.x, fly.y, 1, 1, '#fff6a0');
    state.lights.push({ x: fly.x, y: fly.y, r: 3 + blink * 2 });
  }
}

export function daylight() {
  return state.light ? state.light.dark : lighting().dark;
}

window.colonySetTime = (hour) => {
  state.timeOverride = hour === null || hour === undefined ? null : Number(hour);
};
