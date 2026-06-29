/**
 * world.js
 * Core simulation engine. Manages the full world state and advances
 * the ecosystem one tick at a time.
 *
 * Responsibilities:
 *   - Grid management (CELL_SIZE, occupied set, grid key encoding)
 *   - Colony growth, bloom triggering, colour evolution
 *   - Spore physics, spore-spore collision, spore landing logic
 *   - Ripple lifecycle
 *   - Dust lifecycle (from separated colony sections)
 *   - Colony separation detection via flood fill
 *   - Audio state updates (colour buckets, world complexity)
 *   - Eater tick delegation
 *   - Eater spawn scheduling
 */

import { Cell, Colony, blendColors } from './colony.js';
import { hexToHue } from './audio.js';
import { createEaterState, spawnEater, tickEaters } from './eater.js';
import { BIOMES, DEFAULT_BIOME } from './biomes.js';

/**
 * CELL_SIZE
 * Purpose:  Side length (px) of each grid cell.
 * Type:     number
 */
export const CELL_SIZE = 3;

/**
 * MAX_CELLS
 * Purpose:  Upper bound on total cells. Currently unlimited.
 * Type:     number
 */
export const MAX_CELLS = Infinity;

/**
 * toGrid
 * Purpose:  Convert pixel coordinates to a unique string grid key.
 * Input:    x  number  — Pixel x
 *           y  number  — Pixel y
 * Output:   string  — e.g. '14,22'
 */
function toGrid(x, y) {
  return `${Math.floor(x / CELL_SIZE)},${Math.floor(y / CELL_SIZE)}`;
}

/**
 * snap
 * Purpose:  Snap a pixel value to the nearest grid slot origin.
 * Input:    v  number  — Pixel value
 * Output:   number  — Snapped pixel value (multiple of CELL_SIZE)
 */
function snap(v) {
  return Math.floor(v / CELL_SIZE) * CELL_SIZE;
}

/**
 * createWorld
 * Purpose:  Initialise a fresh world state with all subsystems empty.
 * Input:    biomeKey  string  — Biome ID from BIOMES (default: DEFAULT_BIOME)
 * Output:   Object — {
 *             cells      Cell[]
 *             colonies   Colony[]
 *             spores     Object[]
 *             ripples    Object[]
 *             dust       Object[]
 *             bloomCount number
 *             occupied   Set<string>
 *             es         Object
 *             biome      string
 *           }
 */
export function createWorld(biomeKey = DEFAULT_BIOME) {
  return {
    cells: [],
    colonies: [],
    spores: [],
    ripples: [],
    dust: [],
    bloomCount: 0,
    occupied: new Set(),
    es: createEaterState(),
    biome: biomeKey,
  };
}

/**
 * placeCell
 * Purpose:  Attempt to place a new Cell at the given coordinates.
 *           Rejects if slot is occupied or out of bounds.
 * Input:    world       Object  — World state (mutated: occupied)
 *           x           number  — Target pixel x
 *           y           number  — Target pixel y
 *           colonyId    number  — Owning colony ID
 *           generation  number  — Growth generation depth
 * Output:   Cell|null
 */
function placeCell(world, x, y, colonyId, generation) {
  const sx = snap(x), sy = snap(y);
  const key = toGrid(sx, sy);
  if (world.occupied.has(key)) return null;
  if (sx < 0 || sx + CELL_SIZE > world.W || sy < 0 || sy + CELL_SIZE > world.H) return null;
  world.occupied.add(key);
  return new Cell(sx, sy, colonyId, generation);
}

/**
 * spawnColony
 * Purpose:  Create a new colony at (x, y) seeded with up to 3 initial cells.
 * Input:    world  Object  — World state (mutated)
 *           x      number  — Origin pixel x
 *           y      number  — Origin pixel y
 * Output:   void
 */
export function spawnColony(world, x, y) {
  const col = new Colony(x, y, world.biome || DEFAULT_BIOME);
  const offsets = [[0,0],[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  let placed = 0;
  for (const [ox, oy] of offsets) {
    if (placed >= 3) break;
    const c = placeCell(world, x + ox * CELL_SIZE, y + oy * CELL_SIZE, col.id, 0);
    if (c) { col.cells.push(c); world.cells.push(c); placed++; }
  }
  if (placed > 0) world.colonies.push(col);
}

/**
 * spawnSporeRain
 * Purpose:  Release a batch of spores from the top of the canvas, staggered.
 * Input:    world  Object  — World state (mutated: spores)
 *           W      number  — Canvas width (px)
 *           H      number  — Canvas height (px)
 *           count  number  — Number of spores (default 12)
 * Output:   void
 */
export function spawnSporeRain(world, W, H, count = 12) {
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      world.spores.push({
        x: Math.random() * W, y: -10,
        vx: (Math.random() - 0.5) * 1.2,
        vy: 0.6 + Math.random() * 1.0,
        life: 1,
      });
    }, i * 80);
  }
}

/** DIRS — 8-directional unit offsets for grid neighbour scanning */
const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];

