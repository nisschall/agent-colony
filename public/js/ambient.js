// The colony's day: weather, traffic, clouds, birds and the error storm.
import { canvas, ctx, rect, shade } from './canvas.js';
import { MAP_H, MAP_W, TILE } from './config.js';
import { addToast } from './hud.js';
import { currentHour, daylight } from './lighting.js';
import { state } from './state.js';
import { hash, seeded, weightedPick } from './utils.js';
import { updateVisitors } from './visitors.js';

const CAR_COLORS = ['#e04f4f', '#4f7fe0', '#f2c94c', '#f4e9c9', '#3fb68b'];
export const CARS = [
  { x: 120, y: 13 * TILE + 26, dir: 1, speed: 46 },
  { x: 700, y: 13 * TILE + 11, dir: -1, speed: 38 },
  { x: 400, y: 43 * TILE + 26, dir: 1, speed: 52 },
  { x: 900, y: 43 * TILE + 11, dir: -1, speed: 42 },
].map((car, i) => ({ ...car, color: CAR_COLORS[i % CAR_COLORS.length] }));
const ERROR_STORM_THRESHOLD = 4;
const CLOUDS = [0, 1, 2].map((i) => ({ x: i * 420, y: 120 + i * 230, r: 120 + i * 30, speed: 6 + i * 2 }));
const RAIN = Array.from({ length: 180 }, () => ({ x: Math.random(), y: Math.random(), speed: 0.6 + Math.random() * 0.5 }));

const WEATHERS = [
  { kind: 'clear', weight: 45, clouds: 2, cloudSpeed: 1 },
  { kind: 'breezy', weight: 25, clouds: 5, cloudSpeed: 2.6 },
  { kind: 'drizzle', weight: 15, clouds: 6, cloudSpeed: 1.4 },
  { kind: 'fog', weight: 15, clouds: 3, cloudSpeed: 0.6 },
];
export const VEHICLE_COLORS = ['#e04f4f', '#4f7fe0', '#f2c94c', '#f4e9c9', '#3fb68b', '#8a5ab0', '#d9822b', '#5c6672', '#2f8f9d'];
const LANES = [
  { y: 13 * TILE + 26, dir: 1 },
  { y: 13 * TILE + 11, dir: -1 },
  { y: 43 * TILE + 26, dir: 1 },
  { y: 43 * TILE + 11, dir: -1 },
];
export const DELIVERY_COOLDOWN_MS = 60_000;
export const IDLE_WANDER_CHANCE = 0.35;
export const PARK_ACTIVITIES = ['coffee', 'phone', 'stretch', 'look'];
export const VISITOR_LOOKS = [
  { skin: '#f2c7a5', hair: '#6b3a1f', shirt: '#e86f9c', pants: '#2f3a56' },
  { skin: '#c68e63', hair: '#1b1428', shirt: '#3fb68b', pants: '#444' },
  { skin: '#8d5a3b', hair: '#2b1d14', shirt: '#f2c94c', pants: '#3a2f2f' },
  { skin: '#f5d6bd', hair: '#d9a441', shirt: '#5b8def', pants: '#2f4a3a' },
];
export let dayMood = null;

function moodFor(dateKey) {
  const rand = seeded(hash(dateKey));
  return {
    key: dateKey,
    weather: weightedPick(WEATHERS, rand()),
    carCount: 3 + Math.floor(rand() * 5),
    bus: rand() < 0.6,
    kids: rand() < 0.5,
    balloon: rand() < 0.35,
    foodTruck: rand() < 0.6,
    rainOffset: rand() * 100,
    rand,
  };
}

// Rebuilds the day's traffic and clouds in place, so code holding CARS and CLOUDS keeps working.
function applyMood(mood) {
  dayMood = mood;
  const rand = mood.rand;
  const worldWidth = MAP_W * TILE;
  const vehicles = Array.from({ length: mood.carCount }, () => ({ kind: 'car', speed: 34 + rand() * 22 }));
  if (mood.bus) vehicles.push({ kind: 'bus', speed: 26 });
  CARS.length = 0;
  for (const vehicle of vehicles) {
    const lane = LANES[Math.floor(rand() * LANES.length)];
    const color = vehicle.kind === 'bus' ? '#f2b62c' : VEHICLE_COLORS[Math.floor(rand() * VEHICLE_COLORS.length)];
    CARS.push({ ...vehicle, x: rand() * worldWidth, y: lane.y, dir: lane.dir, color });
  }
  CLOUDS.length = 0;
  for (let i = 0; i < mood.weather.clouds; i++) {
    CLOUDS.push({ x: rand() * worldWidth, y: 60 + rand() * (MAP_H * TILE - 120), r: 90 + rand() * 70, speed: (5 + rand() * 4) * mood.weather.cloudSpeed });
  }
}

function weatherKind() {
  return dayMood ? dayMood.weather.kind : 'clear';
}

export function windFactor() {
  return weatherKind() === 'breezy' ? 3 : 1;
}

// Drizzle comes in showers a few minutes long rather than all day.
export function rainAmount() {
  if (weatherKind() !== 'drizzle') return 0;
  return Math.max(0, Math.sin(state.time / 70 + dayMood.rainOffset));
}

function fogAmount() {
  if (weatherKind() !== 'fog') return 0;
  return Math.max(0, Math.min(1, (11.5 - currentHour()) / 4));
}

export function isDaytime(fromHour, toHour) {
  const hour = currentHour();
  return hour >= fromHour && hour < toHour;
}

export function foodTruckOpen() {
  return Boolean(dayMood && dayMood.foodTruck && isDaytime(10, 17));
}

