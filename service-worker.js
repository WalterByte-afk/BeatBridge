/**
 * AuraDJ - Manifest V3 Background Service Worker
 * Manages offscreen document lifecycle, tab audio capture, and inter-context message routing.
 */

// Track active captured YouTube Music tab ID
let capturedTabId = null;
let lastKnownYtmTabId = null;

// Track offscreen document creation promise to avoid concurrency races
let creatingOffscreenPromise = null;

// Track connected extension ports (e.g. popup, offscreen document)
const activePorts = new Set();

/**
 * Initialize session state on service worker startup
 */
async function initializeState() {
  try {
    const data = await chrome.storage.session.get(['capturedTabId', 'lastKnownYtmTabId']);
    if (data.capturedTabId) {
      capturedTabId = data.capturedTabId;
      console.log(`[AuraDJ] Restored capturedTabId: ${capturedTabId}`);
    }
    if (data.lastKnownYtmTabId) {
      lastKnownYtmTabId = data.lastKnownYtmTabId;
    }
  } catch (err) {
    console.warn('[AuraDJ] Failed to read session storage on init:', err);
  }
}

/**
 * Persist tab capture state in session storage
 */
async function setCapturedTab(tabId) {
  capturedTabId = tabId;
  try {
    if (tabId !== null) {
      await chrome.storage.session.set({ capturedTabId: tabId });
    } else {
      await chrome.storage.session.remove('capturedTabId');
    }
  } catch (err) {
    console.warn('[AuraDJ] Failed to update capturedTabId in session storage:', err);
  }
}

/**
 * Ensures an offscreen document is active.
 * Guarantees only a single offscreen document is created at any time.
 */
async function ensureOffscreenDocument() {
  if (creatingOffscreenPromise) {
    return creatingOffscreenPromise;
  }

  const offscreenUrl = chrome.runtime.getURL('offscreen.html');

  // Check if offscreen document already exists using chrome.offscreen.hasDocument if supported
  if ('hasDocument' in chrome.offscreen) {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) {
      return;
    }
  } else if ('getContexts' in chrome.runtime) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existingContexts && existingContexts.length > 0) {
      return;
    }
  }

  creatingOffscreenPromise = (async () => {
    try {
      console.log('[AuraDJ] Creating offscreen document for audio engine...');
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Audio processing engine for DJ transitions'
      });
      console.log('[AuraDJ] Offscreen document created successfully');
    } catch (err) {
      if (err.message && err.message.includes('Only a single offscreen document may be created')) {
        console.log('[AuraDJ] Offscreen document already exists');
      } else {
        console.error('[AuraDJ] Error creating offscreen document:', err);
        throw err;
      }
    } finally {
      creatingOffscreenPromise = null;
    }
  })();

  return creatingOffscreenPromise;
}

/**
 * Helper to obtain tabCapture stream ID for a specified tab
 * @param {number} targetTabId 
 * @returns {Promise<string>} streamId
 */
function getTabMediaStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!streamId) {
          return reject(new Error(`Failed to obtain media stream ID for tab ${targetTabId}`));
        }
        resolve(streamId);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Finds the most relevant YouTube Music tab (active/current or open in background)
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function findYtmTab() {
  try {
    // 1. Check if user is currently active on a YTM tab in current window
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true, url: '*://music.youtube.com/*' });
    if (activeTab) return activeTab;

    // 2. Check if user is active on a YTM tab across any window
    const [activeAny] = await chrome.tabs.query({ active: true, url: '*://music.youtube.com/*' });
    if (activeAny) return activeAny;

    // 3. Fallback: Find any open YouTube Music tab
    const tabs = await chrome.tabs.query({ url: '*://music.youtube.com/*' });
    if (tabs && tabs.length > 0) {
      // If we previously interacted with a specific YTM tab and it's still alive, prioritize it
      if (capturedTabId) {
        const found = tabs.find(t => t.id === capturedTabId);
        if (found) return found;
      }
      if (lastKnownYtmTabId) {
        const found = tabs.find(t => t.id === lastKnownYtmTabId);
        if (found) return found;
      }
      return tabs[0];
    }
  } catch (err) {
    console.error('[AuraDJ] Error querying YTM tabs:', err);
  }
  return null;
}

