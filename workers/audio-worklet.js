/**
 * AuraDJ - AudioWorklet PCM Capture Processor
 * File: workers/audio-worklet.js
 * 
 * Captures real-time PCM audio chunks (4096 samples) from the live audio stream
 * with full stereo fidelity for the rolling outro transition buffer, plus a mono downmix
 * for Essentia.js WASM beat/harmonic analysis.
 * Passes audio through unchanged to avoid disrupting the playback chain.
 */

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.leftBuffer = new Float32Array(this.bufferSize);
    this.rightBuffer = new Float32Array(this.bufferSize);
    this.monoBuffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    this.isMuted = false;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'SET_MUTE') {
        this.isMuted = !!event.data.muted;
      } else if (event.data && event.data.type === 'RESET_BUFFER') {
        this.leftBuffer = new Float32Array(this.bufferSize);
        this.rightBuffer = new Float32Array(this.bufferSize);
        this.monoBuffer = new Float32Array(this.bufferSize);
        this.writeIndex = 0;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const numChannels = input.length;
    const ch0 = input[0];
    const ch1 = numChannels > 1 ? input[1] : ch0;
    const frameCount = ch0.length;

    // Buffer incoming audio samples
    if (!this.isMuted) {
      for (let i = 0; i < frameCount; i++) {
        const l = ch0[i];
        const r = ch1[i];
        const m = (l + r) * 0.5;

        this.leftBuffer[this.writeIndex] = l;
        this.rightBuffer[this.writeIndex] = r;
        this.monoBuffer[this.writeIndex] = m;
        this.writeIndex++;

        if (this.writeIndex >= this.bufferSize) {
          // Zero-copy transfer to main thread
          const leftCopy = new Float32Array(this.leftBuffer);
          const rightCopy = new Float32Array(this.rightBuffer);
          const monoCopy = new Float32Array(this.monoBuffer);

          this.port.postMessage(
            {
              type: 'PCM_CHUNK',
              mono: monoCopy.buffer,
              left: leftCopy.buffer,
              right: rightCopy.buffer
            },
            [monoCopy.buffer, leftCopy.buffer, rightCopy.buffer]
          );

          this.leftBuffer = new Float32Array(this.bufferSize);
          this.rightBuffer = new Float32Array(this.bufferSize);
          this.monoBuffer = new Float32Array(this.bufferSize);
          this.writeIndex = 0;
        }
      }
    }

    // Pass through audio unchanged to output
    const output = outputs[0];
    if (output) {
      for (let ch = 0; ch < output.length; ch++) {
        if (input[ch] && output[ch]) {
          output[ch].set(input[ch]);
        }
      }
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
