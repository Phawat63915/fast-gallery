(function () {
  'use strict';
  const state = {
    photos: [], layoutRows: [], totalGridHeight: 0, nextCursor: 0, hasMore: true, isLoading: false,
    currentPhotoIndex: -1, lastWheelTime: 0,
    fps: 60, frameCount: 0, lastFpsTime: performance.now(), activeNodes: new Map(),
    preloadedCache: new Set(), preloadedOrder: [],
  };

  const API_BASE = 'http://localhost:8880';
  const MAX_PRELOAD_CACHE = 50;

  const scrollContainer = document.getElementById('scroll-container');
  const virtualGrid = document.getElementById('virtual-grid');
  const statTotal = document.getElementById('stat-total');
  const statFps = document.getElementById('stat-fps');
  const statRam = document.getElementById('stat-ram');
  const statDom = document.getElementById('stat-dom');

  const btnUploadTrigger = document.getElementById('btn-upload-trigger');
  const uploadModal = document.getElementById('upload-modal');
  const btnCloseUpload = document.getElementById('btn-close-upload');
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  const lightboxModal = document.getElementById('lightbox-modal');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxCounter = document.getElementById('lightbox-counter');
  const btnCloseLightbox = document.getElementById('btn-close-lightbox');
  const btnPrevPhoto = document.getElementById('btn-prev-photo');
  const btnNextPhoto = document.getElementById('btn-next-photo');
  const exifTitle = document.getElementById('exif-title');
  const exifDate = document.getElementById('exif-date');

  let layoutWorker = new Worker('layout-worker.js');
  layoutWorker.onmessage = function (e) {
    const { rows, totalHeight } = e.data;
    state.layoutRows = rows;
    state.totalGridHeight = totalHeight;
    virtualGrid.style.height = `${totalHeight}px`;
    renderVirtualGrid();
  };

  async function init() {
    setupEventListeners();
    startFPSMonitor();
    await fetchPhotos();
    await fetchServerStats();
  }

  async function fetchPhotos(isAppend = false) {
    if (state.isLoading || (!state.hasMore && isAppend)) return;
    state.isLoading = true;
    try {
      const url = `${API_BASE}/api/photos?limit=200${state.nextCursor ? '&cursor=' + state.nextCursor : ''}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.photos && data.photos.length > 0) {
        state.photos = isAppend ? state.photos.concat(data.photos) : data.photos;
        state.nextCursor = data.next_cursor;
        statTotal.textContent = state.photos.length.toLocaleString();
        computeLayout();
      } else { state.hasMore = false; }
    } catch (err) { console.error('Failed to fetch photos:', err); }
    finally { state.isLoading = false; }
  }

  async function fetchServerStats() {
    try {
      const res = await fetch(`${API_BASE}/api/stats`);
      const data = await res.json();
      if (data.alloc_ram_mb) statRam.textContent = data.alloc_ram_mb;
    } catch (e) {}
  }

  function computeLayout() {
    const containerWidth = scrollContainer.clientWidth - 48;
    layoutWorker.postMessage({ photos: state.photos, containerWidth: Math.max(320, containerWidth), targetRowHeight: 220, gap: 12 });
  }

  function renderVirtualGrid() {
    if (!state.layoutRows || state.layoutRows.length === 0) return;
    const scrollTop = scrollContainer.scrollTop;
    const viewportHeight = scrollContainer.clientHeight;
    const buffer = 2000;
    const startY = Math.max(0, scrollTop - buffer);
    const endY = scrollTop + viewportHeight + buffer;
    const visibleItems = [];

    for (let r = 0; r < state.layoutRows.length; r++) {
      const row = state.layoutRows[r];
      if (row.y + row.height >= startY && row.y <= endY) {
        for (let i = 0; i < row.items.length; i++) visibleItems.push(row.items[i]);
      }
    }

    const currentVisibleKeys = new Set(visibleItems.map(item => item.photo.id));
    for (let [id, node] of state.activeNodes.entries()) {
      if (!currentVisibleKeys.has(id)) { node.remove(); state.activeNodes.delete(id); }
    }

    for (let item of visibleItems) {
      const { photo, x, y, width, height } = item;
      if (state.activeNodes.has(photo.id)) {
        const node = state.activeNodes.get(photo.id);
        node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      } else {
        const card = createPhotoCard(item);
        card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        virtualGrid.appendChild(card);
        state.activeNodes.set(photo.id, card);
      }
    }
    statDom.textContent = state.activeNodes.size;
    if (scrollTop + viewportHeight >= state.totalGridHeight - 800 && !state.isLoading && state.hasMore) fetchPhotos(true);
  }

  function createPhotoCard(item) {
    const { photo, width, height } = item;
    const card = document.createElement('div');
    card.className = 'photo-card';
    card.style.width = `${width}px`;
    card.style.height = `${height}px`;

    const canvas = document.createElement('canvas');
    canvas.className = 'thumbhash-canvas';
    drawThumbhashPlaceholder(canvas, photo.thumbhash);
    card.appendChild(canvas);

    const img = document.createElement('img');
    img.className = 'real-img';
    img.loading = 'lazy';
    img.src = photo.micro_url.startsWith('http') ? photo.micro_url : `${API_BASE}${photo.micro_url}`;
    img.onload = function () { img.classList.add('loaded'); };
    card.appendChild(img);

    card.addEventListener('click', () => {
      const idx = state.photos.findIndex(p => p.id === photo.id);
      openLightbox(idx >= 0 ? idx : 0);
    });
    return card;
  }

  function drawThumbhashPlaceholder(canvas, thumbhashStr) {
    canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const grad = ctx.createLinearGradient(0, 0, 32, 32);
    let hashNum = 0;
    for (let i = 0; i < (thumbhashStr || '').length; i++) hashNum = (hashNum << 5) - hashNum + thumbhashStr.charCodeAt(i);
    grad.addColorStop(0, `hsl(${Math.abs(hashNum) % 360}, 65%, 45%)`);
    grad.addColorStop(1, `hsl(${Math.abs(hashNum * 7) % 360}, 55%, 25%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
  }

  function scheduleIdlePrefetch(currentIndex, direction = 1) {
    const runPrefetch = () => {
      if (!state.photos || state.photos.length === 0) return;
      for (let step = 1; step <= 5; step++) {
        const targetIdx = (currentIndex + (step * direction) + state.photos.length) % state.photos.length;
        prefetchSingleUrl(state.photos[targetIdx]);
      }
      for (let step = 1; step <= 2; step++) {
        const targetIdx = (currentIndex - (step * direction) + state.photos.length) % state.photos.length;
        prefetchSingleUrl(state.photos[targetIdx]);
      }
    };
    if (window.requestIdleCallback) window.requestIdleCallback(runPrefetch);
    else setTimeout(runPrefetch, 0);
  }

  function prefetchSingleUrl(photo) {
    if (!photo) return;
    const url = (photo.original_url || photo.micro_url).startsWith('http')
      ? (photo.original_url || photo.micro_url)
      : `${API_BASE}${photo.original_url || photo.micro_url}`;
    if (!state.preloadedCache.has(url)) {
      if (state.preloadedOrder.length >= MAX_PRELOAD_CACHE) {
        const oldest = state.preloadedOrder.shift();
        state.preloadedCache.delete(oldest);
      }
      state.preloadedCache.add(url);
      state.preloadedOrder.push(url);
      const img = new Image();
      img.src = url;
      if (img.decode) {
        img.decode().catch(() => {});
      }
    }
  }

  function openLightbox(index, direction = 1) {
    if (index < 0 || index >= state.photos.length) return;
    state.currentPhotoIndex = index;
    const photo = state.photos[index];
    lightboxImg.src = (photo.original_url || photo.micro_url).startsWith('http') ? (photo.original_url || photo.micro_url) : `${API_BASE}${photo.original_url || photo.micro_url}`;
    lightboxCounter.textContent = `${index + 1} / ${state.photos.length}`;
    if (exifTitle) exifTitle.textContent = photo.title;
    if (exifDate) exifDate.textContent = new Date(photo.created_at).toLocaleString('th-TH');
    lightboxModal.classList.remove('hidden');
    scheduleIdlePrefetch(index, direction);
  }

  function closeLightbox() { lightboxModal.classList.add('hidden'); lightboxImg.src = ''; state.currentPhotoIndex = -1; }
  function navigate(dir) {
    if (state.currentPhotoIndex < 0) return;
    let next = state.currentPhotoIndex + dir;
    if (next < 0) next = state.photos.length - 1;
    if (next >= state.photos.length) next = 0;
    openLightbox(next, dir);
  }

  function handleLightboxWheel(e) {
    if (lightboxModal.classList.contains('hidden')) return;
    e.preventDefault();
    const now = Date.now();
    if (now - state.lastWheelTime < 10) return;
    state.lastWheelTime = now;
    const dir = (e.deltaY > 0 || e.deltaX > 0) ? 1 : -1;
    navigate(dir);
  }

  let isScrollingTimer = null;
  let lastScrollTop = 0;
  let lastScrollTime = performance.now();

  function setupEventListeners() {
    scrollContainer.addEventListener('scroll', () => {
      const now = performance.now();
      const dt = now - lastScrollTime;
      let velocity = 0;
      if (dt > 0) {
        velocity = Math.abs(scrollContainer.scrollTop - lastScrollTop) / dt;
      }
      lastScrollTop = scrollContainer.scrollTop;
      lastScrollTime = now;

      if (!scrollContainer.classList.contains('is-scrolling')) {
        scrollContainer.classList.add('is-scrolling');
      }

      if (velocity > 2.0) {
        if (!scrollContainer.classList.contains('fast-scrolling')) {
          scrollContainer.classList.add('fast-scrolling');
        }
      } else {
        if (scrollContainer.classList.contains('fast-scrolling')) {
          scrollContainer.classList.remove('fast-scrolling');
        }
      }

      clearTimeout(isScrollingTimer);
      isScrollingTimer = setTimeout(() => {
        scrollContainer.classList.remove('is-scrolling');
        scrollContainer.classList.remove('fast-scrolling');
      }, 150);

      requestAnimationFrame(renderVirtualGrid);
    }, { passive: true });
    window.addEventListener('resize', computeLayout);
    lightboxModal.addEventListener('wheel', handleLightboxWheel, { passive: false });
    btnPrevPhoto.addEventListener('click', (e) => { e.stopPropagation(); navigate(-1); });
    btnNextPhoto.addEventListener('click', (e) => { e.stopPropagation(); navigate(1); });
    btnCloseLightbox.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => {
      if (!lightboxModal.classList.contains('hidden')) {
        if (e.key === 'ArrowLeft' || e.key === 'k') navigate(-1);
        else if (e.key === 'ArrowRight' || e.key === 'j') navigate(1);
        else if (e.key === 'Escape') closeLightbox();
      }
    });
    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const uploadProgressBox = document.getElementById('upload-progress-box');
    const uploadProgressText = document.getElementById('upload-progress-text');
    const uploadProgressBar = document.getElementById('upload-progress-bar');
    const uploadStatusSub = document.getElementById('upload-status-sub');

    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        dropZone.style.display = 'none';
        uploadProgressBox.style.display = 'block';

        const fileList = Array.from(files);
        const total = fileList.length;
        const BATCH_SIZE = 10;
        const CONCURRENCY = 6;

        const batches = [];
        for (let i = 0; i < fileList.length; i += BATCH_SIZE) {
          batches.push(fileList.slice(i, i + BATCH_SIZE));
        }

        let completedCount = 0;
        let batchIndex = 0;

        async function worker() {
          while (batchIndex < batches.length) {
            const currentBatchIdx = batchIndex++;
            const chunk = batches[currentBatchIdx];

            const formData = new FormData();
            for (const file of chunk) {
              formData.append('photos', file);
            }

            try {
              const res = await fetch(`${API_BASE}/api/upload`, {
                method: 'POST',
                body: formData,
              });
              const data = await res.json();
              if (data.success) {
                completedCount += chunk.length;
                const percent = Math.round((completedCount / total) * 100);
                uploadProgressText.textContent = `${completedCount.toLocaleString()} / ${total.toLocaleString()} (${percent}%)`;
                uploadProgressBar.style.width = `${percent}%`;
                uploadStatusSub.textContent = `Streaming parallel batches... Completed ${completedCount.toLocaleString()} / ${total.toLocaleString()} files (${percent}%)`;
              }
            } catch (err) {
              console.error('Batch upload error:', err);
            }
          }
        }

        const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker());
        await Promise.all(workers);

        uploadStatusSub.textContent = `Upload Complete! Indexed ${total.toLocaleString()} photos across 6 streams!`;
        setTimeout(async () => {
          uploadProgressBox.style.display = 'none';
          dropZone.style.display = 'block';
          uploadModal.classList.add('hidden');
          await fetchPhotos();
          await fetchServerStats();
        }, 800);
      });
    }

    if (btnUploadTrigger) {
      btnUploadTrigger.addEventListener('click', () => {
        uploadModal.classList.remove('hidden');
      });
    }

    if (btnCloseUpload) {
      btnCloseUpload.addEventListener('click', () => {
        uploadModal.classList.add('hidden');
      });
    }
  }

  function startFPSMonitor() {
    function loop(now) {
      state.frameCount++;
      if (now >= state.lastFpsTime + 1000) {
        state.fps = Math.round((state.frameCount * 1000) / (now - state.lastFpsTime));
        statFps.textContent = state.fps;
        state.frameCount = 0;
        state.lastFpsTime = now;
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
