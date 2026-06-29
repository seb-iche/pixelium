/**
 * eater.js
 * Defines the Eater lifecycle system — pixelated creatures that consume
 * colony cells, grow through four stages (worm → colourworm → thickworm → frog),
 * repel each other spatially, and trigger colour-specific audio events.
 *
 * Growth is correlated with world colony count: a busier ecosystem means
 * faster eater development. Eaters avoid overlapping via a repulsion force
 * proportional to their current stage size.
 */

import { BIOMES as BIOMES_REF } from './biomes.js';

const CELL_SIZE = 3;
const DEFAULT_EATER_SPEED = 0.8;
const DEFAULT_EAT_COOLDOWN = 60;
const DEFAULT_MAX_EATERS = 5;
const EAT_RADIUS = 12;
const SCAR_DURATION = 500;
const PAUSE_AFTER_EAT = 20;
const ZONE_RADIUS = 50;
const CELLS_PER_SEGMENT = 20;

/**
 * STAGES
 * Purpose:  Ordered lifecycle stage definitions.
 * Fields:
 *   name      string   — Stage identifier
 *   minEaten  number   — Total cells eaten to reach this stage
 *   size      number   — Head/body pixel radius
 *   eatMult   number   — Speed and eat-rate multiplier
 *   colored   boolean  — Whether body shows eaten colour history
 */
const STAGES = [
  { name: 'worm',      minEaten: 0,  size: 2, eatMult: 1.0, colored: false },
  { name: 'colorworm', minEaten: 12,  size: 2, eatMult: 1.3, colored: true  },
  { name: 'thickworm', minEaten: 35, size: 3, eatMult: 1.6, colored: true  },
  { name: 'frog',      minEaten: 80, size: 4, eatMult: 2.0, colored: true  },
];

/**
 * getStage
 * Purpose:  Return the lifecycle stage for a given total eaten count.
 * Input:    totalEaten  number
 * Output:   Object  — Stage config from STAGES
 */
function getStage(totalEaten) {
  let stage = STAGES[0];
  for (const s of STAGES) {
    if (totalEaten >= s.minEaten) stage = s;
  }
  return stage;
}

/**
 * Eater
 * Purpose:  A single eater creature with position, velocity, body trail,
 *           colour history, and lifecycle state.
 *
 * Properties:
 *   x, y             number    — Head position (px)
 *   vx, vy           number    — Velocity (px/tick)
 *   angle            number    — Movement angle (radians)
 *   eatCooldown      number    — Ticks until next eat attempt
 *   pauseTimer       number    — Forced rest after eating
 *   frame            number    — Animation frame (0 or 1)
 *   frameTick        number    — Frame switch counter
 *   body             {x,y}[]  — Position history; head = index 0
 *   targetLength     number    — Target body segment count
 *   totalEaten       number    — Lifetime cells consumed
 *   zoneX, zoneY     number    — Current feeding zone centre
 *   cellsEatenInZone number    — Cells eaten in current zone
 *   zoneThreshold    number    — Cells before migrating
 *   migrating        boolean   — Travelling to new zone
 *   migrateTargetX/Y number    — Migration destination
 *   colorCounts      Object    — { family: count } in current zone
 *   colorHistory     string[]  — Last 10 eaten hex colours
 *   bodyColor        string|null — Blended body colour
 *   stage            Object    — Current STAGES entry
 */
export class Eater {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.vx = (Math.random() - 0.5) * DEFAULT_EATER_SPEED;
    this.vy = (Math.random() - 0.5) * DEFAULT_EATER_SPEED;
    this.angle = Math.random() * Math.PI * 2;
    this.eatCooldown = 0;
    this.pauseTimer = 0;
    this.frame = 0;
    this.frameTick = 0;
    this.body = [{ x, y }];
    this.targetLength = 1;
    this.totalEaten = 0;
    this.zoneX = x; this.zoneY = y;
    this.cellsEatenInZone = 0;
    this.zoneThreshold = 5 + Math.floor(Math.random() * 10);
    this.migrating = false;
    this.migrateTargetX = x; this.migrateTargetY = y;
    this.colorCounts = {};
    this.colorHistory = [];
    this.bodyColor = null;
    this.stage = STAGES[0];
  }
}

