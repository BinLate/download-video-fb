/**
 * Blob URL Lifecycle and Session Persistence Manager
 * Ensures durable cleanup, serialized storage mutations, and robust concurrency control
 * for in-memory media Blobs across MV3 Service Worker lifecycles and restarts.
 * Author: Bin.Late
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BlobManager = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STORAGE_KEY = "binlate_active_blob_downloads";

  // Serialized promise chain to prevent read/modify/write concurrency races
  let mutationQueue = Promise.resolve();

  function withQueue(task) {
    const next = mutationQueue.then(task, task);
    mutationQueue = next.catch(() => {});
    return next;
  }

  let pendingSeq = 0;

  /**
   * Safe wrapper for chrome.storage.session with strict error propagation.
   * Returns normalized object structure: { active: {}, pending: {} }
   */
  async function getSessionStorage(storageApi = null) {
    const api = storageApi || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session);
    if (api && typeof api.get === "function") {
      return new Promise((resolve, reject) => {
        try {
          api.get(STORAGE_KEY, (res) => {
            if (typeof chrome !== "undefined" && chrome.runtime?.lastError) {
              const err = new Error(chrome.runtime.lastError.message || "Storage get failed");
              console.warn("[Bin.Late FB Downloader] Storage get error:", err.message);
              reject(err);
            } else {
              const raw = res && res[STORAGE_KEY];
              const normalized = {
                active: (raw && raw.active && typeof raw.active === "object") ? { ...raw.active } : {},
                pending: (raw && raw.pending && typeof raw.pending === "object") ? { ...raw.pending } : {}
              };
              // Backward compatibility with flat key-value store
              if (raw && typeof raw === "object" && !raw.active && !raw.pending) {
                normalized.active = { ...raw };
              }
              resolve(normalized);
            }
          });
        } catch (err) {
          console.warn("[Bin.Late FB Downloader] Storage get exception:", err.message);
          reject(err);
        }
      });
    }
    return { active: {}, pending: {} };
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
   * Persisting this ensures offscreen document is protected across service worker restarts.
   */
  async function beginPendingRegistration(blobUrl, storageApi = null) {
    const token = `pending_${++pendingSeq}_${Date.now()}`;
    if (!blobUrl) return token;
    return withQueue(async () => {
      const store = await getSessionStorage(storageApi);
      store.pending[token] = blobUrl;
      await setSessionStorage(store, storageApi);
      return token;
    });
  }

  /**
   * Atomically convert pending registration to active download ID in session storage.
   */
  async function completePendingRegistration(token, downloadId, blobUrl, storageApi = null) {
    if (!downloadId || !blobUrl) return;
    return withQueue(async () => {
      const store = await getSessionStorage(storageApi);
      if (token && store.pending[token]) {
        delete store.pending[token];
      }
      store.active[String(downloadId)] = blobUrl;
      await setSessionStorage(store, storageApi);
    });
  }

  /**
   * Cancel and remove pending registration if download fails to launch.
   */
  async function cancelPendingRegistration(token, storageApi = null) {
    if (!token) return;
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
    return withQueue(async () => {
      const store = await getSessionStorage(storageApi);
      store.active[String(downloadId)] = blobUrl;
      await setSessionStorage(store, storageApi);
    });
  }

  /**
   * Retrieve and unregister a Blob URL upon download completion/interruption (serialized).
   */
  async function unregisterBlobDownload(downloadId, storageApi = null) {
    if (!downloadId) return null;
    return withQueue(async () => {
      const store = await getSessionStorage(storageApi);
      const key = String(downloadId);
      const blobUrl = store.active[key] || null;
      if (blobUrl) {
        delete store.active[key];
        await setSessionStorage(store, storageApi);
      }
      return blobUrl;
    });
  }

  /**
   * Check if any active Blob downloads or durable pending registrations remain.
   * Fail-safe: if storage check errors, returns true so offscreen document is NOT closed.
   */
  async function hasActiveBlobDownloads(storageApi = null) {
    try {
      const store = await getSessionStorage(storageApi);
      const activeCount = Object.keys(store.active || {}).length;
      const pendingCount = Object.keys(store.pending || {}).length;
      return activeCount > 0 || pendingCount > 0;
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
      } else if (typeof chrome !== "undefined" && chrome.offscreen?.closeDocument) {
        try {
          chrome.offscreen.closeDocument().catch(() => {});
        } catch (_) {}
      }
    }
  }

  return {
    STORAGE_KEY,
    getSessionStorage,
    setSessionStorage,
    beginPendingRegistration,
    completePendingRegistration,
    cancelPendingRegistration,
    registerBlobDownload,
    unregisterBlobDownload,
    hasActiveBlobDownloads,
    revokeBlobUrl
  };
});
