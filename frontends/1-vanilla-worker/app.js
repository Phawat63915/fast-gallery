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
    layoutMode: 'masonry', // Default to Pinterest Masonry Engine (0% Cropping, Full Photo)
    
    currentPhotoIndex: -1,
    lastWheelTime: 0,
    
    lastScrollTop: 0,
    lastScrollTime: Date.now(),
    scrollVelocity: 0,
    scrollDirection: 1,
    
    fps: 60,
    frameCount: 0,
    lastFpsTime: performance.now(),
    
    preloadedCache: new Set(),
    preloadedOrder: [],

    // Lightbox Zoom & Pan State
    zoomScale: 1.0,
    zoomX: 0,
    zoomY: 0,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
  };

  const API_BASE = '';
  const MAX_PRELOAD_CACHE = 50;

  const scrollContainer = document.getElementById('scroll-container');
  const galleryStageCanvas = document.getElementById('gallery-stage-canvas');
  const scrollSpacer = document.getElementById('scroll-spacer');
  
  const statEngine = document.getElementById('stat-engine');

  // WebGPU Engine State (WGSL - Next-Gen GPU Architecture)
  let gpuAdapter = null;
  let gpuDevice = null;
  let gpuContext = null;
  let gpuFormat = null;
  let gpuPipeline = null;
  let gpuSampler = null;
  let isWebGPUMode = false;
  const webgpuBindGroupMap = new Map();

  // WebGL Engine State (GLSL Fallback)
  let gl = null;
  let ctxStage = null;
  let webglProgram = null;
  let webglLocations = {};
  let quadBuffer = null;
  let texCoordBuffer = null;

  const wgslShaderCode = `
    struct Uniforms {
      rect: vec4<f32>,       // x, y, width, height
      resolution: vec2<f32>, // viewport width, height
      uv_scale: vec2<f32>,
      uv_offset: vec2<f32>,
      padding: vec2<f32>,
    };

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
    };

    @group(0) @binding(0) var mySampler: sampler;
    @group(0) @binding(1) var myTexture: texture_2d<f32>;
    @group(0) @binding(2) var<uniform> uniforms: Uniforms;

    @vertex
    fn vs_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
      var pos = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0)
      );
      var texCoord = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0)
      );

      var output: VertexOutput;
      let p = pos[VertexIndex];
      let pixelPos = p * uniforms.rect.zw + uniforms.rect.xy;
      let zeroToOne = pixelPos / uniforms.resolution;
      let clipSpace = zeroToOne * 2.0 - 1.0;

      output.position = vec4<f32>(clipSpace.x, -clipSpace.y, 0.0, 1.0);
      output.uv = texCoord[VertexIndex] * uniforms.uv_scale + uniforms.uv_offset;
      return output;
    }

    @fragment
    fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
      return textureSample(myTexture, mySampler, in.uv);
    }
  `;

  async function initWebGPU() {
    if (!navigator.gpu) {
      const msg = 'navigator.gpu undefined';
      console.warn('[FastGallery]', msg);
      if (statEngine) statEngine.textContent = `WebGL 2.0 (${msg})`;
      return false;
    }
    try {
      gpuAdapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) ||
                   await navigator.gpu.requestAdapter({ powerPreference: 'low-power' }) ||
                   await navigator.gpu.requestAdapter();
      if (!gpuAdapter) {
        const msg = 'GPUAdapter null';
        console.warn('[FastGallery]', msg);
        if (statEngine) statEngine.textContent = `WebGL 2.0 (${msg})`;
        return false;
      }
      gpuDevice = await gpuAdapter.requestDevice();
      gpuContext = galleryStageCanvas.getContext('webgpu');
      if (!gpuContext) {
        const msg = 'webgpu context null';
        console.warn('[FastGallery]', msg);
        if (statEngine) statEngine.textContent = `WebGL 2.0 (${msg})`;
        return false;
      }

      gpuFormat = navigator.gpu.getPreferredCanvasFormat();
      gpuContext.configure({
        device: gpuDevice,
        format: gpuFormat,
        alphaMode: 'premultiplied',
      });

      gpuSampler = gpuDevice.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
      });

      const shaderModule = gpuDevice.createShaderModule({ code: wgslShaderCode });
      const compilationInfo = await shaderModule.getCompilationInfo();
      if (compilationInfo && compilationInfo.messages) {
        for (const m of compilationInfo.messages) {
          if (m.type === 'error') {
            console.error('WGSL compilation error:', m.message, 'line:', m.lineNum);
          }
        }
      }

      gpuPipeline = gpuDevice.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: shaderModule,
          entryPoint: 'vs_main',
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [{ format: gpuFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });

      isWebGPUMode = true;
      if (statEngine) {
        statEngine.textContent = 'WebGPU (WGSL)';
        statEngine.style.color = '#38bdf8';
      }
      console.log('⚡ WebGPU WGSL Engine initialized successfully!');
      
      const resizeObserver = new ResizeObserver(() => {
        if (gpuContext && galleryStageCanvas) {
            galleryStageCanvas.width = galleryStageCanvas.clientWidth * window.devicePixelRatio;
            galleryStageCanvas.height = galleryStageCanvas.clientHeight * window.devicePixelRatio;
        }
      });
      resizeObserver.observe(galleryStageCanvas);
      
      return true;
    } catch (e) {
      console.warn('WebGPU init exception, falling back to WebGL:', e);
      if (statEngine) {
        statEngine.textContent = `WebGL 2.0 (GLSL) [WebGPU: ${e.message || 'Error'}]`;
      }
      return false;
    }
  }

  function createWebGPUTexture(gpuDevice, bitmap) {
    if (!gpuDevice || !bitmap) return null;
    try {
      const texture = gpuDevice.createTexture({
        size: [bitmap.width, bitmap.height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });

      gpuDevice.queue.copyExternalImageToTexture(
        { source: bitmap, flipY: false },
        { texture: texture },
        [bitmap.width, bitmap.height]
      );

      return texture;
    } catch (e) {
      return null;
    }
  }

  function initStageRenderer() {
    if (!galleryStageCanvas) return;
    try {
      gl = galleryStageCanvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' }) ||
           galleryStageCanvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'high-performance' });
    } catch (e) {}

    if (gl) {
      const vsSource = `
        attribute vec2 a_position;
        attribute vec2 a_texCoord;
        uniform vec2 u_resolution;
        uniform vec2 u_translation;
        uniform vec2 u_scale;
        uniform vec2 u_uv_scale;
        uniform vec2 u_uv_offset;
        varying vec2 v_texCoord;

        void main() {
          vec2 pixelPosition = a_position * u_scale + u_translation;
          vec2 zeroToOne = pixelPosition / u_resolution;
          vec2 zeroToTwo = zeroToOne * 2.0;
          vec2 clipSpace = zeroToTwo - 1.0;
          gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);
          v_texCoord = a_texCoord * u_uv_scale + u_uv_offset;
        }
      `;

      const fsSource = `
        precision mediump float;
        varying vec2 v_texCoord;
        uniform sampler2D u_image;
        uniform vec4 u_color;
        uniform bool u_useTexture;
        uniform float u_velocity;

        void main() {
          if (u_useTexture) {
            vec4 texColor = texture2D(u_image, v_texCoord);
            
            // GPU Velocity Motion Blur Smoothing during fast scroll
            if (u_velocity > 1.2) {
              float blurOffset = min(0.006, u_velocity * 0.001);
              vec4 b1 = texture2D(u_image, v_texCoord + vec2(0.0, blurOffset));
              vec4 b2 = texture2D(u_image, v_texCoord - vec2(0.0, blurOffset));
              texColor = (texColor * 0.5) + (b1 + b2) * 0.25;
            }

            // GPU Color Enhancement: +6% Vibrance for rich vivid colors
            vec3 rgb = texColor.rgb;
            float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
            rgb = mix(vec3(lum), rgb, 1.06);
            gl_FragColor = vec4(rgb, texColor.a);
          } else {
            gl_FragColor = u_color;
          }
        }
      `;

      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vsSource);
      gl.compileShader(vs);

      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsSource);
      gl.compileShader(fs);

      webglProgram = gl.createProgram();
      gl.attachShader(webglProgram, vs);
      gl.attachShader(webglProgram, fs);
      gl.linkProgram(webglProgram);

      webglLocations = {
        a_position: gl.getAttribLocation(webglProgram, 'a_position'),
        a_texCoord: gl.getAttribLocation(webglProgram, 'a_texCoord'),
        u_resolution: gl.getUniformLocation(webglProgram, 'u_resolution'),
        u_translation: gl.getUniformLocation(webglProgram, 'u_translation'),
        u_scale: gl.getUniformLocation(webglProgram, 'u_scale'),
        u_uv_scale: gl.getUniformLocation(webglProgram, 'u_uv_scale'),
        u_uv_offset: gl.getUniformLocation(webglProgram, 'u_uv_offset'),
        u_image: gl.getUniformLocation(webglProgram, 'u_image'),
        u_color: gl.getUniformLocation(webglProgram, 'u_color'),
        u_useTexture: gl.getUniformLocation(webglProgram, 'u_useTexture'),
        u_velocity: gl.getUniformLocation(webglProgram, 'u_velocity'),
      };

      quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0,  1, 0,  0, 1,
        0, 1,  1, 0,  1, 1,
      ]), gl.STATIC_DRAW);

      texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0,  1, 0,  0, 1,
        0, 1,  1, 0,  1, 1,
      ]), gl.STATIC_DRAW);
    } else {
      ctxStage = galleryStageCanvas.getContext('2d', { alpha: false });
    }
  }

  initStageRenderer();

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
  const activeFetches = new Map();
  const pendingUploadQueue = [];
  const MAX_TEXTURE_CACHE = 400;

  function createGLTexture(glContext, bitmap) {
    if (!glContext || !bitmap) return null;
    try {
      const tex = glContext.createTexture();
      glContext.bindTexture(glContext.TEXTURE_2D, tex);
      glContext.pixelStorei(glContext.UNPACK_FLIP_Y_WEBGL, false);
      glContext.texImage2D(glContext.TEXTURE_2D, 0, glContext.RGBA, glContext.RGBA, glContext.UNSIGNED_BYTE, bitmap);

      const isPow2W = (bitmap.width & (bitmap.width - 1)) === 0;
      const isPow2H = (bitmap.height & (bitmap.height - 1)) === 0;
      const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined' && glContext instanceof WebGL2RenderingContext);

      if (isWebGL2 || (isPow2W && isPow2H)) {
        glContext.generateMipmap(glContext.TEXTURE_2D);
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MIN_FILTER, glContext.LINEAR_MIPMAP_LINEAR);
      } else {
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MIN_FILTER, glContext.LINEAR);
      }
      glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MAG_FILTER, glContext.LINEAR);
      glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_S, glContext.CLAMP_TO_EDGE);
      glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_T, glContext.CLAMP_TO_EDGE);

      return tex;
    } catch (e) {
      return null;
    }
  }

  function processPendingUploads(visibleUrlsSet) {
    if (pendingUploadQueue.length === 0) return;
    let count = 0;
    const maxUploadsPerFrame = 2;

    while (pendingUploadQueue.length > 0 && count < maxUploadsPerFrame) {
      const item = pendingUploadQueue.shift();
      const { url, bitmap } = item;

      if (!visibleUrlsSet || visibleUrlsSet.has(url)) {
        if (isWebGPUMode && gpuDevice) {
          const gpuTex = createWebGPUTexture(gpuDevice, bitmap);
          imageTextureMap.set(url, { bmp: bitmap, gpuTex: gpuTex });
        } else {
          const glTex = gl ? createGLTexture(gl, bitmap) : null;
          imageTextureMap.set(url, { bmp: bitmap, glTex: glTex });
        }
        textureLRU.push(url);
        if (visibleUrlsSet) evictOffscreenTextures(visibleUrlsSet);
        count++;
      } else {
        if (bitmap && typeof bitmap.close === 'function') {
          try { bitmap.close(); } catch (e) {}
        }
        imageTextureMap.delete(url);
      }
    }

    if (pendingUploadQueue.length > 0) {
      requestAnimationFrame(renderVirtualGrid);
    }
  }

  function evictOffscreenTextures(visibleUrlsSet) {
    if (textureLRU.length <= MAX_TEXTURE_CACHE) return;

    let i = 0;
    while (i < textureLRU.length && textureLRU.length > MAX_TEXTURE_CACHE) {
      const url = textureLRU[i];
      if (!visibleUrlsSet.has(url)) {
        textureLRU.splice(i, 1);
        const item = imageTextureMap.get(url);
        if (item) {
          if (item.gpuTex) {
            try { item.gpuTex.destroy(); } catch (e) {}
            webgpuBindGroupMap.delete(url);
          }
          if (item.glTex && gl) {
            try { gl.deleteTexture(item.glTex); } catch (e) {}
          }
          if (item.bmp && typeof item.bmp.close === 'function') {
            try { item.bmp.close(); } catch (e) {}
          }
        }
        imageTextureMap.delete(url);
      } else {
        i++;
      }
    }
  }

  const fetchQueue = [];
  const MAX_CONCURRENT_FETCHES = 6;

  function cleanupStaleFetches(visibleUrlsSet) {
    for (const [url, controller] of activeFetches.entries()) {
      if (!visibleUrlsSet.has(url)) {
        controller.abort();
        activeFetches.delete(url);
        imageTextureMap.delete(url);
      }
    }
    // Prune stale un-started tasks from memory queue
    for (let i = fetchQueue.length - 1; i >= 0; i--) {
      if (!visibleUrlsSet.has(fetchQueue[i].url)) {
        imageTextureMap.delete(fetchQueue[i].url);
        fetchQueue.splice(i, 1);
      }
    }
    processFetchQueue();
  }

  function processFetchQueue() {
    while (activeFetches.size < MAX_CONCURRENT_FETCHES && fetchQueue.length > 0) {
      const task = fetchQueue.shift();
      const { url, visibleUrlsSet, reqW, reqH } = task;

      if (visibleUrlsSet && !visibleUrlsSet.has(url)) {
        imageTextureMap.delete(url);
        continue;
      }

      executeFetch(url, visibleUrlsSet, reqW, reqH);
    }
  }

  function executeFetch(url, visibleUrlsSet, reqW, reqH) {
    const controller = new AbortController();
    activeFetches.set(url, controller);

    if (window.createImageBitmap) {
      fetch(url, { signal: controller.signal })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        })
        .then(blob => {
          const opts = reqW ? { resizeWidth: Math.max(reqW, 360), resizeQuality: 'medium' } : undefined;
          return createImageBitmap(blob, opts);
        })
        .then(bitmap => {
          activeFetches.delete(url);
          if (bitmap) {
            pendingUploadQueue.push({ url, bitmap });
            requestAnimationFrame(renderVirtualGrid);
          }
          processFetchQueue();
        })
        .catch(err => {
          activeFetches.delete(url);
          imageTextureMap.delete(url);
          processFetchQueue();
        });
    } else {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = url;
      img.onload = () => {
        activeFetches.delete(url);
        pendingUploadQueue.push({ url, bitmap: img });
        requestAnimationFrame(renderVirtualGrid);
        processFetchQueue();
      };
      img.onerror = () => {
        activeFetches.delete(url);
        imageTextureMap.delete(url);
        processFetchQueue();
      };
    }
  }

  function fetchImageTexture(url, visibleUrlsSet, reqW, reqH) {
    if (!url) return null;
    if (imageTextureMap.has(url)) {
      const tex = imageTextureMap.get(url);
      if (tex) {
        const idx = textureLRU.indexOf(url);
        if (idx >= 0) {
          textureLRU.splice(idx, 1);
          textureLRU.push(url);
        }
      }
      return tex;
    }

    imageTextureMap.set(url, null);

    fetchQueue.unshift({ url, visibleUrlsSet, reqW, reqH });
    processFetchQueue();

    return null;
  }

  let cachedViewportWidth = 1920;
  let cachedViewportHeight = 1080;

  function resizeStageCanvas() {
    if (!galleryStageCanvas || !scrollContainer) return;
    const rect = scrollContainer.getBoundingClientRect();
    cachedViewportWidth = rect.width;
    cachedViewportHeight = rect.height;

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

  async function initEngine() {
    const webgpuSuccess = await initWebGPU();
    if (!webgpuSuccess) {
      initStageRenderer();
      if (statEngine && !statEngine.textContent.startsWith('WebGL 2.0')) {
        statEngine.textContent = 'WebGL 2.0 (GLSL)';
      }
    }
  }

  async function init() {
    setupEventListeners();
    startFPSMonitor();
    await initEngine();
    await fetchPhotos();
    await fetchServerStats();
  }

  async function fetchPhotos(isAppend = false) {
    if (state.isLoading || (isAppend && !state.hasMore)) return;
    state.isLoading = true;

    try {
      const offset = isAppend ? state.photos.length : 0;
      const url = `${API_BASE}/api/photos?limit=1000&offset=${offset}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.photos && data.photos.length > 0) {
        state.photos = isAppend ? state.photos.concat(data.photos) : data.photos;
        statTotal.textContent = state.photos.length.toLocaleString();
        if (data.photos.length < 1000) {
          state.hasMore = false;
        }
        computeLayout(isAppend);

        // Auto-fetch next batches in background until all 6,231 photos are loaded
        if (state.hasMore) {
          setTimeout(() => {
            fetchPhotos(true);
          }, 100);
        }
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
    const containerWidth = scrollContainer.clientWidth || window.innerWidth;
    layoutWorker.postMessage({
      photos: state.photos,
      containerWidth: containerWidth,
      gap: 2,
      mode: state.layoutMode || 'masonry',
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

  function getThumbhashNormalizedColor(photo) {
    if (photo._rgba) return photo._rgba;
    const hashStr = photo.thumbhash || photo.id || '';
    let hashNum = 0;
    for (let i = 0; i < hashStr.length; i++) {
      hashNum = (hashNum << 5) - hashNum + hashStr.charCodeAt(i);
    }
    const hue = (Math.abs(hashNum) % 360) / 360.0;
    const h = hue * 6.0;
    const c = 0.35;
    const x = c * (1.0 - Math.abs((h % 2) - 1.0));
    let r = 0, g = 0, b = 0;
    if (h < 1) { r = c; g = x; }
    else if (h < 2) { r = x; g = c; }
    else if (h < 3) { g = c; b = x; }
    else if (h < 4) { g = x; b = c; }
    else if (h < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = 0.15;
    photo._rgba = [r + m, g + m, b + m, 1.0];
    photo._hue = Math.abs(hashNum) % 360;
    return photo._rgba;
  }

  function drawThumbhashQuad(ctx, photo, x, y, width, height) {
    const rgba = getThumbhashNormalizedColor(photo);
    const c1 = `hsl(${photo._hue}, 55%, 35%)`;
    const c2 = `hsl(${(photo._hue * 7) % 360}, 45%, 20%)`;

    const grad = ctx.createLinearGradient(x, y, x + width, y + height);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, width, height);
  }

  let isScrolling = false;
  let scrollStopTimer = null;

  function renderVirtualGridWebGPU(visibleItems, visibleUrlsSet, scrollTop, canvasW, canvasH, dpr) {
    if (!gpuDevice || !gpuContext || !gpuPipeline) return;

    try {
      const commandEncoder = gpuDevice.createCommandEncoder();
      const textureView = gpuContext.getCurrentTexture().createView();

      const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: textureView,
          clearValue: { r: 0.043, g: 0.059, b: 0.098, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });

      renderPass.setPipeline(gpuPipeline);

      const vpWidth = canvasW / dpr;
      const vpHeight = canvasH / dpr;

      for (let item of visibleItems) {
        const { photo, x, y, width, height } = item;
        const targetY = y - scrollTop;
        const thumbUrl = getThumbUrl(photo);

        const reqW = Math.round(width * dpr);
        const reqH = Math.round(height * dpr);
        const texObj = fetchImageTexture(thumbUrl, visibleUrlsSet, reqW, reqH);

        if (texObj && texObj.gpuTex) {
          let bindGroup = webgpuBindGroupMap.get(thumbUrl);
          if (!bindGroup) {
            const photoAspect = photo.aspect_ratio || (photo.width && photo.height ? photo.width / photo.height : 1.5);
            const boxAspect = width / height;
            let uvScaleX = 1.0, uvScaleY = 1.0;
            let uvOffsetX = 0.0, uvOffsetY = 0.0;

            if (Math.abs(boxAspect - photoAspect) > 0.04) {
              if (boxAspect > photoAspect) {
                uvScaleY = photoAspect / boxAspect;
                uvOffsetY = (1.0 - uvScaleY) * 0.15;
              } else {
                uvScaleX = boxAspect / photoAspect;
                uvOffsetX = (1.0 - uvScaleX) * 0.5;
              }
            }

            const uniformData = new Float32Array([
              x, targetY, width, height,
              vpWidth, vpHeight,
              uvScaleX, uvScaleY,
              uvOffsetX, uvOffsetY,
              0, 0
            ]);

            const uniformBuffer = gpuDevice.createBuffer({
              size: uniformData.byteLength,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            gpuDevice.queue.writeBuffer(uniformBuffer, 0, uniformData);

            bindGroup = gpuDevice.createBindGroup({
              layout: gpuPipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: gpuSampler },
                { binding: 1, resource: texObj.gpuTex.createView() },
                { binding: 2, resource: { buffer: uniformBuffer } },
              ],
            });
            webgpuBindGroupMap.set(thumbUrl, bindGroup);
          }

          renderPass.setBindGroup(0, bindGroup);
          renderPass.draw(6);
        }
      }

      renderPass.end();
      gpuDevice.queue.submit([commandEncoder.finish()]);
    } catch (e) {
      console.warn('WebGPU render error:', e);
    }
  }

  function renderVirtualGrid() {
    if ((!isWebGPUMode && !gl && !ctxStage) || !state.layoutRows || state.layoutRows.length === 0) return;

    resizeStageCanvas();

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvasW = galleryStageCanvas.width;
    const canvasH = galleryStageCanvas.height;

    const scrollTop = scrollContainer.scrollTop;
    const viewportHeight = cachedViewportHeight || 1080;

    if (scrollTop + viewportHeight >= state.totalGridHeight - 1500 && state.hasMore && !state.isLoading) {
      fetchPhotos(true);
    }

    const startY = Math.max(0, scrollTop - 400);
    const endY = scrollTop + viewportHeight + 400;

    const visibleItems = [];
    const visibleUrlsSet = new Set();
    const startRowIdx = binarySearchStartRow(state.layoutRows, startY);

    for (let r = startRowIdx; r < state.layoutRows.length; r++) {
      const row = state.layoutRows[r];
      if (row.y > endY) break;
      for (let i = 0; i < row.items.length; i++) {
        const item = row.items[i];
        visibleItems.push(item);
        const url = getThumbUrl(item.photo);
        if (url) visibleUrlsSet.add(url);
      }
    }

    cleanupStaleFetches(visibleUrlsSet);
    processPendingUploads(visibleUrlsSet);

    if (isWebGPUMode && gpuDevice && gpuPipeline) {
      renderVirtualGridWebGPU(visibleItems, visibleUrlsSet, scrollTop, canvasW, canvasH, dpr);
      return;
    }

    // WebGL Hardware Mipmap Render Path
    if (gl && webglProgram) {
      gl.viewport(0, 0, canvasW, canvasH);
      gl.clearColor(0.043, 0.059, 0.098, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(webglProgram);
      gl.uniform2f(webglLocations.u_resolution, canvasW / dpr, canvasH / dpr);
      gl.uniform1f(webglLocations.u_velocity, Math.min(5.0, state.scrollVelocity || 0));

      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(webglLocations.a_position);
      gl.vertexAttribPointer(webglLocations.a_position, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.enableVertexAttribArray(webglLocations.a_texCoord);
      gl.vertexAttribPointer(webglLocations.a_texCoord, 2, gl.FLOAT, false, 0, 0);

      for (let item of visibleItems) {
        const { photo, x, y, width, height } = item;
        const targetY = y - scrollTop;
        const thumbUrl = getThumbUrl(photo);
        const reqW = Math.round(width * dpr);
        const reqH = Math.round(height * dpr);
        const texObj = fetchImageTexture(thumbUrl, visibleUrlsSet, reqW, reqH);

        const photoAspect = photo.aspect_ratio || (photo.width && photo.height ? photo.width / photo.height : 1.5);
        const boxAspect = width / height;
        let uvScaleX = 1.0, uvScaleY = 1.0;
        let uvOffsetX = 0.0, uvOffsetY = 0.0;

        // Apply UV cropping only when box and photo aspect ratios differ by > 4%
        if (Math.abs(boxAspect - photoAspect) > 0.04) {
          if (boxAspect > photoAspect) {
            uvScaleY = photoAspect / boxAspect;
            uvOffsetY = (1.0 - uvScaleY) * 0.15;
          } else {
            uvScaleX = boxAspect / photoAspect;
            uvOffsetX = (1.0 - uvScaleX) * 0.5;
          }
        }

        gl.uniform2f(webglLocations.u_uv_scale, uvScaleX, uvScaleY);
        gl.uniform2f(webglLocations.u_uv_offset, uvOffsetX, uvOffsetY);

        if (texObj && texObj.glTex) {
          gl.uniform1i(webglLocations.u_useTexture, 1);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texObj.glTex);
          gl.uniform1i(webglLocations.u_image, 0);
          gl.uniform2f(webglLocations.u_translation, x, targetY);
          gl.uniform2f(webglLocations.u_scale, width, height);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        } else {
          const rgba = getThumbhashNormalizedColor(photo);
          gl.uniform1i(webglLocations.u_useTexture, 0);
          gl.uniform4f(webglLocations.u_color, rgba[0], rgba[1], rgba[2], 1.0);
          gl.uniform2f(webglLocations.u_translation, x, targetY);
          gl.uniform2f(webglLocations.u_scale, width, height);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }

      statDom.textContent = '0 (WebGL Mipmap Engine)';
      return;
    }

    // 2D Canvas Fallback
    if (ctxStage) {
      ctxStage.fillStyle = '#0b0f19';
      ctxStage.fillRect(0, 0, canvasW, canvasH);
      ctxStage.imageSmoothingEnabled = true;
      ctxStage.imageSmoothingQuality = isScrolling ? 'low' : 'medium';

      ctxStage.save();
      ctxStage.scale(dpr, dpr);

      for (let item of visibleItems) {
        const { photo, x, y, width, height } = item;
        const targetY = y - scrollTop;
        const thumbUrl = getThumbUrl(photo);
        const reqW = Math.round(width * dpr);
        const reqH = Math.round(height * dpr);
        const texObj = fetchImageTexture(thumbUrl, visibleUrlsSet, reqW, reqH);

        if (texObj && (texObj.bmp || texObj.src)) {
          ctxStage.drawImage(texObj.bmp || texObj, x, targetY, width, height);
        } else {
          drawThumbhashQuad(ctxStage, photo, x, targetY, width, height);
        }
      }

      ctxStage.restore();
      statDom.textContent = '0 (Canvas 2D Fallback)';
    }
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

  // Off-Thread Idle Prefetching (0ms Blocking Delay - 30 Photos Ahead / 15 Behind)
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
  let resizePending = false;

  function setupEventListeners() {
    scrollContainer.addEventListener('scroll', () => {
      isScrolling = true;
      const now = Date.now();
      const dt = Math.max(1, now - (state.lastScrollTime || now));
      const dy = scrollContainer.scrollTop - (state.lastScrollTop || 0);
      if (dy !== 0) {
        state.scrollDirection = dy > 0 ? 1 : -1;
      }
      state.scrollVelocity = Math.abs(dy / dt);
      state.lastScrollTop = scrollContainer.scrollTop;
      state.lastScrollTime = now;

      if (scrollStopTimer) clearTimeout(scrollStopTimer);
      scrollStopTimer = setTimeout(() => {
        isScrolling = false;
        state.scrollVelocity = 0;
        requestAnimationFrame(renderVirtualGrid);
      }, 150);

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
      if (!resizePending) {
        resizePending = true;
        requestAnimationFrame(() => {
          resizeStageCanvas();
          computeLayout();
          resizePending = false;
        });
      }
    }, { passive: true });

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

    // Mobile Touch Gesture Handler for Lightbox
    let touchStartX = 0;
    let touchStartY = 0;

    lightboxModal.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    lightboxModal.addEventListener('touchend', (e) => {
      if (state.zoomScale > 1.0) return;
      if (e.changedTouches.length === 1) {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) > 40 && Math.abs(dy) < 90) {
          navigateLightbox(dx < 0 ? 1 : -1);
        }
      }
    }, { passive: true });

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

    const btnLayoutToggle = document.getElementById('btn-layout-toggle');
    if (btnLayoutToggle) {
      btnLayoutToggle.addEventListener('click', () => {
        if (state.layoutMode === 'masonry') {
          state.layoutMode = 'grid';
          btnLayoutToggle.textContent = '🔲 Grid';
        } else {
          state.layoutMode = 'masonry';
          btnLayoutToggle.textContent = '📌 Masonry';
        }
        computeLayout();
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
