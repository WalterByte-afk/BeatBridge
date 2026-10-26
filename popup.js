/**
 * AuraDJ - Modular Controller Engine & Chrome Extension Messaging Bridge
 * Implements Teenage Engineering OP-XY Industrial Aesthetic & Audio-Visual DJ Interface
 */

// Helper to send messages over port safely
let sendPortMessage = function(msg) {};

window.AuraDJ = (function() {
  // Internal DJ State
  const state = {
    bpm: 130.0,
    pitchOffset: 0.0,
    status: 'Ready',
    bass: 0,
    isPlaying: false,
    isCueing: false,
    crossfader: 50,
    rotationAngle: 0, // In radians
    angularVelocity: 0,
    isScratching: false,
    lastMouseAngle: 0,
    knobs: {
      tune: { val: 0, min: -12, max: 12, step: 1, unit: '', color: '#587bf8' },
      decay: { val: 0, min: -24, max: 12, step: 1, unit: 'dB', color: '#45c8b2' }, // Mapped to Bass
      fold: { val: 0, min: 0, max: 99, step: 1, unit: '', color: '#8f65eb' },
      cutoff: { val: 20300, min: 200, max: 22000, step: 100, unit: 'k', color: '#e94879' }
    },
    currentStep: 0,
    waveformData: null,
    animFrameId: null
  };

  // Web Audio Synthesizer Fallback for Real-time Scratch & FX Feedback
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  /**
   * SFX Audio Generators
   */
  function triggerSoundEffect(type) {
    try {
      const ctx = getAudioContext();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'scratch') {
        // Vinyl Scratch chirp
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(450, now);
        osc.frequency.linearRampToValueAtTime(120, now + 0.08);
        osc.frequency.linearRampToValueAtTime(750, now + 0.16);
        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.23);
      } else if (type === 'spinback') {
        // Motor spin-back winddown
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(1400, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.45);
        gain.gain.setValueAtTime(0.6, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.45);
        osc.start(now);
        osc.stop(now + 0.46);
      } else if (type === 'airhorn') {
        // Rave Airhorn burst (multi-osc chord)
        [350, 466, 700].forEach(freq => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'square';
          o.frequency.setValueAtTime(freq, now);
          g.gain.setValueAtTime(0.2, now);
          g.gain.linearRampToValueAtTime(0.3, now + 0.05);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
          o.connect(g);
          g.connect(ctx.destination);
          o.start(now);
          o.stop(now + 0.36);
        });
      } else if (type === 'filter') {
        // Low-pass sweep drop
        const noise = ctx.createOscillator();
        noise.type = 'sawtooth';
        noise.frequency.setValueAtTime(900, now);
        noise.frequency.exponentialRampToValueAtTime(50, now + 0.5);
        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        noise.connect(gain);
        noise.start(now);
        noise.stop(now + 0.51);
      } else if (type === 'levelup') {
        // Triumphant 8-bit Level-Up Chime (C5 -> E5 -> G5 -> C6)
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'triangle';
          o.frequency.setValueAtTime(freq, now + idx * 0.08);
          g.gain.setValueAtTime(0.001, now);
          g.gain.setValueAtTime(0.25, now + idx * 0.08);
          g.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.25);
          o.connect(g);
          g.connect(ctx.destination);
          o.start(now + idx * 0.08);
          o.stop(now + idx * 0.08 + 0.26);
        });
      }
    } catch (err) {
      // AudioContext restricted before gesture
    }
  }

  /**
   * ========================================================
   * BEATBRIDGE MASCOT & GAMIFIED DJ PROGRESSION ENGINE
   * ========================================================
   */
  const DJ_LEVELS = [
    { level: 1, title: 'BEDROOM DJ', reqXp: 0, unlock: 'VINYL PLATTER' },
    { level: 2, title: 'VINYL ROOKIE', reqXp: 75, unlock: 'TUBE SATURATION' },
    { level: 3, title: 'GROOVE DIGGER', reqXp: 180, unlock: 'GOLDEN GRILLZ' },
    { level: 4, title: 'BEAT CULPRIT', reqXp: 320, unlock: 'HALFTIME BRAKE' },
    { level: 5, title: 'CLUB RESIDENT', reqXp: 500, unlock: 'NEON WAVEFORM SKINS' },
    { level: 6, title: 'FESTIVAL HEADLINER', reqXp: 750, unlock: 'RESONANT RISER' },
    { level: 7, title: 'RAVE GOD', reqXp: 1100, unlock: 'SUPER GOLD CROWN' },
    { level: 8, title: 'AUDIO WIZARD', reqXp: 1600, unlock: 'DUAL DECK ISOLATOR' },
    { level: 9, title: 'GRANDMASTER OP-XY', reqXp: 2300, unlock: 'MASTER ANALOG COMP' },
    { level: 10, title: 'LEGENDARY MAESTRO', reqXp: 3200, unlock: 'GOLD ROTARY ENCODERS' }
  ];

  const gameStats = {
    xp: 0,
    level: 1,
    streak: 1,
    lastDay: '',
    tracksMixed: 0,
    currentVibe: 'normal',
    isLevelingUp: false
  };

  /**
   * Intelligent Music Vibe & Genre Rhythm Classifier
   */
  function detectVibe() {
    if (!state.isPlaying) return 'sleep';

    const text = `${state.trackTitle || ''} ${state.trackArtist || ''}`.toLowerCase();

    // 1. Hardcore / Hardtek / Frenchcore / Hardstyle / Phonk / DnB (Highest priority genre)
    if (/(hardtek|hardcore|hardstyle|frenchcore|speedcore|gabber|uptempo|rawstyle|metal|deathcore|phonk|terror|dnb|drum and bass|drum & bass|breakcore|schranz)/i.test(text)) {
      return 'hardstyle';
    }

    // 2. Rave / Techno / Trance / EDM / House / Club
    if (/(rave|techno|trance|acid|psytrance|dubstep|hard dance|festival|club|house|edm|electro|electronic|future bass|bass house)/i.test(text)) {
      return 'rave';
    }

    // 3. Pop / Dance / Commercial / Disco / Synthwave
    if (/(pop|disco|funk|synthwave|k-pop|chart|anthem|hit|radio|dance|dancepop|dance-pop|dua|ariana|taylor|weekend|katy|bruno|billie|bts|blackpink)/i.test(text)) {
      return 'pop';
    }

    // 4. Trap / Hip-Hop / Drill / Rap
    if (/(trap|hip hop|hip-hop|rap|drill|grillz|808|freestyle|rhyme|bars|cypher|boombap|boom bap)/i.test(text)) {
      return 'trap';
    }

    // 5. Romance / Love / R&B / Hearts
    if (/(love|heart|romance|romantic|ishq|pyar|mohabbat|dil|jaan|sweet|crush|baby|kiss|darling)/i.test(text)) {
      return 'hearts';
    }

    // 6. Chiptune / Retro / 8-bit / Glitch
    if (/(8bit|8-bit|chiptune|retro|arcade|glitch|game boy|nintendo)/i.test(text)) {
      return 'chiptune';
    }

    // 7. Futuristic / Cyber / Robotic
    if (/(robot|cyber|tech|matrix|synthetic|future|ai|cyborg)/i.test(text)) {
      return 'robotic';
    }

    // 8. Explicit Soft / Acoustic / Ballads / Lofi
    if (/(pal pal|acoustic|piano|unplugged|guitar|soft|slowed|reverb|ambient|sleep|calm|peace|chill|sad|ballad|emotional|sufi|ghazal|lofi|lo-fi|soul|folk|indie|mellow|bedroom|relax|serenade|meditation)/i.test(text)) {
      return 'lofi';
    }

    // 9. Rainbow / Euphoric / Hyperpop
    if (/(rainbow|euphori|happy|pride|sunshine|hyperpop)/i.test(text)) {
      return 'rainbow';
    }

    // 10. Tempo (BPM) based intelligent classification
    const bpm = state.bpm || 120;
    if (bpm >= 148) return 'hardstyle';
    if (bpm >= 124) return 'rave';
    if (bpm >= 108) return 'pop';
    if (bpm >= 88) return 'trap';
    if (bpm < 88) return 'lofi';

    return 'normal';
  }

  /**
   * Mount Animated SVG Mascot into Viewport
   */
  function updateMascotVibe(force = false) {
    if (gameStats.isLevelingUp && !force) return;

    const vibe = detectVibe();
    const mount = document.getElementById('mascot-svg-mount');
    if (!mount) return;

    if (gameStats.currentVibe === vibe && !force && mount.firstElementChild) return;
    gameStats.currentVibe = vibe;

    if (typeof window.MASCOT_SVGS !== 'undefined' && window.MASCOT_SVGS) {
      const svgCode = window.MASCOT_SVGS[vibe] || window.MASCOT_SVGS['normal'] || '';
      mount.innerHTML = svgCode;

      // Update miniature preview in passport modal
      const preview = document.getElementById('passport-mascot-preview');
      if (preview) preview.innerHTML = svgCode;
    }

    const vibeLabel = document.getElementById('pod-vibe-label');
    if (vibeLabel) vibeLabel.textContent = vibe.toUpperCase();

    const passVibe = document.getElementById('passport-vibe-name');
    if (passVibe) passVibe.textContent = vibe.toUpperCase();
  }

  /**
   * Load Game Stats from Chrome Storage
   */
  function loadGameStats() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['bb_xp', 'bb_streak', 'bb_last_day', 'bb_tracks_mixed'], (res) => {
        if (res) {
          gameStats.xp = res.bb_xp || 0;
          gameStats.tracksMixed = res.bb_tracks_mixed || 0;
          gameStats.streak = res.bb_streak || 1;
          gameStats.lastDay = res.bb_last_day || '';

          // Streak verification
          const today = new Date().toISOString().slice(0, 10);
          if (!gameStats.lastDay) {
            gameStats.lastDay = today;
            gameStats.streak = 1;
          } else if (gameStats.lastDay !== today) {
            const diffDays = Math.round((new Date(today) - new Date(gameStats.lastDay)) / (1000 * 60 * 60 * 24));
            if (diffDays === 1) {
              gameStats.streak += 1;
            } else if (diffDays > 1) {
              gameStats.streak = 1;
            }
            gameStats.lastDay = today;
          }

          // Calculate Level from XP
          let currentLvl = 1;
          for (let i = DJ_LEVELS.length - 1; i >= 0; i--) {
            if (gameStats.xp >= DJ_LEVELS[i].reqXp) {
              currentLvl = DJ_LEVELS[i].level;
              break;
            }
          }
          gameStats.level = currentLvl;

          saveGameStats();
          updateGameUI();
          updateMascotVibe(true);
        }
      });
    } else {
      updateGameUI();
      updateMascotVibe(true);
    }
  }

  /**
   * Save Game Stats to Chrome Storage
   */
  function saveGameStats() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        bb_xp: gameStats.xp,
        bb_streak: gameStats.streak,
        bb_last_day: gameStats.lastDay,
        bb_tracks_mixed: gameStats.tracksMixed
      });
    }
  }

  /**
   * Award XP & Check for Level Up
   */
  function addXP(amount) {
    gameStats.xp += amount;

    // Check if level increased
    let currentLvl = 1;
    for (let i = DJ_LEVELS.length - 1; i >= 0; i--) {
      if (gameStats.xp >= DJ_LEVELS[i].reqXp) {
        currentLvl = DJ_LEVELS[i].level;
        break;
      }
    }

    if (currentLvl > gameStats.level) {
      triggerLevelUp(currentLvl);
    }

    saveGameStats();
    updateGameUI();
  }

  /**
   * Trigger Level Up Celebration Animation
   */
  function triggerLevelUp(newLevel) {
    gameStats.level = newLevel;
    gameStats.isLevelingUp = true;

    // Play triumphant sound chime
    triggerSoundEffect('levelup');

    // Show level up banner overlay
    const banner = document.getElementById('mascot-levelup-banner');
    const bannerText = document.getElementById('levelup-banner-text');
    if (banner) {
      if (bannerText) bannerText.textContent = `LVL ${newLevel}`;
      banner.classList.remove('hidden');
      banner.classList.add('flex');
    }

    // Mount golden ascension level-up SVG
    const mount = document.getElementById('mascot-svg-mount');
    if (mount && window.MASCOT_SVGS && window.MASCOT_SVGS['levelup']) {
      mount.innerHTML = window.MASCOT_SVGS['levelup'];
    }

    // Reset after celebration (4.5 seconds)
    setTimeout(() => {
      gameStats.isLevelingUp = false;
      if (banner) {
        banner.classList.add('hidden');
        banner.classList.remove('flex');
      }
      updateMascotVibe(true);
    }, 4500);
  }

  /**
   * Update UI Badges, Meters & Passport Modal
   */
  function updateGameUI() {
    const streakEl = document.getElementById('streak-days');
    if (streakEl) streakEl.textContent = gameStats.streak;

    const lvlEl = document.getElementById('user-level');
    if (lvlEl) lvlEl.textContent = gameStats.level;

    // Level progress calculation
    const currCfg = DJ_LEVELS.find(l => l.level === gameStats.level) || DJ_LEVELS[0];
    const nextCfg = DJ_LEVELS.find(l => l.level === gameStats.level + 1) || {
      level: gameStats.level + 1,
      reqXp: currCfg.reqXp + 1000,
      title: 'LEGENDARY MAESTRO',
      unlock: 'GOLD MASTER BADGE'
    };

    const xpFloor = currCfg.reqXp;
    const xpCeil = nextCfg.reqXp;
    const progress = Math.max(0, gameStats.xp - xpFloor);
    const needed = Math.max(1, xpCeil - xpFloor);
    const pct = Math.min(100, Math.max(0, Math.round((progress / needed) * 100)));

    const podXp = document.getElementById('pod-xp-text');
    if (podXp) podXp.textContent = `${progress}/${needed}`;

    const xpBar = document.getElementById('xp-progress-bar');
    if (xpBar) xpBar.style.width = `${pct}%`;

    // Passport Modal details
    const passRank = document.getElementById('passport-rank-title');
    if (passRank) passRank.textContent = currCfg.title;

    const passLvl = document.getElementById('passport-level-num');
    if (passLvl) passLvl.textContent = gameStats.level;

    const passStreakNum = document.getElementById('passport-streak-num');
    if (passStreakNum) passStreakNum.textContent = gameStats.streak;

    const passStreakVal = document.getElementById('passport-streak-val');
    if (passStreakVal) passStreakVal.textContent = gameStats.streak;

    const passXpDetail = document.getElementById('passport-xp-detail');
    if (passXpDetail) passXpDetail.textContent = `${gameStats.xp} / ${xpCeil} XP`;

    const passFill = document.getElementById('passport-progress-fill');
    if (passFill) passFill.style.width = `${pct}%`;

    const passNeeded = document.getElementById('passport-xp-needed');
    if (passNeeded) passNeeded.textContent = `${Math.max(0, xpCeil - gameStats.xp)} XP to Level ${gameStats.level + 1}`;

    const passTracks = document.getElementById('passport-tracks-mixed');
    if (passTracks) passTracks.textContent = gameStats.tracksMixed;

    const passUnlock = document.getElementById('passport-next-unlock');
    if (passUnlock) passUnlock.textContent = nextCfg.unlock;
  }

  /**
   * Setup Gamification & Passport Modal Listeners
   */
  function setupGamification() {
    loadGameStats();

    // Passport modal open/close
    const cardBtn = document.getElementById('mascot-card-btn');
    const modal = document.getElementById('modal-level-passport');
    const closeBtn = document.getElementById('btn-close-passport');

    if (cardBtn && modal) {
      cardBtn.addEventListener('click', () => {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        updateGameUI();
      });
    }

    if (closeBtn && modal) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        modal.classList.add('hidden');
        modal.classList.remove('flex');
      });
    }

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.add('hidden');
          modal.classList.remove('flex');
        }
      });
    }

    // Periodic XP ticker (every 2.5s during playback)
    setInterval(() => {
      if (state.isPlaying) {
        const automixBtn = document.getElementById('btn-automix');
        const isAuto = automixBtn && automixBtn.dataset.active === 'true';
        addXP(isAuto ? 4 : 2);
        updateMascotVibe();
      }
    }, 2500);

    setupCryptoTipModal();
  }

  /**
   * Setup Crypto Tip Drawer & Modal Listeners
   */
  function setupCryptoTipModal() {
    const tipBtn = document.getElementById('btn-tip');
    const tipModal = document.getElementById('modal-crypto-tip');
    const closeBtn = document.getElementById('btn-close-tip');
    const copyBtn = document.getElementById('btn-copy-address');
    const qrImg = document.getElementById('tip-qr-img');
    const addrText = document.getElementById('tip-address-text');
    const netBadge = document.getElementById('tip-network-badge');
    const tabs = document.querySelectorAll('.crypto-tab');

    const cryptoData = {
      usdt: {
        address: '0x22f61aDAd0E7b10707AD9385C06e24E8f1d49517',
        network: 'NETWORK: BNB SMART CHAIN (BEP20)',
        qr: 'assets/donate/USDT.jpg'
      },
      sol: {
        address: 'CPAZavanFM3JoixS1gHag1QcY9BsD59NXLr9jyuykjtB',
        network: 'NETWORK: SOLANA',
        qr: 'assets/donate/SOL.jpg'
      },
      eth: {
        address: '0x22f61aDAd0E7b10707AD9385C06e24E8f1d49517',
        network: 'NETWORK: ETHEREUM (ERC20) / BSC',
        qr: 'assets/donate/ETH.jpg'
      },
      btc: {
        address: '0x22f61aDAd0E7b10707AD9385C06e24E8f1d49517',
        network: 'NETWORK: BITCOIN (BEP20 / BSC)',
        qr: 'assets/donate/BTC.jpg'
      }
    };

    if (tipBtn && tipModal) {
      tipBtn.addEventListener('click', () => {
        tipModal.classList.remove('hidden');
        tipModal.classList.add('flex');
      });
    }

    if (closeBtn && tipModal) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        tipModal.classList.add('hidden');
        tipModal.classList.remove('flex');
      });
    }

    if (tipModal) {
      tipModal.addEventListener('click', (e) => {
        if (e.target === tipModal) {
          tipModal.classList.add('hidden');
          tipModal.classList.remove('flex');
        }
      });
    }

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const coin = tab.dataset.coin;
        if (!cryptoData[coin]) return;

        tabs.forEach(t => {
          t.className = 'crypto-tab flex-1 py-1 text-center rounded-lg text-[9px] font-mono font-bold text-[#7d869a] hover:text-white';
        });
        tab.className = 'crypto-tab flex-1 py-1 text-center rounded-lg text-[9px] font-mono font-bold bg-[#587bf8] text-white';

        if (qrImg) qrImg.src = cryptoData[coin].qr;
        if (addrText) addrText.textContent = cryptoData[coin].address;
        if (netBadge) netBadge.textContent = cryptoData[coin].network;
      });
    });

    if (copyBtn && addrText) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(addrText.textContent.trim()).then(() => {
          const original = copyBtn.textContent;
          copyBtn.textContent = 'COPIED! ✓';
          copyBtn.className = 'px-2 py-1 rounded bg-[#45c8b2] text-[#0f1016] font-mono text-[7.5px] font-bold transition-all flex-shrink-0';
          setTimeout(() => {
            copyBtn.textContent = original;
            copyBtn.className = 'px-2 py-1 rounded bg-[#587bf8] hover:bg-[#6e8dfa] active:scale-95 text-white font-mono text-[7.5px] font-bold transition-all flex-shrink-0';
          }, 1500);
        });
      });
    }
  }

  /**
   * Fallback Avatar render (noop for compatibility)
   */
  function renderPixelAvatar() {
    updateMascotVibe();
  }

  /**
   * Big Dot-Matrix Digital BPM Display Canvas
   */
  const digitPatterns = {
    '0': [[1,1,1,1],[1,0,0,1],[1,0,0,1],[1,0,0,1],[1,0,0,1],[1,0,0,1],[1,1,1,1]],
    '1': [[0,1,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0],[1,1,1,1]],
    '2': [[1,1,1,1],[0,0,0,1],[0,0,0,1],[1,1,1,1],[1,0,0,0],[1,0,0,0],[1,1,1,1]],
    '3': [[1,1,1,1],[0,0,0,1],[0,0,0,1],[1,1,1,1],[0,0,0,1],[0,0,0,1],[1,1,1,1]],
    '4': [[1,0,0,1],[1,0,0,1],[1,0,0,1],[1,1,1,1],[0,0,0,1],[0,0,0,1],[0,0,0,1]],
    '5': [[1,1,1,1],[1,0,0,0],[1,0,0,0],[1,1,1,1],[0,0,0,1],[0,0,0,1],[1,1,1,1]],
    '6': [[1,1,1,1],[1,0,0,0],[1,0,0,0],[1,1,1,1],[1,0,0,1],[1,0,0,1],[1,1,1,1]],
    '7': [[1,1,1,1],[0,0,0,1],[0,0,0,1],[0,0,1,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]],
    '8': [[1,1,1,1],[1,0,0,1],[1,0,0,1],[1,1,1,1],[1,0,0,1],[1,0,0,1],[1,1,1,1]],
    '9': [[1,1,1,1],[1,0,0,1],[1,0,0,1],[1,1,1,1],[0,0,0,1],[0,0,0,1],[1,1,1,1]],
    '.': [[0,0],[0,0],[0,0],[0,0],[0,0],[1,1],[1,1]],
    '-': [[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0],[0,0,0,0]]
  };

  function renderBpmDots() {
    const canvas = document.getElementById('bpm-dot-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const bpmStr = Math.round(state.bpm).toString();
    const dotSize = 3.2;
    const gap = 1.3;
    let cursorX = 2;
    ctx.fillStyle = '#ffffff';

    for (let char of bpmStr) {
      const grid = digitPatterns[char];
      if (!grid) continue;
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
          if (grid[r][c] === 1) {
            ctx.fillRect(cursorX + c * (dotSize + gap), 2 + r * (dotSize + gap), dotSize, dotSize);
          }
        }
      }
      cursorX += (grid[0].length * (dotSize + gap)) + 5.5;
    }
  }

  /**
   * [SPEC REQ 1] Turntable Jog-Wheel Renderer
   * Machined vinyl grooved platter, center spindle with OP accent ring, high-visibility cue pip
   */
  function renderTurntable() {
    const canvas = document.getElementById('turntable-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = cx - 6;

    ctx.clearRect(0, 0, w, h);

    // Outer Vinyl Edge Shadow
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#14151a';
    ctx.fill();

    // Hub and inner dimensions proportional to radius
    const hubRadius = Math.max(26, radius * 0.35);
    const innerRadius = Math.max(14, hubRadius * 0.55);
    const pinRadius = Math.max(4, hubRadius * 0.17);

    // Platter Vinyl Grooves (Micro rings)
    ctx.lineWidth = 1;
    for (let r = hubRadius + 6; r < radius - 3; r += 4.5) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = (Math.round(r) % 9 === 0) ? '#282b36' : '#1c1e27';
      ctx.stroke();
    }

    // Vinyl Sheen Highlight (Simulated light reflection)
    const sheenGrad = ctx.createLinearGradient(0, 0, w, h);
    sheenGrad.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
    sheenGrad.addColorStop(0.5, 'transparent');
    sheenGrad.addColorStop(1, 'rgba(255, 255, 255, 0.04)');
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 3, 0, Math.PI * 2);
    ctx.fillStyle = sheenGrad;
    ctx.fill();

    // ROTATING SURFACE
    ctx.translate(cx, cy);
    ctx.rotate(state.rotationAngle);

    // Center Matte Label / Spindle Hub
    ctx.beginPath();
    ctx.arc(0, 0, hubRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#1c1e28';
    ctx.fill();
    ctx.lineWidth = 2.0;
    ctx.strokeStyle = '#587bf8';
    ctx.stroke();

    // Inner Accent Ring
    ctx.beginPath();
    ctx.arc(0, 0, innerRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#121319';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#2d3242';
    ctx.stroke();

    // Center Spindle Pin
    ctx.beginPath();
    ctx.arc(0, 0, pinRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#e2e8f0';
    ctx.fill();

    // High-visibility Cue Indicator Needle & Pip
    ctx.beginPath();
    ctx.moveTo(0, -(innerRadius + 2));
    ctx.lineTo(0, -(radius - 5));
    ctx.strokeStyle = 'rgba(88, 123, 248, 0.85)';
    ctx.lineWidth = 2.0;
    ctx.stroke();

    // Outer Glowing Marker Pip
    ctx.beginPath();
    ctx.arc(0, -(radius - 9), Math.max(3.5, radius * 0.04), 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#587bf8';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Stylized OP Pixel Notch mark on center hub
    ctx.fillStyle = '#587bf8';
    ctx.fillRect(-hubRadius * 0.2, -hubRadius * 0.08, hubRadius * 0.15, hubRadius * 0.16);
    ctx.fillRect(hubRadius * 0.08, -hubRadius * 0.08, hubRadius * 0.15, hubRadius * 0.16);

    ctx.restore();

    // Update degrees label
    const degEl = document.getElementById('rot-readout');
    if (degEl) {
      const deg = Math.round(((state.rotationAngle * 180 / Math.PI) % 360 + 360) % 360);
      degEl.textContent = `${deg}°`;
    }
  }

  /**
   * [SPEC REQ 2] Waveform Visualizer Canvas Renderer
   * LED spectral analyzer bars or high-res studio waveform
   */
  function renderWaveform() {
    const canvas = document.getElementById('waveform-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Grid guidelines
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const numBars = 54;
    const barWidth = (w / numBars) - 2.5;

    for (let i = 0; i < numBars; i++) {
      let magnitude = 0.2;
      if (state.waveformData && state.waveformData.length > 0) {
        const sampleIdx = Math.floor((i / numBars) * state.waveformData.length);
        magnitude = (state.waveformData[sampleIdx] || 20) / 255;
      } else if (state.isPlaying) {
        // Dynamic studio oscillation simulation when playing without live stream
        const t = Date.now() * 0.008;
        magnitude = 0.25 + 0.65 * Math.abs(Math.sin(t + (i * 0.22))) * (1 - Math.abs(i - numBars / 2) / (numBars / 1.5));
      } else {
        // Ambient static pattern
        magnitude = 0.15 + 0.15 * Math.sin(i * 0.5);
      }

      const barHeight = Math.max(4, magnitude * (h * 0.85));
      const x = i * (barWidth + 2.5);
      const y = (h - barHeight) / 2;

      // Color coding (OP-XY Pink/Teal/Blue palette gradient)
      if (i < 18) {
        ctx.fillStyle = '#587bf8'; // Lows (Blue)
      } else if (i < 36) {
        ctx.fillStyle = '#45c8b2'; // Mids (Teal)
      } else {
        ctx.fillStyle = '#e94879'; // Highs (Pink)
      }

      // Draw segmented dot-matrix style capsule bars
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  }

  /**
   * Main Animation & Physics Loop (Runs 60FPS for silky turntable inertia)
   */
  function animationLoop() {
    if (state.isPlaying && !state.isScratching) {
      // Continuous rotation according to BPM
      // 33 1/3 RPM base scaled by BPM
      const rps = (state.bpm / 130) * (33.33 / 60);
      state.rotationAngle += (rps * 2 * Math.PI) / 60;
    } else if (!state.isScratching && Math.abs(state.angularVelocity) > 0.0005) {
      // Inertial spin-decay
      state.rotationAngle += state.angularVelocity;
      state.angularVelocity *= 0.94; // friction
    }

    renderTurntable();
    renderWaveform();
    state.animFrameId = requestAnimationFrame(animationLoop);
  }

  /**
   * Knob UI Synchronizer
   */
  function updateKnobDisplay(name) {
    const knob = state.knobs[name];
    if (!knob) return;
    const valEl = document.querySelector(`.val-${name}`);
    const ringEl = document.querySelector(`.ring-${name}`);
    const encEl = document.getElementById(`encoder-${name}`);

    if (valEl) {
      if (name === 'decay') {
        valEl.textContent = (knob.val > 0 ? '+' : '') + knob.val + 'dB';
        const bassDash = document.getElementById('dash-bass');
        if (bassDash) bassDash.textContent = valEl.textContent;
      } else if (name === 'cutoff') {
        valEl.textContent = (knob.val / 1000).toFixed(1) + 'k';
      } else if (name === 'fold') {
        valEl.textContent = knob.val < 10 ? '0' + knob.val : knob.val;
      } else {
        valEl.textContent = knob.val;
      }
    }

    if (ringEl) {
      const ratio = (knob.val - knob.min) / (knob.max - knob.min);
      const circumference = 144;
      ringEl.style.strokeDashoffset = circumference - (ratio * circumference * 0.75);
    }

    if (encEl) {
      const pointer = encEl.querySelector('.knob-pointer');
      if (pointer) {
        const ratio = (knob.val - knob.min) / (knob.max - knob.min);
        const deg = -135 + (ratio * 270);
        pointer.style.transform = `rotate(${deg}deg)`;
        pointer.style.transformOrigin = 'center 14px';
      }
    }
  }

  function setupKnobDrag(name) {
    const el = document.getElementById(`encoder-${name}`);
    if (!el) return;
    let startY = 0;
    let startVal = 0;

    function onMouseMove(e) {
      const dy = startY - (e.clientY || (e.touches && e.touches[0].clientY));
      const k = state.knobs[name];
      const range = k.max - k.min;
      const delta = (dy / 100) * range;
      let newVal = Math.round(startVal + delta);
      newVal = Math.max(k.min, Math.min(k.max, newVal));
      k.val = newVal;
      updateKnobDisplay(name);

      /* CHROME EXTENSION HOOK: Broadcast Knob Change */
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'KNOB_CHANGE', knob: name, value: newVal }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
      sendPortMessage({ type: 'KNOB_CHANGE', knob: name, value: newVal });
    }

    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onMouseMove);
      window.removeEventListener('touchend', onMouseUp);
    }

    function onMouseDown(e) {
      getAudioContext();
      startY = e.clientY || (e.touches && e.touches[0].clientY);
      startVal = state.knobs[name].val;
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('touchmove', onMouseMove);
      window.addEventListener('touchend', onMouseUp);
    }

    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('touchstart', onMouseDown, { passive: true });
  }

  /**
   * Interactive Turntable Jog-Wheel Scratching
   */
  function setupTurntableInteraction() {
    const touchLayer = document.getElementById('turntable-touch-layer');
    if (!touchLayer) return;

    function getAngle(e) {
      const rect = touchLayer.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return Math.atan2(clientY - cy, clientX - cx);
    }

    let lastAngle = 0;
    let lastTime = 0;

    function onStart(e) {
      getAudioContext();
      state.isScratching = true;
      lastAngle = getAngle(e);
      lastTime = performance.now();
      state.angularVelocity = 0;
      triggerSoundEffect('scratch');
      
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onEnd);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
    }

    function onMove(e) {
      if (!state.isScratching) return;
      if (e.cancelable) e.preventDefault();
      const currentAngle = getAngle(e);
      const now = performance.now();
      let delta = currentAngle - lastAngle;

      // Wrap around normalization
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;

      state.rotationAngle += delta;

      const dt = Math.max(1, now - lastTime);
      state.angularVelocity = (delta / dt) * 16; // approximate 60FPS velocity

      lastAngle = currentAngle;
      lastTime = now;

      /* CHROME EXTENSION HOOK: Broadcast Scratch Event */
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'TURNTABLE_SCRATCH', angle: state.rotationAngle, velocity: state.angularVelocity }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
      sendPortMessage({ type: 'TURNTABLE_SCRATCH', angle: state.rotationAngle, velocity: state.angularVelocity });
    }

    function onEnd() {
      state.isScratching = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    }

    touchLayer.addEventListener('mousedown', onStart);
    touchLayer.addEventListener('touchstart', onStart, { passive: false });
  }

  /**
   * Update the Play/Pause button and transport prompt UI based on playback state
   */
  function setPlaybackState(isPlaying) {
    state.isPlaying = Boolean(isPlaying);
    const playBtn = document.getElementById('btn-play-pause');
    const iconPlay = document.getElementById('icon-play');
    const iconPause = document.getElementById('icon-pause');
    const prompt = document.getElementById('disp-play-prompt');

    if (state.isPlaying) {
      if (iconPlay) iconPlay.classList.add('hidden');
      if (iconPause) iconPause.classList.remove('hidden');
      if (playBtn) {
        playBtn.classList.remove('bg-[#587bf8]');
        playBtn.classList.add('bg-[#4068f5]');
      }
      if (prompt) {
        prompt.textContent = 'PLAYING ▶';
        prompt.classList.remove('text-[#587bf8]');
        prompt.classList.add('text-[#45c8b2]');
      }
    } else {
      if (iconPlay) iconPlay.classList.remove('hidden');
      if (iconPause) iconPause.classList.add('hidden');
      if (playBtn) {
        playBtn.classList.remove('bg-[#4068f5]');
        playBtn.classList.add('bg-[#587bf8]');
      }
      if (prompt) {
        prompt.textContent = 'PAUSED ❚❚';
        prompt.classList.remove('text-[#45c8b2]');
        prompt.classList.add('text-[#587bf8]');
      }
    }

    updateMascotVibe();
  }

  /**
   * Transport Controls (Play, Cue, Sync)
   */
  function togglePlay() {
    getAudioContext();
    const targetState = !state.isPlaying;
    setPlaybackState(targetState);

    /* Send playback command to YouTube Music via background service worker */
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'TOGGLE_PLAY', isPlaying: targetState }, (res) => {
        if (chrome.runtime.lastError) {}
        if (res && res.isPlaying !== undefined) {
          setPlaybackState(res.isPlaying);
        }
      });
    }
    sendPortMessage({ type: 'TOGGLE_PLAY', isPlaying: targetState });
  }

  /**
   * [SPEC REQ] 1. updateWaveform(dataArray)
   */
  function updateWaveform(dataArray) {
    state.waveformData = dataArray;
  }

  /**
   * [SPEC REQ] 2. updateTurntable(rotationAngle)
   */
  function updateTurntable(rotationAngle) {
    state.rotationAngle = rotationAngle;
  }

  /**
   * [SPEC REQ] 5. updateStatus(bpm, status, bass)
   */
  function updateStatus(bpm, status, bass, deck) {
    if (bpm !== undefined && bpm !== null) {
      state.bpm = parseFloat(bpm);
      renderBpmDots();
      const dashBpm = document.getElementById('dash-bpm');
      if (dashBpm) dashBpm.textContent = state.bpm.toFixed(1);
    }
    if (status !== undefined && status !== null) {
      state.status = status;
      const dashStatus = document.getElementById('dash-status');
      if (dashStatus) dashStatus.textContent = status;
    }
    if (bass !== undefined && bass !== null) {
      state.bass = bass;
      const dashBass = document.getElementById('dash-bass');
      if (dashBass) dashBass.textContent = typeof bass === 'number' ? `${bass}dB` : bass;
    }
    if (deck) {
      state.activeDeck = deck;
      const deckBadge = document.getElementById('track-deck-badge');
      if (deckBadge) deckBadge.textContent = `DECK ${deck}`;
    }
  }

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function updateTrackInfo(data) {
    if (!data) return;
    const title = data.title || data.name || (data.current && data.current.title);
    const artist = data.artist || (data.current && data.current.artist);
    const albumArt = data.albumArt || data.thumbnail || (data.current && data.current.albumArt);
    const currentTime = data.currentTime !== undefined ? data.currentTime : 0;
    const duration = data.duration !== undefined ? data.duration : 0;

    const titleEl = document.getElementById('track-title');
    if (titleEl && title) {
      titleEl.textContent = title;
      titleEl.setAttribute('title', title);
    }

    const artistEl = document.getElementById('track-artist');
    if (artistEl && artist) {
      artistEl.textContent = artist;
      artistEl.setAttribute('title', artist);
    }

    const artImg = document.getElementById('track-album-art');
    const placeholder = document.getElementById('track-art-placeholder');
    if (artImg) {
      if (albumArt && typeof albumArt === 'string' && albumArt.length > 5) {
        artImg.src = albumArt;
        artImg.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
      } else if (!artImg.src || artImg.src === '') {
        artImg.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
      }
    }

    const timeEl = document.getElementById('track-time');
    if (timeEl && duration > 0) {
      timeEl.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    }

    const progressEl = document.getElementById('track-progress-bar');
    if (progressEl && duration > 0) {
      const pct = Math.min(100, Math.max(0, (currentTime / duration) * 100));
      progressEl.style.width = `${pct}%`;
    }

    const deckBadge = document.getElementById('track-deck-badge');
    if (deckBadge && state.activeDeck) {
      deckBadge.textContent = `DECK ${state.activeDeck}`;
    }

    if (title) state.trackTitle = title;
    if (artist) state.trackArtist = artist;

    if (data.isPlaying !== undefined) {
      setPlaybackState(data.isPlaying);
    } else if (data.isPaused !== undefined) {
      setPlaybackState(!data.isPaused);
    }

    // Refresh mascot vibe according to track genre/rhythm
    updateMascotVibe();
  }

  /**
   * Initialize AuraDJ System & DOM Events
   */
  function init() {
    setupGamification();
    renderPixelAvatar();
    renderBpmDots();
    renderTurntable();
    renderWaveform();
    setupTurntableInteraction();

    // Read cached track state and deck on startup
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
      chrome.storage.session.get(['lastYtmState', 'activeDeck'], (res) => {
        if (res) {
          if (res.lastYtmState) {
            updateTrackInfo(res.lastYtmState);
            if (res.lastYtmState.isPlaying !== undefined) {
              setPlaybackState(res.lastYtmState.isPlaying);
            }
          }
          if (res.activeDeck) {
            state.activeDeck = res.activeDeck;
            const badge = document.getElementById('track-deck-badge');
            if (badge) badge.textContent = `DECK ${res.activeDeck}`;
          }
        }
      });
    }

    // Setup Knobs
    ['tune', 'decay', 'fold', 'cutoff'].forEach(name => {
      updateKnobDisplay(name);
      setupKnobDrag(name);
    });

    // Transport Listeners
    const playPauseBtn = document.getElementById('btn-play-pause');
    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', togglePlay);
    }

    // CUE Button
    const cueBtn = document.getElementById('btn-cue');
    if (cueBtn) {
      cueBtn.addEventListener('mousedown', () => {
        getAudioContext();
        state.rotationAngle = 0;
        triggerSoundEffect('scratch');
        cueBtn.classList.add('bg-[#587bf8]', 'text-white');
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'CUE' }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
        sendPortMessage({ type: 'CUE' });
      });
      cueBtn.addEventListener('mouseup', () => {
        cueBtn.classList.remove('bg-[#587bf8]', 'text-white');
      });
    }

    // SYNC Button
    const syncBtn = document.getElementById('btn-sync');
    if (syncBtn) {
      syncBtn.addEventListener('click', () => {
        getAudioContext();
        state.bpm = 128.0;
        state.pitchOffset = 0.0;
        const pitchPercent = document.getElementById('pitch-percent');
        if (pitchPercent) pitchPercent.textContent = 'SYNCED';
        renderBpmDots();
        updateStatus(128.0, 'Synced', state.bass + 'dB');
        setTimeout(() => {
          if (pitchPercent) pitchPercent.textContent = '+0.0%';
        }, 1200);
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'SYNC', bpm: 128.0 }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
        sendPortMessage({ type: 'SYNC', bpm: 128.0 });
      });
    }

    // BPM Buttons
    const bpmPlusBtn = document.getElementById('btn-bpm-plus');
    if (bpmPlusBtn) {
      bpmPlusBtn.addEventListener('click', () => {
        state.bpm = Math.min(200, state.bpm + 1);
        renderBpmDots();
        updateStatus(state.bpm, state.isPlaying ? 'Live' : 'Ready', state.bass + 'dB');
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'BPM_CHANGE', bpm: state.bpm }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
        sendPortMessage({ type: 'BPM_CHANGE', bpm: state.bpm });
      });
    }

    const bpmMinusBtn = document.getElementById('btn-bpm-minus');
    if (bpmMinusBtn) {
      bpmMinusBtn.addEventListener('click', () => {
        state.bpm = Math.max(60, state.bpm - 1);
        renderBpmDots();
        updateStatus(state.bpm, state.isPlaying ? 'Live' : 'Ready', state.bass + 'dB');
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'BPM_CHANGE', bpm: state.bpm }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
        sendPortMessage({ type: 'BPM_CHANGE', bpm: state.bpm });
      });
    }

    // [SPEC REQ 3] Crossfader Slider Nudge
    const crossfader = document.getElementById('crossfader-slider');
    if (crossfader) {
      crossfader.addEventListener('input', (e) => {
        state.crossfader = parseInt(e.target.value, 10);
        
        /* CHROME EXTENSION HOOK: Broadcast Crossfader blend */
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'CROSSFADER_CHANGE', value: state.crossfader }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
        sendPortMessage({ type: 'CROSSFADER_CHANGE', value: state.crossfader });
      });
    }

    // AutoMix Toggle Button
    const automixBtn = document.getElementById('btn-automix');
    if (automixBtn) {
      // Remove inline onclick for MV3 CSP compliance
      automixBtn.removeAttribute('onclick');
      automixBtn.addEventListener('click', (e) => {
        e.preventDefault();
        automixBtn.dataset.active = automixBtn.dataset.active === 'true' ? 'false' : 'true';
        const on = automixBtn.dataset.active === 'true';
        const txt = automixBtn.querySelector('.automix-txt');
        if (txt) txt.textContent = on ? 'AUTOMIX: ON' : 'AUTOMIX: OFF';
        const dot = document.getElementById('automix-indicator');
        if (on) {
          automixBtn.className = 'px-3 py-1 rounded-lg bg-[#587bf8] border border-[#7494ff] text-white text-[10px] font-mono font-bold uppercase tracking-wider active:scale-95 transition-all shadow-[0_0_12px_rgba(88,123,248,0.5)] flex items-center gap-1.5';
          if (dot) dot.className = 'w-2 h-2 rounded-full bg-[#45c8b2] shadow-[0_0_8px_#45c8b2] animate-ping';
        } else {
          automixBtn.className = 'px-3 py-1 rounded-lg bg-[#1e202a] border border-[#2d3140] hover:border-[#41475d] text-[#b4bccf] text-[10px] font-mono font-bold uppercase tracking-wider active:scale-95 transition-all shadow-sm flex items-center gap-1.5';
          if (dot) dot.className = 'w-2 h-2 rounded-full bg-[#5e6678]';
        }

        /* CHROME EXTENSION HOOK: Broadcast AutoMix Toggle */
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'AUTOMIX_TOGGLE', enabled: on, active: on }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
        sendPortMessage({ type: 'AUTOMIX_TOGGLE', enabled: on, active: on });
      });
    }

    // Mode Switcher Tabs
    document.querySelectorAll('.nav-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-mode-btn').forEach(b => {
          b.classList.remove('text-[#587bf8]', 'bg-[#272b3a]');
          b.classList.add('text-[#71788a]');
        });
        btn.classList.add('text-[#587bf8]', 'bg-[#272b3a]');
        btn.classList.remove('text-[#71788a]');
      });
    });

    // Start 60fps Loop
    animationLoop();

    /**
     * Listen for runtime messages (standalone or tab messaging)
     */
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) return;
        if (message.type === 'WAVEFORM_DATA') {
          const data = message.data !== undefined ? message.data : (message.waveformData || message.payload);
          if (data) window.AuraDJ.updateWaveform(data);
        } else if (message.type === 'ROTATION_UPDATE') {
          window.AuraDJ.updateTurntable(message.angle);
        } else if (message.type === 'STATUS_UPDATE' || message.type === 'ENGINE_STATE') {
          const bpm = message.bpm !== undefined ? message.bpm : message.state?.bpm;
          const status = message.status !== undefined ? message.status : message.state?.status;
          const bass = message.bass !== undefined ? message.bass : message.state?.bass;
          const key = message.key || message.camelotKey || message.state?.key || message.state?.camelotKey;
          const deck = message.activeDeck || message.state?.activeDeck;
          window.AuraDJ.updateStatus(bpm, status, bass, deck);
          if (key) {
            const keyEl = document.getElementById('disp-key');
            if (keyEl) keyEl.textContent = key;
          }
        } else if (message.type === 'YTM_STATE' || message.type === 'TRACK_CHANGED') {
          const trackState = message.state || message.current || message;
          if (trackState && window.AuraDJ && typeof window.AuraDJ.updateTrackInfo === 'function') {
            window.AuraDJ.updateTrackInfo(trackState);
          }
          if (message.type === 'TRACK_CHANGED') {
            gameStats.tracksMixed++;
            addXP(25);
          }
        } else if (message.type === 'ANALYSIS_RESULT') {
          const bpm = message.bpm !== undefined ? message.bpm : (message.result?.bpm ?? message.data?.bpm);
          const key = message.key || message.camelotKey || message.result?.key || message.result?.camelotKey || message.data?.key || message.data?.camelotKey;
          if (bpm !== undefined) window.AuraDJ.updateStatus(bpm);
          if (key) {
            const keyEl = document.getElementById('disp-key');
            if (keyEl) keyEl.textContent = key;
          }
        }
        if (sendResponse) sendResponse({ received: true });
      });
    }
  }

  // Public API Methods exported to window.AuraDJ
  return {
    init,
    updateWaveform,
    updateTurntable,
    updateStatus,
    updateTrackInfo,
    triggerSoundEffect,
    getState: () => ({ ...state })
  };
})();

