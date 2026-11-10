// The Clans panel: link this Mac to a clan hub, choose which projects each clan sees, and open clan towns.
// In a clan's own town (served by the hub) the same button goes back to the hub's list of your clans.
import { CLAN_ID } from '../config.js';
import { addToast } from '../hud.js';
import { state } from '../state.js';
import { api } from './forms.js';
import { duration, escapeHtml, icon } from '../utils.js';

const HUB_KEY = 'agentColony.hub';
const UPDATES_NOTE = 'Adds what your agents say at the end of each turn, and the questions they ask you, for shared projects only. '
  + 'Off: clans see only status and current tool.';
const PRIVACY_NOTE = 'A clan sees each shared project\'s name, size and failing builds, and its agents\' status and current tool. '
  + 'Never your code, prompts, commands, questions or folder paths.';

const panel = document.getElementById('clans');
const body = document.getElementById('clansBody');
let status = null;

function rememberedHub() {
  try { return localStorage.getItem(HUB_KEY) || ''; } catch { return ''; }
}

function rememberHub(hub) {
  try { localStorage.setItem(HUB_KEY, hub); } catch { /* storage unavailable */ }
}

const LINK_NOTE = 'You sign in with GitHub on the hub, then come back here. Nothing is shared until you choose projects.';
const PREPARE_DELAY_MS = 400;
let prepareTimer = null;

// Hub pages open as plain links in a new window: browsers never block those, and the wallpaper hands
// them to your default browser. (Opening a window after waiting on the server counts as a pop-up.)
function hubLink(url, label, id = '') {
  return `<a class="btn" target="_blank" rel="noopener"${id ? ` id="${id}"` : ''} href="${escapeHtml(url)}">${label}</a>`;
}

function hubHost(hub) {
  return hub.replace(/^https?:\/\//, '');
}

function linkForm(broken) {
  const intro = broken
    ? '<p class="warn">The hub no longer accepts this Mac (it was unlinked there). Link it again to keep sharing.</p>'
    : '<p>Share chosen projects with your team on a clan hub, and see everyone\'s agents in one town. You can be in several clans.</p>';
  const hub = broken ? status.hub : rememberedHub();
  return `${intro}
    <div class="field"><div class="label">HUB ADDRESS</div><input id="clanHub" placeholder="https://colony.example.com" value="${escapeHtml(hub)}"></div>
    <div class="note" id="clanLinkNote">${LINK_NOTE}</div>
    <div class="row-buttons"><a class="btn" id="clanLink" target="_blank" rel="noopener" aria-disabled="true">${icon('link')} LINK WITH GITHUB</a></div>`;
}

// The sign-in link is made as soon as there is a hub address, so clicking it opens the hub straight away.
async function prepareLink() {
  const input = document.getElementById('clanHub');
  const link = document.getElementById('clanLink');
  const note = document.getElementById('clanLinkNote');
  if (!input || !link) return;
  const hub = input.value.trim();
  link.removeAttribute('href');
  link.setAttribute('aria-disabled', 'true');
  if (!hub) return;
  const result = await api('/api/clan/link', { hub }, true);
  if (input.value.trim() !== hub) return;
  note.innerHTML = result.ok ? escapeHtml(LINK_NOTE) : `${icon('warning-diamond')} ${escapeHtml(result.message || 'Could not reach the colony server.')}`;
  if (!result.ok) return;
  link.href = result.url;
  link.removeAttribute('aria-disabled');
}

function pushLine() {
  if (status.hubError) return `<span class="warn">${icon('warning-diamond')} Can't reach the hub: ${escapeHtml(status.hubError)}</span>`;
  const push = status.lastPush;
  if (!push.at) return '<span class="dim">Connecting to the hub…</span>';
  const age = Date.now() - push.at;
  if (push.ok) return `<span class="ok">${icon('check')} Sharing · last sent ${age < 60000 ? 'just now' : `${duration(age)} ago`}</span>`;
  return `<span class="warn">${icon('warning-diamond')} ${escapeHtml(push.message)}</span>`;
}

function clanRows() {
  if (!status.clans.length) return '<p class="dim">You are not in a clan yet. Create one or join with an invite code on the hub.</p>';
  return status.clans.map((clan) => `<div class="clan-row"><span>${escapeHtml(clan.name)}<span class="dim">${clan.role === 'leader' ? 'Leader' : 'Member'} · ${clan.members} member${clan.members === 1 ? '' : 's'}</span></span>`
    + `${hubLink(`${status.hub}/clans/${encodeURIComponent(clan.id)}`, `OPEN TOWN ${icon('external-link')}`)}</div>`).join('');
}

// Every project in your town, plus any shared project that isn't on a plot right now.
function shareTable() {
  if (!status.clans.length) return '';
  const names = new Set((state.data ? state.data.projects : []).map((p) => p.name));
  for (const name of Object.keys(status.shares)) names.add(name);
  const head = status.clans.map((clan) => `<th>${escapeHtml(clan.name)}</th>`).join('');
  const rows = [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
    const shared = status.shares[name] || [];
    const boxes = status.clans.map((clan) => `<td><input type="checkbox" data-project="${escapeHtml(name)}" data-clan="${escapeHtml(clan.id)}"${shared.includes(clan.id) ? ' checked' : ''} aria-label="Share ${escapeHtml(name)} with ${escapeHtml(clan.name)}"></td>`).join('');
    return `<tr><td>${escapeHtml(name)}</td>${boxes}</tr>`;
  }).join('');
  return `<div class="section"><div class="label">SHARE PROJECTS</div><table><tr><th>PROJECT</th>${head}</tr>${rows}</table>`
    + `<div class="note">${PRIVACY_NOTE}</div></div>`;
}

