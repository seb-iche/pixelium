/**
 * inspector.js
 * Hover tooltip and click panel for inspecting world objects.
 *
 * Supports three object types:
 *   colony — full lifecycle panel on click, name + age on hover
 *   eater  — stage progress panel on click, stage + age on hover
 *   spore  — life bar on hover only (too short-lived for a panel)
 *   dust   — life bar on hover only
 *
 * Hit detection uses pixel distance against world object positions.
 * All inspection is read-only — nothing is mutated.
 */

import { CELL_SIZE } from './world.js';

const HOVER_RADIUS  = 18;
const EATER_RADIUS  = 20;
const SPORE_RADIUS  = 12;
const DUST_RADIUS   = 10;
const COLONY_SAMPLE = 40;

const colId = hex => hex ? hex.slice(1, 5).toUpperCase() : '----';

const ticksToTime = ticks => {
  const s = Math.floor(ticks / 60);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const shortId = id => Math.floor(id * 99999).toString(36).toUpperCase().slice(0, 4);

const STAGE_THRESHOLDS = [0, 12, 35, 80];
const STAGE_NAMES = ['worm', 'colorworm', 'thickworm', 'frog'];

let enabled = true;
let hovered = null;
let selected = null;

const tooltip = document.createElement('div');
tooltip.id = 'inspector-tooltip';
tooltip.className = 'inspector-hidden';
document.body.appendChild(tooltip);

const panel = document.createElement('div');
panel.id = 'inspector-panel';
panel.className = 'inspector-hidden';
document.body.appendChild(panel);

/**
 * findObjectAt
 * Purpose:  Scan the world for the closest object to (mx, my).
 *           Priority: eaters > spores > dust > colonies.
 * Input:    world  Object  — Full world state
 *           mx,my  number  — Mouse position in canvas px
 * Output:   { type, object, x, y } | null
 */
function findObjectAt(world, mx, my) {
  if (world.es?.eaters) {
    for (const eater of world.es.eaters) {
      const dx = eater.x - mx, dy = eater.y - my;
      if (Math.sqrt(dx*dx + dy*dy) < EATER_RADIUS) {
        return { type: 'eater', object: eater, x: eater.x, y: eater.y };
      }
    }
  }

  for (const s of world.spores) {
    const dx = s.x - mx, dy = s.y - my;
    if (Math.sqrt(dx*dx + dy*dy) < SPORE_RADIUS) {
      return { type: 'spore', object: s, x: s.x, y: s.y };
    }
  }

  for (const d of world.dust) {
    const dx = d.x - mx, dy = d.y - my;
    if (Math.sqrt(dx*dx + dy*dy) < DUST_RADIUS) {
      return { type: 'dust', object: d, x: d.x, y: d.y };
    }
  }

  let bestCol = null, bestDist = HOVER_RADIUS;
  for (const col of world.colonies) {
    const sample = col.cells.length > COLONY_SAMPLE
      ? col.cells.slice(-COLONY_SAMPLE)
      : col.cells;
    for (const c of sample) {
      const cx = c.x + CELL_SIZE / 2, cy = c.y + CELL_SIZE / 2;
      const dx = cx - mx, dy = cy - my;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < bestDist) { bestDist = dist; bestCol = col; }
    }
  }
  if (bestCol) {
    return { type: 'colony', object: bestCol, x: bestCol.x, y: bestCol.y };
  }

  return null;
}

/**
 * renderTooltip
 * Purpose:  Build tooltip HTML for the hovered object.
 * Input:    hit  { type, object }
 * Output:   void — mutates tooltip.innerHTML
 */
