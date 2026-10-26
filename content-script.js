/**
 * AuraDJ - YouTube Music Content Script
 * Scrapes player state, detects track transitions, and facilitates playback control.
 */

(() => {
  console.log('[AuraDJ] YouTube Music content script initialized');

  // Track internal state
  let lastTrackTitle = '';
  let lastTrackArtist = '';
  let trackEndingSoonSent = false;
  let automixEnabled = true;
  let automixTriggeredForCurrentTrack = false;
  let pollingIntervalId = null;
  let domObserver = null;
  let observerDebounceTimeout = null;
  let isContextActive = true;

  /**
   * Safe wrapper around chrome.runtime.sendMessage
   * Gracefully handles extension context invalidation when extension is reloaded
   */
  function sendMessageSafely(message, callback) {
    if (!isContextActive || !chrome.runtime?.id) {
      cleanup();
      return;
    }

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          // Extension context may have become invalidated or service worker temporarily inactive
          const errMsg = chrome.runtime.lastError.message || '';
          if (errMsg.includes('Extension context invalidated')) {
            cleanup();
            return;
          }
        }
        if (typeof callback === 'function') {
          callback(response);
        }
      });
    } catch (err) {
      if (err.message && err.message.includes('Extension context invalidated')) {
        cleanup();
      } else {
        console.warn('[AuraDJ] Error sending runtime message:', err);
      }
    }
  }

  /**
   * Helper to clean up timers and observers when extension context dies
   */
  function cleanup() {
    isContextActive = false;
    if (pollingIntervalId) {
      clearInterval(pollingIntervalId);
      pollingIntervalId = null;
    }
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    if (observerDebounceTimeout) {
      clearTimeout(observerDebounceTimeout);
      observerDebounceTimeout = null;
    }
    console.log('[AuraDJ] Content script cleaned up after context invalidation');
  }

  /**
   * Extract video element from YouTube Music
   * @returns {HTMLVideoElement|null}
   */
  function getVideoElement() {
    return (
      document.querySelector('video.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video')
    );
  }

  /**
   * Extract current track title
   * @returns {string}
   */
  function getTrackTitle() {
    const titleEl =
      document.querySelector('ytmusic-player-bar .title') ||
      document.querySelector('.ytmusic-player-bar .title') ||
      document.querySelector('ytmusic-player-bar yt-formatted-string.title') ||
      document.querySelector('ytmusic-player-bar .middle-controls yt-formatted-string.title') ||
      document.querySelector('#layout ytmusic-player-bar .content-info-wrapper .title');

    if (!titleEl) return '';
    return (titleEl.textContent || titleEl.getAttribute('title') || '').trim();
  }

  /**
   * Extract current track artist
   * @returns {string}
   */
  function getTrackArtist() {
    const bylineEl =
      document.querySelector('ytmusic-player-bar .byline') ||
      document.querySelector('.ytmusic-player-bar .byline') ||
      document.querySelector('ytmusic-player-bar yt-formatted-string.byline') ||
      document.querySelector('ytmusic-player-bar .middle-controls yt-formatted-string.byline') ||
      document.querySelector('#layout ytmusic-player-bar .content-info-wrapper .byline');

    if (!bylineEl) return '';

    // If byline contains an anchor link, the first link is typically the artist
    const artistAnchor = bylineEl.querySelector('a');
    if (artistAnchor && artistAnchor.textContent.trim()) {
      return artistAnchor.textContent.trim();
    }

    const fullByline = (bylineEl.textContent || bylineEl.getAttribute('title') || '').trim();
    // In YTM, artist is usually before the first bullet separator " • "
    if (fullByline.includes(' • ')) {
      return fullByline.split(' • ')[0].trim();
    }

    return fullByline;
  }

  /**
   * Extract album art URL
   * @returns {string}
   */
  function getAlbumArt() {
    const imgEl =
      document.querySelector('ytmusic-player-bar img.image') ||
      document.querySelector('ytmusic-player-bar .thumbnail img') ||
      document.querySelector('ytmusic-player-bar #thumbnail img') ||
      document.querySelector('ytmusic-player-bar img') ||
      document.querySelector('#song-image img');

    if (!imgEl) return '';
    const src = imgEl.src || imgEl.getAttribute('src') || '';
    return src.startsWith('http') || src.startsWith('blob:') || src.startsWith('data:') ? src : '';
  }

  /**
   * Extract next track info from the queue panel
   * @returns {{title: string, artist: string, albumArt: string}|null}
   */
  function getNextTrackInfo() {
    try {
      // 1. Try finding all queue items in the DOM
      const queueItems = Array.from(
        document.querySelectorAll(
          'ytmusic-player-queue-item, .ytmusic-player-queue-item, ytmusic-tab-renderer[page-type="MUSIC_PAGE_TYPE_QUEUE"] ytmusic-player-queue-item'
        )
      );

      if (queueItems.length > 0) {
        // Find index of currently playing item
        const activeIdx = queueItems.findIndex((item) => {
          return (
            item.hasAttribute('selected') ||
            item.classList.contains('selected') ||
            item.getAttribute('play-button-state') === 'playing' ||
            item.getAttribute('play-button-state') === 'paused' ||
            item.querySelector('[aria-label*="Playing"]') !== null
          );
        });

        let nextItem = null;
        if (activeIdx >= 0 && activeIdx + 1 < queueItems.length) {
          nextItem = queueItems[activeIdx + 1];
        } else if (activeIdx === -1 && queueItems.length > 1) {
          // If no active item marker found, assume second queue item is next
          nextItem = queueItems[1];
        }

        if (nextItem) {
          const titleEl =
            nextItem.querySelector('.song-title') ||
            nextItem.querySelector('.title') ||
            nextItem.querySelector('yt-formatted-string[title]');
          const bylineEl =
            nextItem.querySelector('.byline') ||
            nextItem.querySelector('.artist-name') ||
            nextItem.querySelector('yt-formatted-string:not(.song-title):not(.title)');
          const imgEl = nextItem.querySelector('img');

          const title = titleEl ? (titleEl.textContent || titleEl.getAttribute('title') || '').trim() : '';
          const artist = bylineEl ? (bylineEl.textContent || bylineEl.getAttribute('title') || '').trim() : '';
          const albumArt = imgEl ? (imgEl.src || '') : '';

          if (title || artist) {
            return { title, artist, albumArt };
          }
        }
      }

      // 2. Fallback using selector from spec: .side-panel .ytmusic-player-queue-item:nth-child(2)
      const sideItem =
        document.querySelector('.side-panel .ytmusic-player-queue-item:nth-child(2)') ||
        document.querySelector('#side-panel .ytmusic-player-queue-item:nth-child(2)');

      if (sideItem) {
        const titleEl = sideItem.querySelector('.song-title, .title');
        const bylineEl = sideItem.querySelector('.byline');
        const imgEl = sideItem.querySelector('img');
        return {
          title: titleEl ? titleEl.textContent.trim() : '',
          artist: bylineEl ? bylineEl.textContent.trim() : '',
          albumArt: imgEl ? imgEl.src : ''
        };
      }
    } catch (err) {
      console.warn('[AuraDJ] Error scraping next track info:', err);
    }
    return null;
  }

  /**
   * Scrapes current state from the DOM and video element
   * @returns {object} YTM state
   */
  function extractYtmState() {
    const video = getVideoElement();

    const title = getTrackTitle();
    const artist = getTrackArtist();
    const albumArt = getAlbumArt();
    const nextTrack = getNextTrackInfo();

    const currentTime = video && !isNaN(video.currentTime) ? video.currentTime : 0;
    const duration = video && !isNaN(video.duration) && isFinite(video.duration) ? video.duration : 0;
    const isPaused = video ? video.paused : true;
    const isPlaying = !isPaused;
    const volume = video && !isNaN(video.volume) ? video.volume : 1;
    const isMuted = video ? video.muted : false;

    return {
      title,
      artist,
      albumArt,
      currentTime: Math.round(currentTime * 100) / 100,
      duration: Math.round(duration * 100) / 100,
      isPlaying,
      isPaused,
      volume: Math.round(volume * 100) / 100,
      isMuted,
      nextTrack,
      timestamp: Date.now()
    };
  }

  /**
   * Evaluates state, checks transition conditions, and dispatches messages
   */
  function evaluateAndBroadcastState() {
    if (!isContextActive) return;

    const state = extractYtmState();
    const { title, artist, currentTime, duration } = state;

    // Detect Track Change
    const currentTrackKey = `${title} - ${artist}`;
    const previousTrackKey = `${lastTrackTitle} - ${lastTrackArtist}`;

    if (title && currentTrackKey !== previousTrackKey) {
      if (lastTrackTitle !== '') {
        console.log(`[AuraDJ] Track changed from "${previousTrackKey}" to "${currentTrackKey}"`);
        sendMessageSafely({
          type: 'TRACK_CHANGED',
          previous: {
            title: lastTrackTitle,
            artist: lastTrackArtist
          },
          current: {
            title,
            artist,
            duration,
            albumArt: state.albumArt
          },
          state
        });
      }

      lastTrackTitle = title;
      lastTrackArtist = artist;
      trackEndingSoonSent = false;
      automixTriggeredForCurrentTrack = false;
    }

    // Detect Track Ending for Apple AutoMix Transition
    if (duration > 25) {
      const timeRemaining = duration - currentTime;

      // 1. Intelligent AutoMix Early Trigger (at ~12s remaining)
      if (automixEnabled && !automixTriggeredForCurrentTrack && timeRemaining > 0 && timeRemaining <= 12) {
        automixTriggeredForCurrentTrack = true;
        console.log(`[AuraDJ] AutoMix window reached! (${timeRemaining.toFixed(1)}s remaining). Initiating Apple AutoMix transition.`);
        sendMessageSafely({
          type: 'TRIGGER_AUTOMIX',
          timeRemaining: Math.round(timeRemaining * 10) / 10,
          state
        });

        // 1500ms delay: outgoing deck's resonant HPF sweep + echo freeze builds up before Track B enters
        setTimeout(() => {
          skipToNextTrack();
        }, 1500);
      } else if (timeRemaining > 20 && automixTriggeredForCurrentTrack) {
        // Reset if user seeks back in track
        automixTriggeredForCurrentTrack = false;
      }

      // 2. Telemetry warning (30s)
      if (timeRemaining > 0 && timeRemaining <= 30 && !trackEndingSoonSent) {
        trackEndingSoonSent = true;
        sendMessageSafely({
          type: 'TRACK_ENDING_SOON',
          timeRemaining: Math.round(timeRemaining * 10) / 10,
          state
        });
      } else if (timeRemaining > 35 && trackEndingSoonSent) {
        trackEndingSoonSent = false;
      }
    }

    // Send regular state update
    sendMessageSafely({
      type: 'YTM_STATE',
      state
    });
  }

  /**
   * Programmatically click the next track button in YouTube Music
   * @returns {boolean} Whether click was performed
   */
  function skipToNextTrack() {
    console.log('[AuraDJ] Attempting to skip to next track...');

    const nextButtonSelectors = [
      'ytmusic-player-bar .next-button',
      '.ytmusic-player-bar .next-button',
      'button[aria-label="Next song"]',
      'button[aria-label="Next track"]',
      'button[aria-label="Next"]',
      '.ytmusic-player-bar [aria-label*="Next"]',
      '#layout ytmusic-player-bar paper-icon-button.next-button',
      'paper-icon-button[aria-label="Next song"]',
      'tp-yt-paper-icon-button[aria-label="Next song"]'
    ];

    for (const selector of nextButtonSelectors) {
      const btn = document.querySelector(selector);
      if (btn) {
        // Dispatch click
        btn.click();
        console.log(`[AuraDJ] Clicked next button using selector: ${selector}`);
        return true;
      }
    }

    // Fallback: If button element not found, simulate MediaKey / KeyboardEvent
    console.warn('[AuraDJ] Next button not found via standard selectors, attempting keyboard shortcut (Shift+N)');
    const event = new KeyboardEvent('keydown', {
      key: 'N',
      code: 'KeyN',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(event);
    return true;
  }

  /**
   * Listen for commands from the background service worker or popup
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;

    console.log(`[AuraDJ] Content script received message: ${message.type}`);

    if (message.type === 'SKIP_TRACK') {
      const success = skipToNextTrack();
      sendResponse({ success });
      return true;
    }

    if (message.type === 'AUTOMIX_TOGGLE') {
      automixEnabled = (message.enabled !== undefined) ? !!message.enabled : !automixEnabled;
      console.log(`[AuraDJ] Content script AutoMix mode: ${automixEnabled ? 'ENABLED' : 'DISABLED'}`);
      sendResponse({ success: true, automixEnabled });
      return false;
    }

    if (message.type === 'GET_YTM_STATE') {
      const state = extractYtmState();
      sendResponse({ success: true, state });
      return true;
    }

    if (message.type === 'TOGGLE_PLAY') {
      const playPauseBtn =
        document.querySelector('ytmusic-player-bar #play-pause-button') ||
        document.querySelector('#play-pause-button') ||
        document.querySelector('.play-pause-button') ||
        document.querySelector('button[aria-label="Play"]') ||
        document.querySelector('button[aria-label="Pause"]') ||
        document.querySelector('paper-icon-button[aria-label="Play"]') ||
        document.querySelector('paper-icon-button[aria-label="Pause"]');

      if (playPauseBtn) {
        playPauseBtn.click();
        setTimeout(() => {
          evaluateAndBroadcastState();
        }, 50);
        const video = getVideoElement();
        sendResponse({ success: true, isPlaying: video ? !video.paused : true });
        return true;
      }

      const video = getVideoElement();
      if (video) {
        if (video.paused) {
          video.play().catch((e) => console.warn('[AuraDJ] Error playing video:', e));
        } else {
          video.pause();
        }
        setTimeout(() => {
          evaluateAndBroadcastState();
        }, 50);
        sendResponse({ success: true, isPlaying: !video.paused });
      } else {
        sendResponse({ success: false, error: 'Video element not found' });
      }
      return true;
    }

    return false;
  });

  /**
   * Set up MutationObserver to react immediately to player bar DOM updates
   */
  function setupMutationObserver() {
    try {
      const targetNode = document.querySelector('ytmusic-player-bar') || document.body;
      if (!targetNode) return;

      domObserver = new MutationObserver(() => {
        if (observerDebounceTimeout) clearTimeout(observerDebounceTimeout);
        observerDebounceTimeout = setTimeout(() => {
          evaluateAndBroadcastState();
        }, 80);
      });

      domObserver.observe(targetNode, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['title', 'src', 'class', 'selected', 'play-button-state']
      });

      console.log('[AuraDJ] MutationObserver attached to player bar');
    } catch (err) {
      console.warn('[AuraDJ] Failed to attach MutationObserver:', err);
    }
  }

  /**
   * Attach instantaneous play/pause listeners to video element
   */
  function attachVideoListeners() {
    const video = getVideoElement();
    if (video && !video.hasAttribute('data-auradj-listening')) {
      video.setAttribute('data-auradj-listening', 'true');
      video.addEventListener('play', () => evaluateAndBroadcastState());
      video.addEventListener('pause', () => evaluateAndBroadcastState());
      video.addEventListener('playing', () => evaluateAndBroadcastState());
    }
  }

  /**
   * Start polling every 500ms
   */
  function startPolling() {
    if (pollingIntervalId) clearInterval(pollingIntervalId);

    // Initial evaluation & attach video listeners
    attachVideoListeners();
    evaluateAndBroadcastState();

    // 500ms polling loop as required by spec
    pollingIntervalId = setInterval(() => {
      attachVideoListeners();
      evaluateAndBroadcastState();
    }, 500);

    console.log('[AuraDJ] 500ms Polling loop started');
  }

  // Ensure DOM is ready before starting
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setupMutationObserver();
      startPolling();
    });
  } else {
    setupMutationObserver();
    startPolling();
  }
})();
