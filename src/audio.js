/**
 * audio.js
 * Ambient audio engine for mycelium world, inspired by mur mur.
 *
 * Architecture:
 *   - Three sine drone oscillators tuned to a biome chord, each with a
 *     slow LFO and a sub-octave layer. Fade in progressively with world
 *     complexity.
 *   - Two looping noise texture layers (bright 4–8kHz and warm 200–800Hz),
 *     each with a slow LFO for breathing. Bright layer scales with complexity.
 *   - Swell cycle: every 25–60s the master gain rises then recedes. Peak
 *     scales with current world complexity.
 *   - Micro event scheduler: rustles, tones, clicks, shimmers fire at a rate
 *     proportional to world complexity (busy world = more events, less rest).
 *   - Event sounds: bloom chord, collision chord, spore sine, spore impact
 *     noise, spore collision chime, colour-family eat sounds, dust spawn tone.
 *   - World state hook: updateWorldState() drives all gain targets and
 *     micro-event density from live simulation metrics.
 *   - Biome hook: setBiome() shifts drone frequencies over 4 seconds.
 *
 * All gains are very quiet (master 0.05–0.30) to stay subliminal.
 * A 7-second convolution reverb is applied to most signals.
 */

/**
 * PENTATONIC
 * Purpose:  Reference frequency table for melody notes and chord building.
 *           Covers ~3.5 octaves of A pentatonic minor.
 * Type:     number[]  — Frequencies in Hz
 */
const PENTATONIC = [
  55.00, 65.41, 82.41, 98.00, 110.00,
  130.81, 164.81, 196.00, 220.00, 261.63,
  329.63, 392.00, 440.00, 523.25, 659.25,
];

/**
 * BIOME_AUDIO
 * Purpose:  Per-biome audio configuration. droneFreqs are the Hz values
 *           for the three oscillator layers. swellPeak is [min, max]
 *           master gain during a swell event.
 * Type:     { [biomeKey: string]: { droneFreqs: number[], swellPeak: [number, number] } }
 */
const BIOME_AUDIO = {
  earthy:   { droneFreqs: [65.41, 98.00, 130.81],   swellPeak: [0.08, 0.14] },
  aquatic:  { droneFreqs: [130.81, 196.00, 261.63],  swellPeak: [0.09, 0.16] },
  weather:  { droneFreqs: [196.00, 293.66, 392.00],  swellPeak: [0.10, 0.20] },
  volcanic: { droneFreqs: [55.00, 82.41, 110.00],    swellPeak: [0.12, 0.22] },
  arctic:   { droneFreqs: [329.63, 440.00, 523.25],  swellPeak: [0.06, 0.10] },
};

/**
 * chordFreqs
 * Purpose:  Pick three pentatonic frequencies (root, third, fifth)
 *           corresponding to a hue angle, for bloom and collision chords.
 * Input:    hue  number  — Hue angle 0–360
 * Output:   [number, number, number]  — Three Hz values from PENTATONIC
 */
function chordFreqs(hue) {
  const idx = Math.min(
    Math.floor((hue / 360) * (PENTATONIC.length - 1)),
    PENTATONIC.length - 5
  );
  return [PENTATONIC[idx], PENTATONIC[idx + 2], PENTATONIC[idx + 4]];
}

/**
 * hexToHue
 * Purpose:  Convert a hex colour string to a hue angle (0–360°).
 *           Used to map colony colours to musical frequencies.
 * Input:    hex  string  — e.g. '#ff6600'
 * Output:   number  — Hue in degrees 0–360
 */
export function hexToHue(hex) {
  const r = parseInt(hex.slice(1,3),16) / 255;
  const g = parseInt(hex.slice(3,5),16) / 255;
  const b = parseInt(hex.slice(5,7),16) / 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g-b)/d) % 6;
  else if (max === g) h = (b-r)/d + 2;
  else h = (r-g)/d + 4;
  return ((h * 60) + 360) % 360;
}

