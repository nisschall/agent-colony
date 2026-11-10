// Boards and the toolbar: Hall of Fame, Ward, Today's Crew, pause, speed, time and rebuild.
import { fitCamera } from '../camera.js';
import { canvas } from '../canvas.js';
import { addToast, autonomy, statusLabel } from '../hud.js';
import { efficiency, identity, levelOf, prettyModel, xpOf } from '../identity.js';
import { LAYOUT_SEED, YOU } from '../layout.js';
import { TIME_PRESETS } from '../lighting.js';
import { HIRED_MARK, HIRED_VEST, drawPerson } from '../people.js';
import { state } from '../state.js';
import { api } from '../ui/forms.js';
import { renderSheet, selectWorker } from '../ui/sheet.js';
import { clockTime, compact, duration, escapeHtml, money } from '../utils.js';

export function renderBoard(mode) {
  state.boardMode = mode;
  const board = document.getElementById('board');
  const agents = state.data ? state.data.agents.slice() : [];
  let rows;
  if (mode === 'members') {
    renderMembers(board);
    return;
  }
  if (mode === 'fame') {
    document.getElementById('boardTitle').textContent = '🏆 HALL OF FAME — last 24h';
    agents.sort((a, b) => xpOf(b) - xpOf(a));
    rows = agents.map((a, i) => {
      const look = identity(a);
      return `<tr class="row" data-id="${escapeHtml(a.id)}"><td>${i + 1}</td><td>${escapeHtml(look.name)} <span style="color:var(--muted)">${escapeHtml(look.className)}</span></td>`
        + `<td>${escapeHtml(a.project)}</td><td class="num">LV ${levelOf(xpOf(a))}</td><td class="num">${compact(a.linesAdded + a.linesRemoved)}</td>`
        + `<td class="num">${money(a.cost)}</td><td class="num">${compact(efficiency(a))}</td></tr>`;
    });
    board.querySelector('#boardBody').innerHTML = `<table><tr><th>#</th><th>AGENT</th><th>GUILD</th><th class="num">LV</th><th class="num">BRICKS</th><th class="num">GOLD</th><th class="num">BRICKS/$</th></tr>${rows.join('')}</table>`;
  } else {
    document.getElementById('boardTitle').textContent = '🚑 BURNOUT WARD — most stressed first';
    agents.sort((a, b) => b.stress - a.stress);
    rows = agents.map((a) => {
      const look = identity(a);
      const reasons = [];
      if (a.shiftHours >= 2) reasons.push(`${duration(a.shiftHours * 3600000)} shift`);
      if (a.burnPerHour >= 3) reasons.push(`${money(a.burnPerHour)}/h burn`);
      if (a.recentErrors) reasons.push(`${a.recentErrors} errors`);
      if (a.context >= 200000) reasons.push(`${compact(a.context)} context`);
      const color = a.stress >= 65 ? 'var(--red)' : a.stress >= 40 ? 'var(--gold)' : 'var(--green)';
      return `<tr class="row" data-id="${escapeHtml(a.id)}"><td>${escapeHtml(look.name)}</td><td>${escapeHtml(a.project)}</td>`
        + `<td class="num" style="color:${color}">${a.stress}</td><td>${statusLabel(a.status)}</td><td style="color:var(--muted)">${escapeHtml(reasons.join(', ') || 'fresh')}</td></tr>`;
    });
    board.querySelector('#boardBody').innerHTML = `<table><tr><th>AGENT</th><th>GUILD</th><th class="num">STRESS</th><th>STATE</th><th>WHY</th></tr>${rows.join('')}</table>`;
  }
  if (!rows.length) board.querySelector('#boardBody').innerHTML = '<p>No agents have worked in the last 24 hours.</p>';
}

// A clan's members: who is online, how many agents they have here, and how many are waiting on them.
function renderMembers(board) {
  const clan = state.data && state.data.clan;
  document.getElementById('boardTitle').textContent = `👥 ${clan ? clan.name.toUpperCase() : 'CLAN'} — MEMBERS`;
  const members = clan ? clan.members.slice().sort((a, b) => b.waiting - a.waiting || b.online - a.online || b.agents - a.agents) : [];
  const rows = members.map((m) => {
    const seen = m.online ? '<span style="color:var(--green)">● online</span>' : `<span style="color:var(--muted)">${m.lastSeen ? `seen ${duration(Date.now() - m.lastSeen)} ago` : 'not linked yet'}</span>`;
    const waiting = m.waiting ? `<span style="color:var(--gold)">${m.waiting}</span>` : '<span style="color:var(--muted)">0</span>';
    const name = m.name && m.name !== m.login ? ` <span style="color:var(--muted)">${escapeHtml(m.name)}</span>` : '';
    return `<tr><td>${escapeHtml(m.login)}${name}</td><td>${m.role === 'leader' ? 'Leader' : 'Member'}</td><td>${seen}</td>`
      + `<td class="num">${m.agents}</td><td class="num">${waiting}</td></tr>`;
  });
  board.querySelector('#boardBody').innerHTML = rows.length
    ? `<table><tr><th>MEMBER</th><th>ROLE</th><th>STATUS</th><th class="num">AGENTS</th><th class="num">WAITING ON THEM</th></tr>${rows.join('')}</table>`
    : '<p>No members yet.</p>';
}

