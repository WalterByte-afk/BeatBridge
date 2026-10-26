<div align="center">

  <img src="assets/banner.jpg" alt="BeatBridge Banner" width="100%" style="border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);" />

  <br/><br/>

  # 🎛️ BeatBridge
  ### Real-Time AutoMix & Intelligent DJ Engine for YouTube Music

  <p align="center">
    <b>Stop letting YouTube Music treat track transitions like an iPod shuffle from 2004.</b><br/>
    Real-time downbeat transient snapping, harmonic key blending, active vocal ducking & zero-fadeout drops.
  </p>

  <p align="center">
    <a href="https://developer.chrome.com/docs/extensions/mv3/"><img src="https://img.shields.io/badge/Manifest-V3%20Ready-587bf8?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Manifest V3" /></a>
    <a href="https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API"><img src="https://img.shields.io/badge/DSP_Engine-Web_Audio_API-45c8b2?style=for-the-badge&logo=webassembly&logoColor=white" alt="Web Audio" /></a>
    <a href="https://teenage.engineering/products/op-xy"><img src="https://img.shields.io/badge/Design-Teenage_Engineering_OP--XY-e94879?style=for-the-badge&logo=soundcharts&logoColor=white" alt="OP-XY Aesthetic" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-f59e0b?style=for-the-badge" alt="License MIT" /></a>
    <img src="https://img.shields.io/badge/PRs-Welcome-brightgreen?style=for-the-badge" alt="PRs Welcome" />
  </p>

  <p align="center">
    <a href="#-the-problem">The Problem</a> •
    <a href="#-feature-matrix">Feature Matrix</a> •
    <a href="#-how-it-works">How It Works</a> •
    <a href="#-vibe-transition-engine">The 4 Transition Modes</a> •
    <a href="#-installation">Install</a> •
    <a href="#-faq">FAQ</a>
  </p>

</div>

---

## 💀 The Problem

Here is what happens on every standard streaming service when a song ends:

1. **Vanilla YouTube Music:** Awkward, deafening 3-second silence while you stare at the wall.
2. **Spotify Crossfade:** Lazily turns down Song A's volume slider while turning up Song B's volume slider. Now you have two vocalists screaming over each other, two off-beat kick drums producing acoustic mud, and your vibe is completely ruined.
3. **Apple Music:** Has AutoMix, but locks you into their closed ecosystem.

**BeatBridge fixes this directly in your browser.** It captures live audio from YouTube Music, analyzes BPM and downbeats via Essentia DSP, loops the final bar, ducks conflicting vocal stems, and drops the next song strictly on beat one. No awkward fades. No trainwrecks. Just flow.

---

## 📊 Feature Matrix

| Feature | BeatBridge 🎛️ | Apple AutoMix 🍎 | Spotify Crossfade 🟢 | Vanilla YouTube Music ❌ |
| :--- | :---: | :---: | :---: | :---: |
| **Real-time Downbeat Snapping** | **YES (35ms cut)** | Yes | No (lazy volume fade) | No |
| **Active Vocal Stem Ducking** | **YES (300Hz-3.5kHz)** | Yes | No (clashing voices) | No |
| **Harmonic Key Matching** | **YES (Camelot Wheel)** | Yes | No | No |
| **Cross-Genre Engine (Tape Brake/Halftime)** | **YES (4 Modes)** | No | No | No |
| **Interactive Vinyl Scratch Platter** | **YES (60FPS Inertia)** | No | No | No |
| **Hardware Encoders (Filter, Saturation, EQ)** | **YES (Teenage OP-XY)** | No | No | No |
| **Platform** | **YouTube Music** | Apple Music Only | Spotify Only | None |
| **Cost** | **100% Free & Open Source** | $10.99/month | $11.99/month | Free (with pain) |

---

## ⚡ The 4 Transition Modes

Different songs need different handoffs. You can't crossfade a 160 BPM Phonk track into an acoustic Taylor Swift ballad without sounding like a broken dishwasher. BeatBridge adapts automatically:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       BEATBRIDGE VIBE TRANSITION ENGINE                     │
└─────────────────────────────────────────────────────────────────────────────┘
  │
  ├──► [TAPE BRAKE]    Outgoing loop decelerates (1.0x -> 0.05x) like an analog
  │                    technics turntable, catching chords in an ambient reverb
  │                    cloud so the incoming track starts squeaky clean.
  │
  ├──► [1/2 TIME SYNC] Detects 2:1 BPM ratios (150 BPM <-> 75 BPM), locks 8th
  │                    notes to the shared halftime grid, and sweeps high frequencies.
  │
  ├──► [RISER DROP]    Sweeps a resonant bandpass filter (400Hz -> 4000Hz, Q=7.0)
  │                    building white noise tension before dropping beat one.
  │
  └──► [BASS DROP]     Cuts low frequencies instantly (<200Hz) from the outgoing
                       track 35ms before downbeat, letting the new bassline punch.
