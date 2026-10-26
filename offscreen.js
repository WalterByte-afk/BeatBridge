/**
 * AuraDJ - Master Audio Engine (Offscreen Document Script)
 * File: offscreen.js
 * 
 * Production-grade Web Audio API processing engine running inside Chrome Extension Offscreen Document.
 * Manages:
 * 1. Single AudioContext (44.1kHz) and live tab media stream capture.
 * 2. Dual-deck signal chains (Deck A and Deck B) with Butterworth 3-band EQ splitters.
 * 3. MediaRecorder tail buffer capture (30s before track end) and AudioBuffer decoding.
 * 4. Apple AutoMix style BPM-quantized transitions with AudioParam automation and memory reclamation.
 * 5. Real-time Vocal Clash Guard (300Hz-4kHz energy threshold) delaying bass swap by 2 beats.
 * 6. High-speed AnalyserNode visualizer broadcasting (33ms waveform updates).
 * 7. Hardware encoder knob and crossfader DSP mapping (tune, decay/bass, cutoff, fold waveshaper).
 * 8. Real-time Web Audio SFX synthesis (scratch, spinback, airhorn, filter sweep).
 * 9. AudioWorklet PCM tap + Essentia WASM worker communication with zero-copy Transferable ArrayBuffers.
 */

// ---------------------------------------------------------------------------
// Global Engine State & Singletons
// ---------------------------------------------------------------------------
let audioContext = null;
let liveStream = null;
let liveStreamSource = null;
let pcmWorkletNode = null;
let essentiaWorker = null;

// Deck Signal Chains
let deckA = null;
let deckB = null;

// Master FX Bus Nodes
let masterCutoffFilter = null;
let masterFoldShaper = null;
let masterGain = null;
let masterAnalyserNode = null;
let vocalAnalyserNode = null;

// Rolling Stereo PCM Ring Buffer (Holds up to 20 seconds of continuous live audio)
const RING_BUFFER_SEC = 20;
const SAMPLE_RATE = 44100;
const RING_BUFFER_SIZE = SAMPLE_RATE * RING_BUFFER_SEC; // 882,000 samples
const ringLeft = new Float32Array(RING_BUFFER_SIZE);
const ringRight = new Float32Array(RING_BUFFER_SIZE);
let ringWritePos = 0;
let totalSamplesBuffered = 0;

function appendToRingBuffer(leftChunk, rightChunk) {
  if (!leftChunk || !rightChunk) return;
  const len = leftChunk.length;
  for (let i = 0; i < len; i++) {
    ringLeft[ringWritePos] = leftChunk[i];
    ringRight[ringWritePos] = rightChunk[i];
    ringWritePos = (ringWritePos + 1) % RING_BUFFER_SIZE;
  }
  totalSamplesBuffered += len;
}

let vocalDetected = false;

// Intervals & Timeouts
let waveformInterval = null;
let vocalCheckInterval = null;
let bassSwapTimeout = null;
let transitionCompleteTimeout = null;
let activeTransitionCtx = null; // Shared state between transition Phase 1 (outgoing FX) and Phase 2 (incoming FX)

// Analysis and Waveform Data Buffers
const WAVEFORM_FFT_SIZE = 2048;
const waveformFreqData = new Uint8Array(WAVEFORM_FFT_SIZE / 2);
const vocalFreqData = new Uint8Array(WAVEFORM_FFT_SIZE / 2);

// Public Engine State
const engineState = {
  isCapturing: false,
  activeDeck: 'A',          // 'A' or 'B'
  isTransitioning: false,
  transitionPhase: 'IDLE',  // 'IDLE', 'MIXING', 'BASS_SWAP'
  automixEnabled: true,
  status: 'READY',
  bpm: 128.0,
  key: 'C major',
  camelot: '8B',
  confidence: 0.85,
  beats: [],
  downbeats: [],
  vocalDetected: false,
  trackEnergy: 0.5,         // 0.0 (ambient/soft) to 1.0 (heavy phonk/EDM)
  vibeMode: 'AUTO',         // 'TAPE_BRAKE', 'HALF_TIME', 'RISER_DROP', 'BEAT_DROP'
  crossfader: 50,           // 0 to 100
  playbackRate: 1.0,
  bassDb: 0,
  cutoffFreq: 20000,
  foldAmount: 0
};

// ---------------------------------------------------------------------------
// 1. Deck Signal Chain Class
// ---------------------------------------------------------------------------
/**
 * Signal flow per deck:
 * Input (Gain) -> 3-Band Butterworth Filter Splitter -> Per-Band Gains -> Deck Master Gain
 */
class DeckChain {
  constructor(context, id) {
    this.id = id;
    this.context = context;

    // Deck Input Node (feeds live stream or decoded tail buffer source)
    this.inputNode = context.createGain();

    // 1. Low Band (20 - 200 Hz): Butterworth Lowpass
    this.lowFilter = context.createBiquadFilter();
    this.lowFilter.type = 'lowpass';
    this.lowFilter.frequency.value = 200;
    this.lowFilter.Q.value = 0.7071; // Butterworth Q factor

    // 2. Mid Band (200 Hz - 5 kHz): Bandpass centered at 1 kHz
    this.midFilter = context.createBiquadFilter();
    this.midFilter.type = 'bandpass';
    this.midFilter.frequency.value = 1000;
    this.midFilter.Q.value = 0.5;

    // 3. High Band (5 kHz - 20 kHz): Butterworth Highpass
    this.highFilter = context.createBiquadFilter();
    this.highFilter.type = 'highpass';
    this.highFilter.frequency.value = 5000;
    this.highFilter.Q.value = 0.7071; // Butterworth Q factor

    // Per-Band Gain Nodes
    this.lowGain = context.createGain();
    this.midGain = context.createGain();
    this.highGain = context.createGain();

    this.lowGain.gain.value = 1.0;
    this.midGain.gain.value = 1.0;
    this.highGain.gain.value = 1.0;

    // Deck Master Gain Node
    this.masterGain = context.createGain();
    this.masterGain.gain.value = (id === 'A' ? 1.0 : 0.0);

    // ─── Transition FX: Resonant Filter ─────────────────────────────────
    // Default: highpass at 10 Hz = acoustically transparent passthrough
    // Outgoing transition: HPF sweeps 10 → 3000 Hz (DJ filter lift)
    // Incoming transition: switched to LPF sweeping 200 → 20000 Hz (track "opens up")
    this.transitionFilter = context.createBiquadFilter();
    this.transitionFilter.type = 'highpass';
    this.transitionFilter.frequency.value = 10;
    this.transitionFilter.Q.value = 0.7071;

    // ─── Transition FX: BPM-Synced Stereo Echo / Delay Freeze ───────────
    this.echoSend = context.createGain();
    this.echoSend.gain.value = 0.0; // Silent until transition activates
    this.echoDelay = context.createDelay(2.0); // Max 2 seconds
    this.echoDelay.delayTime.value = 0.375; // ~dotted 8th at 120 BPM
    this.echoFilter = context.createBiquadFilter();
    this.echoFilter.type = 'highpass';
    this.echoFilter.frequency.value = 400; // Thins echo tail, prevents low-end mud
    this.echoFilter.Q.value = 0.5;
    this.echoFeedback = context.createGain();
    this.echoFeedback.gain.value = 0.0; // Off by default
    this.echoReturn = context.createGain();
    this.echoReturn.gain.value = 0.0; // Silent until activated

    // Final Deck Output Node (includes transition FX before hitting master bus)
    this.deckOutput = context.createGain();
    this.deckOutput.gain.value = 1.0;

    // Assemble Splitter Network
    this.inputNode.connect(this.lowFilter);
    this.lowFilter.connect(this.lowGain);
    this.lowGain.connect(this.masterGain);

    this.inputNode.connect(this.midFilter);
    this.midFilter.connect(this.midGain);
    this.midGain.connect(this.masterGain);

    this.inputNode.connect(this.highFilter);
    this.highFilter.connect(this.highGain);
    this.highGain.connect(this.masterGain);

    // Dry Path: Master Gain → Transition Filter → Deck Output
    this.masterGain.connect(this.transitionFilter);
    this.transitionFilter.connect(this.deckOutput);

    // Wet Path: Master Gain → Echo Send → Delay → Echo HPF → Echo Return → Deck Output
    this.masterGain.connect(this.echoSend);
    this.echoSend.connect(this.echoDelay);
    this.echoDelay.connect(this.echoFilter);
    this.echoFilter.connect(this.echoReturn);
    this.echoReturn.connect(this.deckOutput);

    // Feedback Loop: Echo HPF → Feedback Gain → back to Delay input
    this.echoFilter.connect(this.echoFeedback);
    this.echoFeedback.connect(this.echoDelay);

    // Active buffer source reference
    this.activeSource = null;
  }