function toggleBoard(mode) {
  const board = document.getElementById('board');
  const open = board.classList.contains('open') && state.boardMode === mode;
  board.classList.toggle('open', !open);
  document.getElementById('btnFame').classList.toggle('on', !open && mode === 'fame');
  document.getElementById('btnWard').classList.toggle('on', !open && mode === 'ward');
  document.getElementById('btnMembers').classList.toggle('on', !open && mode === 'members');
  if (!open) renderBoard(mode);
}

export const BUSY_STATUSES = ['working', 'overworked', 'stuck'];

function crewToday() {
  const agents = state.data ? state.data.agents.filter((a) => a.today) : [];
  const score = (a) => a.today.lines + a.today.edits * 5 + a.today.activeMinutes * 2;
  const rank = (a) => (a.status === 'waiting' ? 2 : BUSY_STATUSES.includes(a.status) ? 1 : 0);
  return agents.sort((a, b) => rank(b) - rank(a) || score(b) - score(a)).map((agent) => ({ agent, score: score(agent) }));
}

export function renderCrew() {
  const crew = crewToday();
  const totalCost = crew.reduce((sum, c) => sum + c.agent.today.cost, 0);
  const totalLines = crew.reduce((sum, c) => sum + c.agent.today.lines, 0);
  const linesByProject = new Map();
  for (const { agent } of crew) linesByProject.set(agent.project, (linesByProject.get(agent.project) || 0) + agent.today.lines);
  const busiest = [...linesByProject.entries()].sort((a, b) => b[1] - a[1])[0];
  const mvpId = crew.length ? crew.slice().sort((a, b) => b.score - a.score)[0].agent.id : null;
  const dateLabel = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });

  document.getElementById('crewTitle').textContent = `🎖 TODAY'S CREW — ${dateLabel}`;
  document.getElementById('crewSummary').innerHTML = [
    `Crew <b>${crew.length}</b>`,
    `On the job <b>${crew.filter((c) => BUSY_STATUSES.includes(c.agent.status)).length}</b>`,
    `Gold spent <b>${money(totalCost)}</b>`,
    `Bricks laid <b>${compact(totalLines)}</b>`,
    `Busiest guild <b>${escapeHtml(busiest ? busiest[0] : '—')}</b>`,
  ].map((item) => `<span>${item}</span>`).join('');

  const grid = document.getElementById('crewGrid');
  if (!crew.length) {
    grid.innerHTML = '<p>No agent has clocked in yet today.</p>';
    return;
  }
  grid.innerHTML = crew.map(({ agent }) => crewCard(agent, agent.id === mvpId)).join('');
}

