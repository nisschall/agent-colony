// Mouse and keyboard: panning, zooming, hovering and clicking things in the town.
import { DAY_MS, FEATURES, LAYER_LABELS, TIERS, buildingHealth, problemLines, starsOf } from './buildings.js';
import { screenToWorld } from './camera.js';
import { canvas } from './canvas.js';
import { statusLabel } from './hud.js';
import { prettyModel } from './identity.js';
import { YOU } from './layout.js';
import { HIRED_MARK, HIRED_VEST, isOutOfSight } from './people.js';
import { state } from './state.js';
import { toggleCrew } from './ui/boards.js';
import { closeBuildingMenu, closeHireForm, openBuildingMenu, openGroundMenu } from './ui/forms.js';
import { closeSheet, selectWorker } from './ui/sheet.js';
import { compact, escapeHtml, money, siteOf } from './utils.js';

let drag = null;

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const hit = hitTest(e.clientX, e.clientY);
  if (hit && hit.type === 'building') openBuildingMenu(hit.building, e.clientX, e.clientY);
  else if (hit && hit.type === 'worker') selectWorker(hit.worker.agent.id, false);
  else openGroundMenu(e.clientX, e.clientY);
});

canvas.addEventListener('pointerdown', (e) => {
  closeBuildingMenu();
  if (e.button !== 0) return;
  drag ={ x: e.clientX, y: e.clientY, cx: state.camera.x, cy: state.camera.y, moved: false };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      drag.moved = true;
      state.following = false;
      canvas.classList.add('dragging');
    }
    state.camera.x = drag.cx - dx / state.camera.zoom;
    state.camera.y = drag.cy - dy / state.camera.zoom;
  }
  updateHover(e.clientX, e.clientY);
});

canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  const wasClick = drag && !drag.moved;
  drag = null;
  if (!wasClick) return;
  const hit = hitTest(e.clientX, e.clientY);
  if (hit && hit.type === 'worker') selectWorker(hit.worker.agent.id, false);
  else if (hit && hit.type === 'building') openBuildingMenu(hit.building, e.clientX, e.clientY);
  else {
    closeSheet();
    openGroundMenu(e.clientX, e.clientY);
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = screenToWorld(e.clientX, e.clientY);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  state.camera.zoom = Math.max(0.6, Math.min(7, state.camera.zoom * factor));
  const after = screenToWorld(e.clientX, e.clientY);
  state.camera.x += before.x - after.x;
  state.camera.y += before.y - after.y;
}, { passive: false });

function hitTest(sx, sy) {
  const p = screenToWorld(sx, sy);
  let best = null;
  let bestDistance = 9;
  for (const worker of state.workers.values()) {
    if (isOutOfSight(worker)) continue;
    const distance = Math.hypot(worker.x - p.x, worker.y - 7 - p.y);
    if (distance < bestDistance) {
      best = worker;
      bestDistance = distance;
    }
  }
  if (best) return { type: 'worker', worker: best };
  for (const building of state.buildings.values()) {
    const h = building.hit;
    if (h && p.x >= h.x0 && p.x <= h.x1 && p.y >= h.y0 && p.y <= h.y1) return { type: 'building', building };
  }
  return null;
}

function buildingTooltip(building) {
  const p = building.project;
  const profile = p.profile;
  const muted = (text) => `<span style="color:var(--muted)">${text}</span>`;
  const lines = [`<b style="color:var(--gold)">${escapeHtml(p.name)}</b>`];
  if (profile) {
    const modules = profile.modules > 1 ? ` · ${profile.modules} modules` : '';
    const stars = starsOf(profile);
    if (stars) lines.push(`<span style="color:var(--gold)">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</span> ${TIERS[profile.tier].label} · complexity ${profile.complexity}/100`);
    else lines.push(TIERS[profile.tier].label);
    const size = profile.codeLines !== undefined ? `${compact(profile.codeLines)} lines of code · ` : '';
    const languages = profile.languages && profile.languages.length ? ` · ${profile.languages.join(', ')}` : '';
    const dependencies = profile.dependencies ? ` · ${profile.dependencies} dependencies` : '';
    lines.push(`${size}${compact(profile.sourceFiles)} files${modules}${languages}${dependencies}`);
    const features = Object.keys(FEATURES).filter((f) => profile.features.includes(f)).map((f) => FEATURES[f].label);
    if (profile.ui) features.unshift('Web UI');
    if (features.length) lines.push(muted(features.join(' · ')));
  }
  lines.push(`${money(p.cost)} spent · ${compact(p.lines)} lines changed`);
  lines.push(`${p.active} at work · ${p.agents} today`);
  const health = buildingHealth(building);
  if (health.live.size) lines.push(`<span style="color:var(--gold)">Now editing ${[...health.live].map((l) => LAYER_LABELS[l]).join(', ')}</span>`);
  for (const problem of problemLines(building)) {
    const color = problem.tone === 'bad' ? 'var(--red)' : problem.tone === 'wait' ? 'var(--gold)' : 'var(--muted)';
    lines.push(`<span style="color:${color}">${escapeHtml(problem.text)}</span>`);
  }
  if (health.heavy) lines.push(`🏗 ${compact(p.linesToday)} lines changed today`);
  if (health.quiet) lines.push(`🌿 Quiet for ${Math.floor((Date.now() - p.lastTs) / DAY_MS)} days`);
  lines.push(muted('Right-click to hire an agent'));
  return lines.join('<br>');
}

function updateHover(sx, sy) {
  const tooltip = document.getElementById('tooltip');
  const hit = hitTest(sx, sy);
  state.hoverId = hit && hit.type === 'worker' ? hit.worker.agent.id : null;
  if (!hit) {
    tooltip.style.display = 'none';
    return;
  }
  let html;
  if (hit.type === 'worker') {
    const a = hit.worker.agent;
    html = `<b style="color:var(--gold)">${escapeHtml(hit.worker.look.name)}</b> · ${escapeHtml(prettyModel(a.model))}<br>${statusLabel(a.status)} · ${escapeHtml(a.project)}${siteOf(a) !== a.project ? ` → working on ${escapeHtml(siteOf(a))}` : ''}<br>${money(a.cost)} spent · ${compact(a.linesAdded + a.linesRemoved)} bricks`;
    if (a.portal) html += `<br><span style="color:${HIRED_VEST}">${HIRED_MARK} Hired from the town · click to give orders</span>`;
    if (a.status === 'waiting') html += `<br><span style="color:var(--gold)">Asks: ${escapeHtml(a.waitingAsk)}</span>`;
  } else {
    html = buildingTooltip(hit.building);
  }
  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
  tooltip.style.left = `${Math.min(sx + 14, innerWidth - 290)}px`;
  tooltip.style.top = `${sy + 14}px`;
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeBuildingMenu();
    closeHireForm();
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if (e.key === ' ') document.getElementById('btnPause').click();
  if (e.key === 'Escape') {
    toggleCrew(false);
    closeSheet();
    document.getElementById('board').classList.remove('open');
  }
});

// Browsers pause animation in background tabs, so when you come back from chatting,
// put everyone where they should be instead of replaying the walk.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  YOU.snap = true;
  for (const worker of state.workers.values()) {
    if (!worker.target) continue;
    worker.x = worker.target.x;
    worker.y = worker.target.y;
  }
});
