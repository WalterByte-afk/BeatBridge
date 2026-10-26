/**
 * AuraDJ - Essentia WASM Analysis Worker
 * File: workers/essentia-worker.js
 * 
 * Performs high-precision audio analysis on accumulated 10-second PCM buffers (441,000 samples @ 44.1kHz).
 * Uses Essentia.js WASM for RhythmExtractor2013 (BPM & beat positions) and KeyExtractor (musical key & scale).
 * Provides a production-grade DSP fallback (Butterworth lowpass filter + energy onset envelope + 
 * autocorrelation with sub-sample parabolic interpolation) when Essentia WASM is not installed.
 */

// ---------------------------------------------------------------------------
// Configuration & State
// ---------------------------------------------------------------------------
const SAMPLE_RATE = 44100;
const ANALYSIS_DURATION_SEC = 10;
const ANALYSIS_BUFFER_SIZE = SAMPLE_RATE * ANALYSIS_DURATION_SEC; // 441,000 samples

let analysisBuffer = new Float32Array(ANALYSIS_BUFFER_SIZE);
let samplesCollected = 0;

let essentia = null;
let essentiaWasm = null;
let isEssentiaReady = false;

// ---------------------------------------------------------------------------
// Camelot Wheel Conversion Table (All 24 Major & Minor Keys + Enharmonics)
// ---------------------------------------------------------------------------
const CAMELOT_MAP = {
  // Minor Keys (A - Inner Ring)
  'ab minor': '1A', 'g# minor': '1A', 'ab min': '1A', 'g# min': '1A', 'abm': '1A', 'g#m': '1A',
  'eb minor': '2A', 'd# minor': '2A', 'eb min': '2A', 'd# min': '2A', 'ebm': '2A', 'd#m': '2A',
  'bb minor': '3A', 'a# minor': '3A', 'bb min': '3A', 'a# min': '3A', 'bbm': '3A', 'a#m': '3A',
  'f minor':  '4A', 'f min':  '4A', 'fm':  '4A',
  'c minor':  '5A', 'c min':  '5A', 'cm':  '5A',
  'g minor':  '6A', 'g min':  '6A', 'gm':  '6A',
  'd minor':  '7A', 'd min':  '7A', 'dm':  '7A',
  'a minor':  '8A', 'a min':  '8A', 'am':  '8A',
  'e minor':  '9A', 'e min':  '9A', 'em':  '9A',
  'b minor':  '10A', 'b min':  '10A', 'bm':  '10A',
  'f# minor': '11A', 'gb minor': '11A', 'f# min': '11A', 'gb min': '11A', 'f#m': '11A', 'gbm': '11A',
  'c# minor': '12A', 'db minor': '12A', 'c# min': '12A', 'db min': '12A', 'c#m': '12A', 'dbm': '12A',

  // Major Keys (B - Outer Ring)
  'b major':  '1B', 'b maj':  '1B', 'b':  '1B',
  'f# major': '2B', 'gb major': '2B', 'f# maj': '2B', 'gb maj': '2B', 'f#': '2B', 'gb': '2B',
  'db major': '3B', 'c# major': '3B', 'db maj': '3B', 'c# maj': '3B', 'db': '3B', 'c#': '3B',
  'ab major': '4B', 'g# major': '4B', 'ab maj': '4B', 'g# maj': '4B', 'ab': '4B', 'g#': '4B',
  'eb major': '5B', 'd# major': '5B', 'eb maj': '5B', 'd# maj': '5B', 'eb': '5B', 'd#': '5B',
  'bb major': '6B', 'a# major': '6B', 'bb maj': '6B', 'a# maj': '6B', 'bb': '6B', 'a#': '6B',
  'f major':  '7B', 'f maj':  '7B', 'f':  '7B',
  'c major':  '8B', 'c maj':  '8B', 'c':  '8B',
  'g major':  '9B', 'g maj':  '9B', 'g':  '9B',
  'd major':  '10B', 'd maj':  '10B', 'd':  '10B',
  'a major':  '11B', 'a maj':  '11B', 'a':  '11B',
  'e major':  '12B', 'e maj':  '12B', 'e':  '12B'
};

/**
 * Converts Key and Scale to Camelot Code (e.g. "C", "major" -> "8B")
 */