  resetGains() {
    const now = this.context.currentTime;
    this.lowGain.gain.cancelScheduledValues(now);
    this.midGain.gain.cancelScheduledValues(now);
    this.highGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.cancelScheduledValues(now);

    this.lowGain.gain.setValueAtTime(1.0, now);
    this.midGain.gain.setValueAtTime(1.0, now);
    this.highGain.gain.setValueAtTime(1.0, now);

    // Reset transition filter to transparent passthrough
    this.transitionFilter.type = 'highpass';
    this.transitionFilter.frequency.cancelScheduledValues(now);
    this.transitionFilter.Q.cancelScheduledValues(now);
    this.transitionFilter.frequency.setValueAtTime(10, now);
    this.transitionFilter.Q.setValueAtTime(0.7071, now);

    // Kill echo chain completely
    this.echoSend.gain.cancelScheduledValues(now);
    this.echoSend.gain.setValueAtTime(0.0, now);
    this.echoReturn.gain.cancelScheduledValues(now);
    this.echoReturn.gain.setValueAtTime(0.0, now);
    this.echoFeedback.gain.cancelScheduledValues(now);
    this.echoFeedback.gain.setValueAtTime(0.0, now);
    this.echoFilter.frequency.cancelScheduledValues(now);
    this.echoFilter.frequency.setValueAtTime(400, now);
  }

  disconnectSource() {
    if (this.activeSource) {
      try {
        this.activeSource.stop();
      } catch (e) {}
      try {
        this.activeSource.disconnect();
      } catch (e) {}
      this.activeSource = null;
    }
  }

  destroy() {
    this.disconnectSource();
    try {
      this.inputNode.disconnect();
      this.lowFilter.disconnect();
      this.midFilter.disconnect();
      this.highFilter.disconnect();
      this.lowGain.disconnect();
      this.midGain.disconnect();
      this.highGain.disconnect();
      this.masterGain.disconnect();
      this.transitionFilter.disconnect();
      this.echoSend.disconnect();
      this.echoDelay.disconnect();
      this.echoFilter.disconnect();
      this.echoFeedback.disconnect();
      this.echoReturn.disconnect();
      this.deckOutput.disconnect();
    } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// 2. Audio Graph & Context Initialization
// ---------------------------------------------------------------------------
function getAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({
      sampleRate: 44100,
      latencyHint: 'interactive'
    });
    console.log('[AuraDJ] AudioContext initialized @ 44100Hz');
  }

  if (audioContext.state === 'suspended') {
    audioContext.resume().then(() => {
      console.log('[AuraDJ] AudioContext resumed');
    });
  }

  return audioContext;
}

/**
 * Builds the Master Output Chain:
 * Decks A & B -> Master Cutoff Filter -> WaveShaper (Fold) -> Master Gain -> Master Analyser -> Destination
 */
function buildMasterAudioGraph() {
  const ctx = getAudioContext();

  // If already built, reuse existing decks and bus
  if (deckA && deckB) {
    return;
  }

  // Create Decks
  deckA = new DeckChain(ctx, 'A');
  deckB = new DeckChain(ctx, 'B');

  // Master Lowpass Filter for Cutoff Knob (200Hz - 20kHz)
  masterCutoffFilter = ctx.createBiquadFilter();
  masterCutoffFilter.type = 'lowpass';
  masterCutoffFilter.frequency.value = engineState.cutoffFreq;
  masterCutoffFilter.Q.value = 0.7071;

  // Master WaveShaper for Fold Knob
  masterFoldShaper = ctx.createWaveShaper();
  masterFoldShaper.oversample = '4x';
  masterFoldShaper.curve = makeDistortionCurve(engineState.foldAmount);

  // Master Output Gain Node
  masterGain = ctx.createGain();
  masterGain.gain.value = 1.0;

  // Master Waveform Analyser Node
  masterAnalyserNode = ctx.createAnalyser();
  masterAnalyserNode.fftSize = WAVEFORM_FFT_SIZE;
  masterAnalyserNode.smoothingTimeConstant = 0.8;

  // Vocal Clash Analyser Node (Tapped from active playing source)
  vocalAnalyserNode = ctx.createAnalyser();
  vocalAnalyserNode.fftSize = WAVEFORM_FFT_SIZE;
  vocalAnalyserNode.smoothingTimeConstant = 0.3;

  // Connect Decks to Master FX Bus (via deckOutput which includes transition FX)
  deckA.deckOutput.connect(masterCutoffFilter);
  deckB.deckOutput.connect(masterCutoffFilter);

  // Master FX Serial Chain
  masterCutoffFilter.connect(masterFoldShaper);
  masterFoldShaper.connect(masterGain);
  masterGain.connect(masterAnalyserNode);
  masterAnalyserNode.connect(ctx.destination);

  console.log('[AuraDJ] Master audio graph constructed');
}

/**
 * Distortion / Saturation Curve Generator for Fold Control
 */