/**
 * checkCollision
 * Purpose:  After placing a new cell, check if it touches a different bloomed
 *           colony and trigger a collision sound if so.
 * Input:    world  Object  — World state
 *           cell   Cell    — Newly placed cell
 *           col    Colony  — Colony the new cell belongs to
 * Output:   void
 */
function checkCollision(world, cell, col) {
  if (!world.audio) return;
  for (const [dx, dy] of DIRS) {
    const nx = cell.x + dx * CELL_SIZE, ny = cell.y + dy * CELL_SIZE;
    const key = toGrid(nx, ny);
    if (!world.occupied.has(key)) continue;
    const neighbour = world.cells.find(
      c => c.x === nx && c.y === ny && c.colonyId !== col.id && c.bloomed
    );
    if (neighbour && col.bloomed) {
      world.audio.triggerCollision(col.colorB, neighbour.neonColor);
      return;
    }
  }
}

/**
 * growColony
 * Purpose:  Attempt to add one new cell to a colony. Triggers bloom if
 *           threshold is reached; otherwise evolves the colour palette.
 * Input:    world  Object  — World state (mutated)
 *           col    Colony  — Colony to grow (mutated)
 * Output:   void
 */
function growColony(world, col) {
  const source = col.cells[Math.floor(Math.random() * col.cells.length)];
  if (!source) return;
  const biome = BIOMES[world.biome] || BIOMES[DEFAULT_BIOME];
  const stepOptions = biome.growth.steps;
  const bloomThreshold = biome.growth.bloomThreshold;
  const dirs = DIRS.slice().sort(() => Math.random() - 0.5);
  for (const [dx, dy] of dirs) {
    const steps = stepOptions[Math.floor(Math.random() * stepOptions.length)];
    const nc = placeCell(world,
      source.x + dx * CELL_SIZE * steps,
      source.y + dy * CELL_SIZE * steps,
      col.id, source.generation + 1);
    if (nc) {
      col.cells.push(nc);
      world.cells.push(nc);
      if (!col.bloomed && col.cells.length >= bloomThreshold) {
        col.bloomed = true;
        world.bloomCount++;
        col.cells.forEach((c, i) => {
          c.bloomed = true;
          c.neonColor = i % 2 === 0 ? col.colorA : col.colorB;
        });
        if (world.audio) world.audio.triggerBloom(col.colorA);
      } else if (col.bloomed) {
        const newColor = blendColors(col.colorA, col.colorB);
        nc.bloomed = true;
        nc.neonColor = newColor;
        col.colorA = col.colorB;
        col.colorB = newColor;
      }
      checkCollision(world, nc, col);
      return;
    }
  }
}

/**
 * checkSporeCollisions
 * Purpose:  Detect when two spores come within 4 cells of each other,
 *           merging them into a new colony. One collision per tick max.
 * Input:    world  Object  — World state (mutated)
 * Output:   void
 */
function checkSporeCollisions(world) {
  for (let i = world.spores.length - 1; i >= 0; i--) {
    for (let j = i - 1; j >= 0; j--) {
      const a = world.spores[i], b = world.spores[j];
      if (!a || !b) continue;
      const dx = a.x - b.x, dy = a.y - b.y;
      if (Math.sqrt(dx*dx + dy*dy) < CELL_SIZE * 4) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        spawnColony(world, mx, my);
        if (world.audio) world.audio.triggerSporeCollision();
        world.spores.splice(i, 1);
        world.spores.splice(j, 1);
        return;
      }
    }
  }
}

/**
 * checkColonySeparation
 * Purpose:  BFS flood fill on each bloomed colony to find cells disconnected
 *           from the main body. Sections smaller than 30% become dust.
 * Input:    world  Object  — World state (mutated: cells, dust, occupied)
 * Output:   void
 */
export function checkColonySeparation(world) {
  for (const col of world.colonies) {
    if (!col.bloomed || col.cells.length < 10) continue;
    const cellMap = new Map();
    for (const c of col.cells) cellMap.set(toGrid(c.x, c.y), c);
    const visited = new Set();
    const queue = [col.cells[0]];
    visited.add(toGrid(col.cells[0].x, col.cells[0].y));
    while (queue.length > 0) {
      const curr = queue.shift();
      for (const [dx, dy] of DIRS) {
        const nk = toGrid(curr.x + dx * CELL_SIZE, curr.y + dy * CELL_SIZE);
        if (!visited.has(nk) && cellMap.has(nk)) {
          visited.add(nk);
          queue.push(cellMap.get(nk));
        }
      }
    }
    const separated = col.cells.filter(c => !visited.has(toGrid(c.x, c.y)));
    if (separated.length === 0) continue;
    if (separated.length > col.cells.length * 0.3) continue;
    for (const c of separated) {
      world.occupied.delete(toGrid(c.x, c.y));
      world.dust.push({ x: c.x, y: c.y, life: 1.0, age: 0,
        maxAge: 180 + Math.floor(Math.random() * 120) });
    }
    const sepSet = new Set(separated.map(c => toGrid(c.x, c.y)));
    col.cells = col.cells.filter(c => !sepSet.has(toGrid(c.x, c.y)));
    world.cells = world.cells.filter(c =>
      c.colonyId !== col.id || !sepSet.has(toGrid(c.x, c.y)));
  }
}

