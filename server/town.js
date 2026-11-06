// The town layout seed, shared by every screen until you rebuild the town.
const fs = require('fs');
const crypto = require('crypto');
const { TOWN_FILE } = require('./config');

function newTownSeed() {
  return crypto.randomInt(1, 2 ** 31 - 1);
}

function loadTownSeed() {
  try {
    const seed = JSON.parse(fs.readFileSync(TOWN_FILE, 'utf8')).seed;
    if (Number.isInteger(seed) && seed > 0) return seed;
  } catch { /* first run */ }
  const seed = newTownSeed();
  fs.writeFileSync(TOWN_FILE, JSON.stringify({ seed }, null, 2));
  return seed;
}

let townSeed = loadTownSeed();

function currentTownSeed() {
  return townSeed;
}

// Several screens may ask at once; only a request that still names the current seed rebuilds.
function rebuildTown(currentSeed) {
  if (currentSeed !== townSeed) return;
  townSeed = newTownSeed();
  fs.writeFileSync(TOWN_FILE, JSON.stringify({ seed: townSeed }, null, 2));
  console.log('Town layout rebuilt');
}

module.exports = { currentTownSeed, rebuildTown };
