/**
 * colony.js
 * Defines the Cell and Colony data classes, colour utilities,
 * and the NEON fallback palette.
 *
 * Cells are individual grid-snapped pixels that make up a colony.
 * Colonies are clusters of cells that grow, bloom, and eject spores.
 * Colours evolve through blending as colonies expand post-bloom.
 */

import { BIOMES, DEFAULT_BIOME } from './biomes.js';

/**
 * NEON
 * Purpose:  Fallback colour palette used when no biome is active.
 * Type:     string[]  — Array of hex colour strings
 */
export const NEON = [
  '#ff00ff','#00ffff','#39ff14','#ff6600','#ff0080',
  '#7700ff','#00ff88','#ffff00','#ff3300','#00ccff',
];

/**
 * hexToRgb
 * Purpose:  Convert a hex colour string to an [r, g, b] tuple.
 * Input:    hex  string  — e.g. '#ff00cc'
 * Output:   [number, number, number]  — Each channel 0–255
 */
export function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * rgbToHex
 * Purpose:  Convert r, g, b channel values to a hex colour string.
 * Input:    r  number  — Red channel 0–255
 *           g  number  — Green channel 0–255
 *           b  number  — Blue channel 0–255
 * Output:   string  — e.g. '#ff00cc'
 */
export function rgbToHex(r, g, b) {
  return '#' +
    Math.round(r).toString(16).padStart(2, '0') +
    Math.round(g).toString(16).padStart(2, '0') +
    Math.round(b).toString(16).padStart(2, '0');
}

/**
 * blendColors
 * Purpose:  Blend two hex colours with a random interpolation weight
 *           and a small random drift so the palette evolves without
 *           converging to a flat midpoint.
 * Input:    hexA  string  — First hex colour
 *           hexB  string  — Second hex colour
 * Output:   string  — Blended hex colour
 */
export function blendColors(hexA, hexB) {
  const [r1, g1, b1] = hexToRgb(hexA);
  const [r2, g2, b2] = hexToRgb(hexB);
  const t = 0.4 + Math.random() * 0.2;
  const drift = () => (Math.random() - 0.5) * 30;
  return rgbToHex(
    Math.min(255, Math.max(0, r1 * (1 - t) + r2 * t + drift())),
    Math.min(255, Math.max(0, g1 * (1 - t) + g2 * t + drift())),
    Math.min(255, Math.max(0, b1 * (1 - t) + b2 * t + drift())),
  );
}

/**
 * Cell
 * Purpose:  Represents a single pixel-sized unit within a colony.
 *
 * Properties:
 *   x          number       — Grid-snapped x position (px)
 *   y          number       — Grid-snapped y position (px)
 *   colonyId   number       — ID of the owning colony
 *   generation number       — Growth generation (0 = seed cell)
 *   age        number       — Ticks since creation
 *   alpha      number       — Current opacity 0–1 (fades in from 0)
 *   bloomed    boolean      — Whether this cell has received a neon colour
 *   neonColor  string|null  — Hex colour assigned at or after bloom
 */
export class Cell {
  /**
   * Input:  x          number  — Pixel x (will be floored)
   *         y          number  — Pixel y (will be floored)
   *         colonyId   number  — Owning colony ID
   *         generation number  — Growth depth from seed
   */
  constructor(x, y, colonyId, generation) {
    this.x = Math.floor(x);
    this.y = Math.floor(y);
    this.colonyId = colonyId;
    this.generation = generation;
    this.age = 0;
    this.alpha = 0;
    this.bloomed = false;
    this.neonColor = null;
  }
}

/**
 * Colony
 * Purpose:  Represents a growing cluster of cells rooted at (x, y).
 *           Seeds its colour palette from the active biome on construction.
 *
 * Properties:
 *   id          number   — Unique random float ID
 *   x           number   — Origin x (grid-snapped)
 *   y           number   — Origin y (grid-snapped)
 *   age         number   — Ticks since creation
 *   cells       Cell[]   — All cells belonging to this colony
 *   bloomed     boolean  — Whether bloom threshold has been reached
 *   colorA      string   — Current leading seed colour (hex)
 *   colorB      string   — Current trailing seed colour (hex)
 *   neonColor   string   — Snapshot of colorA at bloom time
 *   sporeTimer  number   — Ticks until next spore ejection
 */
export class Colony {
  /**
   * Input:  x         number  — Origin x pixel
   *         y         number  — Origin y pixel
   *         biomeKey  string  — Key into BIOMES config (default: DEFAULT_BIOME)
   */
  constructor(x, y, biomeKey = DEFAULT_BIOME) {
    this.id = Math.random();
    this.x = Math.floor(x);
    this.y = Math.floor(y);
    this.age = 0;
    this.cells = [];
    this.bloomed = false;
    const palette = BIOMES[biomeKey]?.colors || NEON;
    this.colorA = palette[Math.floor(Math.random() * palette.length)];
    this.colorB = palette[Math.floor(Math.random() * palette.length)];
    this.neonColor = this.colorA;
    const [min, max] = BIOMES[biomeKey]?.growth.sporeInterval || [80, 120];
    this.sporeTimer = min + Math.random() * (max - min);
  }
}