// The updates drawer on the left: what agents finished, what they are waiting on, and builds that broke or
// recovered. Only those moments, never every edit or tool call, so it stays readable. In a clan's town it
// shows every member's agents (for members who share their updates); in your own town, your agents.
import { CLAN_ID } from '../config.js';
import { state } from '../state.js';
import { duration, escapeHtml } from '../utils.js';
import { selectWorker } from './sheet.js';

const FEED_KINDS = new Set(['update', 'waiting', 'broke', 'fixed']);
const ICONS = { update: '💬', waiting: '🙋', broke: '⚠', fixed: '✓' };
const WAITING_PREFIXES = ['is waiting for your review: ', 'needs you: '];
const COLLAPSED_ITEMS = 2;
const EXPANDED_ITEMS = 50;
const OPEN_KEY = 'agentColony.feedOpen';

const feed = document.getElementById('feed');
const list = document.getElementById('feedList');
let filter = 'all';
let myLogin = '';

function rememberedOpen() {
  try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}

function rememberOpen(open) {
  try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* storage unavailable */ }
}

function ownerOf(event) {
  const worker = state.workers.get(event.agentId);
  return worker ? worker.agent.owner || '' : '';
}

// A question is still open while its agent is waiting and hasn't asked anything newer since.
function stillWaiting(event) {
  const worker = state.workers.get(event.agentId);
  return Boolean(worker && worker.agent.status === 'waiting' && event.ts >= worker.agent.waitingSince - 1000);
}

function waitingText(event, owner) {
  const prefix = WAITING_PREFIXES.find((p) => event.text.startsWith(p));
  const question = prefix ? event.text.slice(prefix.length) : event.text === 'is waiting for review' ? '' : event.text;
  const whom = owner || 'you';
  const lead = stillWaiting(event) ? `waiting on ${whom}` : `asked ${whom}`;
  return `${lead}${question ? `: ${question}` : ''}`;
}

function itemHtml(event) {
  const worker = state.workers.get(event.agentId);
  const owner = ownerOf(event);
  const name = worker ? worker.look.name : 'An agent';
  const who = owner ? `${name} · ${owner}` : name;
  const text = event.kind === 'waiting' ? waitingText(event, owner) : event.text;
  const answered = event.kind === 'waiting' && !stillWaiting(event) ? ' answered' : '';
  return `<li class="${event.kind}${answered}" data-id="${escapeHtml(event.agentId || '')}" title="${escapeHtml(text)}">`
    + `<div class="meta"><span class="who">${escapeHtml(who)}</span><span class="where">${escapeHtml(event.project || '')}</span>`
    + `<span class="t">${duration(Date.now() - event.ts)}</span></div>`
    + `<div class="what">${ICONS[event.kind]} ${escapeHtml(text)}</div></li>`;
}

function matches(event) {
  if (filter === 'waiting') return event.kind === 'waiting' && stillWaiting(event);
  if (filter === 'mine') return ownerOf(event) === myLogin;
  return true;
}

export function renderFeed() {
  if (!state.data) return;
  const open = feed.classList.contains('open');
  const events = state.data.events.filter((e) => FEED_KINDS.has(e.kind)).filter(matches).sort((a, b) => b.ts - a.ts);
  const shown = events.slice(0, open ? EXPANDED_ITEMS : COLLAPSED_ITEMS);
  document.getElementById('feedCount').textContent = events.length ? `${events.length}` : '';
  list.innerHTML = shown.map(itemHtml).join('')
    || `<li class="empty">${CLAN_ID ? 'No updates yet. Members share them from their town\'s 🛡 panel.' : 'No updates yet today.'}</li>`;
}

document.getElementById('feedToggle').addEventListener('click', () => {
  const open = !feed.classList.contains('open');
  feed.classList.toggle('open', open);
  rememberOpen(open);
  renderFeed();
});

document.getElementById('feedFilters').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-filter]');
  if (!chip) return;
  filter = chip.dataset.filter;
  for (const other of document.querySelectorAll('#feedFilters [data-filter]')) other.classList.toggle('on', other === chip);
  renderFeed();
});

list.addEventListener('click', (e) => {
  const item = e.target.closest('li[data-id]');
  if (item && state.workers.has(item.dataset.id)) selectWorker(item.dataset.id, true);
});

feed.classList.toggle('open', rememberedOpen());
// "Mine" only means something in a clan's town, where the page asks the hub who you are.
if (CLAN_ID) {
  fetch('/api/me').then((r) => r.json()).then((me) => { myLogin = me.user ? me.user.login : ''; }).catch(() => {});
} else {
  document.querySelector('#feedFilters [data-filter="mine"]').remove();
}
