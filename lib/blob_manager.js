/**
 * Blob URL Lifecycle and Session Persistence Manager
 * Ensures durable cleanup and revocation of in-memory media Blobs across MV3 Service Worker lifecycles.
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

  /**
   * Safe wrapper for chrome.storage.session or memory fallback.
   */
  async function getSessionStorage(storageApi = null) {
    const api = storageApi || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session);
    if (api && typeof api.get === "function") {
      return new Promise((resolve) => {
        try {
          api.get(STORAGE_KEY, (res) => {
            if (typeof chrome !== "undefined" && chrome.runtime?.lastError) {
              resolve({});
            } else {
              resolve((res && res[STORAGE_KEY]) || {});
            }
          });
        } catch (_) {
          resolve({});
        }
      });
    }
    return {};
  }

  async function setSessionStorage(data, storageApi = null) {
    const api = storageApi || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session);
    if (api && typeof api.set === "function") {
      return new Promise((resolve) => {
        try {
          api.set({ [STORAGE_KEY]: data }, () => resolve());
        } catch (_) {
          resolve();
        }
      });
    }
  }

  /**
   * Register a new active Blob URL download.
   */
  async function registerBlobDownload(downloadId, blobUrl, storageApi = null) {
    if (!downloadId || !blobUrl) return;
    const store = await getSessionStorage(storageApi);
    store[String(downloadId)] = blobUrl;
    await setSessionStorage(store, storageApi);
  }

  /**
   * Retrieve and unregister a Blob URL upon download completion/interruption.
   */
  async function unregisterBlobDownload(downloadId, storageApi = null) {
    if (!downloadId) return null;
    const store = await getSessionStorage(storageApi);
    const key = String(downloadId);
    const blobUrl = store[key] || null;
    if (blobUrl) {
      delete store[key];
      await setSessionStorage(store, storageApi);
    }
    return blobUrl;
  }

  /**
   * Check if any active Blob downloads remain.
   */
  async function hasActiveBlobDownloads(storageApi = null) {
    const store = await getSessionStorage(storageApi);
    return Object.keys(store).length > 0;
  }

  /**
   * Revoke a Blob URL via offscreen messaging and close offscreen if no downloads remain.
   */
  async function revokeBlobUrl(blobUrl, { messageSender = null, offscreenCloser = null, storageApi = null } = {}) {
    if (!blobUrl) return;

    // 1. Request offscreen to revoke the URL
    if (typeof messageSender === "function") {
      try {
        await messageSender({ action: "OFFSCREEN_REVOKE_URL", blobUrl });
      } catch (_) {}
    } else if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({ action: "OFFSCREEN_REVOKE_URL", blobUrl }).catch(() => {});
      } catch (_) {}
    }

    // 2. If no active Blob downloads remain, close offscreen document to free memory
    const hasRemaining = await hasActiveBlobDownloads(storageApi);
    if (!hasRemaining) {
      if (typeof offscreenCloser === "function") {
        try {
          await offscreenCloser();
        } catch (_) {}
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
    registerBlobDownload,
    unregisterBlobDownload,
    hasActiveBlobDownloads,
    revokeBlobUrl
  };
});