/**
 * Broadcasts a message to all open extension views (popup, offscreen doc)
 * and active long-lived connection ports.
 * @param {object} message 
 */
function broadcastExtensionMessage(message) {
  // 1. Post to runtime listeners (offscreen, popup)
  chrome.runtime.sendMessage(message, () => {
    // Suppress "The message port closed before a response was received" error when no views are open
    if (chrome.runtime.lastError) {
      // Intentionally silent
    }
  });

  // 2. Post to connected ports
  for (const port of activePorts) {
    try {
      port.postMessage(message);
    } catch (err) {
      console.warn('[AuraDJ] Failed to send to port:', port.name, err);
    }
  }
}

// Concurrency lock for start capture requests
let startingCapturePromise = null;

/**
 * Start tab audio capture on YouTube Music tab
 * @param {number|undefined} requestedTabId 
 * @returns {Promise<{success: boolean, tabId: number, streamId: string, alreadyCapturing?: boolean}>}
 */
async function handleStartCapture(requestedTabId) {
  if (startingCapturePromise) {
    return startingCapturePromise;
  }

  startingCapturePromise = (async () => {
    let targetTab = null;

    if (requestedTabId) {
      try {
        targetTab = await chrome.tabs.get(requestedTabId);
      } catch (e) {
        console.warn(`[AuraDJ] Could not find tab ID ${requestedTabId}, searching for YTM tab...`);
      }
    }

    if (!targetTab) {
      targetTab = await findYtmTab();
    }

    if (!targetTab || !targetTab.id) {
      throw new Error('No YouTube Music tab found. Please open music.youtube.com.');
    }

    const tabId = targetTab.id;
    console.log(`[AuraDJ] Starting audio capture for tab #${tabId} (${targetTab.title || 'YTM'})`);

    // Ensure offscreen document is alive before obtaining stream
    await ensureOffscreenDocument();

    // Mute tab to prevent duplicate direct audio output (captured stream will be played back by offscreen engine)
    try {
      await chrome.tabs.update(tabId, { muted: true });
      console.log(`[AuraDJ] Muted YouTube Music tab #${tabId}`);
    } catch (muteErr) {
      console.warn(`[AuraDJ] Failed to mute tab #${tabId}:`, muteErr);
    }

    // Obtain media stream ID for tabCapture (handle already captured tabs gracefully)
    let streamId;
    try {
      streamId = await getTabMediaStreamId(tabId);
      console.log(`[AuraDJ] Obtained tabCapture streamId: ${streamId}`);
    } catch (streamErr) {
      if (streamErr.message && streamErr.message.includes('Cannot capture a tab with an active stream')) {
        console.log(`[AuraDJ] Tab #${tabId} already has an active stream in Chrome.`);
        await setCapturedTab(tabId);
        return { success: true, tabId, alreadyCapturing: true };
      }
      throw streamErr;
    }

    await setCapturedTab(tabId);

    // Forward start command with streamId to offscreen audio engine
    const startMsg = {
      type: 'START_CAPTURE',
      streamId,
      tabId,
      title: targetTab.title || 'YouTube Music'
    };

    broadcastExtensionMessage(startMsg);

    return { success: true, tabId, streamId };
  })().finally(() => {
    startingCapturePromise = null;
  });

  return startingCapturePromise;
}

/**
 * Stop tab audio capture and restore tab audio output
 */
async function handleStopCapture() {
  console.log('[AuraDJ] Stopping audio capture...');

  const tabToUnmute = capturedTabId || lastKnownYtmTabId;

  if (tabToUnmute) {
    try {
      await chrome.tabs.update(tabToUnmute, { muted: false });
      console.log(`[AuraDJ] Unmuted tab #${tabToUnmute}`);
    } catch (err) {
      console.warn(`[AuraDJ] Could not unmute tab #${tabToUnmute}:`, err.message);
    }
  }

  await setCapturedTab(null);

  // Instruct offscreen audio engine to stop and release media stream
  broadcastExtensionMessage({ type: 'STOP_CAPTURE' });

  return { success: true };
}