function crewCard(agent, isMvp) {
  const look = identity(agent);
  const today = agent.today;
  const energy = Math.max(0, 100 - agent.stress);
  const energyClass = energy < 35 ? 'bad' : energy < 60 ? 'warn' : '';
  const stats = [
    ['Gold', money(today.cost)],
    ['Bricks', compact(today.lines)],
    ['Edits', today.edits],
    ['Active', duration(today.activeMinutes * 60000)],
    ['In at', clockTime(today.firstTs)],
    ['Quiet', duration(Date.now() - agent.lastTs)],
    ['Your msgs', today.humanMsgs],
    ['Autonomy', autonomy(agent)],
  ];
  const statsHtml = stats.map(([k, v]) => `<div><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('');
  const quest = agent.title || `work on ${agent.project}`;
  return `<div class="card ${agent.status}" data-id="${escapeHtml(agent.id)}">`
    + (isMvp ? '<span class="ribbon">⭐ MVP</span>' : '')
    + `<div class="top"><canvas width="28" height="28" data-portrait="${escapeHtml(agent.id)}"></canvas><div>`
    + `<div class="name">${agent.portal ? `<span style="color:${HIRED_VEST}">${HIRED_MARK}</span> ` : ''}${escapeHtml(look.name)}</div>`
    + `<div class="cls">${escapeHtml(prettyModel(agent.model))} ${escapeHtml(look.className)} · LV ${levelOf(xpOf(agent))}</div>`
    + `<span class="badge ${agent.status}">${statusLabel(agent.status)}</span>`
    + (YOU.revieweeId === agent.id ? '<span class="badge review">📋 Your focus</span>' : '')
    + '</div></div>'
    + `<div class="quest">${agent.status === 'waiting' ? `🙋 “${escapeHtml(agent.waitingAsk)}”` : `“${escapeHtml(quest)}”`}</div>`
    + `<div class="guild">Guild: ${escapeHtml(agent.project)}</div>`
    + `<div class="bar ${energyClass}" title="Energy"><i style="width:${energy}%"></i></div>`
    + `<div class="stats">${statsHtml}</div></div>`;
}

export function drawCrewPortraits() {
  for (const canvasEl of document.querySelectorAll('#crewGrid canvas[data-portrait]')) {
    const worker = state.workers.get(canvasEl.dataset.portrait);
    if (!worker) continue;
    const p = canvasEl.getContext('2d');
    p.imageSmoothingEnabled = false;
    p.fillStyle = '#1f3a2a';
    p.fillRect(0, 0, 28, 28);
    p.fillStyle = '#2a4a36';
    p.fillRect(0, 22, 28, 6);
    const status = worker.agent.status;
    const pose = BUSY_STATUSES.includes(status) ? 'type' : status === 'sleeping' ? 'sleep' : 'sit';
    if (pose === 'sleep') drawPerson(p, 18, 19, worker, { pose, portrait: true });
    else drawPerson(p, 14, 24, worker, { pose, portrait: true });
    drawPortraitIcon(p, status);
  }
}

function drawPortraitIcon(p, status) {
  const blinkOn = Math.floor(state.time * 4) % 2 === 0;
  if (status === 'overworked') {
    p.fillStyle = '#ff7a1a';
    p.fillRect(21, 3 - (blinkOn ? 1 : 0), 4, 6 + (blinkOn ? 1 : 0));
    p.fillStyle = '#ffe066';
    p.fillRect(22, 6, 2, 3);
  } else if (status === 'stuck') {
    p.fillStyle = '#fff';
    p.fillRect(20, 2, 6, 8);
    p.fillStyle = '#e33';
    p.fillRect(22, 3, 2, 4);
    p.fillRect(22, 8, 2, 1);
  } else if (status === 'sleeping') {
    p.fillStyle = blinkOn ? '#fff' : '#a99bc4';
    p.font = '6px "Press Start 2P"';
    p.textAlign = 'left';
    p.fillText('z', 20, 9);
  }
}

export function toggleCrew(open) {
  const crewEl = document.getElementById('crew');
  crewEl.classList.toggle('open', open);
  document.getElementById('btnCrew').classList.toggle('on', open);
  document.getElementById('crewGrid').classList.remove('dealt');
  if (open) {
    document.getElementById('board').classList.remove('open');
    renderCrew();
    setTimeout(() => document.getElementById('crewGrid').classList.add('dealt'), 600);
  }
}

document.getElementById('btnCrew').onclick = () => toggleCrew(!document.getElementById('crew').classList.contains('open'));
document.getElementById('crewClose').onclick = () => toggleCrew(false);
document.getElementById('crewGrid').addEventListener('click', (e) => {
  const card = e.target.closest('.card[data-id]');
  if (!card || !state.workers.has(card.dataset.id)) return;
  toggleCrew(false);
  selectWorker(card.dataset.id, true);
  state.following = true;
  renderSheet();
});

document.getElementById('btnFame').onclick = () => toggleBoard('fame');
document.getElementById('btnWard').onclick = () => toggleBoard('ward');
document.getElementById('btnMembers').onclick = () => toggleBoard('members');
document.getElementById('boardClose').onclick = () => toggleBoard(state.boardMode);
document.getElementById('boardBody').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  toggleBoard(state.boardMode);
  selectWorker(row.dataset.id, true);
});
document.getElementById('btnPause').onclick = (e) => {
  state.paused = !state.paused;
  e.currentTarget.textContent = state.paused ? '▶' : '⏸';
  e.currentTarget.classList.toggle('on', state.paused);
};
document.getElementById('btnSpeed').onclick = (e) => {
  state.speed = state.speed >= 3 ? 1 : state.speed + 1;
  e.currentTarget.textContent = `${state.speed}x`;
};
document.getElementById('btnTime').onclick = (e) => {
  state.timePreset = (state.timePreset + 1) % TIME_PRESETS.length;
  const preset = TIME_PRESETS[state.timePreset];
  window.colonySetTime(preset.hour);
  e.currentTarget.title = `Time of day: ${preset.label}`;
  e.currentTarget.classList.toggle('on', preset.hour !== null);
};
document.getElementById('btnHome').onclick = () => {
  state.following = false;
  fitCamera();
};
document.getElementById('btnRebuild').onclick = () => window.colonyRebuildTown();

// The page reloads itself when the server reports a new layout, so every screen switches together.
window.colonyRebuildTown = async () => {
  if (!confirm('Rebuild the town with a new layout? Every project keeps its building; plots, streets and the park are rearranged.')) return;
  const result = await api('/api/town/rebuild', { seed: LAYOUT_SEED });
  if (result.ok) addToast('🎲 Rebuilding the town…', 'info');
};