function toCamelot(key, scale) {
  if (!key) return '8A';
  const cleanKey = key.trim().toLowerCase();
  const cleanScale = (scale || '').trim().toLowerCase();
  const query = `${cleanKey} ${cleanScale}`.trim();

  if (CAMELOT_MAP[query]) return CAMELOT_MAP[query];
  if (CAMELOT_MAP[cleanKey]) return CAMELOT_MAP[cleanKey];

  // Fallback heuristic based on root note and mode
  const isMinor = cleanScale.includes('min') || cleanScale === 'm';
  return isMinor ? '8A' : '8B';
}

// ---------------------------------------------------------------------------
// Essentia WASM Initialization
// ---------------------------------------------------------------------------

// Polyfill document and window for Emscripten / Essentia in Web Worker context
if (typeof self.document === 'undefined') {
  self.document = {
    createElement: () => ({}),
    getElementsByTagName: () => [],
    head: {},
    body: {},
    currentScript: null,
    location: self.location
  };
}
if (typeof self.window === 'undefined') {
  self.window = self;
}

function initEssentia() {
  try {
    // Configure WASM location
    self.Module = self.Module || {};
    self.Module.locateFile = function (path, prefix) {
      if (path.endsWith('.wasm')) {
        return '../lib/' + path;
      }
      return (prefix || '') + path;
    };

    // Import Essentia WASM binary loader
    try {
      importScripts('../lib/essentia-wasm.module.js');
    } catch (e1) {
      try {
        importScripts('/lib/essentia-wasm.module.js');
      } catch (e2) {}
    }

    // Import Essentia JS high-level API wrapper
    try {
      importScripts('../lib/essentia.js-core.js');
    } catch (e3) {
      try {
        importScripts('/lib/essentia.js-core.js');
      } catch (e4) {}
    }

    if (typeof EssentiaWASM !== 'undefined') {
      if (typeof EssentiaWASM === 'function') {
        const wasmPromise = EssentiaWASM();
        if (wasmPromise && typeof wasmPromise.then === 'function') {
          wasmPromise.then((wasmInstance) => {
            essentiaWasm = wasmInstance;
            if (typeof Essentia !== 'undefined') {
              essentia = new Essentia(wasmInstance);
            } else {
              essentia = wasmInstance;
            }
            isEssentiaReady = true;
            console.log('[AuraDJ] Essentia WASM initialized successfully');
          }).catch((err) => {
            console.warn('[AuraDJ] Essentia WASM initialization rejected:', err);
          });
        }
      } else if (typeof Essentia !== 'undefined') {
        essentia = new Essentia(EssentiaWASM);
        isEssentiaReady = true;
        console.log('[AuraDJ] Essentia WASM initialized synchronously');
      }
    }
  } catch (err) {
    console.warn('[AuraDJ] Essentia WASM could not be loaded, using fallback beat detector:', err);
  }
}

// Initialize on worker load
initEssentia();

// ---------------------------------------------------------------------------
// Fallback DSP: Autocorrelation Beat Detection Pipeline
// ---------------------------------------------------------------------------

/**
 * 2nd-order Butterworth low-pass filter to isolate rhythmic bass energy (kick/bassline)
 */