/**
 * tickDust
 * Purpose:  Age all dust particles; remove expired ones.
 * Input:    world  Object  — World state (mutated: dust)
 * Output:   void
 */
function tickDust(world) {
  for (let i = world.dust.length - 1; i >= 0; i--) {
    const d = world.dust[i];
    d.age++;
    d.life = 1 - (d.age / d.maxAge);
    if (d.life <= 0) world.dust.splice(i, 1);
  }
}

/**
 * tickWorld
 * Purpose:  Advance the full ecosystem one simulation tick.
 *           Order: suppress growth → grow colonies → spore collisions →
 *           spore physics → age cells → ripples → dust → audio →
 *           eaters → separation check → eater spawn.
 * Input:    world  Object  — Full world state (broadly mutated)
 * Output:   void
 */
export function tickWorld(world) {
  const suppressed = new Set();
  if (world.es) {
    for (const eater of world.es.eaters) {
      if (eater.migrating) continue;
      for (const col of world.colonies) {
        if (!col.bloomed) continue;
        for (const c of col.cells) {
          const dx = c.x - eater.zoneX, dy = c.y - eater.zoneY;
          if (Math.sqrt(dx*dx + dy*dy) < 60) { suppressed.add(col.id); break; }
        }
      }
    }
  }

  const biome = BIOMES[world.biome] || BIOMES[DEFAULT_BIOME];

  for (const col of world.colonies) {
    col.age++;
    col.sporeTimer--;
    if (!suppressed.has(col.id)) {
      const growRate = col.bloomed ? 3 : 2;
      for (let g = 0; g < growRate; g++) {
        if (Math.random() < biome.growth.rate) growColony(world, col);
      }
    }
    if (col.sporeTimer <= 0) {
      const [sMin, sMax] = biome.growth.sporeInterval;
      col.sporeTimer = sMin + Math.random() * (sMax - sMin);
      world.spores.push({
        x: col.x + (Math.random() - 0.5) * 20,
        y: col.y + (Math.random() - 0.5) * 20,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        life: 1,
      });
      if (world.audio) world.audio.triggerSpore();
    }
  }

  checkSporeCollisions(world);

  for (let i = world.spores.length - 1; i >= 0; i--) {
    const s = world.spores[i];
    s.x += s.vx; s.y += s.vy;
    s.vx += (Math.random() - 0.5) * 0.1;
    s.vy += (Math.random() - 0.5) * 0.1;
    s.life -= 0.004;
    const outOfBounds = s.x < 0 || s.x > world.W || s.y < 0 || s.y > world.H;
    if (s.life <= 0 || outOfBounds) {
      if (s.life > 0.1 && !outOfBounds) {
        const nearDust = world.dust.some(d => {
          const dx = d.x - s.x, dy = d.y - s.y;
          return Math.sqrt(dx*dx + dy*dy) < 40;
        });
        const nearCells = world.cells.some(c => {
          const dx = c.x - s.x, dy = c.y - s.y;
          return Math.sqrt(dx*dx + dy*dy) < 80;
        });
        if (nearDust) {
          spawnColony(world, s.x, s.y);
          if (world.audio) world.audio.triggerDustSpawn();
        } else if (nearCells) {
          world.ripples.push({ x: s.x, y: s.y, radius: 0,
            maxRadius: 120 + Math.random() * 80, age: 0, maxAge: 80 });
          if (world.audio) world.audio.triggerSporeImpact();
          spawnColony(world, s.x, s.y);
        } else {
          spawnColony(world, s.x, s.y);
        }
      }
      world.spores.splice(i, 1);
    }
  }

  for (const c of world.cells) {
    c.age++;
    if (c.alpha < 1) c.alpha += 0.04;
  }

  for (let i = world.ripples.length - 1; i >= 0; i--) {
    const r = world.ripples[i];
    r.age++;
    r.radius = (r.age / r.maxAge) * r.maxRadius;
    if (r.age >= r.maxAge) world.ripples.splice(i, 1);
  }

  tickDust(world);

  if (world.audio && world.audio.started) {
    const HUE_BUCKETS = 10;
    const bucketCounts = new Map();
    for (const c of world.cells) {
      if (!c.bloomed || !c.neonColor) continue;
      const hue = hexToHue(c.neonColor);
      const bucket = Math.floor((hue / 360) * HUE_BUCKETS);
      bucketCounts.set(bucket, (bucketCounts.get(bucket) || 0) + 1);
    }
    world.audio.updateColourBuckets(bucketCounts);
    world.audio.updateWorldState({
      cells: world.cells.length,
      bloomCount: world.bloomCount,
      colonies: world.colonies.length,
      eaters: world.es?.eaters.length || 0,
      dust: world.dust.length,
    });
  }

  tickEaters(world, world.es);

  if (world._separationTick === undefined) world._separationTick = 0;
  world._separationTick++;
  if (world._separationTick % 30 === 0) checkColonySeparation(world);

  if (world.bloomCount > 0 && Math.random() < biome.eaters.spawnChance) {
    spawnEater(world, world.es);
  }
}
