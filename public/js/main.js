// Agent Colony page entry point: wallpaper hooks, the frame loop and start-up.
import { fitCamera, resize } from './camera.js';
import { PARAMS, WALLPAPER, WALLPAPER_FRAME_MS } from './config.js';
import { updateClock } from './hud.js';
import { render } from './render.js';
import { paintGround, placeScenery } from './scenery.js';
import { update } from './simulation.js';
import { liteMode, setLiteMode, state } from './state.js';
import { connect } from './sync.js';
import { drawCrewPortraits } from './ui/boards.js';
import { closeBuildingMenu, closeHireForm, openFoundForm } from './ui/forms.js';
import { selectWorker } from './ui/sheet.js';
// Mouse and keyboard handlers attach themselves when this loads.
import './input.js';

// The wallpaper app passes how much of the screen the menu bar and Dock cover.
for (const side of ['top', 'bottom', 'left', 'right']) {
  const pixels = Number(PARAMS.get(side));
  if (pixels > 0) document.documentElement.style.setProperty(`--inset-${side}`, `${pixels}px`);
}

// Hooks for the menu-bar app: jump to an agent waiting on you, or open the new app / new chat form.
window.colonyFocusAgent = (agentId) => {
  if (state.workers.has(agentId)) selectWorker(agentId, true);
};

window.colonyOpenNewProject = () => openFoundForm();

window.colonySetWorkMode = (working) => {
  const changed = working === liteMode;
  setLiteMode(WALLPAPER && !working);
  document.getElementById('statusDetails').classList.remove('open');
  if (changed) fitCamera();
  document.body.classList.toggle('wallpaper', liteMode);
  if (!working) {
    closeBuildingMenu();
    closeHireForm();
  }
};
function frame(now) {
  // Wallpaper mode draws about 15 frames a second to save battery.
  if (liteMode && now - (frame.last || 0) < WALLPAPER_FRAME_MS) {
    requestAnimationFrame(frame);
    return;
  }
  const dt = Math.min(0.1, (now - (frame.last || now)) / 1000);
  frame.last = now;
  if (!state.paused && state.data) update(dt * state.speed);
  if (state.following && state.selectedId) {
    const worker = state.workers.get(state.selectedId);
    if (worker) {
      state.camera.x += (worker.x - state.camera.x) * 0.1;
      state.camera.y += (worker.y - state.camera.y) * 0.1;
    }
  }
  if (state.data) render();
  if (document.getElementById('crew').classList.contains('open')) drawCrewPortraits();
  updateClock();
  requestAnimationFrame(frame);
}

paintGround();
placeScenery();
resize();
fitCamera();
window.addEventListener('resize', () => {
  resize();
  if (WALLPAPER) fitCamera();
});
connect();
requestAnimationFrame(frame);