const CLOUD_SHADOW = (() => {
  const shadow = document.createElement('canvas');
  shadow.width = 64;
  shadow.height = 64;
  const g = shadow.getContext('2d');
  const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(10, 20, 40, 0.16)');
  gradient.addColorStop(1, 'rgba(10, 20, 40, 0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 64, 64);
  return shadow;
})();

function recentErrorCount() {
  return state.data ? state.data.agents.reduce((sum, a) => sum + (a.recentErrors || 0), 0) : 0;
}

export function updateAmbient(dt) {
  const worldWidth = MAP_W * TILE;
  const today = new Date().toDateString();
  if (!dayMood || dayMood.key !== today) applyMood(moodFor(today));
  updateVisitors(dt);
  for (const car of CARS) {
    car.x += car.dir * car.speed * dt;
    if (car.x > worldWidth + 30) car.x = -30;
    if (car.x < -30) car.x = worldWidth + 30;
  }
  for (const cloud of CLOUDS) {
    cloud.x += cloud.speed * dt;
    if (cloud.x - cloud.r > worldWidth) cloud.x = -cloud.r;
  }
  state.birds = (state.birds || []).filter((bird) => bird.x < worldWidth + 40);
  for (const bird of state.birds) bird.x += bird.vx * dt;
  if (!state.birds.length && daylight() < 0.5 && Math.random() < dt / 20) {
    const y = 40 + Math.random() * (MAP_H * TILE - 160);
    const size = 3 + Math.floor(Math.random() * 3);
    state.birds = Array.from({ length: size }, (_, i) => ({ x: -20 - i * 9, y: y + (i % 2) * 7 - i * 2, vx: 55, phase: i }));
  }
  const storming = recentErrorCount() >= ERROR_STORM_THRESHOLD;
  if (storming && !state.storming) addToast(`🌧 Error storm: ${recentErrorCount()} errors in the last 15 minutes`);
  state.storming = storming;
}

export function drawCar(car) {
  if (car.kind === 'bus') {
    drawBus(car);
    return;
  }
  const x = Math.round(car.x);
  const y = Math.round(car.y);
  const front = car.dir > 0 ? 6 : -7;
  rect(x - 7, y - 2, 14, 3, 'rgba(0,0,0,.25)');
  rect(x - 7, y - 8, 14, 6, car.color);
  rect(x - 4, y - 10, 8, 3, shade(car.color, -30));
  rect(x - 3, y - 9, 6, 1, '#a8d8ff');
  rect(x - 6, y - 3, 3, 2, '#222');
  rect(x + 3, y - 3, 3, 2, '#222');
  rect(x + front, y - 7, 1, 2, '#fff6c4');
  state.lights.push({ x: x + front + car.dir * 6, y: y - 6, r: 9 });
}

function drawBus(bus) {
  const x = Math.round(bus.x);
  const y = Math.round(bus.y);
  const front = bus.dir > 0 ? 16 : -17;
  rect(x - 17, y - 2, 34, 3, 'rgba(0,0,0,.25)');
  rect(x - 17, y - 13, 34, 11, bus.color);
  rect(x - 17, y - 13, 34, 1, shade(bus.color, 30));
  for (let i = 0; i < 5; i++) rect(x - 14 + i * 6, y - 11, 4, 4, '#a8d8ff');
  rect(x - 17, y - 6, 34, 1, shade(bus.color, -30));
  rect(x - 12, y - 3, 4, 2, '#222');
  rect(x + 8, y - 3, 4, 2, '#222');
  rect(x + front, y - 8, 1, 2, '#fff6c4');
  state.lights.push({ x: x + front + bus.dir * 6, y: y - 7, r: 10 });
}

export function drawClouds() {
  if (state.storming) return;
  ctx.imageSmoothingEnabled = true;
  for (const cloud of CLOUDS) ctx.drawImage(CLOUD_SHADOW, cloud.x - cloud.r, cloud.y - cloud.r * 0.6, cloud.r * 2, cloud.r * 1.2);
  ctx.imageSmoothingEnabled = false;
}

export function drawBirds() {
  for (const bird of state.birds || []) {
    const flap = Math.floor(state.time * 6 + bird.phase) % 2 ? -1 : 1;
    const x = Math.round(bird.x);
    const y = Math.round(bird.y);
    rect(x - 3, y + flap, 1, 1, '#1b1428');
    rect(x - 2, y, 1, 1, '#1b1428');
    rect(x - 1, y + 1, 2, 1, '#1b1428');
    rect(x + 1, y, 1, 1, '#1b1428');
    rect(x + 2, y + flap, 1, 1, '#1b1428');
  }
}

// An error storm overrides the day's weather; otherwise drizzle showers and morning fog come from the day's mood.
export function drawWeather(m) {
  const rain = state.storming ? 1 : rainAmount() * 0.45;
  const fog = fogAmount();
  if (rain <= 0 && fog <= 0) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (fog > 0) {
    ctx.fillStyle = `rgba(225, 230, 240, ${0.3 * fog})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (rain <= 0) {
    ctx.setTransform(m.zoom, 0, 0, m.zoom, m.ox, m.oy);
    return;
  }
  ctx.fillStyle = `rgba(30, 40, 70, ${0.22 * rain})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = `rgba(170, 200, 255, ${0.25 + 0.2 * rain})`;
  ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1));
  ctx.beginPath();
  for (const drop of RAIN.slice(0, Math.ceil(RAIN.length * rain))) {
    drop.y = (drop.y + drop.speed * 0.03) % 1;
    const x = drop.x * canvas.width;
    const y = drop.y * canvas.height;
    ctx.moveTo(x, y);
    ctx.lineTo(x - 4, y + 14);
  }
  ctx.stroke();
  ctx.setTransform(m.zoom, 0, 0, m.zoom, m.ox, m.oy);
}