/**
 * createEaterState
 * Purpose:  Initialise shared eater subsystem state.
 * Input:    none
 * Output:   Object — { eaters, scars, edgeCache, edgeCacheAge, mouse }
 */
export function createEaterState() {
  return {
    eaters: [],
    scars: new Map(),
    edgeCache: [],
    edgeCacheAge: 0,
    mouse: { x: -999, y: -999 },
  };
}

/**
 * spawnEater
 * Purpose:  Spawn a new eater at a random edge cell, respecting maxEaters.
 * Input:    world  Object
 *           es     Object
 * Output:   void
 */
export function spawnEater(world, es) {
  const maxEaters = world.biome
    ? (BIOMES_REF[world.biome]?.eaters.maxEaters || DEFAULT_MAX_EATERS)
    : DEFAULT_MAX_EATERS;
  if (es.eaters.length >= maxEaters) return;
  _refreshEdgeCache(world, es);
  if (es.edgeCache.length === 0) return;
  const target = es.edgeCache[Math.floor(Math.random() * es.edgeCache.length)];
  const e = new Eater(target.x + CELL_SIZE / 2, target.y + CELL_SIZE / 2);
  e.zoneX = e.x; e.zoneY = e.y;
  es.eaters.push(e);
}

/**
 * _refreshEdgeCache
 * Purpose:  Rebuild bloomed edge cell list every 60 ticks (max 300 sample).
 * Input:    world  Object
 *           es     Object  (mutated)
 * Output:   void
 */
function _refreshEdgeCache(world, es) {
  es.edgeCacheAge++;
  if (es.edgeCacheAge < 60) return;
  es.edgeCacheAge = 0;
  const bloomed = world.cells.filter(c => c.bloomed);
  const sample = bloomed.length > 300
    ? bloomed.sort(() => Math.random() - 0.5).slice(0, 300)
    : bloomed;
  es.edgeCache = sample.filter(c => _isEdgeFast(c, world));
}

/**
 * _isEdgeFast
 * Purpose:  Check if a cell has at least one unoccupied 8-neighbour.
 * Input:    cell   Cell
 *           world  Object
 * Output:   boolean
 */
function _isEdgeFast(cell, world) {
  const gx = Math.floor(cell.x / CELL_SIZE);
  const gy = Math.floor(cell.y / CELL_SIZE);
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
    if (!world.occupied.has(`${gx+dx},${gy+dy}`)) return true;
  }
  return false;
}

/**
 * colorFamily
 * Purpose:  Classify a hex colour into a broad family for eat sound selection.
 * Input:    hex  string
 * Output:   string — 'blue'|'green'|'red'|'yellow'|'magenta'|'cyan'|'other'|'unknown'
 */
export function colorFamily(hex) {
  if (!hex) return 'unknown';
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  const max = Math.max(r,g,b);
  if (max === 0) return 'unknown';
  if (b === max && b > r*1.3 && b > g*1.1) return 'blue';
  if (g === max && g > r*1.2 && g > b*1.2) return 'green';
  if (r === max && r > g*1.3 && r > b*1.3) return 'red';
  if (r === max && g > b*1.2) return 'yellow';
  if (r === max && b > g*1.1) return 'magenta';
  if (g === max && b > r*1.1) return 'cyan';
  return 'other';
}

/**
 * _dominantFamily
 * Purpose:  Find the most-eaten colour family in the current zone.
 * Input:    colorCounts  Object
 * Output:   string
 */
function _dominantFamily(colorCounts) {
  let best = 'other', bestCount = 0;
  for (const [fam, count] of Object.entries(colorCounts)) {
    if (count > bestCount) { bestCount = count; best = fam; }
  }
  return best;
}

/**
 * _pickNewZone
 * Purpose:  Select a far migration target from the edge cache.
 * Input:    eater  Eater  (mutated)
 *           world  Object
 *           es     Object
 * Output:   void
 */
function _pickNewZone(eater, world, es) {
  if (es.edgeCache.length === 0) return;
  let best = null, bestDist = 0;
  for (let i = 0; i < 8; i++) {
    const c = es.edgeCache[Math.floor(Math.random() * es.edgeCache.length)];
    const dx = c.x - eater.x, dy = c.y - eater.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist > bestDist) { bestDist = dist; best = c; }
  }
  if (best) {
    eater.migrateTargetX = best.x + CELL_SIZE / 2;
    eater.migrateTargetY = best.y + CELL_SIZE / 2;
  }
}

