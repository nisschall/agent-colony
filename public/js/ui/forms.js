// Talking to the server, plus the building menu, new app / new chat and hire forms.
import { API_TOKEN, FLOOR_H } from '../config.js';
import { addToast } from '../hud.js';
import { state } from '../state.js';
import { money } from '../utils.js';

// `quiet` skips the error toast, for requests that repeat on a timer.
export async function api(path, body, quiet = false) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Colony-Token': API_TOKEN },
      body: JSON.stringify(body || {}),
    });
    const result = await response.json();
    if (!result.ok && !quiet) addToast(`⚠ ${result.message}`);
    return result;
  } catch {
    if (!quiet) addToast('⚠ Could not reach the colony server');
    return { ok: false };
  }
}

let menuBuilding = null;

export function openBuildingMenu(building, sx, sy) {
  menuBuilding = building;
  const menu = document.getElementById('ctxMenu');
  document.getElementById('ctxTitle').textContent = building.name.toUpperCase();
  document.getElementById('ctxHire').disabled = !building.project.path;
  menu.classList.add('open');
  menu.style.left = `${Math.min(sx, innerWidth - 220)}px`;
  menu.style.top = `${Math.min(sy, innerHeight - 120)}px`;
}

export function closeBuildingMenu() {
  document.getElementById('ctxMenu').classList.remove('open');
  document.getElementById('groundMenu').classList.remove('open');
}

export function openGroundMenu(sx, sy) {
  const menu = document.getElementById('groundMenu');
  menu.classList.add('open');
  menu.style.left = `${Math.min(sx, innerWidth - 240)}px`;
  menu.style.top = `${Math.min(sy, innerHeight - 60)}px`;
}

function showFoundFields() {
  const isNew = document.getElementById('foundMode').value === 'new';
  document.getElementById('newFields').style.display = isNew ? '' : 'none';
  document.getElementById('existingFields').style.display = isNew ? 'none' : '';
}

export function openFoundForm() {
  state.hireMode = 'found';
  openHireForm(null);
}

function openHireForm(building) {
  closeBuildingMenu();
  menuBuilding = building;
  const founding = !building;
  if (!founding) state.hireMode = 'hire';
  document.getElementById('whereBlock').classList.toggle('open', founding);
  document.getElementById('hireTitle').textContent = founding ? '✨ NEW APP OR NEW CHAT' : `HIRE AN AGENT — ${building.name}`;
  document.getElementById('hirePath').textContent = founding ? 'A new building rises for it in the town.' : `Works in ${building.project.path}`;
  const parentInput = document.getElementById('foundParent');
  if (founding && !parentInput.value) parentInput.value = state.data.defaults.projectsFolder;
  showFoundFields();
  const spent = state.data.totals.costToday;
  document.getElementById('hireBudget').textContent = spent >= state.budget
    ? `Today's spend (${money(spent)}) is already over your ${money(state.budget)} budget.`
    : '';
  document.getElementById('hire').classList.add('open');
  document.getElementById(founding ? 'foundName' : 'hireBrief').focus();
}

document.getElementById('foundMode').onchange = showFoundFields;
document.getElementById('groundFound').onclick = () => {
  closeBuildingMenu();
  openFoundForm();
};

export function closeHireForm() {
  document.getElementById('hire').classList.remove('open');
}

document.getElementById('ctxHire').onclick = () => openHireForm(menuBuilding);
document.getElementById('ctxZoom').onclick = () => {
  closeBuildingMenu();
  state.following = false;
  state.camera.x = menuBuilding.x;
  state.camera.y = menuBuilding.y - menuBuilding.floors * FLOOR_H / 2;
  state.camera.zoom = 3.5;
};
document.getElementById('hireClose').onclick = closeHireForm;
document.getElementById('hireCancel').onclick = closeHireForm;
document.getElementById('hireGo').onclick = async () => {
  const brief = document.getElementById('hireBrief').value.trim();
  if (!brief) {
    addToast('⚠ Write a quest brief first');
    return;
  }
  const overBudget = state.data.totals.costToday >= state.budget;
  if (overBudget && !confirm('You are over today\'s budget. Hire this agent anyway?')) return;
  const button = document.getElementById('hireGo');
  button.disabled = true;
  const model = document.getElementById('hireModel').value;
  const founding = state.hireMode === 'found';
  const request = founding
    ? {
      mode: document.getElementById('foundMode').value,
      name: document.getElementById('foundName').value.trim(),
      parent: document.getElementById('foundParent').value.trim(),
      folder: document.getElementById('foundFolder').value.trim(),
      model,
      brief,
    }
    : { project: menuBuilding.name, model, brief };
  const result = await api(founding ? '/api/found' : '/api/hire', request);
  button.disabled = false;
  if (!result.ok) return;
  document.getElementById('hireBrief').value = '';
  document.getElementById('foundName').value = '';
  closeHireForm();
  addToast(founding ? `✨ New ${model} agent is starting the project` : `🧑‍🔧 New ${model} agent hired for ${menuBuilding.name}`, 'info');
  state.pendingSelect = result.agentId;
};
