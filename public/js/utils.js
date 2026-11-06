// Small pure helpers: hashing, seeded randomness, formatting and the budget setting.
import { BUDGET_KEY } from './config.js';

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seeded(seed) {
  let s = seed || 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 | 0;
    return ((s >>> 0) % 10000) / 10000;
  };
}

export function pick(list, seed) {
  return list[seed % list.length];
}

export function money(value) {
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  if (value >= 100) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}

export function compact(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

export function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function readBudget() {
  try {
    const stored = Number(localStorage.getItem(BUDGET_KEY));
    return stored > 0 ? stored : 50;
  } catch {
    return 50;
  }
}

export function saveBudget(value) {
  try { localStorage.setItem(BUDGET_KEY, String(value)); } catch { /* storage unavailable */ }
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function weightedPick(list, roll) {
  const total = list.reduce((sum, item) => sum + item.weight, 0);
  let running = 0;
  return list.find((item) => (running += item.weight) > roll * total) || list[0];
}