```

---

## 🕹️ Teenage Engineering OP-XY Hardware UI

BeatBridge doesn't look like another boring extension popup. It looks and feels like a boutique Scandinavian synth:

* **Rotary Hardware Encoders:**
  * `TUNE`: Live master pitch shifting ($\pm 12$ semitones)
  * `BASS`: Low-shelf sub-bass punch
  * `FOLD`: Tube-style waveshaper distortion & saturation
  * `CUT`: Resonant master low-pass filter
* **Machined Jog Platter:** Grab it with your mouse to scratch, pause, or nudge playback like real vinyl.
* **Dot-Matrix BPM Telemetry:** Live tempo readout, key Camelot wheel indicator, and dual-deck status.
* **Spectral Visualizer:** 54-band audio spectrum analyzer running at 60 FPS on HTML5 Canvas.

---

## 🛠️ Architecture

```
                  ┌─────────────────────────────────────────┐
                  │         music.youtube.com (Tab)         │
                  │         [content-script.js]             │
                  │   (Playback observer & DOM controller)  │
                  └────────────────────┬────────────────────┘
                                       │ Mutes tab (zero duplicate audio)
                                       │ Triggers next track on cue
                                       ▼
 ┌───────────────────────┐  START_CAPTURE  ┌─────────────────────────────┐
 │      code.html        ├────────────────►│     service-worker.js       │
 │      popup.js         │                 │ (MV3 background broker &    │
 │ (OP-XY UI & Encoders) │◄────────────────┤  tabCapture stream manager) │
 └───────────▲───────────┘  ENGINE_STATE   └──────────────┬──────────────┘
             │                                            │ Stream ID
             │ Port (Waveform data @ 30FPS)               ▼
 ┌───────────┴───────────────────────────────────────────────────────────┐
 │                           offscreen.html / offscreen.js               │
 │                                                                       │
 │  MediaStreamSourceNode ──► PCM Capture Worklet                        │
 │                                  │                                    │
 │        ┌─────────────────────────┴─────────────────────────┐          │
 │        ▼ (Outgoing Deck A)                 ▼ (Incoming Deck B)        │
 │   AudioBufferSourceNode               MediaStreamAudioSourceNode      │
 │        │                                           │                  │
 │   3-Band Butterworth Isolator         3-Band Butterworth Isolator     │
 │   Active Vocal Notch Filter           GainNode (Instant Low Punch)    │
 │        │                                           │                  │
 │        └─────────────────────────┬─────────────────┘                  │
 │                                  ▼                                    │
 │                       Master Equal-Power Fader                        │
 │                                  ▼                                    │
 │                        Destination (Speakers)                         │
 └───────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Installation

Got Chrome? You can install BeatBridge in under 30 seconds:

1. **Clone this repo** (or download as ZIP and extract):
   ```bash
   git clone https://github.com/WalterByte-afk/BeatBridge.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Toggle **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the `BeatBridge` folder.
5. Head over to [YouTube Music](https://music.youtube.com), play any track, and open the extension icon.

---

## ❓ FAQ

<details>
<summary><b>Does this send my music data or YouTube login to any external server?</b></summary>
<br/>
No. Zero telemetry, zero analytics, zero external API calls. All audio processing, transient analysis, and beat-matching are performed 100% locally on your machine using the browser's Web Audio API and WebAssembly.
</details>

<details>
<summary><b>Will this work on regular YouTube (youtube.com)?</b></summary>
<br/>
BeatBridge is tailor-made for <code>music.youtube.com</code> where songs have structured track metadata, consistent durations, and queues. Support for regular YouTube is on the roadmap!
</details>

<details>
<summary><b>Can I scratch the record while a song is playing?</b></summary>
<br/>
Yes! Click and drag the vinyl platter in the popup UI to scratch the audio in real time. Release it to let the inertia spring it back into play.
</details>

<details>
<summary><b>Will this make me sound like David Guetta?</b></summary>
<br/>
Honestly, probably better. At least you won't shout awkward motivational speeches into the mic right before the drop :p
</details>

---

## ☕ Support / Tip Jar

BeatBridge is 100% free and open-source under the **MIT License**. If it saved your party, gym session, or late-night coding streak, feel free to drop some gas into the tip jar:

* **USDT (TRC20):** `TPF6tQ8r2P...` *(Update with your address)*
* **Solana:** `Beat...`
* **Bitcoin:** `bc1q...`

---

<div align="center">
  <sub>Crafted with rhythm & caffeine. Star this repo if you love good music transitions! ⭐</sub>
</div>
