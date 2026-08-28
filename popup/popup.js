/**
 * Download Video / Reel Facebook - Popup Logic
 * Author: Bin.Late
 */

document.addEventListener("DOMContentLoaded", async () => {
  const statusIndicator = document.getElementById("statusIndicator");
  const statusText = document.getElementById("statusText");
  const statusDot = statusIndicator.querySelector(".status-dot");
  const detectedCountSpan = document.getElementById("detectedCount");
  const videoListContainer = document.getElementById("videoListContainer");
  const btnRescan = document.getElementById("btnRescan");
  const appVersionTag = document.getElementById("appVersionTag");
  if (appVersionTag && chrome.runtime?.getManifest) {
    appVersionTag.textContent = "v" + (chrome.runtime.getManifest().version || "1.2.0");
  }
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  const inputVideoUrl = document.getElementById("inputVideoUrl");
  const btnClearUrl = document.getElementById("btnClearUrl");
  const btnDownloadHd = document.getElementById("btnDownloadHd");
  const btnDownloadSd = document.getElementById("btnDownloadSd");

  // Tab switching
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      tabContents.forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-tab");
      document.getElementById(targetId)?.classList.add("active");
    });
  });

  btnClearUrl?.addEventListener("click", () => {
    inputVideoUrl.value = "";
    inputVideoUrl.focus();
  });

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isFbTab = activeTab?.url && (activeTab.url.includes("facebook.com") || activeTab.url.includes("fb.watch"));

  if (isFbTab) {
    statusDot.classList.add("active");
    statusText.textContent = "Đã kết nối Facebook";
    loadVideosFromTab(activeTab.id);
  } else {
    statusDot.classList.remove("active");
    statusText.textContent = "Sẵn sàng (Tải qua Link)";
    renderEmptyState(false);
  }

  btnRescan?.addEventListener("click", () => {
    if (activeTab?.id && isFbTab) {
      statusText.textContent = "Đang quét...";
      chrome.tabs.sendMessage(activeTab.id, { action: "SCAN_NOW" }, () => {
        if (chrome.runtime.lastError) {
          console.warn(chrome.runtime.lastError);
        }
        loadVideosFromTab(activeTab.id);
      });
    }
  });

  btnDownloadHd?.addEventListener("click", () => handleManualDownload("HD"));
  btnDownloadSd?.addEventListener("click", () => handleManualDownload("SD"));

  function loadVideosFromTab(tabId) {
    chrome.runtime.sendMessage({ action: "GET_TAB_VIDEOS", tabId }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(chrome.runtime.lastError);
      }
      const videos = response?.videos || [];
      detectedCountSpan.textContent = videos.length.toString();
      statusText.textContent = `Tìm thấy ${videos.length} video/reel`;

      if (videos.length === 0) {
        renderEmptyState(true);
      } else {
        renderVideoList(videos);
      }
    });
  }

  function renderVideoList(videos) {
    videoListContainer.innerHTML = "";

    videos.forEach((vid, index) => {
      const card = document.createElement("div");
      card.className = "video-card";

      const isReel = vid.type === "reel";
      const title = vid.title || (isReel ? `Reel Facebook #${index + 1}` : `Video Facebook #${index + 1}`);

      card.innerHTML = `
        <div class="card-header">
          <span class="card-type-badge ${isReel ? "reel" : "video"}">
            ${isReel ? "🎬 REEL" : "📹 VIDEO"}
          </span>
          <span class="card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
        </div>
        <div class="card-actions">
          <button type="button" class="btn-card-action primary btn-dl-hd" data-id="${vid.id}">
            ⬇️ Tải HD
          </button>
          <button type="button" class="btn-card-action secondary btn-dl-sd" data-id="${vid.id}">
            Tải SD
          </button>
          <button type="button" class="btn-card-action secondary btn-copy" title="Sao chép liên kết" data-id="${vid.id}">
            📋 Link
          </button>
        </div>
      `;

      card.querySelector(".btn-dl-hd").addEventListener("click", () => {
        triggerDownload(vid, "HD");
      });

      card.querySelector(".btn-dl-sd").addEventListener("click", () => {
        triggerDownload(vid, "SD");
      });

      card.querySelector(".btn-copy").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const targetUrl = vid.postLink || vid.hdUrl || vid.sdUrl || vid.url || activeTab?.url;
        await navigator.clipboard.writeText(targetUrl);
        const originalText = btn.textContent;
        btn.textContent = "✅ Đã chép";
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      });

      videoListContainer.appendChild(card);
    });
  }

  function renderEmptyState(isFacebookTab) {
    videoListContainer.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="10"/>
          <polygon points="10 8 16 12 10 16 10 8"/>
        </svg>
        <span class="empty-text">${isFacebookTab ? "Chưa phát hiện video nào" : "Bạn chưa mở Facebook"}</span>
        <span class="empty-sub">
          ${isFacebookTab 
            ? "Hãy cuộn trang hoặc phát một video/reel trên Facebook để tiện ích bắt link tự động." 
            : "Bạn có thể mở facebook.com hoặc dán link video/reel vào tab 'Tải qua Link' bên trên."}
        </span>
      </div>
    `;
  }

  function triggerDownload(videoInfo, quality = "HD") {
    statusText.textContent = `Đang xử lý ${quality}...`;

    const targetStream = quality === "HD"
      ? (videoInfo.hdUrl || videoInfo.sdUrl || videoInfo.url)
      : (videoInfo.sdUrl || videoInfo.hdUrl || videoInfo.url);

    const isDashSeparate = Boolean(
      videoInfo.isDashSeparate ||
      (videoInfo.audioUrl && targetStream && videoInfo.audioUrl !== targetStream)
    );

    chrome.runtime.sendMessage(
      {
        action: "DOWNLOAD_FILE",
        payload: {
          url: targetStream && !targetStream.startsWith("blob:") ? targetStream : null,
          audioUrl: videoInfo.audioUrl || null,
          isDashSeparate: isDashSeparate,
          isDash: Boolean(videoInfo.isDash),
          isProgressive: Boolean(videoInfo.isProgressive),
          progressiveHdUrl: videoInfo.progressiveHdUrl || null,
          progressiveSdUrl: videoInfo.progressiveSdUrl || null,
          postUrl: videoInfo.postLink,
          tabId: activeTab?.id,
          type: videoInfo.type || "video",
          title: videoInfo.title || "fb_video",
          quality: quality,
          // Round-9 B001: identity of THE video the user clicked. The network
          // capture fallback may only correlate against THIS source, never
          // against the page-wide set of playing videos.
          selectedSource: videoInfo.elementSrc || (targetStream && !targetStream.startsWith("blob:") ? targetStream : null) || null
        }
      },
      (res) => {
        if (chrome.runtime.lastError) {
          statusText.textContent = "⚠️ Không kết nối được tiện ích. Hãy tải lại trang Facebook.";
          return;
        }
        if (res && res.success) {
          statusText.textContent = "✅ Bắt đầu tải file...";
        } else {
          statusText.textContent = `⚠️ ${res?.error || "Không tìm thấy luồng video."}`;
        }
      }
    );
  }

  function handleManualDownload(quality = "HD") {
    const rawUrl = inputVideoUrl.value.trim();
    if (!rawUrl) {
      alert("Vui lòng nhập đường link Video hoặc Reel Facebook hợp lệ!");
      inputVideoUrl.focus();
      return;
    }

    const isReel = rawUrl.includes("/reel/") || rawUrl.includes("/reels/");
    const type = isReel ? "reel" : "video";

    statusText.textContent = `Đang phân tích link ${quality}...`;
    btnDownloadHd.disabled = true;
    btnDownloadSd.disabled = true;

    chrome.runtime.sendMessage(
      {
        action: "RESOLVE_AND_DOWNLOAD",
        payload: {
          url: rawUrl,
          postUrl: rawUrl,
          tabId: activeTab?.id,
          type: type,
          title: `fb_${type}_manual`,
          quality: quality
        }
      },
      (res) => {
        btnDownloadHd.disabled = false;
        btnDownloadSd.disabled = false;

        if (res && res.success) {
          statusText.textContent = "✅ Đang tải video...";
        } else {
          statusText.textContent = `⚠️ ${res?.error || "Không phân tích được link."}`;
          window.open(rawUrl, "_blank");
        }
      }
    );
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
});
