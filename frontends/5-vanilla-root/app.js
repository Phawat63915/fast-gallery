(function () {
  'use strict';
  const state = {
    photos: [], layoutRows: [], totalGridHeight: 0, nextCursor: 0, hasMore: true, isLoading: false,
    currentPhotoIndex: -1, wheelThrottleTimer: 0,
    fps: 60, frameCount: 0, lastFpsTime: performance.now(), activeNodes: new Map(),
  };

  const API_BASE = 'http://localhost:8880';

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
    const buffer = 400;
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

  function openLightbox(index) {
    if (index < 0 || index >= state.photos.length) return;
    state.currentPhotoIndex = index;
    const photo = state.photos[index];
    lightboxImg.src = (photo.original_url || photo.micro_url).startsWith('http') ? (photo.original_url || photo.micro_url) : `${API_BASE}${photo.original_url || photo.micro_url}`;
    lightboxCounter.textContent = `${index + 1} / ${state.photos.length}`;
    if (exifTitle) exifTitle.textContent = photo.title;
    if (exifDate) exifDate.textContent = new Date(photo.created_at).toLocaleString('th-TH');
    lightboxModal.classList.remove('hidden');
  }

  function closeLightbox() { lightboxModal.classList.add('hidden'); lightboxImg.src = ''; state.currentPhotoIndex = -1; }
  function navigate(dir) {
    if (state.currentPhotoIndex < 0) return;
    let next = state.currentPhotoIndex + dir;
    if (next < 0) next = state.photos.length - 1;
    if (next >= state.photos.length) next = 0;
    openLightbox(next);
  }

  function handleLightboxWheel(e) {
    if (lightboxModal.classList.contains('hidden')) return;
    e.preventDefault();
    const now = Date.now();
    if (now - state.wheelThrottleTimer < 100) return; // 100ms ultra-fast throttle
    state.wheelThrottleTimer = now;
    if (e.deltaY > 0 || e.deltaX > 0) navigate(1);
    else if (e.deltaY < 0 || e.deltaX < 0) navigate(-1);
  }

  function setupEventListeners() {
    scrollContainer.addEventListener('scroll', () => requestAnimationFrame(renderVirtualGrid));
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
    btnUploadTrigger.addEventListener('click', () => uploadModal.classList.remove('hidden'));
    btnCloseUpload.addEventListener('click', () => uploadModal.classList.add('hidden'));
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