function renderTooltip(hit) {
  const { type, object } = hit;
  let html = '';

  if (type === 'colony') {
    const col = object;
    const status = col.bloomed ? 'bloomed' : 'growing';
    html = `
      <span class="tt-type">colony</span>
      <span class="tt-id">COL-${shortId(col.id)}</span>
      <span class="tt-detail">${status} · ${col.cells.length} cells · ${ticksToTime(col.age)}</span>
    `;
  } else if (type === 'eater') {
    const e = object;
    const stage = e.stage?.name || 'worm';
    html = `
      <span class="tt-type">eater</span>
      <span class="tt-id">${stage}</span>
      <span class="tt-detail">${e.totalEaten} eaten · ${e.migrating ? 'migrating' : 'feeding'}</span>
    `;
  } else if (type === 'spore') {
    const pct = Math.round(object.life * 100);
    html = `
      <span class="tt-type">spore</span>
      <span class="tt-detail">life ${pct}%</span>
      <div class="tt-bar"><div class="tt-bar-fill" style="width:${pct}%"></div></div>
    `;
  } else if (type === 'dust') {
    const pct = Math.round(object.life * 100);
    html = `
      <span class="tt-type">dust</span>
      <span class="tt-detail">fading · ${pct}% · ${pct > 20 ? 'can seed' : 'almost gone'}</span>
      <div class="tt-bar"><div class="tt-bar-fill dust" style="width:${pct}%"></div></div>
    `;
  }

  tooltip.innerHTML = html;
}

/**
 * renderPanel
 * Purpose:  Build full detail panel HTML for a selected colony or eater.
 * Input:    hit  { type, object }
 * Output:   void — mutates panel.innerHTML
 */
function renderPanel(hit) {
  const { type, object } = hit;
  let html = '';

  if (type === 'colony') {
    const col = object;
    const swatch = hex => `<span class="swatch" style="background:${hex}" title="${hex}"></span>`;
    const bloomThreshold = 60;
    const bloomPct = col.bloomed ? 100 : Math.round((col.cells.length / bloomThreshold) * 100);
    html = `
      <div class="panel-header">
        <span class="panel-type">colony</span>
        <span class="panel-id">COL-${shortId(col.id)}</span>
        <button class="panel-close" id="panel-close-btn">×</button>
      </div>
      <div class="panel-body">
        <div class="panel-row">
          <span class="panel-label">status</span>
          <span class="panel-value ${col.bloomed ? 'val-bloom' : ''}">${col.bloomed ? '✦ bloomed' : '○ growing'}</span>
        </div>
        <div class="panel-row">
          <span class="panel-label">age</span>
          <span class="panel-value">${ticksToTime(col.age)}</span>
        </div>
        <div class="panel-row">
          <span class="panel-label">cells</span>
          <span class="panel-value">${col.cells.length}</span>
        </div>
        <div class="panel-row">
          <span class="panel-label">bloom</span>
          <div class="panel-bar"><div class="panel-bar-fill" style="width:${Math.min(100, bloomPct)}%"></div></div>
        </div>
        <div class="panel-row">
          <span class="panel-label">colour A</span>
          <span class="panel-value">${swatch(col.colorA)} ${colId(col.colorA)}</span>
        </div>
        <div class="panel-row">
          <span class="panel-label">colour B</span>
          <span class="panel-value">${swatch(col.colorB)} ${colId(col.colorB)}</span>
        </div>
        <div class="panel-row">
          <span class="panel-label">ID</span>
          <span class="panel-value mono">COL-${shortId(col.id)}</span>
        </div>
        <div class="panel-note">${col.bloomed
          ? 'Palette evolves with each new cell — colour A and B drift toward each other then apart.'
          : `Needs ${Math.max(0, bloomThreshold - col.cells.length)} more cells to bloom.`
        }</div>
      </div>
    `;
  } else if (type === 'eater') {
    const e = object;
    const currentStage = e.stage?.name || 'worm';
    const stageIdx = STAGE_NAMES.indexOf(currentStage);
    const nextThreshold = STAGE_THRESHOLDS[Math.min(stageIdx + 1, 3)];
    const progressPct = nextThreshold > 0
      ? Math.round((e.totalEaten / nextThreshold) * 100)
      : 100;
    const swatch = hex => hex
      ? `<span class="swatch" style="background:${hex}"></span>`
      : `<span class="swatch dark"></span>`;
    const stageLabel = { worm: 'worm', colorworm: 'colour worm', thickworm: 'thick worm', frog: 'frog' };

    html = `
      <div class="panel-header">
        <span class="panel-type">eater</span>
        <span class="panel-id">${stageLabel[currentStage] || currentStage}</span>
        <button class="panel-close" id="panel-close-btn">×</button>
      </div>
      <div class="panel-body">
        <div class="panel-row">
          <span class="panel-label">stage</span>
          <span class="panel-value val-bloom">${stageLabel[currentStage] || currentStage}</span>
        </div>
        <div class="panel-row">
          <span class="panel-label">total eaten</span>
          <span class="panel-value">${e.totalEaten} cells</span>
        </div>
        <div class="panel-row">
          <span class="panel-label">next stage</span>
          <div class="panel-bar"><div class="panel-bar-fill eater" style="width:${Math.min(100, progressPct)}%"></div></div>
        </div>
        <div class="panel-row">
          <span class="panel-label">body colour</span>
          <span class="panel-value">${swatch(e.bodyColor)} ${e.bodyColor ? colId(e.bodyColor) : 'none yet'}</span>
        </div>
        <div class="panel-row">
          <span class="panel-label">behaviour</span>
          <span class="panel-value">${e.migrating ? '→ migrating' : '◉ feeding'}</span>
        </div>
        <div class="panel-row">
          <span class="panel-label">zone eaten</span>
          <span class="panel-value">${e.cellsEatenInZone} / ${e.zoneThreshold}</span>
        </div>
        <div class="panel-row">
          <span class="panel-label">size</span>
          <span class="panel-value">${e.stage?.size || 2}px · ${e.body.length} segments</span>
        </div>
        <div class="panel-note">${
          currentStage === 'frog'
            ? 'Fully evolved. Fastest eating rate. Two eyes, wide head.'
            : `Eats ${nextThreshold - e.totalEaten} more cells to reach next stage.`
        }</div>
      </div>
    `;
  }

  panel.innerHTML = html;
  document.getElementById('panel-close-btn')?.addEventListener('click', () => {
    selected = null;
    panel.className = 'inspector-hidden';
  });
}