/**
 * AudioEngine
 * Purpose:  Central audio controller. Owns the AudioContext, all persistent
 *           nodes (master gain, reverb, drones, textures), and provides
 *           methods for event sounds and world-state-driven updates.
 *
 * Key properties:
 *   ctx             AudioContext  — Web Audio context
 *   master          GainNode      — Final output gain (complexity-driven)
 *   reverb          ConvolverNode — Long diffuse reverb (7s)
 *   droneLayers     Object[]      — Three drone layer objects
 *                                   { osc, sub, lfo, lfoGain, gain, freq }
 *   brightGain      GainNode      — High-frequency texture level
 *   warmGain        GainNode      — Low-mid texture level
 *   complexity      number        — Smoothed world complexity 0–1
 *   complexityTarget number       — Raw target before smoothing
 *   microRestProb   number        — Rest probability for micro events (0.6→0.1)
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.reverb = null;
    this.started = false;
    this.droneLayers = [];
    this.brightGain = null;
    this.warmGain = null;
    this.lastBloom = -Infinity;
    this.lastCollision = -Infinity;
    this.lastSpore = -Infinity;
    this.currentDroneHue = 0;
    this.droneShiftTimer = 0;
    this.complexity = 0;
    this.complexityTarget = 0;
    this.complexityTick = 0;
    this.microRestProb = 0.6;
  }

  /**
   * start
   * Purpose:  Initialise the Web Audio context and all continuous audio layers.
   *           Must be called from a user gesture (browser autoplay policy).
   *           Safe to call multiple times — no-ops after first call.
   * Input:    none
   * Output:   Promise<void>
   */
  async start() {
    if (this.started) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.setValueAtTime(0.05, this.ctx.currentTime);
    this.master.connect(this.ctx.destination);
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._makeReverb(7.0);
    const rvGain = this.ctx.createGain();
    rvGain.gain.setValueAtTime(0.7, this.ctx.currentTime);
    this.reverb.connect(rvGain);
    rvGain.connect(this.master);
    this._startDroneLayers();
    this._startTextureBright();
    this._startTextureWarm();
    this._startMicroEvents();
    this._startSwellCycle();
    this.started = true;
  }

  /**
   * _makeReverb
   * Purpose:  Generate a synthetic impulse response for convolution reverb.
   *           Exponentially decaying white noise on two channels.
   * Input:    duration  number  — Reverb tail in seconds
   * Output:   AudioBuffer  — Stereo impulse response
   */
  _makeReverb(duration) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * duration);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.0);
      }
    }
    return buf;
  }

  /**
   * _startDroneLayers
   * Purpose:  Create three sustained sine oscillators forming an open chord
   *           (A2, E3, A3). Each has a slow LFO for organic pitch drift and
   *           a sub-octave sine for warmth. Layer 0 starts quiet; layers 1
   *           and 2 start at 0 and are brought in by complexity.
   * Input:    none
   * Output:   void  — Populates this.droneLayers[]
   */
  _startDroneLayers() {
    const now = this.ctx.currentTime;
    const baseFreqs = [110, 164.81, 220];
    this.droneLayers = baseFreqs.map((freq, i) => {
      const osc = this.ctx.createOscillator();
      const sub = this.ctx.createOscillator();
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      const gain = this.ctx.createGain();
      const subGain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      sub.type = 'sine';
      sub.frequency.setValueAtTime(freq * 0.5, now);
      lfo.frequency.setValueAtTime(0.03 + i * 0.02, now);
      lfoGain.gain.setValueAtTime(freq * 0.006, now);
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      gain.gain.setValueAtTime(0, now);
      subGain.gain.setValueAtTime(0.25, now);
      osc.connect(gain);
      sub.connect(subGain);
      subGain.connect(gain);
      gain.connect(this.reverb);
      gain.connect(this.master);
      gain.gain.linearRampToValueAtTime(i === 0 ? 0.012 : 0, now + 6);
      osc.start(now); sub.start(now); lfo.start(now);
      return { osc, sub, lfo, lfoGain, gain, freq };
    });
  }

  /**
   * _shiftDroneToHue
   * Purpose:  Glide all three drones to new frequencies derived from a
   *           target hue, over 12 seconds. Only fires when shift > 2Hz.
   * Input:    hue  number  — Target hue 0–360°
   * Output:   void
   */
  _shiftDroneToHue(hue) {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    const rootIdx = Math.min(
      Math.floor((hue / 360) * (PENTATONIC.length - 1)),
      PENTATONIC.length - 4
    );
    const freqs = [PENTATONIC[rootIdx], PENTATONIC[rootIdx+2], PENTATONIC[rootIdx+4]];
    this.droneLayers.forEach((layer, i) => {
      const target = freqs[i];
      if (Math.abs(target - layer.freq) > 2) {
        layer.osc.frequency.linearRampToValueAtTime(target, now + 12);
        layer.sub.frequency.linearRampToValueAtTime(target * 0.5, now + 12);
        layer.lfoGain.gain.linearRampToValueAtTime(target * 0.006, now + 12);
        layer.freq = target;
      }
    });
  }

  /**
   * _startTextureBright
   * Purpose:  Looping high-frequency noise (4–8kHz) for airy forest shimmer.
   *           Gain starts at 0 and rises with complexity. 0.05Hz LFO breathes.
   * Input:    none
   * Output:   void  — Sets this.brightGain
   */
  _startTextureBright() {
    const now = this.ctx.currentTime;
    const bufLen = this.ctx.sampleRate * 3;
    const buf = this.ctx.createBuffer(1, bufLen, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.setValueAtTime(4000, now); hp.Q.setValueAtTime(0.5, now);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.setValueAtTime(6000, now); bp.Q.setValueAtTime(1.8, now);
    this.brightGain = this.ctx.createGain();
    this.brightGain.gain.setValueAtTime(0, now);
    const lfo = this.ctx.createOscillator();
    const lfoDepth = this.ctx.createGain();
    lfo.frequency.setValueAtTime(0.05, now);
    lfoDepth.gain.setValueAtTime(0.02, now);
    lfo.connect(lfoDepth);
    lfoDepth.connect(this.brightGain.gain);
    lfo.start(now);
    src.connect(hp); hp.connect(bp); bp.connect(this.brightGain);
    this.brightGain.connect(this.reverb);
    this.brightGain.connect(this.master);
    src.start(now);
  }

  /**
   * _startTextureWarm
   * Purpose:  Looping low-mid noise (200–800Hz) for warm body underneath
   *           the bright texture. 0.037Hz LFO (different from bright) creates
   *           natural beating between the two layers.
   * Input:    none
   * Output:   void  — Sets this.warmGain
   */
  _startTextureWarm() {
    const now = this.ctx.currentTime;
    const bufLen = this.ctx.sampleRate * 4;
    const buf = this.ctx.createBuffer(1, bufLen, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.setValueAtTime(350, now); bp.Q.setValueAtTime(1.2, now);
    this.warmGain = this.ctx.createGain();
    this.warmGain.gain.setValueAtTime(0, now);
    this.warmGain.gain.linearRampToValueAtTime(0.05, now + 12);
    const lfo = this.ctx.createOscillator();
    const lfoDepth = this.ctx.createGain();
    lfo.frequency.setValueAtTime(0.037, now);
    lfoDepth.gain.setValueAtTime(0.015, now);
    lfo.connect(lfoDepth);
    lfoDepth.connect(this.warmGain.gain);
    lfo.start(now);
    src.connect(bp); bp.connect(this.warmGain);
    this.warmGain.connect(this.reverb);
    this.warmGain.connect(this.master);
    src.start(now);
  }

  /**
   * _startSwellCycle
   * Purpose:  Schedule recurring master gain swells every 25–60 seconds.
   *           Rise, hold, fall. Peak scales with current complexity.
   * Input:    none
   * Output:   void  — Self-scheduling via setTimeout
   */
  _startSwellCycle() {
    const doSwell = () => {
      if (!this.started) return;
      const now = this.ctx.currentTime;
      const swellUp   = 8  + Math.random() * 8;
      const swellHold = 4  + Math.random() * 8;
      const swellDown = 10 + Math.random() * 10;
      const basePeak  = 0.05 + this.complexity * 0.20;
      const peak      = basePeak + Math.random() * 0.08;
      this.master.gain.linearRampToValueAtTime(peak, now + swellUp);
      this.master.gain.linearRampToValueAtTime(peak * 0.85, now + swellUp + swellHold);
      this.master.gain.linearRampToValueAtTime(
        0.05 + this.complexity * 0.15,
        now + swellUp + swellHold + swellDown
      );
      setTimeout(doSwell, (25 + Math.random() * 35) * 1000);
    };
    setTimeout(doSwell, (15 + Math.random() * 15) * 1000);
  }

  /**
   * _startMicroEvents
   * Purpose:  Continuous stream of tiny ambient sounds — rustles, tones,
   *           clicks, shimmers. Rest probability and interval both scale
   *           with world complexity (busier world = more events).
   * Input:    none
   * Output:   void  — Self-scheduling via setTimeout
   */
  _startMicroEvents() {
    const scheduleNext = () => {
      if (!this.started) return;
      if (Math.random() < (this.microRestProb ?? 0.6)) {
        setTimeout(scheduleNext, 800 + Math.random() * 2000);
        return;
      }
      const type = Math.random();
      if (type < 0.35) this._microRustle();
      else if (type < 0.60) this._microTone();
      else if (type < 0.80) this._microClick();
      else this._microShimmer();
      const interval = 200 + Math.random() * 600 * (1 - (this.complexity ?? 0) * 0.5);
      setTimeout(scheduleNext, interval);
    };
    setTimeout(scheduleNext, 5000);
  }

  /**
   * _microRustle
   * Purpose:  Very short high-frequency noise burst (~60ms).
   *           Simulates a leaf rustle or wing flutter. Filtered above 3.5–5.5kHz.
   * Input:    none
   * Output:   void
   */
  _microRustle() {
    const now = this.ctx.currentTime;
    const bufLen = Math.floor(this.ctx.sampleRate * 0.06);
    const buf = this.ctx.createBuffer(1, bufLen, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.setValueAtTime(3500 + Math.random() * 2000, now);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.08 + Math.random() * 0.12, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.06);
    src.connect(hp); hp.connect(gain);
    gain.connect(this.reverb); gain.connect(this.master);
    src.start(now); src.stop(now + 0.07);
  }

  /**
   * _microTone
   * Purpose:  Quiet pentatonic sine note with slow pitch drift (~1–2s).
   *           Simulates a distant insect or resonating surface.
   * Input:    none
   * Output:   void
   */
  _microTone() {
    const now = this.ctx.currentTime;
    const freq = PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)];
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.linearRampToValueAtTime(freq * 0.997, now + 1.5);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.015 + Math.random() * 0.02, now + 0.2);
    gain.gain.linearRampToValueAtTime(0, now + 1.2 + Math.random() * 0.8);
    osc.connect(gain); gain.connect(this.reverb); gain.connect(this.master);
    osc.start(now); osc.stop(now + 2.2);
  }

  /**
   * _microClick
   * Purpose:  Very short broadband transient (~8ms).
   *           Simulates a twig snap or small impact.
   * Input:    none
   * Output:   void
   */
  _microClick() {
    const now = this.ctx.currentTime;
    const bufLen = Math.floor(this.ctx.sampleRate * 0.008);
    const buf = this.ctx.createBuffer(1, bufLen, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = (Math.random() * 2 - 1) * (1 - i/bufLen);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.06 + Math.random() * 0.08, now);
    src.connect(gain);
    gain.connect(this.reverb); gain.connect(this.master);
    src.start(now); src.stop(now + 0.01);
  }

  /**
   * _microShimmer
   * Purpose:  Short bandpass-filtered noise sweep (~150ms).
   *           Simulates wind through leaves or a resonant shimmer.
   *           Centre frequency randomised 2–6kHz with high Q.
   * Input:    none
   * Output:   void
   */
  _microShimmer() {
    const now = this.ctx.currentTime;
    const bufLen = Math.floor(this.ctx.sampleRate * 0.15);
    const buf = this.ctx.createBuffer(1, bufLen, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2000 + Math.random() * 4000, now);
    bp.Q.setValueAtTime(3.0 + Math.random() * 4, now);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.07, now + 0.04);
    gain.gain.linearRampToValueAtTime(0, now + 0.15);
    src.connect(bp); bp.connect(gain);
    gain.connect(this.reverb); gain.connect(this.master);
    src.start(now); src.stop(now + 0.16);
  }

  /**
   * setBiome
   * Purpose:  Shift all three drone oscillators to biome frequencies over 4s.
   * Input:    biomeKey  string  — Key from BIOME_AUDIO
   * Output:   void
   */
  setBiome(biomeKey) {
    if (!this.started) return;
    const biomeAudio = BIOME_AUDIO[biomeKey];
    if (!biomeAudio) return;
    const now = this.ctx.currentTime;
    this.droneLayers.forEach((layer, i) => {
      const target = biomeAudio.droneFreqs[i];
      if (target) {
        layer.osc.frequency.linearRampToValueAtTime(target, now + 4);
        layer.sub.frequency.linearRampToValueAtTime(target * 0.5, now + 4);
        layer.lfoGain.gain.linearRampToValueAtTime(target * 0.006, now + 4);
        layer.freq = target;
      }
    });
  }

  /**
   * updateColourBuckets
   * Purpose:  Find the dominant hue bucket across bloomed cells and shift
   *           the drone chord toward it. Acts every 300 calls; only when
   *           hue shift exceeds 20°.
   * Input:    bucketCounts  Map<number, number>  — Hue bucket → cell count
   * Output:   void
   */
  updateColourBuckets(bucketCounts) {
    if (!this.started) return;
    let maxCount = 0, dominantBucket = 0;
    for (const [bucket, count] of bucketCounts) {
      if (count > maxCount) { maxCount = count; dominantBucket = bucket; }
    }
    this.droneShiftTimer++;
    if (this.droneShiftTimer > 300) {
      this.droneShiftTimer = 0;
      const hue = (dominantBucket / 10) * 360;
      if (Math.abs(hue - this.currentDroneHue) > 20) {
        this._shiftDroneToHue(hue);
        this.currentDroneHue = hue;
      }
    }
  }

  /**
   * updateWorldState
   * Purpose:  Drive all dynamic audio from live world metrics. Called every
   *           tick but acts every 60 calls. Smoothly adjusts master gain,
   *           drone volumes, texture brightness, and micro-event rest prob.
   *
   *           Complexity = cellScore*0.6 + bloomScore*0.3 + eaterScore*0.1
   *           Smoothed with alpha=0.05 (~60 updates to fully transition.
   *
   * Input:    { cells, bloomCount, colonies, eaters, dust }
   *             cells       number  — Total active cells
   *             bloomCount  number  — Colonies bloomed
   *             colonies    number  — Total colonies
   *             eaters      number  — Active eaters
   *             dust        number  — Active dust particles (reserved)
   * Output:   void
   */
  updateWorldState({ cells, bloomCount, colonies, eaters, dust }) {
    if (!this.started) return;
    this.complexityTick++;
    if (this.complexityTick < 60) return;
    this.complexityTick = 0;
    const now = this.ctx.currentTime;
    const cellScore  = Math.min(1, cells / 30000);
    const bloomScore = Math.min(1, bloomCount / 20);
    const eaterScore = Math.min(1, eaters / 5);
    this.complexityTarget = cellScore * 0.6 + bloomScore * 0.3 + eaterScore * 0.1;
    this.complexity += (this.complexityTarget - this.complexity) * 0.05;
    const c = this.complexity;
    this.master.gain.linearRampToValueAtTime(0.05 + c * 0.25, now + 8);
    if (this.droneLayers.length >= 3) {
      this.droneLayers[0].gain.gain.linearRampToValueAtTime(0.012 + c * 0.015, now + 6);
      this.droneLayers[1].gain.gain.linearRampToValueAtTime(c > 0.3 ? (c - 0.3) / 0.7 * 0.018 : 0, now + 6);
      this.droneLayers[2].gain.gain.linearRampToValueAtTime(c > 0.6 ? (c - 0.6) / 0.4 * 0.014 : 0, now + 6);
    }
    if (this.brightGain) this.brightGain.gain.linearRampToValueAtTime(0.04 + c * 0.12, now + 8);
    if (this.warmGain)   this.warmGain.gain.linearRampToValueAtTime(0.05 + c * 0.05, now + 8);
    this.microRestProb = 0.60 - c * 0.50;
  }

  /**
   * triggerBloom
   * Purpose:  Quiet three-note triangle chord when a colony blooms.
   *           Frequency from colony seed colour hue. 25% fire chance; 15s cooldown.
   * Input:    colorA  string  — Hex colour of blooming colony
   * Output:   void
   */
  triggerBloom(colorA) {
    if (!this.started) return;
    if (Math.random() > 0.25) return;
    const now = this.ctx.currentTime;
    if (now - this.lastBloom < 15.0) return;
    this.lastBloom = now;
    const freqs = chordFreqs(hexToHue(colorA));
    freqs.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime((freq * 0.5) * (1 + i * 0.001), now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.018, now + 1.2);
      gain.gain.linearRampToValueAtTime(0.008, now + 3.0);
      gain.gain.linearRampToValueAtTime(0, now + 5.0);
      osc.connect(gain); gain.connect(this.reverb); gain.connect(this.master);
      osc.start(now); osc.stop(now + 5.1);
    });
  }

  /**
   * triggerCollision
   * Purpose:  Deep three-note sine chord when two colonies touch.
   *           Frequency blends the hues of both colonies. 20s cooldown.
   * Input:    colorA  string  — Growing colony hex colour
   *           colorB  string  — Neighbour colony hex colour
   * Output:   void
   */
  triggerCollision(colorA, colorB) {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    if (now - this.lastCollision < 20.0) return;
    this.lastCollision = now;
    const blendedHue = (hexToHue(colorA) + hexToHue(colorB)) / 2;
    const freqs = chordFreqs(blendedHue);
    freqs.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime((freq * 0.25) * (1 + i * 0.001), now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.02, now + 2.0);
      gain.gain.linearRampToValueAtTime(0.008, now + 5.0);
      gain.gain.linearRampToValueAtTime(0, now + 8.0);
      osc.connect(gain); gain.connect(this.reverb); gain.connect(this.master);
      osc.start(now); osc.stop(now + 8.1);
    });
  }

  /**
   * triggerSpore
   * Purpose:  Quiet sine tone from lower pentatonic register when a colony
   *           ejects a spore. 2.5s cooldown between sounds.
   * Input:    none
   * Output:   void
   */
  triggerSpore() {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    if (now - this.lastSpore < 2.5) return;
    this.lastSpore = now;
    const freq = PENTATONIC[Math.floor(Math.random() * 8)];
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.linearRampToValueAtTime(freq * 0.994, now + 2.5);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.014, now + 0.1);
    gain.gain.linearRampToValueAtTime(0, now + 2.5);
    osc.connect(gain); gain.connect(this.reverb); gain.connect(this.master);
    osc.start(now); osc.stop(now + 2.6);
  }

  /**
   * triggerSporeImpact
   * Purpose:  Soft thud when a spore lands near existing cells.
   *           Bandpass noise at 400Hz, ~300ms duration.
   * Input:    none
   * Output:   void
   */
  triggerSporeImpact() {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    const bufLen = Math.floor(this.ctx.sampleRate * 0.3);
    const buf = this.ctx.createBuffer(1, bufLen, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.setValueAtTime(400, now); bp.Q.setValueAtTime(1.0, now);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.03);
    gain.gain.linearRampToValueAtTime(0, now + 0.3);
    src.connect(bp); bp.connect(gain);
    gain.connect(this.reverb); gain.connect(this.master);
    src.start(now); src.stop(now + 0.35);
  }

  /**
   * triggerSporeCollision
   * Purpose:  Soft three-note chime (C5, E5, G5) when two spores merge.
   * Input:    none
   * Output:   void
   */
  triggerSporeCollision() {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    [261.63, 329.63, 392.00].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * (1 + i * 0.002), now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.03, now + 0.06);
      gain.gain.linearRampToValueAtTime(0, now + 1.0);
      osc.connect(gain); gain.connect(this.reverb); gain.connect(this.master);
      osc.start(now); osc.stop(now + 1.1);
    });
  }

  /** triggerEaterFlee — reserved, currently silent */
  triggerEaterFlee() {}

  /**
   * triggerEatSound
   * Purpose:  Nature-inspired sound for the dominant colour family eaten.
   *           blue    → water drop (descending sine 520→160Hz)
   *           green   → cricket chirp (two triangle pulses ~1600–1900Hz)
   *           red     → frog croak (LFO-modulated sine 80Hz)
   *           yellow  → bird trill (fast LFO on 880Hz sine)
   *           magenta → moth flutter (short bandpass noise 700Hz)
   *           cyan    → wind chime (1200Hz sine long decay)
   *           other   → leaf rustle (_microRustle)
   * Input:    family  string  — From colorFamily()
   * Output:   void
   */
  triggerEatSound(family) {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    if (family === 'blue') {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(160, now + 0.3);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.03, now + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + 0.35);
      osc.connect(gain); gain.connect(this.reverb); gain.connect(this.master);
      osc.start(now); osc.stop(now + 0.4);
    } else if (family === 'green') {
      [0, 0.07].forEach(delay => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(1600 + Math.random() * 300, now + delay);
        gain.gain.setValueAtTime(0, now + delay);
        gain.gain.linearRampToValueAtTime(0.018, now + delay + 0.01);
        gain.gain.linearRampToValueAtTime(0, now + delay + 0.06);
        osc.connect(gain); gain.connect(this.reverb); gain.connect(this.master);
        osc.start(now + delay); osc.stop(now + delay + 0.08);
      });
    } else if (family === 'red') {
      const osc = this.ctx.createOscillator();
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      const gain = this.ctx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(80, now);
      lfo.frequency.setValueAtTime(16, now); lfoGain.gain.setValueAtTime(10, now);
      lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.03, now + 0.04);
      gain.gain.linearRampToValueAtTime(0, now + 0.4);
      osc.connect(gain); gain.connect(this.reverb); gain.connect(this.master);
      osc.start(now); lfo.start(now); osc.stop(now + 0.45); lfo.stop(now + 0.45);
    } else if (family === 'yellow') {
      const osc = this.ctx.createOscillator();
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      const gain = this.ctx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(880, now);
      lfo.frequency.setValueAtTime(10, now); lfoGain.gain.setValueAtTime(100, now);
      lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.02, now + 0.05);
      gain.gain.linearRampToValueAtTime(0, now + 0.45);
      osc.connect(gain); gain.connect(this.reverb); gain.connect(this.master);
      osc.start(now); lfo.start(now); osc.stop(now + 0.5); lfo.stop(now + 0.5);
    } else if (family === 'magenta') {
      const bufLen = Math.floor(this.ctx.sampleRate * 0.1);
      const buf = this.ctx.createBuffer(1, bufLen, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource(); src.buffer = buf;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.setValueAtTime(700, now); bp.Q.setValueAtTime(2.5, now);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.04, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + 0.1);
      src.connect(bp); bp.connect(gain);
      gain.connect(this.reverb); gain.connect(this.master);
      src.start(now); src.stop(now + 0.12);
    } else if (family === 'cyan') {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(1200, now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.025, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
      osc.connect(gain); gain.connect(this.reverb); gain.connect(this.master);
      osc.start(now); osc.stop(now + 1.1);
    } else {
      this._microRustle();
    }
  }

  /**
   * triggerDustSpawn
   * Purpose:  Rising sine tone (110→196Hz over 2s) when a spore lands near
   *           dust and spawns a new colony — new life from decay.
   * Input:    none
   * Output:   void
   */
  triggerDustSpawn() {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, now);
    osc.frequency.linearRampToValueAtTime(196, now + 2.0);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.025, now + 0.6);
    gain.gain.linearRampToValueAtTime(0, now + 2.5);
    osc.connect(gain); gain.connect(this.reverb); gain.connect(this.master);
    osc.start(now); osc.stop(now + 2.6);
  }

  /**
   * stopAll
   * Purpose:  Fade out and stop all continuous nodes over 2 seconds.
   *           Safe to call even if audio was never started.
   * Input:    none
   * Output:   void
   */
  stopAll() {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    this.droneLayers.forEach(layer => {
      try {
        layer.gain.gain.linearRampToValueAtTime(0, now + 2.0);
        layer.osc.stop(now + 2.1);
        layer.sub.stop(now + 2.1);
        layer.lfo.stop(now + 2.1);
      } catch(e) {}
    });
    this.droneLayers = [];
    try { this.brightGain.gain.linearRampToValueAtTime(0, now + 2.0); } catch(e) {}
    try { this.warmGain.gain.linearRampToValueAtTime(0, now + 2.0); } catch(e) {}
  }
}