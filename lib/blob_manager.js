/**
 * Robust Blob Download & Lifecycle Manager
 * Author: Bin.Late
 * Handles Blob URL tracking, pending-to-active state transitions, and offscreen document lifecycle.
 * Features dual-layer persistence: chrome.storage.session + in-memory fallback map for zero-leak guarantees.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BlobManager = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STORAGE_KEY = "binlate_fb_blob_downloads";
  let pendingSeq = 0;

  // In-memory fallback map: { key (downloadId or token) -> { url, token, downloadId } }
  const memoryFallbackMap = new Map();

  function clearMemoryFallback() {
    memoryFallbackMap.clear();
  }

  // In-process serialized mutex queue for all storage mutations
  let mutationQueue = Promise.resolve();

  function withQueue(fn) {
    const next = mutationQueue.then(fn, fn);
    mutationQueue = next.catch(() => {});
    return next;
  }

  /**
   * Helper to safely read and normalize session storage data.
   */
  async function getSessionStorage(storageApi = null) {
    const api = storageApi || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session);
    if (api && typeof api.get === "function") {
      return new Promise((resolve) => {
        try {
          api.get(STORAGE_KEY, (result) => {
            if (typeof chrome !== "undefined" && chrome.runtime?.lastError) {
              console.warn("[Bin.Late FB Downloader] Storage get error:", chrome.runtime.lastError.message);
              resolve({ active: {}, pending: {}, readError: true });
            } else {
              const raw = result ? result[STORAGE_KEY] : null;
              if (raw && typeof raw === "object") {
                const active = raw.active && typeof raw.active === "object" ? raw.active : {};
                const pending = raw.pending && typeof raw.pending === "object" ? raw.pending : {};
                resolve({ active, pending, readError: false });
              } else {
                resolve({ active: {}, pending: {}, readError: false });
              }
            }
          });
        } catch (err) {
          console.warn("[Bin.Late FB Downloader] Storage get exception:", err.message);
          resolve({ active: {}, pending: {}, readError: true });
        }
      });
    }
    return { active: {}, pending: {}, readError: false };
  }

  async function setSessionStorage(data, storageApi = null) {
    const api = storageApi || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session);
    if (api && typeof api.set === "function") {
      return new Promise((resolve, reject) => {
        try {
          api.set({ [STORAGE_KEY]: data }, () => {
            if (typeof chrome !== "undefined" && chrome.runtime?.lastError) {
              const err = new Error(chrome.runtime.lastError.message || "Storage set failed");
              console.warn("[Bin.Late FB Downloader] Storage set error:", err.message);
              reject(err);
            } else {
              resolve();
            }
          });
        } catch (err) {
          console.warn("[Bin.Late FB Downloader] Storage set exception:", err.message);
          reject(err);
        }
      });
    }
  }

  /**
   * Start a durable pending registration in session storage before chrome.downloads.download() starts.
   */
  async function beginPendingRegistration(blobUrl, storageApi = null) {
    const token = `pending_${++pendingSeq}_${Date.now()}`;
    if (!blobUrl) return token;

    // Record in memory fallback
    memoryFallbackMap.set(token, { url: blobUrl, downloadId: null, token, createdAt: Date.now() });

    return withQueue(async () => {
      try {
        const store = await getSessionStorage(storageApi);
        store.pending[token] = { url: blobUrl, downloadId: null, createdAt: Date.now() };
        await setSessionStorage(store, storageApi);
      } catch (err) {
        console.warn("[Bin.Late FB Downloader] beginPendingRegistration storage write failed, using memory fallback:", err.message);
      }
      return token;
    });
  }

  /**
   * Atomically convert pending registration to active download ID in session storage.
   */
  async function completePendingRegistration(token, downloadId, blobUrl, storageApi = null) {
    if (!downloadId || !blobUrl) return;

    // Update memory fallback
    const dlKey = String(downloadId);
    if (token) memoryFallbackMap.delete(token);
    for (const [k, v] of memoryFallbackMap.entries()) {
      if (v?.token === token || v?.url === blobUrl) {
        memoryFallbackMap.delete(k);
      }
    }
    memoryFallbackMap.set(dlKey, { url: blobUrl, token, downloadId: dlKey, createdAt: Date.now() });

    return withQueue(async () => {
      const store = await getSessionStorage(storageApi);
      if (token && store.pending[token]) {
        delete store.pending[token];
      }
      store.active[dlKey] = blobUrl;
      await setSessionStorage(store, storageApi);
    });
  }

  /**
   * Record downloadId on a pending registration if the active transition fails.
   */
  async function recordPendingDownloadId(token, downloadId, storageApi = null) {
    if (!token || !downloadId) return;

    const dlKey = String(downloadId);
    const existing = memoryFallbackMap.get(token);
    if (existing) {
      existing.downloadId = dlKey;
      memoryFallbackMap.set(dlKey, existing);
      memoryFallbackMap.delete(token);
    }

    return withQueue(async () => {
      try {
        const store = await getSessionStorage(storageApi);
        if (store.pending[token]) {
          const entry = store.pending[token];
          store.pending[token] = typeof entry === "object"
            ? { ...entry, downloadId: dlKey }
            : { url: entry, downloadId: dlKey };
          await setSessionStorage(store, storageApi);
        }
      } catch (_) {}
    });
  }

  /**
   * Cancel and remove pending registration if download fails to launch.
   */
  async function cancelPendingRegistration(token, storageApi = null) {
    if (!token) return;
    memoryFallbackMap.delete(token);
    for (const [k, v] of memoryFallbackMap.entries()) {
      if (v?.token === token) {
        memoryFallbackMap.delete(k);
      }
    }
    return withQueue(async () => {
      try {
        const store = await getSessionStorage(storageApi);
        if (store.pending[token]) {
          delete store.pending[token];
          await setSessionStorage(store, storageApi);
        }
      } catch (err) {
        console.warn("[Bin.Late FB Downloader] Failed to cancel pending registration:", err.message);
      }
    });
  }

  /**
   * Direct registration helper (serialized).
   */
  async function registerBlobDownload(downloadId, blobUrl, storageApi = null) {
    if (!downloadId || !blobUrl) return;
    const dlKey = String(downloadId);
    memoryFallbackMap.set(dlKey, { url: blobUrl, downloadId: dlKey, token: null });

    return withQueue(async () => {
      const store = await getSessionStorage(storageApi);
      store.active[dlKey] = blobUrl;
      await setSessionStorage(store, storageApi);
    });
  }

  /**
   * Retrieve and unregister a Blob URL upon download completion/interruption.
   * Reconciles session storage active map, pending entries, and memory fallback map.
   */
  async function unregisterBlobDownload(downloadId, storageApi = null) {
    if (!downloadId) return null;
    const dlKey = String(downloadId);

    return withQueue(async () => {
      let blobUrl = null;

      try {
        const store = await getSessionStorage(storageApi);
        blobUrl = store.active[dlKey] || null;
        if (blobUrl) {
          delete store.active[dlKey];
        } else {
          // Reconcile with pending records
          for (const [token, entry] of Object.entries(store.pending || {})) {
            const entryUrl = typeof entry === "string" ? entry : entry?.url;
            const entryDlId = typeof entry === "object" ? entry?.downloadId : null;
            if (entryDlId && String(entryDlId) === dlKey) {
              blobUrl = entryUrl;
              delete store.pending[token];
              break;
            }
          }
        }
        await setSessionStorage(store, storageApi);
      } catch (err) {
        console.warn("[Bin.Late FB Downloader] Storage error during unregisterBlobDownload, checking memory fallback:", err.message);
      }

      // Always clean up memory fallback for this downloadId and associated URL
      if (memoryFallbackMap.has(dlKey)) {
        const mem = memoryFallbackMap.get(dlKey);
        if (!blobUrl) blobUrl = mem?.url || null;
        memoryFallbackMap.delete(dlKey);
        if (mem?.token) memoryFallbackMap.delete(mem.token);
      }

      if (blobUrl) {
        for (const [k, v] of memoryFallbackMap.entries()) {
          if (v?.url === blobUrl) {
            memoryFallbackMap.delete(k);
          }
        }
      }

      return blobUrl;
    });
  }

  /**
   * Reconcile and remove an orphaned pending entry by URL once its Blob is being revoked.
   */
  async function reconcilePendingBlobDownload(blobUrl, storageApi = null) {
    if (!blobUrl) return;

    // Clean memory fallback
    for (const [k, v] of memoryFallbackMap.entries()) {
      if (v?.url === blobUrl) {
        memoryFallbackMap.delete(k);
      }
    }

    return withQueue(async () => {
      try {
        const store = await getSessionStorage(storageApi);
        let modified = false;
        for (const [token, entry] of Object.entries(store.pending || {})) {
          const entryUrl = typeof entry === "string" ? entry : entry?.url;
          if (entryUrl === blobUrl) {
            delete store.pending[token];
            modified = true;
          }
        }
        if (modified) {
          await setSessionStorage(store, storageApi);
        }
      } catch (_) {}
    });
  }

  /**
   * Check if any active Blob downloads or durable pending registrations remain.
   * Fail-safe: if storage check errors, returns true so offscreen document is NOT closed.
   */
  async function hasActiveBlobDownloads(storageApi = null) {
    try {
      const store = await getSessionStorage(storageApi);
      if (store.readError) return true; // Fail closed on storage read error
      const activeCount = Object.keys(store.active || {}).length;
      const pendingCount = Object.keys(store.pending || {}).length;
      return activeCount > 0 || pendingCount > 0 || memoryFallbackMap.size > 0;
    } catch (err) {
      console.warn("[Bin.Late FB Downloader] Failed to verify active blob downloads; keeping offscreen open for safety:", err.message);
      return true; // Fail closed: keep offscreen alive on storage errors
    }
  }

  /**
   * Revoke a Blob URL via offscreen messaging and close offscreen if no downloads or pending registrations remain.
   */
  async function revokeBlobUrl(blobUrl, { messageSender = null, offscreenCloser = null, storageApi = null } = {}) {
    if (!blobUrl) return;

    // Clean up any remaining pending record referencing this blobUrl
    await reconcilePendingBlobDownload(blobUrl, storageApi);

    // 1. Request offscreen to revoke the URL
    if (typeof messageSender === "function") {
      try {
        await messageSender({ action: "OFFSCREEN_REVOKE_URL", blobUrl });
      } catch (err) {
        console.warn("[Bin.Late FB Downloader] Message sender error during revoke:", err);
      }
    } else if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({ action: "OFFSCREEN_REVOKE_URL", blobUrl }).catch(() => {});
      } catch (_) {}
    }

    // 2. If no active or pending Blob downloads remain, close offscreen document to free memory
    const hasRemaining = await hasActiveBlobDownloads(storageApi);
    if (!hasRemaining) {
      if (typeof offscreenCloser === "function") {
        try {
          await offscreenCloser();
        } catch (err) {
          console.warn("[Bin.Late FB Downloader] Offscreen closer error:", err);
        }
      } else if (typeof chrome !== "undefined" && chrome.offscreen && chrome.offscreen.closeDocument) {
        try {
          await chrome.offscreen.closeDocument();
        } catch (_) {}
      }
    }
  }

  return {
    STORAGE_KEY,
    memoryFallbackMap,
    clearMemoryFallback,
    beginPendingRegistration,
    completePendingRegistration,
    recordPendingDownloadId,
    cancelPendingRegistration,
    registerBlobDownload,
    unregisterBlobDownload,
    reconcilePendingBlobDownload,
    hasActiveBlobDownloads,
    revokeBlobUrl
  };
});