function makeDistortionCurve(amount) {
  const k = typeof amount === 'number' ? amount : 0;
  const n_samples = 44100;
  const curve = new Float32Array(n_samples);
  const deg = Math.PI / 180;

  if (k <= 0) {
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = x; // Linear passthrough
    }
    return curve;
  }

  for (let i = 0; i < n_samples; ++i) {
    const x = (i * 2) / n_samples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

// ---------------------------------------------------------------------------
// 3. Audio Capture & AudioWorklet / Essentia Worker Setup
// ---------------------------------------------------------------------------
async function startCapture(streamId) {
  if (!streamId || typeof streamId !== 'string') {
    console.log('[AuraDJ] startCapture received empty or non-string streamId, ignoring');
    return false;
  }
  console.log('[AuraDJ] Starting capture for mediaStreamId:', streamId);
  const ctx = getAudioContext();

  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => {});
  }

  // If already capturing actively with a valid live stream, avoid duplicate getUserMedia
  if (engineState.isCapturing && liveStream && liveStream.active && liveStreamSource) {
    console.log('[AuraDJ] Audio capture is already active and healthy.');
    return true;
  }

  // Ensure any previous stream tracks are stopped so Chrome does not lock tab capture
  if (liveStream) {
    try {
      liveStream.getTracks().forEach((track) => track.stop());
    } catch (e) {}
    liveStream = null;
  }

  try {
    // 1. Capture Tab Audio via getUserMedia
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    };

    liveStream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log('[AuraDJ] Captured live tab MediaStream successfully');

    // Handle track ended
    liveStream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        console.warn('[AuraDJ] Captured tab media track ended');
        engineState.isCapturing = false;
        broadcastEngineState();
      };
    });

    // 2. Setup Audio Graph
    buildMasterAudioGraph();

    if (liveStreamSource) {
      try { liveStreamSource.disconnect(); } catch (e) {}
    }
    liveStreamSource = ctx.createMediaStreamSource(liveStream);

    // Initial routing: Connect live stream to active deck and Vocal Analyser
    const activeDeck = (engineState.activeDeck === 'B') ? deckB : deckA;
    const inactiveDeck = (engineState.activeDeck === 'B') ? deckA : deckB;

    liveStreamSource.connect(activeDeck.inputNode);
    liveStreamSource.connect(vocalAnalyserNode);

    activeDeck.masterGain.gain.setValueAtTime(1.0, ctx.currentTime);
    inactiveDeck.masterGain.gain.setValueAtTime(0.0, ctx.currentTime);
    engineState.isCapturing = true;

    // 3. Setup AudioWorklet for Real-Time PCM Tap
    try {
      const workletUrl = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
        ? chrome.runtime.getURL('workers/audio-worklet.js')
        : 'workers/audio-worklet.js';

      await ctx.audioWorklet.addModule(workletUrl);
      pcmWorkletNode = new AudioWorkletNode(ctx, 'pcm-capture-processor');
      liveStreamSource.connect(pcmWorkletNode);
      console.log('[AuraDJ] PCMCaptureProcessor AudioWorklet attached');

      // 4. Setup Essentia Worker
      const workerUrl = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
        ? chrome.runtime.getURL('workers/essentia-worker.js')
        : 'workers/essentia-worker.js';

      essentiaWorker = new Worker(workerUrl);

      // Forward PCM chunks from AudioWorklet to Essentia Worker & Ring Buffer
      pcmWorkletNode.port.onmessage = (event) => {
        if (!event.data || event.data.type !== 'PCM_CHUNK') return;

        // 1. Forward mono PCM chunk to Essentia Worker for beat/key extraction
        if (event.data.mono && essentiaWorker) {
          essentiaWorker.postMessage(
            { type: 'PCM_CHUNK', data: event.data.mono },
            [event.data.mono]
          );
        } else if (event.data.data && essentiaWorker) {
          essentiaWorker.postMessage(
            { type: 'PCM_CHUNK', data: event.data.data },
            [event.data.data]
          );
        }

        // 2. Append stereo chunk to the real-time rolling ring buffer for seamless outro transitions
        if (event.data.left && event.data.right) {
          appendToRingBuffer(new Float32Array(event.data.left), new Float32Array(event.data.right));
        }
      };

      // Handle Analysis Results from Essentia Worker
      essentiaWorker.onmessage = (event) => {
        const result = event.data;
        if (result && result.type === 'ANALYSIS_RESULT') {
          engineState.bpm = result.bpm;
          engineState.key = result.key;
          engineState.camelot = result.camelot;
          engineState.confidence = result.confidence;
          engineState.beats = result.beats || [];
          engineState.downbeats = result.downbeats || [];

          console.log(`[AuraDJ] Analysis result: ${result.bpm} BPM | Key: ${result.key} (${result.camelot}) | Conf: ${result.confidence} [${result.method}]`);
          broadcastEngineState();
        }
      };
    } catch (workletErr) {
      console.warn('[AuraDJ] AudioWorklet or Essentia worker setup failed, continuing playback:', workletErr);
    }

    // 5. Start Real-time Monitoring & Broadcast Loops
    initVocalClashDetector();
    initWaveformBroadcast();

    broadcastEngineState();
    return true;
  } catch (err) {
    console.error('[AuraDJ] Failed to start audio capture:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 4. Apple AutoMix Outro Loop & Transition Engine
// ---------------------------------------------------------------------------

/**
 * Triggered at 12s remaining before track end.
 * Loops the current 4-bar groove seamlessly on the outgoing deck while
 * YouTube Music advances to Track B.
 */
function handleTriggerAutoMix() {
  if (!engineState.automixEnabled || engineState.isTransitioning) {
    console.log('[AuraDJ] AutoMix trigger ignored (already transitioning or disabled)');
    return;
  }

  const ctx = getAudioContext();
  if (!deckA || !deckB) {
    buildMasterAudioGraph();
  }

  const outgoingDeck = (engineState.activeDeck === 'A') ? deckA : deckB;
  const incomingDeck = (engineState.activeDeck === 'A') ? deckB : deckA;

  if (!outgoingDeck || !incomingDeck) {
    console.warn('[AuraDJ] Decks not available for AutoMix transition');
    return;
  }

  console.log(`[AuraDJ] TRIGGER_AUTOMIX: Seamless transition Deck ${outgoingDeck.id} -> Deck ${incomingDeck.id}`);

  // 1. Calculate tempo-aligned phrase duration
  const bpm = (engineState.bpm && engineState.bpm >= 50 && engineState.bpm <= 220) ? engineState.bpm : 128.0;
  const barSec = (4 * 60) / bpm; // duration of 1 bar in seconds (e.g. 1.875s @ 128BPM)
  const transitionBars = bpm > 140 ? 4 : 8;
  const transitionDuration = transitionBars * barSec;

  // Keep live audio streaming smoothly through Deck A so the REAL song outro plays naturally!
  // No artificial repeating loops, no cut-off audio chunks — the actual song finishes its real musical phrase!
  if (liveStreamSource) {
    try {
      liveStreamSource.connect(outgoingDeck.inputNode);
    } catch (e) {}
  }

  // 2. Start Phase 1: Outgoing deck warm HPF sweep + BPM stereo echo wash on the ACTUAL song outro
  startOutgoingTransition(outgoingDeck, bpm, barSec, transitionDuration);

  // 3. Store transition context for Phase 2 (incoming FX triggered on TRACK_CHANGED)
  activeTransitionCtx = {
    outgoingDeck, incomingDeck, bpm, barSec,
    transitionDuration, bassSwapped: false, incomingStarted: false,
    outgoingEnergy: currentTrackEnergy,
    outgoingBass: currentBassEnergy
  };

  engineState.isTransitioning = true;
  engineState.transitionPhase = 'ECHO_OUT';
  engineState.status = 'MIXING...';
  broadcastEngineState();

  // Schedule overall cleanup after transition duration + echo tail decay
  if (transitionCompleteTimeout) clearTimeout(transitionCompleteTimeout);
  transitionCompleteTimeout = setTimeout(cleanupTransition, (transitionDuration + 5.0) * 1000);
}

/**
 * Handle track change signal.
 * If already transitioning via AutoMix, seamlessly continue with intelligent VIBE matching.
 * If manual skip in YTM, do an instant 100ms smooth crossfade without replaying old audio.
 */
function handleTrackChanged() {
  console.log('[AuraDJ] TRACK_CHANGED received.');

  // If AutoMix transition is in flight: START Phase 2 (incoming deck effects with adaptive vibe matching)
  if (engineState.isTransitioning && activeTransitionCtx && !activeTransitionCtx.incomingStarted) {
    console.log('[AuraDJ] Track changed during AutoMix — evaluating track vibes (Phase 2)');
    activeTransitionCtx.incomingStarted = true;

    // Connect live stream to incoming deck NOW (Track B has started playing)
    const incomingDeck = activeTransitionCtx.incomingDeck;
    const outgoingDeck = activeTransitionCtx.outgoingDeck;
    if (liveStreamSource) {
      liveStreamSource.connect(incomingDeck.inputNode);
    }

    // Adaptive Vibe Analysis: Sample incoming track profile over 100ms
    setTimeout(() => {
      let inBassSum = 0;
      let inMidSum = 0;
      let inHighSum = 0;

      if (vocalAnalyserNode) {
        vocalAnalyserNode.getByteFrequencyData(vocalFreqData);
        for (let i = 1; i <= 12; i++) inBassSum += vocalFreqData[i];
        for (let i = 13; i <= 160; i++) inMidSum += vocalFreqData[i];
        for (let i = 161; i <= 700; i++) inHighSum += vocalFreqData[i];
      }

      const inBassAvg = (inBassSum / 12) / 255;
      const inMidAvg = (inMidSum / 148) / 255;
      const inHighAvg = (inHighSum / 540) / 255;
      const incomingEnergy = inBassAvg * 0.5 + inMidAvg * 0.35 + inHighAvg * 0.15;

      const outgoingEnergy = activeTransitionCtx.outgoingEnergy || currentTrackEnergy || 0.5;
      const bpmA = activeTransitionCtx.bpm || 128;
      const bpmB = engineState.bpm || 128;
      const bpmRatio = Math.max(bpmA, bpmB) / Math.min(bpmA, bpmB);
      const isHalfTime = Math.abs(bpmRatio - 2.0) <= 0.18;

      console.log(`[AuraDJ] Vibe Check: OutEnergy=${(outgoingEnergy * 100).toFixed(0)}%, InEnergy=${(incomingEnergy * 100).toFixed(0)}%, Ratio=${bpmRatio.toFixed(2)}, HalfTime=${isHalfTime}`);

      if (outgoingEnergy > 0.45 && incomingEnergy < 0.35) {
        // High Energy / Phonk -> Soft / Instrumental
        executeTapeBrakeTransition(outgoingDeck, incomingDeck, bpmA, activeTransitionCtx.barSec);
      } else if (isHalfTime) {
        // Half-Time / Double-Time Metric Modulation
        executeHalfTimeTransition(outgoingDeck, incomingDeck, bpmA, bpmB, activeTransitionCtx.barSec);
      } else if (outgoingEnergy < 0.35 && incomingEnergy > 0.48) {
        // Soft / Ambient -> High Energy Phonk / Club Anthem
        executeEnergyRiserTransition(outgoingDeck, incomingDeck, bpmA, activeTransitionCtx.barSec);
      } else {
        // Matching Energy & Genre (Standard Beat-Drop Handoff)
        startIncomingTransition(incomingDeck, outgoingDeck, bpmA, activeTransitionCtx.barSec);
      }

      engineState.transitionPhase = 'BLENDING';
      broadcastEngineState();
    }, 100);

    return;
  }

  if (engineState.isTransitioning) {
    console.log('[AuraDJ] Track changed during active transition — continuing mix.');
    return;
  }

  // Manual skip or sudden track change:
  // Smoothly blend to the incoming deck over 100ms with ZERO playback of old audio!
  const ctx = getAudioContext();
  if (!deckA || !deckB) {
    buildMasterAudioGraph();
  }
  const outgoingDeck = (engineState.activeDeck === 'A') ? deckA : deckB;
  const incomingDeck = (engineState.activeDeck === 'A') ? deckB : deckA;

  if (!outgoingDeck || !incomingDeck) return;

  if (liveStreamSource) {
    try { liveStreamSource.disconnect(outgoingDeck.inputNode); } catch (e) {}
    liveStreamSource.connect(incomingDeck.inputNode);
  }

  outgoingDeck.disconnectSource();

  const now = ctx.currentTime;
  outgoingDeck.masterGain.gain.setValueAtTime(1.0, now);
  outgoingDeck.masterGain.gain.linearRampToValueAtTime(0.0, now + 0.1);

  incomingDeck.resetGains();
  incomingDeck.masterGain.gain.setValueAtTime(0.0, now);
  incomingDeck.masterGain.gain.linearRampToValueAtTime(1.0, now + 0.1);

  engineState.activeDeck = incomingDeck.id;
  engineState.status = 'LIVE';
  broadcastEngineState();
}

/**
 * Apple AutoMix Transition Engine:
 * Triggers the two-phase smart DJ transition:
 * Phase 1: Outgoing resonant HPF sweep + BPM-synced delay echo freeze wash
 * Phase 2: Incoming LPF sweep-open + downbeat bass drop & vocal clash guard
 */
function executeTransition() {
  handleTriggerAutoMix();
}

// ---------------------------------------------------------------------------
// 5. Apple AutoMix Transition FX Functions (Filter Sweeps + Echo Freeze)
// ---------------------------------------------------------------------------

/**
 * Phase 1: Outgoing Deck Effects (called from handleTriggerAutoMix)
 *
 * Instead of fading volume (crossfade), this creates a professional DJ transition:
 * - Resonant HPF sweep lifts the track "into the clouds" (10Hz → 3kHz)
 * - BPM-synced echo/delay freeze captures rhythmic tail that bridges into next track
 * - EQ bands stay FULL — the filter does the thinning, NOT volume!
 */
function startOutgoingTransition(deck, bpm, barSec, duration) {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const startTime = now + 0.02;
  const endTime = startTime + duration;
  const beatSec = 60 / bpm;
  const delayTime = Math.min(beatSec * 0.75, 0.45); // Dotted 8th note for lush stereo bridge

  // 1. Warm Resonant HPF Sweep: 20 Hz → 2400 Hz (smooth, musical DJ filter lift without harsh whistling)
  deck.transitionFilter.type = 'highpass';
  deck.transitionFilter.frequency.cancelScheduledValues(startTime);
  deck.transitionFilter.Q.cancelScheduledValues(startTime);
  deck.transitionFilter.frequency.setValueAtTime(20, startTime);
  deck.transitionFilter.frequency.exponentialRampToValueAtTime(2400, endTime);
  deck.transitionFilter.Q.setValueAtTime(0.7071, startTime);
  deck.transitionFilter.Q.linearRampToValueAtTime(1.4, startTime + duration * 0.6);
  deck.transitionFilter.Q.linearRampToValueAtTime(0.8, endTime);

  // 2. Lush Ambient Echo / Delay Wash — seamlessly bridges into the next track
  deck.echoDelay.delayTime.setValueAtTime(delayTime, startTime);

  deck.echoSend.gain.cancelScheduledValues(startTime);
  deck.echoSend.gain.setValueAtTime(0.0, startTime);
  deck.echoSend.gain.linearRampToValueAtTime(0.55, startTime + duration * 0.2);

  deck.echoReturn.gain.cancelScheduledValues(startTime);
  deck.echoReturn.gain.setValueAtTime(0.0, startTime);
  deck.echoReturn.gain.linearRampToValueAtTime(0.45, startTime + duration * 0.2);

  deck.echoFilter.frequency.cancelScheduledValues(startTime);
  deck.echoFilter.frequency.setValueAtTime(500, startTime);
  deck.echoFilter.frequency.exponentialRampToValueAtTime(2200, endTime);

  deck.echoFeedback.gain.cancelScheduledValues(startTime);
  deck.echoFeedback.gain.setValueAtTime(0.5, startTime);
  deck.echoFeedback.gain.linearRampToValueAtTime(0.68, startTime + duration * 0.5);

  // 3. Gentle Vocal Ducking: preserve musical warmth while clearing the singing voice
  deck.lowGain.gain.cancelScheduledValues(startTime);
  deck.lowGain.gain.setValueAtTime(1.0, startTime);

  deck.midGain.gain.cancelScheduledValues(startTime);
  deck.midGain.gain.setValueAtTime(1.0, startTime);
  deck.midGain.gain.exponentialRampToValueAtTime(0.2, startTime + Math.min(barSec * 1.5, 2.0));

  deck.highGain.gain.cancelScheduledValues(startTime);
  deck.highGain.gain.setValueAtTime(1.0, startTime);
  deck.highGain.gain.linearRampToValueAtTime(0.75, endTime);

  deck.masterGain.gain.cancelScheduledValues(startTime);
  deck.masterGain.gain.setValueAtTime(1.0, startTime);

  console.log(`[AuraDJ] Phase 1: Butter-smooth HPF sweep + echo wash (${duration.toFixed(1)}s, echo=${(delayTime * 1000).toFixed(0)}ms)`);
}

/**
 * Adaptive Vibe Transition 1: Turntable Motor Brake + Ambient Reverb Shimmer
 * Used when Outgoing Track is High Energy (Phonk/EDM/Trap) and Incoming Track is Soft/Instrumental/Acoustic.
 * Instead of clashing fast drums over a gentle piano, this stops the rhythm with an analog vinyl brake
 * and smears the trailing chord into an expansive ambient cloud, letting the acoustic melody shine cleanly.
 */
function executeTapeBrakeTransition(outDeck, inDeck, bpm, barSec) {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const brakeDuration = 0.65; // 650ms turntable motor spin-down
  const ambientDecaySec = 3.5;

  console.log('[AuraDJ] *** EXECUTING VIBE TRANSITION: TURNTABLE MOTOR BRAKE + AMBIENT SHIMMER ***');
  engineState.status = 'TAPE BRAKE';
  engineState.vibeMode = 'TAPE_BRAKE';
  engineState.transitionPhase = 'TAPE_BRAKE';
  broadcastEngineState();

  // 1. Analog Turntable Motor Spin-down on outgoing phrase loop
  if (outDeck.activeSource && outDeck.activeSource.playbackRate) {
    outDeck.activeSource.playbackRate.cancelScheduledValues(now);
    outDeck.activeSource.playbackRate.setValueAtTime(1.0, now);
    outDeck.activeSource.playbackRate.exponentialRampToValueAtTime(0.05, now + brakeDuration);
  }

  // 2. Outgoing dry audio cuts cleanly at the end of the brake
  outDeck.masterGain.gain.cancelScheduledValues(now);
  outDeck.masterGain.gain.setValueAtTime(outDeck.masterGain.gain.value, now);
  outDeck.masterGain.gain.linearRampToValueAtTime(0.0, now + brakeDuration);

  // 3. Catch the spinning tape tail into an expansive, shimmering ambient delay/reverb cloud
  outDeck.echoDelay.delayTime.setValueAtTime(0.42, now); // Dreamy space delay
  outDeck.echoFilter.frequency.setValueAtTime(750, now); // Warm ambient band
  outDeck.echoSend.gain.setValueAtTime(0.9, now);
  outDeck.echoSend.gain.linearRampToValueAtTime(0.0, now + brakeDuration + 0.1);
  outDeck.echoFeedback.gain.setValueAtTime(0.85, now);
  outDeck.echoFeedback.gain.linearRampToValueAtTime(0.4, now + ambientDecaySec * 0.5);
  outDeck.echoFeedback.gain.linearRampToValueAtTime(0.0, now + ambientDecaySec);
  outDeck.echoReturn.gain.setValueAtTime(0.65, now);
  outDeck.echoReturn.gain.linearRampToValueAtTime(0.25, now + ambientDecaySec * 0.6);
  outDeck.echoReturn.gain.linearRampToValueAtTime(0.0, now + ambientDecaySec);

  // 4. Incoming Soft/Instrumental Track: Pure Crystal-Clear Acoustic Entry!
  // NO MUFFLED 200Hz FILTER! Full transparency so the piano/acoustic shines cleanly!
  inDeck.transitionFilter.type = 'lowpass';
  inDeck.transitionFilter.frequency.cancelScheduledValues(now);
  inDeck.transitionFilter.frequency.setValueAtTime(20000, now); // Wide open
  inDeck.transitionFilter.Q.setValueAtTime(0.7071, now);

  inDeck.lowGain.gain.cancelScheduledValues(now);
  inDeck.lowGain.gain.setValueAtTime(1.0, now);
  inDeck.midGain.gain.cancelScheduledValues(now);
  inDeck.midGain.gain.setValueAtTime(1.0, now);
  inDeck.highGain.gain.cancelScheduledValues(now);
  inDeck.highGain.gain.setValueAtTime(1.0, now);

  // Smooth 450ms gentle volume swell into the ambient cloud
  inDeck.masterGain.gain.cancelScheduledValues(now);
  inDeck.masterGain.gain.setValueAtTime(0.0, now);
  inDeck.masterGain.gain.linearRampToValueAtTime(1.0, now + 0.45);

  if (activeTransitionCtx) activeTransitionCtx.bassSwapped = true;
}

/**
 * Adaptive Vibe Transition 2: Metric Half-Time / Double-Time Modulation
 * Used when tempos are in a 2:1 ratio (e.g. 150 BPM Phonk <-> 75 BPM Lofi/Chill/Trap).
 * Strips high-frequency hi-hat clutter and syncs delay to the half-time pulse grid.
 */
function executeHalfTimeTransition(outDeck, inDeck, bpmA, bpmB, barSec) {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const baseBpm = Math.min(bpmA, bpmB);
  const halfBeatSec = 60 / baseBpm;
  const delayTime = halfBeatSec * 0.75; // Dotted 8th on the half-time grid

  console.log(`[AuraDJ] *** EXECUTING VIBE TRANSITION: METRIC HALF-TIME LOCK (${baseBpm.toFixed(1)} BPM GRID) ***`);
  engineState.status = '1/2 TIME SYNC';
  engineState.vibeMode = 'HALF_TIME';
  engineState.transitionPhase = 'HALF_TIME';
  broadcastEngineState();

  // Strip fast 16th-note phonk hi-hats so only half-time kick/snare groove stays
  outDeck.transitionFilter.type = 'lowpass';
  outDeck.transitionFilter.frequency.cancelScheduledValues(now);
  outDeck.transitionFilter.frequency.setValueAtTime(20000, now);
  outDeck.transitionFilter.frequency.exponentialRampToValueAtTime(2400, now + barSec);

  // Sync delay to half-time grid
  outDeck.echoDelay.delayTime.setValueAtTime(delayTime, now);
  outDeck.echoSend.gain.setValueAtTime(0.7, now);
  outDeck.echoReturn.gain.setValueAtTime(0.5, now);
  outDeck.echoFeedback.gain.setValueAtTime(0.65, now);

  // Let incoming track open up smoothly on half-time grid
  inDeck.transitionFilter.type = 'lowpass';
  inDeck.transitionFilter.frequency.setValueAtTime(300, now);
  inDeck.transitionFilter.frequency.exponentialRampToValueAtTime(20000, now + barSec * 3);
  inDeck.masterGain.gain.setValueAtTime(1.0, now);
  inDeck.lowGain.gain.setValueAtTime(0.05, now);

  scheduleBassSwap(outDeck, inDeck, now + barSec * 2, baseBpm, barSec);
}

/**
 * Adaptive Vibe Transition 3: Energy Riser Build-Up
 * Used when Outgoing Track is Soft/Ambient and Incoming Track is High Energy (Phonk/EDM Drop).
 * Cuts outgoing bass early and sweeps a resonant riser up to prime the listener for the heavy drop.
 */
function executeEnergyRiserTransition(outDeck, inDeck, bpm, barSec) {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const buildSec = Math.max(barSec * 2, 3.5);

  console.log('[AuraDJ] *** EXECUTING VIBE TRANSITION: ENERGY RISER BUILD-UP TO DROP ***');
  engineState.status = 'RISER DROP';
  engineState.vibeMode = 'RISER_DROP';
  engineState.transitionPhase = 'RISER_DROP';
  broadcastEngineState();

  // Cut outgoing bass early
  outDeck.lowGain.gain.setValueAtTime(outDeck.lowGain.gain.value, now);
  outDeck.lowGain.gain.linearRampToValueAtTime(0.0, now + 0.8);

  // Resonant bandpass sweep climbs up like a synth riser
  outDeck.transitionFilter.type = 'bandpass';
  outDeck.transitionFilter.frequency.cancelScheduledValues(now);
  outDeck.transitionFilter.frequency.setValueAtTime(400, now);
  outDeck.transitionFilter.frequency.exponentialRampToValueAtTime(4000, now + buildSec);
  outDeck.transitionFilter.Q.setValueAtTime(7.0, now);

  // Incoming heavy track primes for instant drop
  inDeck.transitionFilter.type = 'lowpass';
  inDeck.transitionFilter.frequency.setValueAtTime(20000, now);
  inDeck.lowGain.gain.setValueAtTime(0.05, now);
  inDeck.masterGain.gain.setValueAtTime(1.0, now);

  // Schedule explosive bass drop
  scheduleBassSwap(outDeck, inDeck, now + buildSec, bpm, barSec);
}

/**
 * Phase 2 (Default): Standard Beat-Drop Handoff for Matching Vibes
 *
 * LPF sweep "opens up" the new track from a muffled rumble to full clarity.
 * Bass stays cut until the scheduled bass swap drops it in on the downbeat.
 */
function startIncomingTransition(inDeck, outDeck, bpm, barSec) {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const buildDuration = Math.min(Math.max(barSec * 2, 2.5), 4.0);

  // 1. Warm LPF Sweep: 700 Hz → 20,000 Hz (track enters with immediate warmth & clarity, no underwater muffling)
  inDeck.transitionFilter.type = 'lowpass';
  inDeck.transitionFilter.frequency.cancelScheduledValues(now);
  inDeck.transitionFilter.Q.cancelScheduledValues(now);
  inDeck.transitionFilter.frequency.setValueAtTime(700, now);
  inDeck.transitionFilter.frequency.exponentialRampToValueAtTime(20000, now + buildDuration);
  inDeck.transitionFilter.Q.setValueAtTime(0.9, now);
  inDeck.transitionFilter.Q.linearRampToValueAtTime(0.7071, now + buildDuration);

  // 2. Master gain ON smoothly
  inDeck.masterGain.gain.cancelScheduledValues(now);
  inDeck.masterGain.gain.setValueAtTime(0.85, now);
  inDeck.masterGain.gain.linearRampToValueAtTime(1.0, now + 0.8);

  // 3. Gentle Low Entrance: enters at 0.25 and ramps to 0.7 before full drop
  inDeck.lowGain.gain.cancelScheduledValues(now);
  inDeck.lowGain.gain.setValueAtTime(0.25, now);
  inDeck.lowGain.gain.linearRampToValueAtTime(0.7, now + Math.min(barSec * 1.2, 1.8));

  // 4. Mids/Highs enter with full, crisp fidelity
  inDeck.midGain.gain.cancelScheduledValues(now);
  inDeck.midGain.gain.setValueAtTime(0.75, now);
  inDeck.midGain.gain.linearRampToValueAtTime(1.0, now + 1.2);
  inDeck.highGain.gain.cancelScheduledValues(now);
  inDeck.highGain.gain.setValueAtTime(0.85, now);
  inDeck.highGain.gain.linearRampToValueAtTime(1.0, now + 1.0);

  // 5. No echo on incoming track
  inDeck.echoSend.gain.setValueAtTime(0.0, now);
  inDeck.echoReturn.gain.setValueAtTime(0.0, now);

  // 6. Schedule musical bass swap on the first downbeat measure
  const swapDelay = Math.min(Math.max(barSec * 1.5, 1.8), 3.0);
  scheduleBassSwap(outDeck, inDeck, now + swapDelay, bpm, barSec);

  console.log(`[AuraDJ] Phase 2: Warm incoming transition (${buildDuration.toFixed(1)}s). Downbeat bass drop in ${swapDelay.toFixed(1)}s`);
}

/**
 * Bass Swap Scheduler — swaps low-end between outgoing and incoming decks.
 * Smoothly crossfades sub-bass over 150ms while dissolving outgoing audio into a lush reverb tail.
 */
function scheduleBassSwap(outDeck, inDeck, targetTime, bpm, barSec) {
  if (bassSwapTimeout) clearTimeout(bassSwapTimeout);

  const ctx = getAudioContext();
  const twoBeatsDelaySec = 120 / bpm;
  let swapTime = targetTime;

  function checkAndSwap() {
    if (activeTransitionCtx && activeTransitionCtx.bassSwapped) return;

    const timeUntilSwap = swapTime - ctx.currentTime;

    if (timeUntilSwap > 0.08) {
      bassSwapTimeout = setTimeout(checkAndSwap, Math.max(20, (timeUntilSwap - 0.05) * 1000));
      return;
    }

    // Vocal clash guard: delay 1-2 beats if vocals detected in outgoing track
    if (vocalDetected) {
      console.log(`[AuraDJ] Vocal clash! Holding bass swap by 2 beats (${twoBeatsDelaySec.toFixed(2)}s)`);
      swapTime += twoBeatsDelaySec;
      bassSwapTimeout = setTimeout(checkAndSwap, twoBeatsDelaySec * 1000);
      return;
    }

    const execTime = Math.max(ctx.currentTime, swapTime);

    // Outgoing bass: smooth 150ms cross-drop (click-free, zero abrupt silence)
    outDeck.lowGain.gain.setValueAtTime(outDeck.lowGain.gain.value, execTime);
    outDeck.lowGain.gain.linearRampToValueAtTime(0.0, execTime + 0.15);

    // Incoming bass: punches in with full power on the downbeat drop
    inDeck.lowGain.gain.setValueAtTime(inDeck.lowGain.gain.value, execTime);
    inDeck.lowGain.gain.linearRampToValueAtTime(1.0, execTime + 0.15);

    // Smooth Musical Handoff: blend dry outgoing audio into the echo cloud over 450ms
    outDeck.masterGain.gain.cancelScheduledValues(execTime);
    outDeck.masterGain.gain.setValueAtTime(outDeck.masterGain.gain.value, execTime);
    outDeck.masterGain.gain.linearRampToValueAtTime(0.0, execTime + 0.45);

    // Echo freeze: lush ambient tail naturally floats behind Track B's groove
    const dissolveSec = Math.max(barSec * 1.5, 3.0);
    outDeck.echoFeedback.gain.cancelScheduledValues(execTime);
    outDeck.echoFeedback.gain.setValueAtTime(0.7, execTime);
    outDeck.echoFeedback.gain.linearRampToValueAtTime(0.35, execTime + dissolveSec * 0.4);
    outDeck.echoFeedback.gain.linearRampToValueAtTime(0.0, execTime + dissolveSec);

    outDeck.echoReturn.gain.cancelScheduledValues(execTime);
    outDeck.echoReturn.gain.setValueAtTime(0.45, execTime);
    outDeck.echoReturn.gain.linearRampToValueAtTime(0.2, execTime + dissolveSec * 0.5);
    outDeck.echoReturn.gain.linearRampToValueAtTime(0.0, execTime + dissolveSec);

    if (activeTransitionCtx) activeTransitionCtx.bassSwapped = true;
    engineState.transitionPhase = 'BASS_SWAPPED';
    engineState.status = 'BASS DROP';
    console.log(`[AuraDJ] *** BUTTER-SMOOTH BASS SWAP AT ${execTime.toFixed(2)}s ***`);
    broadcastEngineState();
  }

  checkAndSwap();
}

/**
 * Transition Cleanup — resets all FX nodes and finalizes the deck swap.
 * Called after transition duration + echo tail decay time.
 */
function cleanupTransition() {
  const ctx = getAudioContext();

  if (activeTransitionCtx) {
    const { outgoingDeck, incomingDeck } = activeTransitionCtx;

    if (!activeTransitionCtx.bassSwapped) {
      if (outgoingDeck) outgoingDeck.lowGain.gain.setValueAtTime(0.0, ctx.currentTime);
      if (incomingDeck) incomingDeck.lowGain.gain.setValueAtTime(1.0, ctx.currentTime);
    }

    if (outgoingDeck) {
      outgoingDeck.disconnectSource();
      outgoingDeck.resetGains();
      outgoingDeck.masterGain.gain.setValueAtTime(0.0, ctx.currentTime);
    }

    if (incomingDeck) {
      incomingDeck.resetGains();
      incomingDeck.masterGain.gain.setValueAtTime(1.0, ctx.currentTime);
    }

    engineState.activeDeck = incomingDeck ? incomingDeck.id : engineState.activeDeck;
    activeTransitionCtx = null;
  }

  engineState.isTransitioning = false;
  engineState.transitionPhase = 'IDLE';
  engineState.status = 'LIVE';

  console.log(`[AuraDJ] AutoMix transition complete. Active Deck: ${engineState.activeDeck}`);
  broadcastEngineState();
}

// ---------------------------------------------------------------------------
// 6. Real-Time Energy & Texture Profiler (0.0 to 1.0)
// ---------------------------------------------------------------------------
let currentTrackEnergy = 0.5; // 0.0 (ambient/soft) to 1.0 (heavy phonk/EDM)
let currentBassEnergy = 0.5;

function updateTrackEnergyProfile() {
  if (!masterAnalyserNode) return;
  masterAnalyserNode.getByteFrequencyData(waveformFreqData);
  let lowSum = 0;
  let midSum = 0;
  let highSum = 0;

  // Bins @ 44.1kHz / 2048 FFT = ~21.5Hz per bin
  // Low/Bass: 20Hz - 250Hz (bins 1 to 12)
  for (let i = 1; i <= 12; i++) lowSum += waveformFreqData[i];
  // Mid/Vocal: 250Hz - 3.5kHz (bins 13 to 160)
  for (let i = 13; i <= 160; i++) midSum += waveformFreqData[i];
  // High/Air: 3.5kHz - 16kHz (bins 161 to 740)
  for (let i = 161; i <= 740; i++) highSum += waveformFreqData[i];

  const bassAvg = (lowSum / 12) / 255;
  const midAvg = (midSum / 148) / 255;
  const highAvg = (highSum / 580) / 255;

  // Weighted energy index: Bass and Mids define density & loudness
  const rawEnergy = bassAvg * 0.5 + midAvg * 0.35 + highAvg * 0.15;
  currentTrackEnergy = currentTrackEnergy * 0.92 + rawEnergy * 0.08;
  currentBassEnergy = currentBassEnergy * 0.92 + bassAvg * 0.08;
  engineState.trackEnergy = Math.round(currentTrackEnergy * 100) / 100;
}

// ---------------------------------------------------------------------------
// 6b. Vocal Clash Guard Detector (300Hz - 4kHz Spectral Energy)
// ---------------------------------------------------------------------------
function initVocalClashDetector() {
  if (vocalCheckInterval) clearInterval(vocalCheckInterval);

  vocalCheckInterval = setInterval(() => {
    updateTrackEnergyProfile();
    if (!vocalAnalyserNode) return;
    vocalAnalyserNode.getByteFrequencyData(vocalFreqData);

    // Bins for 300Hz - 4000Hz @ 44.1kHz with 2048 FFT
    // bin = freq / (44100 / 2048) = freq / 21.533
    // 300Hz -> bin 14, 4000Hz -> bin 186
    const startBin = 14;
    const endBin = 186;
    let sum = 0;
    for (let i = startBin; i <= endBin; i++) {
      sum += vocalFreqData[i];
    }
    const avgEnergy = sum / (endBin - startBin + 1);

    // Threshold: 140 / 255
    const wasVocal = vocalDetected;
    vocalDetected = avgEnergy > 140;

    if (vocalDetected !== wasVocal) {
      engineState.vocalDetected = vocalDetected;
      broadcastEngineState();
    }
  }, 100);
}

// ---------------------------------------------------------------------------
// 7. Waveform Visualizer & Engine State Broadcasting
// ---------------------------------------------------------------------------
function initWaveformBroadcast() {
  if (waveformInterval) clearInterval(waveformInterval);

  waveformInterval = setInterval(() => {
    if (!masterAnalyserNode) return;
    masterAnalyserNode.getByteFrequencyData(waveformFreqData);

    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'WAVEFORM_DATA',
          data: Array.from(waveformFreqData)
        }).catch(() => {});
      }
    } catch (e) {}
  }, 33); // ~30 FPS
}