// Initialize once DOM is ready
window.addEventListener('DOMContentLoaded', window.AuraDJ.init);

/**
 * =========================================================================
 * Chrome Extension Messaging Bridge
 * =========================================================================
 */
if (typeof chrome !== 'undefined' && chrome.runtime) {
  let activePort = null;

  // Establish a long-lived port connection to background service worker
  if (chrome.runtime.connect) {
    try {
      const port = chrome.runtime.connect({ name: 'popup' });
      activePort = port;

      sendPortMessage = function(msg) {
        if (activePort) {
          try {
            activePort.postMessage(msg);
          } catch (err) {
            console.warn('Port postMessage error:', err);
          }
        }
      };

      // Listen on port for incoming messages
      port.onMessage.addListener((message) => {
        if (!message) return;

        // WAVEFORM_DATA
        if (message.type === 'WAVEFORM_DATA') {
          const data = message.data !== undefined ? message.data : (message.waveformData || message.payload);
          if (data && window.AuraDJ && typeof window.AuraDJ.updateWaveform === 'function') {
            window.AuraDJ.updateWaveform(data);
          }
        }

        // ENGINE_STATE
        else if (message.type === 'ENGINE_STATE') {
          const bpm = message.bpm !== undefined ? message.bpm : message.state?.bpm;
          const status = message.status !== undefined ? message.status : message.state?.status;
          const bass = message.bass !== undefined ? message.bass : message.state?.bass;
          const key = message.key || message.camelotKey || message.state?.key || message.state?.camelotKey;
          const deck = message.activeDeck || message.state?.activeDeck;

          if (window.AuraDJ && typeof window.AuraDJ.updateStatus === 'function') {
            window.AuraDJ.updateStatus(bpm, status, bass, deck);
          }
          if (key) {
            const keyEl = document.getElementById('disp-key');
            if (keyEl) keyEl.textContent = key;
          }
        }

        // YTM_STATE / TRACK_CHANGED
        else if (message.type === 'YTM_STATE' || message.type === 'TRACK_CHANGED') {
          const trackState = message.state || message.current || message;
          if (trackState && window.AuraDJ && typeof window.AuraDJ.updateTrackInfo === 'function') {
            window.AuraDJ.updateTrackInfo(trackState);
          }
        }

        // ANALYSIS_RESULT
        else if (message.type === 'ANALYSIS_RESULT') {
          const bpm = message.bpm !== undefined ? message.bpm : (message.result?.bpm ?? message.data?.bpm);
          const key = message.key || message.camelotKey || message.result?.key || message.result?.camelotKey || message.data?.key || message.data?.camelotKey;

          if (bpm !== undefined && window.AuraDJ && typeof window.AuraDJ.updateStatus === 'function') {
            window.AuraDJ.updateStatus(bpm);
          }
          if (key) {
            const keyEl = document.getElementById('disp-key');
            if (keyEl) keyEl.textContent = key;
          }
        }
      });

      port.onDisconnect.addListener(() => {
        activePort = null;
      });
    } catch (e) {
      console.warn('Could not connect chrome.runtime port:', e);
    }
  }

  // Start Capture Initialization: when popup opens, request capture if needed
  try {
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'START_CAPTURE' }, (res) => {
        if (chrome.runtime.lastError) {
          console.log('[AuraDJ] START_CAPTURE response error:', chrome.runtime.lastError.message);
        } else if (res && res.alreadyCapturing) {
          console.log('[AuraDJ] Stream already actively captured.');
        }
      });
    }
  } catch (e) {
    console.warn('Could not send START_CAPTURE initialization:', e);
  }
}