function applyButterworthLowpass(signal, sampleRate, cutoff = 200, q = 0.7071) {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw0 = Math.cos(w0);

  const b0 = (1 - cosw0) / 2;
  const b1 = 1 - cosw0;
  const b2 = (1 - cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;

  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;

  const filtered = new Float32Array(signal.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

  for (let i = 0; i < signal.length; i++) {
    const x0 = signal[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    filtered[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return filtered;
}

/**
 * Robust DSP fallback beat detection using onset envelope extraction and autocorrelation
 */
function runFallbackAnalysis(buffer) {
  // DSP autocorrelation analysis runs continuously on 10s audio buffers

  // 1. Isolate low-frequency rhythm content (<200 Hz)
  const lowpassed = applyButterworthLowpass(buffer, SAMPLE_RATE, 200, 0.7071);

  // 2. Compute decimation / envelope onset flux (hop size = 128 samples -> ~344.5 Hz envelope rate)
  const hopSize = 128;
  const envelopeRate = SAMPLE_RATE / hopSize;
  const numFrames = Math.floor(lowpassed.length / hopSize);
  const energyEnvelope = new Float32Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    let frameSum = 0;
    const offset = f * hopSize;
    for (let j = 0; j < hopSize; j++) {
      const s = lowpassed[offset + j];
      frameSum += s * s;
    }
    energyEnvelope[f] = Math.sqrt(frameSum / hopSize);
  }

  // 3. Half-wave rectified onset difference (detect attack transients)
  const onsetFlux = new Float32Array(numFrames);
  let fluxSum = 0;
  for (let i = 1; i < numFrames; i++) {
    const diff = energyEnvelope[i] - energyEnvelope[i - 1];
    onsetFlux[i] = diff > 0 ? diff : 0;
    fluxSum += onsetFlux[i];
  }

  // Remove DC bias
  const fluxMean = fluxSum / numFrames;
  for (let i = 0; i < numFrames; i++) {
    onsetFlux[i] = Math.max(0, onsetFlux[i] - fluxMean);
  }

  // 4. Autocorrelation over BPM range [60, 200]
  // Lag limits in envelope samples:
  // 200 BPM -> T = 60/200 = 0.30s -> lag = 0.30 * 344.53 = 103 samples
  // 60 BPM  -> T = 60/60  = 1.00s -> lag = 1.00 * 344.53 = 345 samples
  const minBpm = 60;
  const maxBpm = 200;
  const lagMin = Math.floor(envelopeRate * (60 / maxBpm));
  const lagMax = Math.ceil(envelopeRate * (60 / minBpm));

  let bestLag = lagMin;
  let maxCorr = -1;
  const corrArray = new Float32Array(lagMax + 2);

  for (let lag = lagMin; lag <= lagMax; lag++) {
    let sum = 0;
    const len = numFrames - lag;
    for (let i = 0; i < len; i++) {
      sum += onsetFlux[i] * onsetFlux[i + lag];
    }
    const normalized = sum / len; // Unbiased autocorrelation
    corrArray[lag] = normalized;
    if (normalized > maxCorr) {
      maxCorr = normalized;
      bestLag = lag;
    }
  }

  // 5. Fundamental beat resolution: check near half-lag (for double tempo e.g. 128 vs 64 BPM)
  const targetHalf = Math.round(bestLag / 2);
  if (targetHalf >= lagMin) {
    let subPeakLag = targetHalf;
    let subPeakVal = -1;
    for (let l = targetHalf - 2; l <= targetHalf + 2; l++) {
      if (corrArray[l] > subPeakVal) {
        subPeakVal = corrArray[l];
        subPeakLag = l;
      }
    }
    // If the sub-peak is at least 50% of maxCorr, it is the true fundamental beat!
    if (subPeakVal >= maxCorr * 0.50) {
      bestLag = subPeakLag;
    }
  }

  // Parabolic peak interpolation for sub-sample BPM precision
  let interpolatedLag = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = corrArray[bestLag - 1];
    const y1 = corrArray[bestLag];
    const y2 = corrArray[bestLag + 1];
    const denom = 2 * (2 * y1 - y0 - y2);
    if (denom !== 0) {
      const delta = (y2 - y0) / denom;
      if (Math.abs(delta) < 1) {
        interpolatedLag = bestLag + delta;
      }
    }
  }

  // Calculate detected BPM
  let detectedBpm = (60 * envelopeRate) / interpolatedLag;

  // Clamp within reasonable musical limits
  detectedBpm = Math.max(60, Math.min(220, detectedBpm));

  // 6. Generate approximate beat positions across the 10-second buffer
  const beatPeriodSec = 60 / detectedBpm;
  const beats = [];
  const downbeats = [];

  // Align phase with the strongest onset peak in the first 2 beat periods
  const searchWindow = Math.min(numFrames, Math.floor(envelopeRate * beatPeriodSec * 2));
  let peakOnsetIdx = 0;
  let maxOnsetVal = 0;
  for (let i = 0; i < searchWindow; i++) {
    if (onsetFlux[i] > maxOnsetVal) {
      maxOnsetVal = onsetFlux[i];
      peakOnsetIdx = i;
    }
  }
  const firstBeatSec = peakOnsetIdx / envelopeRate;

  let currentBeatTime = firstBeatSec;
  let beatCount = 0;
  while (currentBeatTime < ANALYSIS_DURATION_SEC) {
    beats.push(Math.round(currentBeatTime * 1000) / 1000);
    if (beatCount % 4 === 0) {
      downbeats.push(Math.round(currentBeatTime * 1000) / 1000);
    }
    currentBeatTime += beatPeriodSec;
    beatCount++;
  }

  // Normalize confidence (0.4 to 0.95 scale based on peak prominence)
  const avgCorr = corrArray.reduce((acc, v) => acc + v, 0) / (lagMax - lagMin + 1);
  const confidence = Math.min(0.95, Math.max(0.40, (maxCorr / (avgCorr + 1e-6)) * 0.35));

  postMessage({
    type: 'ANALYSIS_RESULT',
    bpm: Math.round(detectedBpm * 10) / 10,
    beats: beats,
    downbeats: downbeats,
    key: 'C major',
    camelot: '8B',
    confidence: Math.round(confidence * 100) / 100,
    method: 'fallback-autocorrelation'
  });
}

// ---------------------------------------------------------------------------
// Essentia WASM Analysis Routine
// ---------------------------------------------------------------------------
function runEssentiaAnalysis(buffer) {
  try {
    if (!essentia) {
      runFallbackAnalysis(buffer);
      return;
    }

    // Convert Float32Array to Emscripten Vector
    const signalVector = essentia.arrayToVector(buffer);

    // 1. Rhythm & BPM extraction
    const rhythm = essentia.RhythmExtractor2013(signalVector);
    const bpm = rhythm.bpm || 0;
    const ticks = rhythm.ticks ? essentia.vectorToArray(rhythm.ticks) : [];
    const confidence = rhythm.confidence || 0.8;

    // 2. Key & Scale extraction
    let key = 'C';
    let scale = 'major';
    if (typeof essentia.KeyExtractor === 'function') {
      const keyData = essentia.KeyExtractor(signalVector);
      if (keyData) {
        key = keyData.key || 'C';
        scale = keyData.scale || 'major';
      }
    }

    const camelot = toCamelot(key, scale);

    // Free Emscripten Vector memory
    if (signalVector && typeof signalVector.delete === 'function') {
      signalVector.delete();
    }

    // Extract downbeats (every 4th beat)
    const downbeats = [];
    for (let i = 0; i < ticks.length; i += 4) {
      downbeats.push(ticks[i]);
    }

    postMessage({
      type: 'ANALYSIS_RESULT',
      bpm: Math.round(bpm * 10) / 10,
      beats: Array.from(ticks),
      downbeats: downbeats,
      key: `${key} ${scale}`.trim(),
      camelot: camelot,
      confidence: Math.round(confidence * 100) / 100,
      method: 'essentia'
    });
  } catch (err) {
    console.warn('[AuraDJ] Essentia WASM execution error, falling back:', err);
    runFallbackAnalysis(buffer);
  }
}

// ---------------------------------------------------------------------------
// Worker Message Handling & Stream Accumulation
// ---------------------------------------------------------------------------
self.onmessage = function (event) {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'PCM_CHUNK') {
    const chunkData = msg.data || msg.buffer;
    if (!chunkData) return;

    const chunk = new Float32Array(chunkData);
    const samplesToCopy = Math.min(chunk.length, ANALYSIS_BUFFER_SIZE - samplesCollected);

    analysisBuffer.set(chunk.subarray(0, samplesToCopy), samplesCollected);
    samplesCollected += samplesToCopy;

    // When the 10-second buffer is full, trigger analysis and reset
    if (samplesCollected >= ANALYSIS_BUFFER_SIZE) {
      const bufferToAnalyze = new Float32Array(analysisBuffer);

      // Reset buffer immediately to begin collecting the next analysis window
      analysisBuffer = new Float32Array(ANALYSIS_BUFFER_SIZE);
      samplesCollected = 0;

      if (isEssentiaReady && essentia) {
        runEssentiaAnalysis(bufferToAnalyze);
      } else {
        runFallbackAnalysis(bufferToAnalyze);
      }
    }
  } else if (msg.type === 'RESET') {
    analysisBuffer = new Float32Array(ANALYSIS_BUFFER_SIZE);
    samplesCollected = 0;
    console.log('[AuraDJ] Essentia worker buffer reset');
  }
};