function broadcastEngineState() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'ENGINE_STATE',
        state: { ...engineState }
      }).catch(() => {});
    }
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// 8. Hardware Knobs & Crossfader DSP Handlers
// ---------------------------------------------------------------------------
function handleKnobChange(knob, value) {
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  if (knob === 'tune') {
    // Range: 0.5 to 2.0 (mapped from -12 to +12 semitones: 2^(semitones/12))
    let rate = 1.0;
    if (typeof value === 'number') {
      if (value >= -12 && value <= 12 && (value < 0.4 || value > 2.1)) {
        rate = Math.pow(2, value / 12);
      } else {
        rate = Math.max(0.5, Math.min(2.0, value));
      }
    }
    engineState.playbackRate = rate;

    // Apply playbackRate to any active AudioBufferSourceNodes
    if (deckA && deckA.activeSource && deckA.activeSource.playbackRate) {
      deckA.activeSource.playbackRate.setValueAtTime(rate, now);
    }
    if (deckB && deckB.activeSource && deckB.activeSource.playbackRate) {
      deckB.activeSource.playbackRate.setValueAtTime(rate, now);
    }
  } else if (knob === 'decay') {
    // Bass Low-Band Gain: -24dB to +12dB -> linear gain = 10^(dB/20)
    const dB = Math.max(-24, Math.min(12, value));
    const linearGain = Math.pow(10, dB / 20);
    engineState.bassDb = dB;

    const activeDeck = (engineState.activeDeck === 'A') ? deckA : deckB;
    if (activeDeck && activeDeck.lowGain) {
      activeDeck.lowGain.gain.setTargetAtTime(linearGain, now, 0.02);
    }
  } else if (knob === 'cutoff') {
    // Master Lowpass Filter: 200Hz to 20000Hz
    const freq = Math.max(200, Math.min(20000, value));
    engineState.cutoffFreq = freq;
    if (masterCutoffFilter) {
      masterCutoffFilter.frequency.setTargetAtTime(freq, now, 0.02);
    }
  } else if (knob === 'fold') {
    // Waveshaper Saturation (0 to 100)
    const fold = Math.max(0, Math.min(100, value));
    engineState.foldAmount = fold;
    if (masterFoldShaper) {
      masterFoldShaper.curve = makeDistortionCurve(fold);
    }
  }

  broadcastEngineState();
}