/**
 * _blendColorHistory
 * Purpose:  Average the last N eaten colours into one body colour.
 * Input:    history  string[]
 * Output:   string|null
 */
function _blendColorHistory(history) {
  if (!history || history.length === 0) return null;
  let r = 0, g = 0, b = 0;
  for (const hex of history) {
    r += parseInt(hex.slice(1,3),16);
    g += parseInt(hex.slice(3,5),16);
    b += parseInt(hex.slice(5,7),16);
  }
  const n = history.length;
  const toHex = v => Math.round(v/n).toString(16).padStart(2,'0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * tickEaters
 * Purpose:  Advance all eaters one tick: scar ageing, edge cache refresh,
 *           movement, repulsion, body update, eating, colour history, growth.
 * Input:    world  Object  (mutated)
 *           es     Object  (mutated)
 * Output:   void
 */
export function tickEaters(world, es) {
  const biomeEaters = world.biome ? (BIOMES_REF[world.biome]?.eaters || {}) : {};
  const BASE_SPEED = biomeEaters.speed || DEFAULT_EATER_SPEED;
  const BASE_COOLDOWN = biomeEaters.eatCooldown || DEFAULT_EAT_COOLDOWN;

  for (const [key, remaining] of es.scars) {
    if (remaining <= 1) {
      es.scars.delete(key);
      world.occupied.delete(key);
    } else {
      es.scars.set(key, remaining - 1);
    }
  }

  _refreshEdgeCache(world, es);

  for (const eater of es.eaters) {
    eater.stage = getStage(eater.totalEaten);
    const stage = eater.stage;

    // On transition to coloured stage, immediately apply existing history
    if (stage.colored && !eater.bodyColor && eater.colorHistory.length > 0) {
      eater.bodyColor = _blendColorHistory(eater.colorHistory);
    }

    const EATER_SPEED = BASE_SPEED * stage.eatMult * 0.7;
    const EAT_COOLDOWN = Math.max(5, Math.floor(BASE_COOLDOWN / stage.eatMult));

    eater.eatCooldown = Math.max(0, eater.eatCooldown - 1);
    eater.frameTick++;
    if (eater.frameTick > Math.max(2, 8 - stage.size)) {
      eater.frameTick = 0;
      eater.frame = (eater.frame + 1) % 2;
    }

    if (eater.pauseTimer > 0) { eater.pauseTimer--; continue; }

    if (eater.migrating) {
      const tx = eater.migrateTargetX - eater.x;
      const ty = eater.migrateTargetY - eater.y;
      const dist = Math.sqrt(tx*tx + ty*ty);
      if (dist < ZONE_RADIUS * 0.5) {
        eater.migrating = false;
        eater.zoneX = eater.migrateTargetX;
        eater.zoneY = eater.migrateTargetY;
        eater.cellsEatenInZone = 0;
        eater.zoneThreshold = 5 + Math.floor(Math.random() * 10);
        eater.colorCounts = {};
      } else {
        const mag = dist || 1;
        eater.vx = eater.vx * 0.7 + (tx/mag) * EATER_SPEED * 1.8;
        eater.vy = eater.vy * 0.7 + (ty/mag) * EATER_SPEED * 1.8;
        const spd = Math.sqrt(eater.vx*eater.vx + eater.vy*eater.vy);
        if (spd > EATER_SPEED * 2.2) {
          eater.vx = (eater.vx/spd) * EATER_SPEED * 2.2;
          eater.vy = (eater.vy/spd) * EATER_SPEED * 2.2;
        }
      }
    } else {
      const zoneDistX = eater.x - eater.zoneX;
      const zoneDistY = eater.y - eater.zoneY;
      const zoneDist = Math.sqrt(zoneDistX*zoneDistX + zoneDistY*zoneDistY);
      eater.angle += (Math.random() - 0.5) * 0.3;
      eater.vx = eater.vx * 0.88 + Math.cos(eater.angle) * EATER_SPEED * 0.12;
      eater.vy = eater.vy * 0.88 + Math.sin(eater.angle) * EATER_SPEED * 0.12;
      if (zoneDist > ZONE_RADIUS) {
        eater.vx -= (zoneDistX/zoneDist) * 0.4;
        eater.vy -= (zoneDistY/zoneDist) * 0.4;
      }
      const spd = Math.sqrt(eater.vx*eater.vx + eater.vy*eater.vy);
      if (spd > EATER_SPEED * 1.3) {
        eater.vx = (eater.vx/spd) * EATER_SPEED * 1.3;
        eater.vy = (eater.vy/spd) * EATER_SPEED * 1.3;
      }
      if (eater.cellsEatenInZone >= eater.zoneThreshold) {
        const dominant = _dominantFamily(eater.colorCounts);
        if (world.audio) world.audio.triggerEatSound(dominant);
        eater.migrating = true;
        _pickNewZone(eater, world, es);
      }
    }

    // Repulsion — radius and force scale with stage size
    const repelRadius = 30 + stage.size * 10;
    for (const other of es.eaters) {
      if (other === eater) continue;
      const rx = eater.x - other.x, ry = eater.y - other.y;
      const rdist = Math.sqrt(rx*rx + ry*ry);
      if (rdist < repelRadius && rdist > 0) {
        const force = (1 - rdist / repelRadius) * 0.5;
        eater.vx += (rx / rdist) * force;
        eater.vy += (ry / rdist) * force;
        eater.angle += (rx > 0 ? 0.15 : -0.15);
      }
    }

    eater.x += eater.vx;
    eater.y += eater.vy;
    if (eater.x < 0 || eater.x > world.W) { eater.vx *= -1; eater.angle = Math.PI - eater.angle; }
    if (eater.y < 0 || eater.y > world.H) { eater.vy *= -1; eater.angle = -eater.angle; }

    eater.body.unshift({ x: eater.x, y: eater.y });
    const maxSegments = Math.min(eater.targetLength * 6, 20 + stage.size * 4);
    if (eater.body.length > maxSegments) eater.body.length = maxSegments;

    if (!eater.migrating && eater.eatCooldown === 0) {
      const eatenColor = _tryEatFast(eater, world, es);
      if (eatenColor) {
        eater.eatCooldown = EAT_COOLDOWN;
        eater.pauseTimer = PAUSE_AFTER_EAT;
        eater.cellsEatenInZone++;
        eater.totalEaten++;
        const fam = colorFamily(eatenColor);
        eater.colorCounts[fam] = (eater.colorCounts[fam] || 0) + 1;
        eater.colorHistory.push(eatenColor);
        if (eater.colorHistory.length > 10) eater.colorHistory.shift();
        if (stage.colored) {
          eater.bodyColor = _blendColorHistory(eater.colorHistory);
        }
        // Growth threshold decreases as world colony count rises
        const colonyBonus = Math.min(5, Math.floor(world.colonies.length / 8));
        const growThreshold = Math.max(10, CELLS_PER_SEGMENT - colonyBonus);
        if (eater.totalEaten % growThreshold === 0) {
          eater.targetLength++;
        }
      }
    }
  }
}

/**
 * _tryEatFast
 * Purpose:  Eat the nearest eligible edge cell within EAT_RADIUS.
 *           Bounding-box pre-filter avoids scanning all cells.
 * Input:    eater  Eater  (mutated)
 *           world  Object  (mutated)
 *           es     Object  (mutated)
 * Output:   string|null  — Hex colour of eaten cell, or null
 */
function _tryEatFast(eater, world, es) {
  const ex = eater.x, ey = eater.y;
  for (let i = world.cells.length - 1; i >= 0; i--) {
    const c = world.cells[i];
    if (!c.bloomed) continue;
    const dx = c.x + CELL_SIZE/2 - ex;
    const dy = c.y + CELL_SIZE/2 - ey;
    if (Math.abs(dx) > EAT_RADIUS*2 || Math.abs(dy) > EAT_RADIUS*2) continue;
    if (Math.sqrt(dx*dx + dy*dy) < EAT_RADIUS && _isEdgeFast(c, world)) {
      const key = `${Math.floor(c.x/CELL_SIZE)},${Math.floor(c.y/CELL_SIZE)}`;
      const eaten = c.neonColor;
      world.cells.splice(i, 1);
      const col = world.colonies.find(col => col.id === c.colonyId);
      if (col) { const ci = col.cells.indexOf(c); if (ci !== -1) col.cells.splice(ci, 1); }
      es.scars.set(key, SCAR_DURATION);
      world.occupied.add(key);
      return eaten;
    }
  }
  return null;
}