/**
 * Send track skip command to YouTube Music content script
 */
async function handleSkipTrack() {
  const targetTab = capturedTabId ? { id: capturedTabId } : await findYtmTab();
  if (!targetTab || !targetTab.id) {
    throw new Error('No YouTube Music tab available to skip track');
  }

  try {
    const response = await chrome.tabs.sendMessage(targetTab.id, { type: 'SKIP_TRACK' });
    console.log(`[AuraDJ] Sent SKIP_TRACK to tab #${targetTab.id}, response:`, response);
    return response || { success: true };
  } catch (err) {
    console.warn(`[AuraDJ] Failed to send SKIP_TRACK to tab #${targetTab.id}:`, err);
    throw err;
  }
}

/**
 * Send play/pause toggle command to YouTube Music content script
 */
async function handleTogglePlay(isPlaying) {
  const targetTab = capturedTabId ? { id: capturedTabId } : await findYtmTab();
  if (!targetTab || !targetTab.id) {
    console.warn('[AuraDJ] No YouTube Music tab available for TOGGLE_PLAY');
    return { success: false, error: 'No YouTube Music tab found' };
  }

  try {
    const response = await chrome.tabs.sendMessage(targetTab.id, { type: 'TOGGLE_PLAY', isPlaying });
    console.log(`[AuraDJ] Sent TOGGLE_PLAY to tab #${targetTab.id}, response:`, response);
    return response || { success: true };
  } catch (err) {
    console.warn(`[AuraDJ] Failed to send TOGGLE_PLAY to tab #${targetTab.id}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Handle incoming extension runtime messages
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  const msgType = message.type;
  console.log(`[AuraDJ] Service worker received message: ${msgType} from ${sender.tab ? 'tab #' + sender.tab.id : (sender.url || 'extension')}`);

  // 1. START_CAPTURE: From popup
  if (msgType === 'START_CAPTURE') {
    handleStartCapture(message.tabId)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('[AuraDJ] Error in START_CAPTURE:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message channel open for async response
  }

  // 2. STOP_CAPTURE: From popup or offscreen doc
  if (msgType === 'STOP_CAPTURE') {
    handleStopCapture()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('[AuraDJ] Error in STOP_CAPTURE:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // 3. GET_MEDIA_STREAM_ID: Request stream ID directly
  if (msgType === 'GET_MEDIA_STREAM_ID') {
    const targetTabId = message.tabId || capturedTabId || lastKnownYtmTabId;
    if (!targetTabId) {
      sendResponse({ success: false, error: 'Target tab ID not specified' });
      return false;
    }
    getTabMediaStreamId(targetTabId)
      .then((streamId) => sendResponse({ success: true, streamId }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 4. YTM_STATE: From content script on music.youtube.com -> Forward to offscreen doc
  if (msgType === 'YTM_STATE') {
    const stateObj = message.state || message.payload || message;
    if (sender.tab && sender.tab.id) {
      lastKnownYtmTabId = sender.tab.id;
      chrome.storage.session.set({
        lastKnownYtmTabId: sender.tab.id,
        lastYtmState: stateObj
      }).catch(() => {});
    } else {
      chrome.storage.session.set({ lastYtmState: stateObj }).catch(() => {});
    }

    // Forward to offscreen audio engine and any connected popup
    broadcastExtensionMessage({
      type: 'YTM_STATE',
      state: stateObj,
      tabId: sender.tab?.id
    });

    sendResponse({ success: true });
    return false;
  }

  // 5. ENGINE_STATE: From offscreen doc -> Forward to popup
  if (msgType === 'ENGINE_STATE') {
    broadcastExtensionMessage({
      type: 'ENGINE_STATE',
      state: message.state || message.payload || message
    });
    sendResponse({ success: true });
    return false;
  }

  // 6. Audio controls: KNOB_CHANGE, CROSSFADER_CHANGE, AUTOMIX_TOGGLE, TRIGGER_SFX
  // Sent from popup -> Forward to offscreen engine
  if (
    msgType === 'KNOB_CHANGE' ||
    msgType === 'CROSSFADER_CHANGE' ||
    msgType === 'AUTOMIX_TOGGLE' ||
    msgType === 'TRIGGER_SFX'
  ) {
    broadcastExtensionMessage(message);
    sendResponse({ success: true, forwarded: true });
    return false;
  }

  // 6b. TOGGLE_PLAY: From popup -> Send to YouTube Music content script & broadcast to offscreen
  if (msgType === 'TOGGLE_PLAY') {
    handleTogglePlay(message.isPlaying)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    broadcastExtensionMessage(message);
    return true;
  }

  // 7. Track lifecycle signals from content script: TRACK_ENDING_SOON, TRACK_CHANGED, TRIGGER_AUTOMIX
  if (msgType === 'TRACK_ENDING_SOON' || msgType === 'TRACK_CHANGED' || msgType === 'TRIGGER_AUTOMIX') {
    console.log(`[AuraDJ] Track event [${msgType}]:`, message);
    if (msgType === 'TRACK_CHANGED' && (message.current || message.state)) {
      chrome.storage.session.set({
        lastYtmState: message.state || message.current
      }).catch(() => {});
    }
    broadcastExtensionMessage(message);
    sendResponse({ success: true });
    return false;
  }

  // 8. SKIP_TRACK: Programmatically advance track on YouTube Music
  if (msgType === 'SKIP_TRACK') {
    handleSkipTrack()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 9. Query current capture status
  if (msgType === 'GET_CAPTURE_STATE') {
    sendResponse({
      capturedTabId,
      isCapturing: Boolean(capturedTabId),
      lastKnownYtmTabId
    });
    return false;
  }

  return false;
});

/**
 * Handle long-lived port connections from popup or offscreen document
 */
chrome.runtime.onConnect.addListener((port) => {
  console.log(`[AuraDJ] Port connected: ${port.name}`);
  activePorts.add(port);

  port.onDisconnect.addListener(() => {
    console.log(`[AuraDJ] Port disconnected: ${port.name}`);
    activePorts.delete(port);
  });

  port.onMessage.addListener(async (msg) => {
    console.log(`[AuraDJ] Port message received on [${port.name}]:`, msg?.type);
    if (msg && msg.type === 'START_CAPTURE') {
      try {
        const res = await handleStartCapture(msg.tabId);
        port.postMessage({ type: 'CAPTURE_STARTED', ...res });
      } catch (err) {
        port.postMessage({ type: 'CAPTURE_ERROR', error: err.message });
      }
    } else if (msg && msg.type === 'STOP_CAPTURE') {
      try {
        await handleStopCapture();
        port.postMessage({ type: 'CAPTURE_STOPPED' });
      } catch (err) {
        port.postMessage({ type: 'CAPTURE_ERROR', error: err.message });
      }
    } else if (msg && msg.type === 'TOGGLE_PLAY') {
      handleTogglePlay(msg.isPlaying);
      broadcastExtensionMessage(msg);
    } else if (msg) {
      // Re-route message to other extension contexts
      broadcastExtensionMessage(msg);
    }
  });
});

/**
 * Handle tab close: clean up muted state and inform audio engine if captured tab closes
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === capturedTabId) {
    console.warn(`[AuraDJ] Captured YouTube Music tab #${tabId} was closed`);
    await setCapturedTab(null);
    broadcastExtensionMessage({ type: 'STOP_CAPTURE', reason: 'TAB_CLOSED' });
  }
  if (tabId === lastKnownYtmTabId) {
    lastKnownYtmTabId = null;
  }
});

/**
 * Lifecycle setup:
 * Initialize session state and offscreen document on install/startup
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[AuraDJ] Extension installed/updated:', details.reason);
  await initializeState();
  await ensureOffscreenDocument().catch((err) => {
    console.warn('[AuraDJ] Initial offscreen document setup:', err.message);
  });
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[AuraDJ] Extension starting up');
  await initializeState();
  await ensureOffscreenDocument().catch((err) => {
    console.warn('[AuraDJ] Startup offscreen document setup:', err.message);
  });
});

// Top-level service worker execution
initializeState();
ensureOffscreenDocument().catch((err) => {
  console.warn('[AuraDJ] Top-level offscreen document setup:', err.message);
});