function handleCrossfaderChange(value) {
  engineState.crossfader = value;
  if (!deckA || !deckB || engineState.isTransitioning) return;

  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const x = Math.max(0, Math.min(100, value)) / 100;

  // Equal-Power Crossfade Curve
  const gainA = Math.cos(x * 0.5 * Math.PI);
  const gainB = Math.sin(x * 0.5 * Math.PI);

  deckA.masterGain.gain.setTargetAtTime(gainA, now, 0.02);
  deckB.masterGain.gain.setTargetAtTime(gainB, now, 0.02);
}

// ---------------------------------------------------------------------------
// 9. Real-Time Web Audio SFX Synthesizer
// ---------------------------------------------------------------------------
function triggerSoundEffect(type) {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const targetBus = masterCutoffFilter || ctx.destination;

  if (type === 'scratch') {
    // Vinyl scratch chirp: pitch envelope 450Hz -> 120Hz -> 750Hz
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(450, now);
    osc.frequency.linearRampToValueAtTime(120, now + 0.08);
    osc.frequency.linearRampToValueAtTime(750, now + 0.16);

    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.22);

    osc.connect(gain);
    gain.connect(targetBus);
    osc.start(now);
    osc.stop(now + 0.23);
  } else if (type === 'spinback') {
    // Motor spinback wind-down: exponential decay 1400Hz -> 80Hz
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1400, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.45);

    gain.gain.setValueAtTime(0.6, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.45);

    osc.connect(gain);
    gain.connect(targetBus);
    osc.start(now);
    osc.stop(now + 0.46);
  } else if (type === 'airhorn') {
    // Rave Airhorn burst (multi-oscillator square chord: [350, 466, 700] Hz)
    [350, 466, 700].forEach((freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, now);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(targetBus);
      osc.start(now);
      osc.stop(now + 0.36);
    });
  } else if (type === 'filter' || type === 'sweep') {
    // Low-pass sweep drop: 900Hz down to 50Hz
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(900, now);
    osc.frequency.exponentialRampToValueAtTime(50, now + 0.50);

    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.50);

    osc.connect(gain);
    gain.connect(targetBus);
    osc.start(now);
    osc.stop(now + 0.51);
  }
}

