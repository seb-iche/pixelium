/**
 * renderer.js
 * Canvas 2D drawing engine for mycelium world.
 *
 * Draw order each frame:
 *   1. Fade trail (semi-transparent black for motion blur)
 *   2. Colony threads (Bresenham lines between adjacent cells)
 *   3. Spore particles
 *   4. Cells (with ripple boost brightening)
 *   5. Ripple rings
 *   6. Dust particles
 *   7. Scars
 *   8. Eaters (lifecycle-aware: worm → colourworm → thickworm → frog)
 */

import { CELL_SIZE } from './world.js';
import { hexToRgb } from './colony.js';

/**
 * createRenderer
 * Purpose:  Extract a 2D context from the canvas.
 * Input:    canvas  HTMLCanvasElement
 * Output:   { ctx: CanvasRenderingContext2D }
 */
export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  return { ctx };
}

/**
 * resizeCanvas
 * Purpose:  Resize canvas to fill the browser window.
 * Input:    canvas  HTMLCanvasElement  (mutated)
 * Output:   void
 */
export function resizeCanvas(canvas) {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

/**
 * drawPixelLine
 * Purpose:  Bresenham line between two points, each step drawn as a CELL_SIZE square.
 * Input:    ctx        CanvasRenderingContext2D
 *           x0,y0      number  — Start (px)
 *           x1,y1      number  — End (px)
 *           r,g,b      number  — Colour channels 0–255
 *           alpha      number  — Opacity 0–1
 * Output:   void
 */
function drawPixelLine(ctx, x0, y0, x1, y1, r, g, b, alpha) {
  x0 = Math.floor(x0); y0 = Math.floor(y0);
  x1 = Math.floor(x1); y1 = Math.floor(y1);
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
  while (true) {
    ctx.fillRect(x0, y0, CELL_SIZE, CELL_SIZE);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/**
 * getRippleBoost
 * Purpose:  Calculate brightness boost for a cell from nearby ripple rings.
 *           Boost peaks at the wavefront band (±24px from ring edge).
 * Input:    cx       number    — Cell x (px)
 *           cy       number    — Cell y (px)
 *           ripples  Object[]  — Active ripples {x, y, radius, age, maxAge}
 * Output:   number  — Boost 0–0.9
 */
function getRippleBoost(cx, cy, ripples) {
  let boost = 0;
  for (const rip of ripples) {
    const dx = cx - rip.x, dy = cy - rip.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const rippleWidth = 24;
    const delta = Math.abs(dist - rip.radius);
    if (delta < rippleWidth) {
      const wave = 1 - (delta / rippleWidth);
      const fade = 1 - (rip.age / rip.maxAge);
      boost = Math.max(boost, wave * fade * 0.9);
    }
  }
  return boost;
}

/**
 * brighten
 * Purpose:  Lerp r, g, b toward white by factor t.
 * Input:    r,g,b  number  — Source channels 0–255
 *           t      number  — 0=unchanged, 1=white
 * Output:   [number, number, number]
 */
function brighten(r, g, b, t) {
  return [
    Math.round(r + (255 - r) * t),
    Math.round(g + (255 - g) * t),
    Math.round(b + (255 - b) * t),
  ];
}

/**
 * render
 * Purpose:  Top-level render call. Delegates to renderFlat.
 * Input:    ctx      CanvasRenderingContext2D
 *           world    Object
 *           isoMode  boolean  — Reserved, unused
 * Output:   void
 */
export function render(ctx, world, isoMode = false) {
  renderFlat(ctx, world, ctx.canvas.width, ctx.canvas.height);
}

/**
 * renderFlat
 * Purpose:  Draw the full world in flat 2D pixel art style each frame.
 * Input:    ctx    CanvasRenderingContext2D
 *           world  Object
 *           W,H    number  — Canvas dimensions (px)
 * Output:   void
 */
function renderFlat(ctx, world, W, H) {
  // 1. Fade trail
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(0, 0, W, H);

  // 2. Colony threads
  for (const col of world.colonies) {
    const sorted = col.cells.slice().sort((a, b) => a.generation - b.generation);
    const [tr, tg, tb] = col.bloomed ? hexToRgb(col.neonColor) : [200, 200, 200];
    for (let i = 1; i < sorted.length; i += 2) {
      const a = sorted[i - 1], b = sorted[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      if (Math.sqrt(dx * dx + dy * dy) < 14) {
        const alpha = col.bloomed
          ? Math.min(0.3, a.alpha * 0.35)
          : Math.min(0.15, a.alpha * 0.2);
        drawPixelLine(ctx, a.x, a.y, b.x, b.y, tr, tg, tb, alpha);
      }
    }
  }

  // 3. Spores
  for (const s of world.spores) {
    ctx.fillStyle = `rgba(180,255,255,${(s.life * 0.7).toFixed(2)})`;
    ctx.fillRect(Math.floor(s.x), Math.floor(s.y), CELL_SIZE, CELL_SIZE);
  }

  // 4. Cells with ripple boost
  const hasRipples = world.ripples.length > 0;
  for (const c of world.cells) {
    const px = Math.floor(c.x), py = Math.floor(c.y);
    const alpha = Math.min(1, c.alpha);
    let r, g, b, a;
    if (c.bloomed && c.neonColor) {
      [r, g, b] = hexToRgb(c.neonColor);
      const glow = c.age > 30 ? Math.min(1, (c.age - 30) / 60) : 0;
      a = alpha * (0.7 + 0.3 * glow);
    } else {
      r = g = b = 190; a = alpha * 0.55;
    }
    if (hasRipples) {
      const boost = getRippleBoost(px, py, world.ripples);
      if (boost > 0) {
        [r, g, b] = brighten(r, g, b, boost);
        a = Math.min(1, a + boost * 0.4);
      }
    }
    ctx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(2)})`;
    ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
  }

  // 5. Ripple rings
  for (const rip of world.ripples) {
    const fade = 1 - (rip.age / rip.maxAge);
    ctx.beginPath();
    ctx.arc(rip.x, rip.y, rip.radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${(fade * 0.15).toFixed(2)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 6. Dust
  if (world.dust) {
    for (const d of world.dust) {
      const grey = Math.floor(80 + d.life * 80);
      ctx.fillStyle = `rgba(${grey},${grey},${grey},${(d.life * 0.7).toFixed(2)})`;
      ctx.fillRect(Math.floor(d.x), Math.floor(d.y), CELL_SIZE, CELL_SIZE);
    }
  }

  // 7 & 8. Scars and eaters
  if (world.es) {
    for (const [key, remaining] of world.es.scars) {
      const [gx, gy] = key.split(',').map(Number);
      const fade = remaining / 500;
      ctx.fillStyle = `rgba(8,8,8,${(fade * 0.95).toFixed(2)})`;
      ctx.fillRect(gx * CELL_SIZE, gy * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }

    for (const eater of world.es.eaters) {
      const bodyLen = eater.body.length;
      const stage = eater.stage || { size: 2, name: 'worm', colored: false };
      const s = stage.size;
      const isFrog = stage.name === 'frog';
      const color = (stage.colored && eater.bodyColor) ? eater.bodyColor : null;

      for (let i = bodyLen - 1; i >= 0; i--) {
        const seg = eater.body[i];
        const px = Math.floor(seg.x);
        const py = Math.floor(seg.y);
        const t = 1 - (i / bodyLen);

        if (i === 0) {
          if (isFrog) {
            const hr = color ? parseInt(color.slice(1,3),16) : 20;
            const hg = color ? parseInt(color.slice(3,5),16) : 40;
            const hb = color ? parseInt(color.slice(5,7),16) : 20;
            ctx.fillStyle = `rgb(${Math.min(255,Math.round(hr+(255-hr)*0.3))},${Math.min(255,Math.round(hg+(255-hg)*0.3))},${Math.min(255,Math.round(hb+(255-hb)*0.3))})`;
            ctx.fillRect(px - s - 1, py - s, (s+1)*2, s*2);
            ctx.fillStyle = 'rgba(255,255,80,1.0)';
            ctx.fillRect(px - s + 1, py - 1, 2, 2);
            ctx.fillRect(px + s - 2, py - 1, 2, 2);
          } else {
            ctx.fillStyle = color || 'rgba(35,28,18,0.98)';
            ctx.fillRect(px - s, py - s, s*2, s*2);
            ctx.fillStyle = 'rgba(255,210,60,1.0)';
            ctx.fillRect(px, py - 1, 2, 2);
          }
        } else {
          const segSize = Math.max(1, Math.floor(s * (0.4 + t * 0.6)));
          if (color) {
            const cr = parseInt(color.slice(1,3),16);
            const cg = parseInt(color.slice(3,5),16);
            const cb = parseInt(color.slice(5,7),16);
            const dim = 0.3 + t * 0.7;
            ctx.fillStyle = `rgba(${Math.round(cr*dim)},${Math.round(cg*dim)},${Math.round(cb*dim)},${(0.7+t*0.3).toFixed(2)})`;
          } else {
            const v = Math.floor(t * 25);
            ctx.fillStyle = `rgba(${v+10},${v+8},${v+5},${(0.7+t*0.3).toFixed(2)})`;
          }
          if (isFrog) {
            ctx.fillRect(px - segSize - 1, py - segSize, (segSize+1)*2, segSize*2);
          } else {
            ctx.fillRect(px - segSize, py - segSize, segSize*2, segSize*2);
          }
        }
      }
    }
  }
}