function linkedView() {
  const who = status.user ? `@${escapeHtml(status.user.login)}` : 'you';
  return `<div class="linked-as"><span>Linked as <b>${who}</b> on ${escapeHtml(hubHost(status.hub))}</span><button class="btn danger" id="clanUnlink">UNLINK</button></div>
    <div class="note">${pushLine()}</div>
    <div class="section"><div class="label">YOUR CLANS</div>${clanRows()}
      <div class="row-buttons">${hubLink(`${status.hub}/`, `CREATE OR JOIN A CLAN ${icon('external-link')}`)}</div></div>
    ${shareTable()}
    <div class="section"><label class="switch"><input type="checkbox" id="clanShareUpdates"${status.shareUpdates ? ' checked' : ''}> Share my agents' updates</label>
      <div class="note">${UPDATES_NOTE}</div></div>`;
}

function render() {
  if (!status) {
    body.innerHTML = '<p class="dim">Loading…</p>';
    return;
  }
  const linked = status.linked && !status.broken;
  body.innerHTML = linked ? linkedView() : linkForm(status.broken);
  document.getElementById('btnClans').classList.toggle('on', linked);
  if (!linked) prepareLink();
}

async function refresh() {
  const result = await api('/api/clan/status', {}, true);
  status = result.ok ? result : { linked: false, broken: false, hub: '', user: null, clans: [], shares: {}, lastPush: { at: 0 } };
  if (!result.ok && result.message) addToast(result.message, '', 'warning-diamond');
  render();
}

export function openClans() {
  panel.classList.add('open');
  render();
  refresh();
}

function closeClans() {
  panel.classList.remove('open');
}

body.addEventListener('click', async (e) => {
  const target = e.target.closest('button, a');
  if (!target) return;
  if (target.id === 'clanLink') {
    if (!target.href) {
      e.preventDefault();
      document.getElementById('clanHub').focus();
      return;
    }
    rememberHub(document.getElementById('clanHub').value.trim());
    document.getElementById('clanLinkNote').textContent = 'Finish signing in on the hub in your browser. This panel updates when you come back.';
  } else if (target.id === 'clanUnlink') {
    const result = await api('/api/clan/unlink', {});
    if (result.ok) addToast('This Mac is no longer linked', 'info', 'shield');
    refresh();
  }
});

body.addEventListener('input', (e) => {
  if (e.target.id !== 'clanHub') return;
  clearTimeout(prepareTimer);
  prepareTimer = setTimeout(prepareLink, PREPARE_DELAY_MS);
});

body.addEventListener('change', async (e) => {
  if (e.target.id === 'clanShareUpdates') {
    const result = await api('/api/clan/updates', { share: e.target.checked });
    if (result.ok) {
      status.shareUpdates = result.shareUpdates;
      addToast(result.message, 'info', 'shield');
    } else {
      e.target.checked = !e.target.checked;
    }
    return;
  }
  const box = e.target.closest('input[data-project]');
  if (!box) return;
  const project = box.dataset.project;
  const boxes = body.querySelectorAll(`input[data-project="${CSS.escape(project)}"]`);
  const clans = [...boxes].filter((b) => b.checked).map((b) => b.dataset.clan);
  const result = await api('/api/clan/shares', { project, clans });
  if (result.ok) status.shares = result.shares;
  else box.checked = !box.checked;
});

document.getElementById('clansClose').onclick = closeClans;
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeClans();
});

// Coming back from the hub after linking, or switching back to this window, shows the current state.
window.addEventListener('focus', () => {
  if (panel.classList.contains('open')) refresh();
});

if (CLAN_ID) {
  document.getElementById('btnClans').title = 'All your clans';
  document.getElementById('btnClans').onclick = () => { location.href = '/'; };
} else {
  document.getElementById('btnClans').onclick = () => (panel.classList.contains('open') ? closeClans() : openClans());
  const params = new URLSearchParams(location.search);
  if (params.get('clan') === 'linked') {
    const url = new URL(location.href);
    url.searchParams.delete('clan');
    history.replaceState(null, '', url);
    addToast('This Mac is linked. Choose which projects each clan sees.', 'info', 'shield');
    openClans();
  }
}