// ---------------------------------------------------------------------------
// 10. Engine Cleanup & Resource Destruction
// ---------------------------------------------------------------------------
async function stopCapture() {
  console.log('[AuraDJ] Stopping audio capture and tearing down engine');

  if (waveformInterval) {
    clearInterval(waveformInterval);
    waveformInterval = null;
  }
  if (vocalCheckInterval) {
    clearInterval(vocalCheckInterval);
    vocalCheckInterval = null;
  }
  if (bassSwapTimeout) {
    clearTimeout(bassSwapTimeout);
    bassSwapTimeout = null;
  }
  if (transitionCompleteTimeout) {
    clearTimeout(transitionCompleteTimeout);
    transitionCompleteTimeout = null;
  }

  // Reset ring buffer and transition state
  ringWritePos = 0;
  totalSamplesBuffered = 0;
  engineState.transitionPhase = 'IDLE';
  engineState.status = 'READY';

  if (deckA) {
    deckA.destroy();
    deckA = null;
  }
  if (deckB) {
    deckB.destroy();
    deckB = null;
  }

  if (liveStreamSource) {
    try {
      liveStreamSource.disconnect();
    } catch (e) {}
    liveStreamSource = null;
  }

  if (liveStream) {
    try {
      liveStream.getTracks().forEach((track) => track.stop());
    } catch (e) {}
    liveStream = null;
  }

  if (pcmWorkletNode) {
    try {
      pcmWorkletNode.disconnect();
    } catch (e) {}
    pcmWorkletNode = null;
  }

  if (essentiaWorker) {
    essentiaWorker.terminate();
    essentiaWorker = null;
  }

  if (audioContext && audioContext.state !== 'closed') {
    try {
      await audioContext.close();
    } catch (e) {}
    audioContext = null;
  }

  engineState.isCapturing = false;
  engineState.isTransitioning = false;
  engineState.isBufferingTail = false;
  engineState.vocalDetected = false;
  broadcastEngineState();
  console.log('[AuraDJ] Audio engine successfully torn down');
}

