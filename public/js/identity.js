// Who each agent is: name, look, model family and level.
import { HAIRS, NAMES, SKINS } from './config.js';
import { hash, pick } from './utils.js';

function modelFamily(model, kind) {
  const name = String(model || '').toLowerCase();
  if (kind === 'codex' || /gpt|codex/.test(name)) return 'codex';
  if (/fable|mythos/.test(name)) return 'fable';
  if (/opus/.test(name)) return 'opus';
  if (/sonnet/.test(name)) return 'sonnet';
  if (/haiku/.test(name)) return 'haiku';
  return 'opus';
}

const FAMILY = {
  opus: { shirt: '#8e5bd6', className: 'Architect' },
  sonnet: { shirt: '#3d8be0', className: 'Builder' },
  haiku: { shirt: '#4cbf6a', className: 'Runner' },
  fable: { shirt: '#e0a92c', className: 'Sage' },
  codex: { shirt: '#22a6a0', className: 'Tinkerer' },
};

export function prettyModel(model) {
  if (!model) return 'Unknown model';
  return model.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d)$/, ' $1')
    .replace(/^\w/, (c) => c.toUpperCase());
}

const assignedNames = new Map();

function nameFor(id) {
  if (assignedNames.has(id)) return assignedNames.get(id);
  const taken = new Set(assignedNames.values());
  const start = hash(id) % NAMES.length;
  let name = NAMES[start];
  for (let i = 0; i < NAMES.length && taken.has(name); i++) name = NAMES[(start + i) % NAMES.length];
  if (taken.has(name)) name = `${NAMES[start]} ${assignedNames.size}`;
  assignedNames.set(id, name);
  return name;
}

export function identity(agent) {
  const seed = hash(agent.id);
  const family = modelFamily(agent.model, agent.kind);
  const className = agent.kind === 'subagent' ? 'Apprentice' : FAMILY[family].className;
  return {
    name: nameFor(agent.id),
    family,
    className,
    skin: pick(SKINS, seed >>> 5),
    hair: pick(HAIRS, seed >>> 9),
    shirt: FAMILY[family].shirt,
    pants: ['#2f3a56', '#3a2f2f', '#2f4a3a', '#444'][(seed >>> 13) % 4],
  };
}

export function xpOf(agent) {
  return (agent.linesAdded + agent.linesRemoved) + agent.toolCalls * 2 + agent.tokens.output / 1000;
}

export function levelOf(xp) {
  return Math.floor(Math.sqrt(xp / 25)) + 1;
}

export function levelProgress(xp) {
  const level = levelOf(xp);
  const floorXp = 25 * (level - 1) ** 2;
  const nextXp = 25 * level ** 2;
  return (xp - floorXp) / (nextXp - floorXp);
}

export function efficiency(agent) {
  const lines = agent.linesAdded + agent.linesRemoved;
  if (agent.cost < 0.01) return lines > 0 ? lines : 0;
  return lines / agent.cost;
}
