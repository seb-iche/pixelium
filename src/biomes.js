/**
 * biomes.js
 * Defines the configuration for each biome in the ecosystem.
 * Each biome controls colony colours, growth behaviour, eater behaviour,
 * audio tuning, and visual feel. All other modules read from this config
 * at runtime so biome switching requires no logic changes elsewhere.
 *
 * Exported:
 *   BIOMES        — Object map of biome configs keyed by biome ID string
 *   DEFAULT_BIOME — String ID of the fallback biome
 */

/**
 * BIOMES
 * Purpose:  Central configuration object for all five ecosystem biomes.
 * Type:     { [biomeKey: string]: BiomeConfig }
 *
 * BiomeConfig shape:
 *   name         string    — Display name
 *   description  string    — One-line description
 *   colors       string[]  — Hex colour palette for colony seeds
 *   growth: {
 *     rate            number            — Probability (0–1) per tick that a colony grows
 *     steps           number[]          — Allowed grid-step distances per growth attempt
 *     bloomThreshold  number            — Cell count required before a colony blooms
 *     sporeInterval   [number, number]  — [min, max] ticks between spore ejections
 *   }
 *   eaters: {
 *     spawnChance  number  — Per-tick probability of spawning a new eater
 *     maxEaters    number  — Hard cap on simultaneous eaters
 *     speed        number  — Base movement speed (px/tick)
 *     eatCooldown  number  — Ticks between each eat event
 *   }
 *   audio: {
 *     droneFreqs   number[]          — Base Hz for the three drone oscillator layers
 *     textureFreq  number            — Centre frequency for texture bandpass filter
 *     swellPeak    [number, number]  — [min, max] master gain during swell cycle
 *   }
 *   visual: {
 *     fadeSpeed  number  — Alpha increment per tick during cell fade-in
 *     glowAge    number  — Ticks before full glow effect activates on a cell
 *   }
 */
export const BIOMES = {

  earthy: {
    name: 'Earthy',
    description: 'slow dense growth, deep low drones',
    colors: [
      '#c8601a', '#e8920a', '#a84010', '#d4a030',
      '#8b4513', '#cd853f', '#ff6600', '#b8860b',
      '#a0522d', '#d2691e',
    ],
    growth: {
      rate: 0.45,
      steps: [1, 2],
      bloomThreshold: 60,
      sporeInterval: [160, 220],
    },
    eaters: {
      spawnChance: 0.008,
      maxEaters: 4,
      speed: 0.6,
      eatCooldown: 30,
    },
    audio: {
      droneFreqs: [65.41, 98.00, 130.81],
      textureFreq: 200,
      swellPeak: [0.08, 0.14],
    },
    visual: {
      fadeSpeed: 0.03,
      glowAge: 60,
    },
  },

  aquatic: {
    name: 'Aquatic',
    description: 'flowing spread, water sounds',
    colors: [
      '#00ffff', '#00ccff', '#0088ff', '#00ff88',
      '#44ffcc', '#0044cc', '#66eeff', '#00aacc',
      '#22ddff', '#0077bb',
    ],
    growth: {
      rate: 0.65,
      steps: [1, 2, 3],
      bloomThreshold: 70,
      sporeInterval: [100, 160],
    },
    eaters: {
      spawnChance: 0.003,
      maxEaters: 3,
      speed: 1.0,
      eatCooldown: 50,
    },
    audio: {
      droneFreqs: [130.81, 196.00, 261.63],
      textureFreq: 1200,
      swellPeak: [0.09, 0.16],
    },
    visual: {
      fadeSpeed: 0.06,
      glowAge: 30,
    },
  },

  weather: {
    name: 'Weather',
    description: 'erratic fast growth, wind textures',
    colors: [
      '#cc00ff', '#ffffff', '#ffff00', '#ff00cc',
      '#ddddff', '#aa44ff', '#ffffaa', '#ff88ff',
      '#eeeeff', '#cc88ff',
    ],
    growth: {
      rate: 0.80,
      steps: [1, 2, 3, 4],
      bloomThreshold: 50,
      sporeInterval: [60, 120],
    },
    eaters: {
      spawnChance: 0.004,
      maxEaters: 4,
      speed: 1.4,
      eatCooldown: 25,
    },
    audio: {
      droneFreqs: [196.00, 293.66, 392.00],
      textureFreq: 3000,
      swellPeak: [0.10, 0.20],
    },
    visual: {
      fadeSpeed: 0.08,
      glowAge: 20,
    },
  },

  volcanic: {
    name: 'Volcanic',
    description: 'aggressive growth, frequent eaters',
    colors: [
      '#ff2200', '#ff6600', '#cc1100', '#ff4400',
      '#ff8800', '#991100', '#ff3300', '#dd5500',
      '#ff1100', '#aa3300',
    ],
    growth: {
      rate: 0.70,
      steps: [1, 2],
      bloomThreshold: 45,
      sporeInterval: [80, 130],
    },
    eaters: {
      spawnChance: 0.02,
      maxEaters: 10,
      speed: 1.2,
      eatCooldown: 12,
    },
    audio: {
      droneFreqs: [55.00, 82.41, 110.00],
      textureFreq: 150,
      swellPeak: [0.12, 0.22],
    },
    visual: {
      fadeSpeed: 0.05,
      glowAge: 40,
    },
  },

  arctic: {
    name: 'Arctic',
    description: 'very slow crystalline growth',
    colors: [
      '#aaddff', '#ffffff', '#cceeff', '#88ccff',
      '#ddeeff', '#99bbdd', '#eef8ff', '#bbddff',
      '#ffffff', '#aaccee',
    ],
    growth: {
      rate: 0.25,
      steps: [1],
      bloomThreshold: 100,
      sporeInterval: [240, 360],
    },
    eaters: {
      spawnChance: 0.001,
      maxEaters: 2,
      speed: 0.4,
      eatCooldown: 80,
    },
    audio: {
      droneFreqs: [329.63, 440.00, 523.25],
      textureFreq: 5000,
      swellPeak: [0.06, 0.10],
    },
    visual: {
      fadeSpeed: 0.02,
      glowAge: 90,
    },
  },

};

/**
 * DEFAULT_BIOME
 * Purpose:  Fallback biome ID used when no biome is specified.
 * Type:     string
 */
export const DEFAULT_BIOME = 'earthy';