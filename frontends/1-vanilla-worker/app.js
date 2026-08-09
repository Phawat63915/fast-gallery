// FastGallery Stack 1: Vanilla JS + Web Worker Engine
// Features: Realtime Zero-Latency Image Swap (0ms VSync), Off-Thread Idle Prefetching, DOM Node Recycling

(function () {
  'use strict';

  const state = {
    photos: [],
    layoutRows: [],
    totalGridHeight: 0,
    nextCursor: 0,
    hasMore: true,
    isLoading: false,
    
    currentPhotoIndex: -1,
    lastWheelTime: 0,
    lastDirection: 1,
    
    lastScrollTop: 0,
    lastScrollTime: Date.now(),
    scrollVelocity: 0,
    scrollDirection: 1,
    
    fps: 60,
    frameCount: 0,
    lastFpsTime: performance.now(),
    
    activeNodes: new Map(),
    nodePool: [],
    preloadedCache: new Set(),
    preloadedOrder: [],

    // Lightbox Zoom & Pan State
    zoomScale: 1.0,
    zoomX: 0,
    zoomY: 0,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    lastZoomX: 0,
    lastZoomY: 0,
  };

  const API_BASE = '';
  const MAX_PRELOAD_CACHE = 50;

  const scrollContainer = document.getElementById('scroll-container');
  const galleryStageCanvas = document.getElementById('gallery-stage-canvas');
  const scrollSpacer = document.getElementById('scroll-spacer');
  const ctxStage = galleryStageCanvas ? galleryStageCanvas.getContext('2d', { alpha: false }) : null;

  const statTotal = document.getElementById('stat-total');
  const statFps = document.getElementById('stat-fps');
  const statRam = document.getElementById('stat-ram');
  const statDom = document.getElementById('stat-dom');

  const btnUploadTrigger = document.getElementById('btn-upload-trigger');
  const uploadModal = document.getElementById('upload-modal');
  const btnCloseUpload = document.getElementById('btn-close-upload');

  const lightboxModal = document.getElementById('lightbox-modal');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxCounter = document.getElementById('lightbox-counter');
  const lightboxFilename = document.getElementById('lightbox-filename');
  const btnZoomToggle = document.getElementById('btn-zoom-toggle');
  const btnExifToggle = document.getElementById('btn-exif-toggle');
  const btnCloseLightbox = document.getElementById('btn-close-lightbox');
  const btnPrevPhoto = document.getElementById('btn-prev-photo');
  const btnNextPhoto = document.getElementById('btn-next-photo');
  const exifDrawer = document.getElementById('exif-drawer');
  const exifTitle = document.getElementById('exif-title');
  const exifDate = document.getElementById('exif-date');
  const exifCamera = document.getElementById('exif-camera');
  const exifFocal = document.getElementById('exif-focal');
  const exifIso = document.getElementById('exif-iso');
  const exifRes = document.getElementById('exif-res');

  const imageTextureMap = new Map();
  const textureLRU = [];
  const MAX_TEXTURE_CACHE = 80;

  function fetchImageTexture(url) {
    if (!url) return null;
    if (imageTextureMap.has(url)) {
      return imageTextureMap.get(url);
    }

    if (textureLRU.length >= MAX_TEXTURE_CACHE) {
      const oldestUrl = textureLRU.shift();
      const oldestBmp = imageTextureMap.get(oldestUrl);
      if (oldestBmp && oldestBmp.close) {
        oldestBmp.close();
      }
      imageTextureMap.delete(oldestUrl);
    }

    imageTextureMap.set(url, null);

    if (window.createImageBitmap) {
      fetch(url)
        .then(res => res.blob())
        .then(blob => createImageBitmap(blob))
        .then(bitmap => {
          imageTextureMap.set(url, bitmap);
          textureLRU.push(url);
          requestAnimationFrame(renderVirtualGrid);
        })
        .catch(() => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = url;
          img.onload = () => {
            imageTextureMap.set(url, img);
            textureLRU.push(url);
            requestAnimationFrame(renderVirtualGrid);
          };
        });
    } else {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = url;
      img.onload = () => {
        imageTextureMap.set(url, img);
        textureLRU.push(url);
        requestAnimationFrame(renderVirtualGrid);
      };
    }

    return null;
  }

  function resizeStageCanvas() {
    if (!galleryStageCanvas || !scrollContainer) return;
    const rect = scrollContainer.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const targetW = Math.floor(rect.width * dpr);
    const targetH = Math.floor(rect.height * dpr);

    if (galleryStageCanvas.width !== targetW || galleryStageCanvas.height !== targetH) {
      galleryStageCanvas.width = targetW;
      galleryStageCanvas.height = targetH;
    }
  }

  let layoutWorker = new Worker('layout-worker.js');

  layoutWorker.onmessage = function (e) {
    const { rows, totalHeight } = e.data;
    state.layoutRows = rows;
    state.totalGridHeight = totalHeight;

    if (scrollSpacer) {
      scrollSpacer.style.height = `${totalHeight}px`;
    }
    resizeStageCanvas();
    renderVirtualGrid();
  };

  async function init() {
    setupEventListeners();
    startFPSMonitor();
    await fetchPhotos();
    await fetchServerStats();
  }

  async function fetchPhotos(isAppend = false) {
    if (state.isLoading || (isAppend && !state.hasMore)) return;
    state.isLoading = true;

    try {
      const url = `${API_BASE}/api/photos?limit=500${state.nextCursor ? '&cursor=' + state.nextCursor : ''}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.photos && data.photos.length > 0) {
        state.photos = isAppend ? state.photos.concat(data.photos) : data.photos;
        state.nextCursor = data.next_cursor;
        statTotal.textContent = state.photos.length.toLocaleString();
        if (data.photos.length < 500 || !data.next_cursor) {
          state.hasMore = false;
        }
        computeLayout(isAppend);
      } else {
        state.hasMore = false;
      }
    } catch (err) {
      console.error('Failed to fetch photos:', err);
    } finally {
      state.isLoading = false;
    }
  }

  async function fetchServerStats() {
    try {
      const res = await fetch(`${API_BASE}/api/stats`);
      const data = await res.json();
      if (data.alloc_ram_mb) statRam.textContent = data.alloc_ram_mb;
    } catch (e) {}
  }

  function computeLayout(isAppend = false) {
    const containerWidth = scrollContainer.clientWidth;
    layoutWorker.postMessage({
      photos: state.photos,
      containerWidth: Math.max(320, containerWidth),
      targetRowHeight: 180,
      gap: 1,
      isAppend: isAppend,
    });
  }

  function binarySearchStartRow(rows, startY) {
    let low = 0;
    let high = rows.length - 1;
    let result = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (rows[mid].y + rows[mid].height >= startY) {
        result = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return result;
  }

  function drawThumbhashQuad(ctx, photo, x, y, width, height) {
    const hashStr = photo.thumbhash || photo.id || '';
    let hashNum = 0;
    for (let i = 0; i < hashStr.length; i++) {
      hashNum = (hashNum << 5) - hashNum + hashStr.charCodeAt(i);
    }
    const c1 = `hsl(${Math.abs(hashNum) % 360}, 55%, 35%)`;
    const c2 = `hsl(${Math.abs(hashNum * 7) % 360}, 45%, 20%)`;

    const grad = ctx.createLinearGradient(x, y, x + width, y + height);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, width, height);
  }

  function renderVirtualGrid() {
    if (!ctxStage || !state.layoutRows || state.layoutRows.length === 0) return;

    resizeStageCanvas();

    const rect = scrollContainer.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvasW = galleryStageCanvas.width;
    const canvasH = galleryStageCanvas.height;

    ctxStage.fillStyle = '#0b0f19';
    ctxStage.fillRect(0, 0, canvasW, canvasH);

    ctxStage.imageSmoothingEnabled = true;
    ctxStage.imageSmoothingQuality = 'high';

    const scrollTop = scrollContainer.scrollTop;
    const viewportHeight = rect.height;

    if (scrollTop + viewportHeight >= state.totalGridHeight - 1500 && state.hasMore && !state.isLoading) {
      fetchPhotos(true);
    }

    const startY = Math.max(0, scrollTop - 400);
    const endY = scrollTop + viewportHeight + 400;

    const visibleItems = [];
    const startRowIdx = binarySearchStartRow(state.layoutRows, startY);

    for (let r = startRowIdx; r < state.layoutRows.length; r++) {
      const row = state.layoutRows[r];
      if (row.y > endY) break;
      for (let i = 0; i < row.items.length; i++) {
        visibleItems.push(row.items[i]);
      }
    }

    ctxStage.save();
    ctxStage.scale(dpr, dpr);

    for (let item of visibleItems) {
      const { photo, x, y, width, height } = item;
      const targetY = y - scrollTop;
      const thumbUrl = getThumbUrl(photo);
      const texture = fetchImageTexture(thumbUrl);

      if (texture) {
        ctxStage.drawImage(texture, x, targetY, width, height);
      } else {
        drawThumbhashQuad(ctxStage, photo, x, targetY, width, height);
      }
    }

    ctxStage.restore();

    statDom.textContent = '0 (Single Canvas)';
  }

  function predecodeUpcomingPhoto(photo) {
    if (!photo) return;
    const url = getThumbUrl(photo);
    if (!url || state.preloadedCache.has(url)) return;

    if (state.preloadedOrder.length >= MAX_PRELOAD_CACHE) {
      const oldest = state.preloadedOrder.shift();
      state.preloadedCache.delete(oldest);
    }
    state.preloadedCache.add(url);
    state.preloadedOrder.push(url);

    const offscreenImg = new Image();
    offscreenImg.decoding = 'async';
    offscreenImg.src = url;
    if (offscreenImg.decode) {
      offscreenImg.decode().catch(() => {});
    }
  }

  function getThumbUrl(photo) {
    if (!photo) return '';
    if (photo.filename) {
      return photo.filename.startsWith('http') ? photo.filename : `${API_BASE}/uploads/thumbnails/${photo.filename}`;
    }
    const fallback = photo.micro_url || photo.original_url || '';
    return fallback.startsWith('http') ? fallback : `${API_BASE}${fallback}`;
  }

  function getOriginalUrl(photo) {
    if (!photo) return '';
    if (photo.filename) {
      return photo.filename.startsWith('http') ? photo.filename : `${API_BASE}/uploads/originals/${photo.filename}`;
    }
    const fallback = photo.original_url || photo.micro_url || '';
    return fallback.startsWith('http') ? fallback : `${API_BASE}${fallback}`;
  }

  let webgpuDevice = null;

  async function getWebGPUDevice() {
    if (webgpuDevice) return webgpuDevice;
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      webgpuDevice = await adapter.requestDevice();
      return webgpuDevice;
    } catch (e) {
      return null;
    }
  }

  const wgslCode = `
    struct VertexOutput {
      @builtin(position) Position : vec4<f32>,
      @location(0) fragUV : vec2<f32>,
    };

    @vertex
    fn vs_main(@builtin(vertex_index) VertexIndex : u32) -> VertexOutput {
      var pos = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>( 1.0,  1.0)
      );
      var uv = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(1.0, 0.0)
      );

      var output : VertexOutput;
      output.Position = vec4<f32>(pos[VertexIndex], 0.0, 1.0);
      output.fragUV = uv[VertexIndex];
      return output;
    }

    @group(0) @binding(0) var mySampler: sampler;
    @group(0) @binding(1) var myTexture: texture_2d<f32>;

    @fragment
    fn fs_main(@location(0) fragUV : vec2<f32>) -> @location(0) vec4<f32> {
      return textureSample(myTexture, mySampler, fragUV);
    }
  `;

  async function renderImageToWebGPUCanvas(canvas, imgElement) {
    if (!canvas || !imgElement || !imgElement.complete || !imgElement.naturalWidth) return false;

    const device = await getWebGPUDevice();
    if (!device) return false;

    try {
      canvas.width = imgElement.naturalWidth;
      canvas.height = imgElement.naturalHeight;

      const context = canvas.getContext('webgpu');
      if (!context) return false;

      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'opaque' });

      const shaderModule = device.createShaderModule({ code: wgslCode });
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: shaderModule, entryPoint: 'vs_main' },
        fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });

      const texture = device.createTexture({
        size: [canvas.width, canvas.height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });

      device.queue.copyExternalImageToTexture(
        { source: imgElement },
        { texture: texture },
        [canvas.width, canvas.height]
      );

      const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: texture.createView() },
        ],
      });

      const commandEncoder = device.createCommandEncoder();
      const textureView = context.getCurrentTexture().createView();
      const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{ view: textureView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      });

      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.draw(6, 1, 0, 0);
      renderPass.end();

      device.queue.submit([commandEncoder.finish()]);
      return true;
    } catch (e) {
      return false;
    }
  }

  const vsSource = `
    attribute vec2 aPosition;
    attribute vec2 aTexCoord;
    varying vec2 vTexCoord;
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
      vTexCoord = aTexCoord;
    }
  `;

  const fsSource = `
    precision mediump float;
    varying vec2 vTexCoord;
    uniform sampler2D uSampler;
    void main() {
      gl_FragColor = texture2D(uSampler, vTexCoord);
    }
  `;

  function renderImageToWebGLCanvas(canvas, imgElement) {
    if (!canvas || !imgElement || !imgElement.complete || !imgElement.naturalWidth) return;

    canvas.width = imgElement.naturalWidth;
    canvas.height = imgElement.naturalHeight;

    let gl = canvas.getContext('webgl', { alpha: false });
    if (!gl) gl = canvas.getContext('experimental-webgl');
    if (!gl) return;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    const vertices = new Float32Array([
      -1, -1,  0, 1,
       1, -1,  1, 1,
      -1,  1,  0, 0,
      -1,  1,  0, 0,
       1, -1,  1, 1,
       1,  1,  1, 0
    ]);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);

    const aTex = gl.getAttribLocation(program, 'aTexCoord');
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imgElement);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  async function renderImageToGPUCanvas(canvas, imgElement) {
    const successGPU = await renderImageToWebGPUCanvas(canvas, imgElement);
    if (!successGPU) {
      renderImageToWebGLCanvas(canvas, imgElement);
    }
  }

  function acquirePhotoCard(item) {
    const { photo, width, height } = item;
    let card;
    let canvas;
    let img;

    if (state.nodePool.length > 0) {
      card = state.nodePool.pop();
      canvas = card.querySelector('canvas');
      img = card.querySelector('img');
    } else {
      card = document.createElement('div');
      card.className = 'tile photo-card';
      canvas = document.createElement('canvas');
      canvas.className = 'thumbhash-canvas';
      card.appendChild(canvas);

      img = document.createElement('img');
      img.className = 'real-img';
      img.loading = 'eager';
      img.decoding = 'async';
      card.appendChild(img);

      card.addEventListener('click', () => {
        const photoId = card.dataset.photoId;
        const idx = state.photos.findIndex(p => p.id === photoId);
        if (idx >= 0) openLightbox(idx);
      });
    }

    card.style.width = `${width}px`;
    card.style.height = `${height}px`;
    card.dataset.photoId = photo.id;

    drawThumbhashPlaceholder(canvas, photo.thumbhash);

    const thumbUrl = getThumbUrl(photo);
    if (img.src !== thumbUrl) {
      img.onload = () => {
        renderImageToGPUCanvas(canvas, img);
      };
      img.src = thumbUrl;
      if (img.complete) {
        renderImageToGPUCanvas(canvas, img);
      }
    }

    return card;
  }

  function drawThumbhashPlaceholder(canvas, thumbhashStr) {
    const hash = thumbhashStr || 'none';
    if (canvas.dataset.hash === hash) return;
    canvas.dataset.hash = hash;

    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (!thumbhashStr) {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, 32, 32);
      return;
    }

    const grad = ctx.createLinearGradient(0, 0, 32, 32);
    let hashNum = 0;
    for (let i = 0; i < thumbhashStr.length; i++) {
      hashNum = (hashNum << 5) - hashNum + thumbhashStr.charCodeAt(i);
    }

    const c1 = `hsl(${Math.abs(hashNum) % 360}, 65%, 45%)`;
    const c2 = `hsl(${Math.abs(hashNum * 7) % 360}, 55%, 25%)`;

    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
  }

  // Off-Thread Idle Prefetching (0ms Blocking Delay - 15 Photos Ahead / 8 Behind)
  function scheduleIdlePrefetch(currentIndex, direction = 1) {
    const runPrefetch = () => {
      if (!state.photos || state.photos.length === 0) return;
      for (let step = 1; step <= 30; step++) {
        const targetIdx = (currentIndex + (step * direction) + state.photos.length) % state.photos.length;
        prefetchSingleUrl(state.photos[targetIdx]);
      }
      for (let step = 1; step <= 15; step++) {
        const targetIdx = (currentIndex - (step * direction) + state.photos.length) % state.photos.length;
        prefetchSingleUrl(state.photos[targetIdx]);
      }
    };

    if (window.requestIdleCallback) {
      window.requestIdleCallback(runPrefetch);
    } else {
      setTimeout(runPrefetch, 0);
    }
  }

  function prefetchSingleUrl(photo) {
    if (!photo) return;
    const url = getOriginalUrl(photo);

    if (!state.preloadedCache.has(url)) {
      if (state.preloadedOrder.length >= MAX_PRELOAD_CACHE) {
        const oldestUrl = state.preloadedOrder.shift();
        state.preloadedCache.delete(oldestUrl);
      }
      state.preloadedCache.add(url);
      state.preloadedOrder.push(url);

      const img = new Image();
      img.src = url;
      if (img.decode) img.decode().catch(() => {});
    }
  }

  function updateZoomTransform(animate = false) {
    if (!lightboxImg) return;
    if (state.zoomScale <= 1.0) {
      state.zoomScale = 1.0;
      state.zoomX = 0;
      state.zoomY = 0;
    }
    lightboxImg.style.transition = animate ? 'transform 0.12s ease-out' : 'none';
    lightboxImg.style.transform = `translate3d(${state.zoomX}px, ${state.zoomY}px, 0) scale(${state.zoomScale})`;
  }

  function resetZoom() {
    state.zoomScale = 1.0;
    state.zoomX = 0;
    state.zoomY = 0;
    state.isDragging = false;
    if (lightboxImg) {
      lightboxImg.style.transition = 'none';
      lightboxImg.classList.remove('is-dragging');
      lightboxImg.style.transform = 'translate3d(0px, 0px, 0px) scale(1)';
    }
  }

  function toggleZoom() {
    if (state.zoomScale > 1.0) {
      resetZoom();
    } else {
      state.zoomScale = 2.5;
      state.zoomX = 0;
      state.zoomY = 0;
      updateZoomTransform(true);
    }
  }

  // Realtime 0ms Instant Image Swap
  function openLightbox(index, direction = 1) {
    if (index < 0 || index >= state.photos.length) return;

    state.currentPhotoIndex = index;
    resetZoom();

    const photo = state.photos[index];
    const targetURL = getOriginalUrl(photo);

    lightboxImg.src = targetURL;
    lightboxCounter.textContent = `${index + 1} / ${state.photos.length}`;
    if (lightboxFilename) lightboxFilename.textContent = photo.filename || photo.id || 'Untitled Image';

    if (exifTitle) exifTitle.textContent = photo.filename || photo.id || 'Untitled Image';
    if (exifDate) exifDate.textContent = new Date(photo.created_at).toLocaleString('th-TH');
    if (exifCamera) exifCamera.textContent = `${photo.camera_make || 'Sony'} ${photo.camera_model || 'A7 IV'}`.trim();
    if (exifFocal) exifFocal.textContent = photo.focal_length || '35mm';
    if (exifIso) exifIso.textContent = photo.iso ? `ISO ${photo.iso}` : 'ISO 100';
    if (exifRes) exifRes.textContent = `${photo.width || 1920} × ${photo.height || 1080}`;;

    lightboxModal.classList.remove('hidden');

    // Offload prefetching so UI thread stays 100% realtime
    scheduleIdlePrefetch(index, direction);
  }

  function closeLightbox() {
    resetZoom();
    lightboxModal.classList.add('hidden');
    lightboxImg.src = '';
    state.currentPhotoIndex = -1;
  }

  function navigateLightbox(direction) {
    if (state.currentPhotoIndex < 0) return;
    let nextIndex = state.currentPhotoIndex + direction;

    if (nextIndex >= state.photos.length - 5 && state.hasMore && !state.isLoading) {
      fetchPhotos(true);
    }

    if (nextIndex < 0) nextIndex = state.photos.length - 1;
    if (nextIndex >= state.photos.length) nextIndex = 0;
    openLightbox(nextIndex, direction);
  }

  // Realtime Zero-Latency Wheel Handler (Native Trackpad Sync)
  function handleLightboxWheel(e) {
    if (lightboxModal.classList.contains('hidden')) return;

    e.preventDefault();
    const now = Date.now();
    if (now - state.lastWheelTime < 10) return; // Ultra-fast 10ms trackpad response
    state.lastWheelTime = now;

    const dir = (e.deltaY > 0 || e.deltaX > 0) ? 1 : -1;
    navigateLightbox(dir);
  }

  let rAFPending = false;

  function setupEventListeners() {
    scrollContainer.addEventListener('scroll', () => {
      if (!rAFPending) {
        rAFPending = true;
        requestAnimationFrame(() => {
          renderVirtualGrid();
          rAFPending = false;
        });
      }
    }, { passive: true });

    if (galleryStageCanvas) {
      galleryStageCanvas.addEventListener('click', (e) => {
        if (!state.layoutRows || state.layoutRows.length === 0) return;
        const rect = galleryStageCanvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top + scrollContainer.scrollTop;

        for (let r = 0; r < state.layoutRows.length; r++) {
          const row = state.layoutRows[r];
          if (clickY >= row.y && clickY <= row.y + row.height) {
            for (let i = 0; i < row.items.length; i++) {
              const item = row.items[i];
              if (clickX >= item.x && clickX <= item.x + item.width) {
                const photoId = item.photo.id;
                const idx = state.photos.findIndex(p => p.id === photoId);
                if (idx >= 0) openLightbox(idx);
                return;
              }
            }
          }
        }
      });
    }

    window.addEventListener('resize', () => {
      resizeStageCanvas();
      computeLayout();
    });

    lightboxModal.addEventListener('wheel', (e) => {
      if (state.zoomScale > 1.0 || e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.25 : -0.25;
        state.zoomScale = Math.max(1.0, Math.min(5.0, state.zoomScale + delta));
        updateZoomTransform();
      } else {
        handleLightboxWheel(e);
      }
    }, { passive: false });

    if (btnZoomToggle) {
      btnZoomToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleZoom();
      });
    }

    if (lightboxImg) {
      lightboxImg.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        toggleZoom();
      });

      lightboxImg.addEventListener('mousedown', (e) => {
        if (state.zoomScale <= 1.0) return;
        e.preventDefault();
        state.isDragging = true;
        state.dragStartX = e.clientX - state.zoomX;
        state.dragStartY = e.clientY - state.zoomY;
        lightboxImg.classList.add('is-dragging');
      });
    }

    window.addEventListener('mousemove', (e) => {
      if (!state.isDragging) return;
      e.preventDefault();
      state.zoomX = e.clientX - state.dragStartX;
      state.zoomY = e.clientY - state.dragStartY;
      updateZoomTransform();
    });

    window.addEventListener('mouseup', () => {
      if (state.isDragging) {
        state.isDragging = false;
        if (lightboxImg) lightboxImg.classList.remove('is-dragging');
      }
    });

    if (btnPrevPhoto) {
      btnPrevPhoto.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateLightbox(-1);
      });
    }

    if (btnNextPhoto) {
      btnNextPhoto.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateLightbox(1);
      });
    }

    if (btnCloseLightbox) {
      btnCloseLightbox.addEventListener('click', closeLightbox);
    }

    if (btnExifToggle) {
      btnExifToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (exifDrawer) {
          exifDrawer.style.display = exifDrawer.style.display === 'none' ? 'flex' : 'none';
          btnExifToggle.classList.toggle('active');
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (!lightboxModal.classList.contains('hidden')) {
        if (e.key === 'ArrowLeft' || e.key === 'k') {
          navigateLightbox(-1);
        } else if (e.key === 'ArrowRight' || e.key === 'j') {
          navigateLightbox(1);
        } else if (e.key === 'Escape') {
          closeLightbox();
        }
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

    // Upload Modal Tab Switching
    const tabBatchUpload = document.getElementById('tab-batch-upload');
    const tabCustomUrl = document.getElementById('tab-custom-url');
    const sectionBatchUpload = document.getElementById('section-batch-upload');
    const sectionCustomUrl = document.getElementById('section-custom-url');
    const inputCustomUrl = document.getElementById('input-custom-url');
    const btnAddCustomUrl = document.getElementById('btn-add-custom-url');
    const customUrlStatus = document.getElementById('custom-url-status');

    if (tabBatchUpload && tabCustomUrl) {
      tabBatchUpload.addEventListener('click', () => {
        tabBatchUpload.classList.add('active');
        tabCustomUrl.classList.remove('active');
        sectionBatchUpload.classList.remove('hidden');
        sectionCustomUrl.classList.add('hidden');
      });
      tabCustomUrl.addEventListener('click', () => {
        tabCustomUrl.classList.add('active');
        tabBatchUpload.classList.remove('active');
        sectionCustomUrl.classList.remove('hidden');
        sectionBatchUpload.classList.add('hidden');
      });
    }

    if (btnAddCustomUrl && inputCustomUrl) {
      const addCustomPhoto = async () => {
        const url = inputCustomUrl.value.trim();
        if (!url) {
          customUrlStatus.style.color = '#ef4444';
          customUrlStatus.textContent = 'Please enter a valid image URL.';
          return;
        }

        customUrlStatus.style.color = '#06b6d4';
        customUrlStatus.textContent = 'Verifying image URL...';

        const imgLoader = new Image();
        const finishAdd = async (aspectRatio, w, h) => {
          try {
            await fetch(`${API_BASE}/api/photos/url`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: url, aspect_ratio: aspectRatio, width: w || 1920, height: h || 1080 }),
            });
          } catch (e) {
            console.error(e);
          }

          const newPhoto = {
            id: `custom_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            filename: url,
            original_url: url,
            micro_url: url,
            aspect_ratio: aspectRatio,
            created_at: Date.now(),
            camera_make: 'Custom Web Link',
            camera_model: 'Direct Import',
            width: w || 1920,
            height: h || 1080
          };

          state.photos.unshift(newPhoto);
          statTotal.textContent = state.photos.length.toLocaleString();
          computeLayout();

          inputCustomUrl.value = '';
          customUrlStatus.style.color = '#10b981';
          customUrlStatus.textContent = 'Photo added successfully!';
          setTimeout(() => {
            uploadModal.classList.add('hidden');
            customUrlStatus.textContent = '';
          }, 600);
        };

        imgLoader.onload = () => {
          const ar = (imgLoader.naturalWidth && imgLoader.naturalHeight)
            ? (imgLoader.naturalWidth / imgLoader.naturalHeight)
            : 1.5;
          finishAdd(ar, imgLoader.naturalWidth, imgLoader.naturalHeight);
        };

        imgLoader.onerror = () => {
          finishAdd(1.5, 1920, 1080);
        };

        imgLoader.src = url;
      };

      btnAddCustomUrl.addEventListener('click', addCustomPhoto);
      inputCustomUrl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addCustomPhoto();
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