// ---------------------------------------------------------------------------
// 11. Chrome Extension Message Dispatcher
// ---------------------------------------------------------------------------
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    switch (message.type) {
      case 'START_CAPTURE': {
        const streamId = message.mediaStreamId || message.streamId;
        if (!streamId) {
          sendResponse({ received: true, ignored: true, reason: 'No streamId for offscreen document' });
          return false;
        }
        startCapture(streamId)
          .then(() => sendResponse({ success: true, activeDeck: engineState.activeDeck }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true; // Keep sendResponse open asynchronously
      }

      case 'STOP_CAPTURE': {
        stopCapture()
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      }

      case 'TRIGGER_AUTOMIX': {
        handleTriggerAutoMix();
        sendResponse({ success: true, transitioning: true });
        break;
      }

      case 'TRACK_ENDING_SOON': {
        console.log(`[AuraDJ] Track ending soon (${message.timeRemaining}s remaining)`);
        sendResponse({ success: true });
        break;
      }

      case 'TRACK_CHANGED': {
        handleTrackChanged();
        sendResponse({ success: true, transitioning: engineState.isTransitioning });
        break;
      }

      case 'TRIGGER_TRANSITION': {
        handleTriggerAutoMix();
        sendResponse({ success: true });
        break;
      }

      case 'KNOB_CHANGE': {
        handleKnobChange(message.knob, message.value);
        sendResponse({ success: true });
        break;
      }

      case 'CROSSFADER_CHANGE': {
        handleCrossfaderChange(message.value);
        sendResponse({ success: true });
        break;
      }

      case 'AUTOMIX_TOGGLE': {
        engineState.automixEnabled = (message.enabled !== undefined)
          ? !!message.enabled
          : !engineState.automixEnabled;
        broadcastEngineState();
        sendResponse({ success: true, automixEnabled: engineState.automixEnabled });
        break;
      }

      case 'TRIGGER_SFX': {
        triggerSoundEffect(message.sfx);
        sendResponse({ success: true, sfx: message.sfx });
        break;
      }

      case 'GET_ENGINE_STATE':
      case 'GET_STATE': {
        sendResponse({ success: true, state: engineState });
        break;
      }

      case 'TURNTABLE_SCRATCH': {
        if (message.velocity) {
          const activeDeck = (engineState.activeDeck === 'A') ? deckA : deckB;
          if (activeDeck && activeDeck.activeSource && activeDeck.activeSource.playbackRate) {
            const ctx = getAudioContext();
            const scratchRate = Math.max(0.1, Math.min(3.0, 1.0 + message.velocity * 0.4));
            activeDeck.activeSource.playbackRate.setValueAtTime(scratchRate, ctx.currentTime);
          }
        }
        sendResponse({ success: true });
        break;
      }

      case 'TOGGLE_PLAY': {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') {
          ctx.resume();
        }
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ received: true });
        break;
    }
  });
}

// Exported namespace for testing and offscreen environment embedding
window.AuraEngine = {
  getAudioContext,
  startCapture,
  stopCapture,
  handleTriggerAutoMix,
  handleTrackChanged,
  executeTransition,
  triggerSoundEffect,
  handleKnobChange,
  handleCrossfaderChange,
  getState: () => ({ ...engineState })
};