/**
 * positionTooltip
 * Purpose:  Place tooltip near mouse, flipping if near screen edge.
 * Input:    mx,my  number  — Mouse position
 * Output:   void
 */
function positionTooltip(mx, my) {
  const offset = 16;
  let x = mx + offset;
  let y = my + offset;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  if (x + tw > window.innerWidth - 10) x = mx - tw - offset;
  if (y + th > window.innerHeight - 10) y = my - th - offset;
  tooltip.style.left = `${x}px`;
  tooltip.style.top  = `${y}px`;
}

/**
 * setEnabled
 * Purpose:  Toggle inspector on/off. Hides all UI when disabled.
 * Input:    val  boolean
 * Output:   void
 */
export function setEnabled(val) {
  enabled = val;
  if (!enabled) {
    hovered = null;
    selected = null;
    tooltip.className = 'inspector-hidden';
    panel.className = 'inspector-hidden';
  }
}

/**
 * isEnabled
 * Output:  boolean
 */
export function isEnabled() { return enabled; }

/**
 * onMouseMove
 * Purpose:  Update hover state and tooltip on each mouse move.
 * Input:    world  Object
 *           mx,my  number
 * Output:   void
 */
export function onMouseMove(world, mx, my) {
  if (!enabled) return;
  hovered = findObjectAt(world, mx, my);
  if (hovered) {
    renderTooltip(hovered);
    tooltip.className = '';
    positionTooltip(mx, my);
  } else {
    tooltip.className = 'inspector-hidden';
  }
}

/**
 * onMouseClick
 * Purpose:  Open detail panel for clicked colony or eater.
 *           Spore and dust are hover-only.
 * Input:    world  Object
 *           mx,my  number
 * Output:   void
 */
export function onMouseClick(world, mx, my) {
  if (!enabled) return;
  const hit = findObjectAt(world, mx, my);
  if (!hit) {
    selected = null;
    panel.className = 'inspector-hidden';
    return;
  }
  if (hit.type === 'spore' || hit.type === 'dust') return;
  selected = hit;
  renderPanel(hit);
  panel.className = '';
}

/**
 * updatePanel
 * Purpose:  Refresh panel content each tick so values stay live.
 * Input:    none
 * Output:   void
 */
export function updatePanel() {
  if (!enabled || !selected) return;
  renderPanel(selected);
}