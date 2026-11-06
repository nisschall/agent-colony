// The agent card: details, orders, Open in Terminal and stop.
import { addToast, autonomy, statusLabel } from '../hud.js';
import { efficiency, levelOf, levelProgress, prettyModel, xpOf } from '../identity.js';
import { HIRED_MARK, drawPerson } from '../people.js';
import { state } from '../state.js';
import { api } from '../ui/forms.js';
import { compact, duration, escapeHtml, money } from '../utils.js';

export function renderSheet() {
  const worker = state.workers.get(state.selectedId);
  if (!worker) {
    closeSheet();
    return;
  }
  const agent = worker.agent;
  const look = worker.look;
  const xp = xpOf(agent);
  document.getElementById('sheetName').textContent = look.name;
  const hiredNote = agent.portal ? ` · ${HIRED_MARK} hired from the town` : '';
  document.getElementById('sheetClass').textContent = `${prettyModel(agent.model)} ${look.className}${hiredNote}`;
  document.getElementById('sheetLevel').textContent = `LV ${levelOf(xp)} · ${statusLabel(agent.status)}`;
  document.getElementById('sheetQuest').textContent = agent.title ? `Quest: ${agent.title}` : `Quest: work on ${agent.project}`;
  document.getElementById('sheetXp').style.width = `${levelProgress(xp) * 100}%`;
  const energy = Math.max(0, 100 - agent.stress);
  const energyBar = document.getElementById('sheetEnergyBar');
  energyBar.className = `bar ${energy < 35 ? 'bad' : energy < 60 ? 'warn' : ''}`;
  document.getElementById('sheetEnergy').style.width = `${energy}%`;
  const accuracy = agent.toolCalls ? Math.round(100 * (1 - agent.toolErrors / agent.toolCalls)) : 100;
  const stats = [
    ['Guild', agent.project],
    ['Shift', duration(agent.shiftHours * 3600000)],
    ['Gold spent', money(agent.cost)],
    ['Burn', `${money(agent.burnPerHour)}/h`],
    ['Bricks +', compact(agent.linesAdded)],
    ['Bricks −', compact(agent.linesRemoved)],
    ['Files', agent.filesTouched],
    ['Tool uses', compact(agent.toolCalls)],
    ['Accuracy', `${accuracy}%`],
    ['Errors 15m', agent.recentErrors],
    ['Tokens out', compact(agent.tokens.output)],
    ['Context', compact(agent.context)],
    ['Lines / $', compact(efficiency(agent))],
    ['Last seen', `${duration(Date.now() - agent.lastTs)} ago`],
    ['Your msgs', agent.humanMsgs],
    ['Stopped', agent.interrupts],
    ['Autonomy', autonomy(agent)],
    ['You last', agent.lastHumanTs ? `${duration(Date.now() - agent.lastHumanTs)} ago` : 'never'],
  ];
  document.getElementById('sheetStats').innerHTML = stats
    .map(([k, v]) => `<div><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('');
  const doing = agent.status === 'waiting'
    ? `🙋 Waiting on you for ${duration(Date.now() - agent.waitingSince)}: ${agent.waitingAsk}`
    : agent.lastAction || '—';
  document.getElementById('sheetDoing').textContent = doing;
  renderOrdersBox(agent);
  document.getElementById('btnFollow').classList.toggle('on', state.following);
  drawPortrait(worker);
}

function renderOrdersBox(agent) {
  const box = document.getElementById('ordersBox');
  const note = document.getElementById('ordersNote');
  const sendButton = document.getElementById('btnOrders');
  const stopButton = document.getElementById('btnStop');
  const terminalButton = document.getElementById('btnTerminal');
  const watchOnly = document.getElementById('watchOnlyNote');
  const portal = agent.portal;
  box.classList.toggle('open', Boolean(portal));
  sendButton.style.display = portal ? '' : 'none';
  terminalButton.style.display = portal ? '' : 'none';
  stopButton.style.display = portal && portal.running ? '' : 'none';
  watchOnly.textContent = portal ? '' : 'Watch-only: this agent lives in the Claude app, so reply to it there.';
  const outcome = portal && portal.outcome;
  document.getElementById('replyBox').classList.toggle('open', Boolean(outcome));
  if (!portal) return;
  sendButton.disabled = portal.running;
  terminalButton.disabled = portal.running;
  if (outcome) document.getElementById('sheetReply').textContent = outcome.reply;
  note.textContent = ordersNote(agent, portal);
}

function ordersNote(agent, portal) {
  if (portal.running) return 'Working on your last orders. You can send more once it finishes.';
  const outcome = portal.outcome;
  if (outcome && outcome.state === 'needs-you') return `🙋 Needs you: ${outcome.summary}. Its reply above says what to do.`;
  if (outcome) return '✓ Done. Give it the next task or follow-up.';
  if (agent.status === 'waiting') return `It asks: ${agent.waitingAsk}`;
  return 'Idle. Give it the next task or follow-up.';
}

document.getElementById('btnOrders').onclick = async () => {
  const input = document.getElementById('ordersInput');
  const message = input.value.trim();
  if (!message || !state.selectedId) return;
  const result = await api(`/api/agents/${encodeURIComponent(state.selectedId)}/orders`, { message });
  if (result.ok) {
    input.value = '';
    addToast('📋 Orders sent', 'info');
  }
};

document.getElementById('btnTerminal').onclick = async () => {
  if (!state.selectedId) return;
  const result = await api(`/api/agents/${encodeURIComponent(state.selectedId)}/terminal`);
  if (result.ok) addToast('💻 Opened in Terminal. Keep talking to it there.', 'info');
};

document.getElementById('btnStop').onclick = async () => {
  if (!state.selectedId) return;
  const result = await api(`/api/agents/${encodeURIComponent(state.selectedId)}/stop`);
  if (result.ok) addToast('✋ Agent stopped', 'info');
};

function drawPortrait(worker) {
  const portrait = document.getElementById('portrait');
  const p = portrait.getContext('2d');
  p.imageSmoothingEnabled = false;
  p.fillStyle = '#1f3a2a';
  p.fillRect(0, 0, 24, 24);
  drawPerson(p, 12, 20, worker, { pose: 'stand', portrait: true });
}

export function selectWorker(id, focus) {
  state.selectedId = id;
  document.getElementById('sheet').classList.add('open');
  if (focus) {
    const worker = state.workers.get(id);
    state.camera.x = worker.x;
    state.camera.y = worker.y;
    state.camera.zoom = Math.max(state.camera.zoom, 3);
  }
  renderSheet();
}

export function closeSheet() {
  state.selectedId = null;
  state.following = false;
  document.getElementById('sheet').classList.remove('open');
}

document.getElementById('sheetClose').onclick = closeSheet;
document.getElementById('btnFollow').onclick = () => {
  state.following = !state.following;
  renderSheet();
};
