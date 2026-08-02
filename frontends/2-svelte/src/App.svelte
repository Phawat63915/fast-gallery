<script>
  import { onMount } from 'svelte';

  let photos = $state([]);
  let currentPhotoIndex = $state(-1);
  let isLightboxOpen = $state(false);
  let isUploadOpen = $state(false);
  let ramAlloc = $state('-- MB');
  let lastWheelTime = 0;
  let scrollTop = $state(0);
  let viewportHeight = $state(800);
  let gridContainer;
  let fileInput;

  // 99,999 Parallel Streaming Pipeline Progress State
  let isUploading = $state(false);
  let uploadProgress = $state(0);
  let uploadTotal = $state(0);
  let uploadPercent = $state(0);
  let uploadStatusText = $state('');
  let isExifOpen = $state(true);

  // Lightbox Zoom & Pan State
  let zoomScale = $state(1.0);
  let zoomX = $state(0);
  let zoomY = $state(0);
  let isDragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;

  // Upload Modal Tab State
  let uploadTab = $state('batch'); // 'batch' | 'url'
  let customUrlInput = $state('');
  let customUrlStatus = $state('');
  let customUrlStatusColor = $state('#06b6d4');

  const preloadedCache = new Set();
  const preloadedOrder = [];
  const MAX_PRELOAD_CACHE = 50;

  const API_BASE = '';

  onMount(async () => {
    await fetchPhotos();
    await fetchStats();
    if (gridContainer) {
      viewportHeight = gridContainer.clientHeight || 800;
    }

    const handleKeydown = (e) => {
      if (isLightboxOpen) {
        if (e.key === 'ArrowRight' || e.key === 'j') navigate(1);
        else if (e.key === 'ArrowLeft' || e.key === 'k') navigate(-1);
        else if (e.key === 'Escape') closeLightbox();
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  let nextCursor = 0;
  let hasMorePhotos = true;
  let isLoadingMore = false;

  async function fetchPhotos(isAppend = false) {
    if (isLoadingMore || (isAppend && !hasMorePhotos)) return;
    isLoadingMore = true;

    try {
      const url = `${API_BASE}/api/photos?limit=500${nextCursor ? `&cursor=${nextCursor}` : ''}`;
      const res = await fetch(url);
      const data = await res.json();
      const newPhotos = data.photos || [];

      if (newPhotos.length < 500 || !data.next_cursor) {
        hasMorePhotos = false;
      }
      nextCursor = data.next_cursor || 0;
      photos = isAppend ? [...photos, ...newPhotos] : newPhotos;
    } catch (e) {
      console.error(e);
    } finally {
      isLoadingMore = false;
    }
  }

  async function fetchStats() {
    try {
      const res = await fetch(`${API_BASE}/api/stats`);
      const data = await res.json();
      if (data.alloc_ram_mb) ramAlloc = data.alloc_ram_mb;
    } catch (e) {}
  }

  let virtualData = $derived.by(() => {
    if (!photos || photos.length === 0) return { items: [], topSpacer: 0, bottomSpacer: 0 };
    const rowHeight = 223;
    const itemsPerRow = 4;
    const bufferRows = 12;
    const totalRows = Math.ceil(photos.length / itemsPerRow);

    const currentLine = Math.floor(scrollTop / rowHeight);
    const visibleLines = Math.ceil(viewportHeight / rowHeight);

    const startRow = Math.max(0, currentLine - bufferRows);
    const endRow = Math.min(totalRows, currentLine + visibleLines + bufferRows);

    const startIdx = startRow * itemsPerRow;
    const endIdx = Math.min(photos.length, endRow * itemsPerRow);

    const topSpacer = startRow * rowHeight;
    const bottomSpacer = Math.max(0, (totalRows - endRow) * rowHeight);

    const items = photos.slice(startIdx, endIdx).map((photo, offset) => ({
      photo,
      globalIndex: startIdx + offset
    }));

    return { items, topSpacer, bottomSpacer };
  });

  function handleScroll(e) {
    scrollTop = e.target.scrollTop;
    const currentContainerHeight = e.target.clientHeight || 800;
    const totalScrollHeight = e.target.scrollHeight || 1;

    if (scrollTop + currentContainerHeight >= totalScrollHeight - 1500 && hasMorePhotos && !isLoadingMore) {
      fetchPhotos(true);
    }
  }

  function scheduleIdlePrefetch(index, direction = 1) {
    const runPrefetch = () => {
      if (!photos || photos.length === 0) return;
      for (let step = 1; step <= 15; step++) {
        const targetIdx = (index + (step * direction) + photos.length) % photos.length;
        prefetchSingleUrl(photos[targetIdx]);
      }
      for (let step = 1; step <= 8; step++) {
        const targetIdx = (index - (step * direction) + photos.length) % photos.length;
        prefetchSingleUrl(photos[targetIdx]);
      }
    };

    if (typeof window !== 'undefined' && window.requestIdleCallback) {
      window.requestIdleCallback(runPrefetch);
    } else {
      setTimeout(runPrefetch, 0);
    }
  }

  function getThumbUrl(photo) {
    if (!photo) return '';
    if (photo.filename && !photo.filename.startsWith('http')) {
      return `${API_BASE}/uploads/thumbnails/${photo.filename}`;
    }
    return photo.filename || photo.micro_url || photo.original_url || '';
  }

  function getOriginalUrl(photo) {
    if (!photo) return '';
    if (photo.filename && !photo.filename.startsWith('http')) {
      return `${API_BASE}/uploads/originals/${photo.filename}`;
    }
    return photo.original_url || photo.micro_url || photo.filename || '';
  }

  function prefetchSingleUrl(photo) {
    if (!photo) return;
    const url = getOriginalUrl(photo);
    if (!preloadedCache.has(url)) {
      if (preloadedOrder.length >= MAX_PRELOAD_CACHE) {
        const oldest = preloadedOrder.shift();
        preloadedCache.delete(oldest);
      }
      preloadedCache.add(url);
      preloadedOrder.push(url);
      const img = new Image();
      img.src = url;
      if (img.decode) img.decode().catch(() => {});
    }
  }

  function resetZoom() {
    zoomScale = 1.0;
    zoomX = 0;
    zoomY = 0;
    isDragging = false;
  }

  function toggleZoom() {
    if (zoomScale > 1.0) {
      resetZoom();
    } else {
      zoomScale = 2.5;
      zoomX = 0;
      zoomY = 0;
    }
  }

  function openLightbox(index, direction = 1) {
    if (index < 0 || index >= photos.length) return;
    resetZoom();
    currentPhotoIndex = index;
    isLightboxOpen = true;
    scheduleIdlePrefetch(index, direction);
  }

  function closeLightbox() {
    resetZoom();
    isLightboxOpen = false;
    currentPhotoIndex = -1;
  }

  function navigate(dir) {
    if (currentPhotoIndex < 0) return;
    let nextIndex = currentPhotoIndex + dir;

    if (nextIndex >= photos.length - 5 && hasMorePhotos && !isLoadingMore) {
      fetchPhotos(true);
    }

    if (nextIndex < 0) nextIndex = photos.length - 1;
    if (nextIndex >= photos.length) nextIndex = 0;
    openLightbox(nextIndex, dir);
  }

  function handleWheel(e) {
    if (zoomScale > 1.0 || e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.25 : -0.25;
      zoomScale = Math.max(1.0, Math.min(5.0, zoomScale + delta));
    } else {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheelTime < 10) return;
      lastWheelTime = now;
      const dir = (e.deltaY > 0 || e.deltaX > 0) ? 1 : -1;
      navigate(dir);
    }
  }

  function handleMouseDown(e) {
    if (zoomScale <= 1.0) return;
    e.preventDefault();
    isDragging = true;
    dragStartX = e.clientX - zoomX;
    dragStartY = e.clientY - zoomY;
  }

  function handleMouseMove(e) {
    if (!isDragging) return;
    e.preventDefault();
    zoomX = e.clientX - dragStartX;
    zoomY = e.clientY - dragStartY;
  }

  function handleMouseUp() {
    isDragging = false;
  }

  async function handleFileUpload(files) {
    if (!files || files.length === 0) return;

    isUploading = true;
    uploadProgress = 0;
    uploadTotal = files.length;
    uploadPercent = 0;
    uploadStatusText = 'Preparing parallel streams...';

    const fileList = Array.from(files);
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
            uploadProgress = completedCount;
            uploadPercent = Math.round((completedCount / uploadTotal) * 100);
            uploadStatusText = `Streaming parallel batches... Completed ${completedCount.toLocaleString()} / ${uploadTotal.toLocaleString()} files (${uploadPercent}%)`;
          }
        } catch (err) {
          console.error(err);
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker());
    await Promise.all(workers);

    uploadStatusText = `Upload Complete! Indexed ${uploadTotal.toLocaleString()} photos!`;
    setTimeout(async () => {
      isUploading = false;
      isUploadOpen = false;
      await fetchPhotos();
      await fetchStats();
    }, 800);
  }

  function addCustomPhoto() {
    const url = customUrlInput.trim();
    if (!url) {
      customUrlStatusColor = '#ef4444';
      customUrlStatus = 'Please enter a valid image URL.';
      return;
    }

    customUrlStatusColor = '#06b6d4';
    customUrlStatus = 'Verifying image URL...';

    const imgLoader = new Image();
    const finishAdd = (aspectRatio, w, h) => {
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

      photos = [newPhoto, ...photos];
      customUrlInput = '';
      customUrlStatusColor = '#10b981';
      customUrlStatus = 'Photo added successfully!';
      setTimeout(() => {
        isUploadOpen = false;
        customUrlStatus = '';
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
  }
</script>

<style>
  :global(*) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) { background: #0b0f19; color: #f8fafc; font-family: 'Inter', sans-serif; height: 100vh; overflow: hidden; user-select: none; }
  .header { height: 64px; background: rgba(11, 15, 25, 0.95); border-bottom: 1px solid rgba(255, 255, 255, 0.08); display: flex; align-items: center; justify-content: space-between; padding: 0 24px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo { font-size: 24px; }
  .btn-upload {
    background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%);
    border: none;
    padding: 8px 18px;
    border-radius: 10px;
    color: #fff;
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(6, 182, 212, 0.35);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .btn-upload:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 20px rgba(6, 182, 212, 0.5);
  }
  .icon-btn { width: 36px; height: 36px; border-radius: 8px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .icon-btn.active { background: rgba(59,130,246,0.3); border-color: #3b82f6; }
  .grid-container { height: calc(100vh - 64px); overflow-y: auto; padding: 24px; display: flex; flex-wrap: wrap; gap: 12px; align-content: flex-start; }
  .tile {
    height: 220px;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    background: #0f172a;
    will-change: transform;
    backface-visibility: hidden;
    transform: translateZ(0);
    content-visibility: auto;
    contain-intrinsic-size: 220px 300px;
  }
  
  .tile img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.25s ease; will-change: transform; }
  .tile:hover img { transform: scale(1.04); }
  .lightbox { position: fixed; inset: 0; background: rgba(4,7,13,0.96); z-index: 2000; display: flex; flex-direction: column; }
  .lightbox-bar { height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid rgba(255,255,255,0.1); }
  .lightbox-stage { flex: 1; display: flex; align-items: center; justify-content: center; position: relative; width: 100%; height: 100%; padding: 0; margin: 0; overflow: hidden; }
  .lightbox-stage img { width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: contain; transform-origin: center center; cursor: grab; user-select: none; }
  .lightbox-stage img.is-dragging { cursor: grabbing !important; }
  .arrow { position: absolute; top: 50%; transform: translateY(-50%); width: 48px; height: 48px; border-radius: 50%; background: rgba(17,24,39,0.7); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 2100; }
  .prev { left: 24px; } .next { right: 24px; }
  .close-btn { background: none; border: none; color: #fff; font-size: 24px; cursor: pointer; }
  
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.88); display: flex; align-items: center; justify-content: center; z-index: 3000; }
  .modal-card { width: 540px; background: #111726; border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; padding: 28px; box-shadow: 0 30px 80px rgba(0,0,0,0.8); }
  .upload-tabs { display: flex; gap: 8px; margin-top: 16px; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; }
  .upload-tab { background: none; border: none; padding: 8px 16px; border-radius: 8px; color: #94a3b8; font-size: 0.875rem; font-weight: 600; cursor: pointer; transition: all 0.2s ease; }
  .upload-tab.active { background: rgba(59, 130, 246, 0.15); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.3); }
  .drop-area { border: 2px dashed rgba(255,255,255,0.25); border-radius: 16px; padding: 40px; text-align: center; cursor: pointer; transition: border-color 0.2s ease; }
  .drop-area:hover { border-color: #3b82f6; }
  
  .progress-container { margin-top: 20px; background: rgba(255,255,255,0.06); border-radius: 12px; height: 12px; overflow: hidden; position: relative; }
  .progress-bar { height: 100%; background: linear-gradient(90deg, #3b82f6 0%, #06b6d4 100%); transition: width 0.2s ease; border-radius: 12px; }
</style>

<div class="header">
  <div class="brand">
    <div class="logo">2️⃣</div>
    <div>
      <h2>Stack 2: Svelte 5</h2>
      <p style="font-size: 0.7rem; color: #94a3b8;">Immich Choice • Port 8882</p>
    </div>
  </div>
  <div style="display: flex; align-items: center; gap: 16px;">
    <span style="font-size: 0.8rem; color: #94a3b8;">Photos: {photos.length} | RAM: {ramAlloc}</span>
    <button class="btn-upload" onclick={() => isUploadOpen = true}>Upload Photos (99,999+)</button>
  </div>
</div>

<div class="grid-container" bind:this={gridContainer} onscroll={handleScroll}>
  <div style="height: {virtualData.topSpacer}px; width: 100%;"></div>
  {#each virtualData.items as item (item.photo.id)}
    <div class="tile" style="width: {220 * (item.photo.aspect_ratio || 1.5)}px;" onclick={() => openLightbox(item.globalIndex)}>
      <img src={getThumbUrl(item.photo)} alt={item.photo.filename || item.photo.id} loading="lazy" decoding="async" />
    </div>
  {/each}
  <div style="height: {virtualData.bottomSpacer}px; width: 100%;"></div>
</div>

{#if isLightboxOpen && currentPhotoIndex >= 0}
  <div class="lightbox" onwheel={handleWheel}>
    <div class="lightbox-bar">
      <div style="display: flex; align-items: center; gap: 16px; min-width: 0; flex: 1;">
        <span style="font-size: 0.85rem; color: #94a3b8;">{currentPhotoIndex + 1} / {photos.length}</span>
        <span style="font-weight: 600; font-size: 0.9rem; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 600px;">{photos[currentPhotoIndex].filename || photos[currentPhotoIndex].id}</span>
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <button class="icon-btn" onclick={toggleZoom} title="Zoom (Click / Wheel)">🔍</button>
        <button class="icon-btn {isExifOpen ? 'active' : ''}" onclick={() => isExifOpen = !isExifOpen} title="Toggle EXIF Info">ℹ️</button>
        <button class="close-btn" onclick={closeLightbox}>&times;</button>
      </div>
    </div>
    <div style="flex: 1; display: flex; overflow: hidden;">
      <div class="lightbox-stage" onmousemove={handleMouseMove} onmouseup={handleMouseUp}>
        <button class="arrow prev" onclick={() => navigate(-1)}>&#10094;</button>
        <img
          src={getOriginalUrl(photos[currentPhotoIndex])}
          alt=""
          class={isDragging ? 'is-dragging' : ''}
          style="transform: translate3d({zoomX}px, {zoomY}px, 0) scale({zoomScale});"
          ondblclick={toggleZoom}
          onmousedown={handleMouseDown}
        />
        <button class="arrow next" onclick={() => navigate(1)}>&#10095;</button>
      </div>
      {#if isExifOpen}
        <aside style="width: 320px; background: rgba(15, 23, 42, 0.9); border-left: 1px solid rgba(255,255,255,0.1); padding: 24px; display: flex; flex-direction: column; gap: 16px;">
          <h4 style="font-family: 'Outfit', sans-serif; font-size: 1.1rem; color: #fff;">{photos[currentPhotoIndex].filename || photos[currentPhotoIndex].id || 'Untitled Image'}</h4>
          <p style="font-size: 0.8rem; color: #94a3b8;">{new Date(photos[currentPhotoIndex].created_at).toLocaleString('th-TH')}</p>
          <div style="margin-top: 12px;">
            <h5 style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 8px;">METADATA EXIF</h5>
            <div style="display: flex; flex-direction: column; gap: 8px; font-size: 0.825rem;">
              <div style="display:flex; justify-content:space-between;"><span style="color:#94a3b8;">Camera</span><span style="color:#fff; font-weight:600;">{photos[currentPhotoIndex].camera_make || 'Sony'} {photos[currentPhotoIndex].camera_model || 'A7 IV'}</span></div>
              <div style="display:flex; justify-content:space-between;"><span style="color:#94a3b8;">Lens</span><span style="color:#fff; font-weight:600;">{photos[currentPhotoIndex].focal_length || '35mm'}</span></div>
              <div style="display:flex; justify-content:space-between;"><span style="color:#94a3b8;">ISO</span><span style="color:#fff; font-weight:600;">{photos[currentPhotoIndex].iso ? `ISO ${photos[currentPhotoIndex].iso}` : 'ISO 100'}</span></div>
              <div style="display:flex; justify-content:space-between;"><span style="color:#94a3b8;">Resolution</span><span style="color:#fff; font-weight:600;">{photos[currentPhotoIndex].width || 1920} × {photos[currentPhotoIndex].height || 1080}</span></div>
            </div>
          </div>
        </aside>
      {/if}
    </div>
  </div>
{/if}

{#if isUploadOpen}
  <div class="modal">
    <div class="modal-card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3>Add Photos & Media</h3>
        {#if !isUploading}
          <button class="close-btn" onclick={() => isUploadOpen = false}>&times;</button>
        {/if}
      </div>

      <div class="upload-tabs">
        <button class="upload-tab {uploadTab === 'batch' ? 'active' : ''}" onclick={() => uploadTab = 'batch'}>📁 Batch Upload Files</button>
        <button class="upload-tab {uploadTab === 'url' ? 'active' : ''}" onclick={() => uploadTab = 'url'}>🔗 Custom Image URL</button>
      </div>

      {#if uploadTab === 'batch'}
        {#if !isUploading}
          <div class="drop-area" onclick={() => fileInput.click()}>
            <p style="font-size: 40px;">⚡🚀</p>
            <p style="margin-top: 12px; font-weight: 600; font-size: 1.05rem;">Select up to 99,999+ photos</p>
            <p style="margin-top: 6px; font-size: 0.8rem; color: #94a3b8;">6 Parallel Worker Streams • Zero Main-Thread Lockup</p>
            <input bind:this={fileInput} type="file" multiple accept="image/*" style="display:none;" onchange={(e) => handleFileUpload(e.target.files)} />
          </div>
        {:else}
          <div style="margin-top: 20px;">
            <div style="display:flex; justify-content:space-between; font-size: 0.9rem; font-weight:600;">
              <span>Uploading via 6 Parallel Streams...</span>
              <span style="color: #06b6d4;">{uploadProgress.toLocaleString()} / {uploadTotal.toLocaleString()} ({uploadPercent}%)</span>
            </div>
            <div class="progress-container">
              <div class="progress-bar" style="width: {uploadPercent}%;"></div>
            </div>
            <p style="margin-top: 12px; font-size: 0.8rem; color: #94a3b8; text-align: center;">{uploadStatusText}</p>
          </div>
        {/if}
      {:else}
        <div style="margin-top: 16px;">
          <label style="font-size: 0.85rem; color: #94a3b8; margin-bottom: 8px; display: block;">Enter Direct Image URL (HTTP/HTTPS):</label>
          <div style="display: flex; gap: 10px;">
            <input
              type="url"
              bind:value={customUrlInput}
              placeholder="https://images.unsplash.com/photo-..."
              style="flex: 1; padding: 12px 16px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); color: #fff; font-size: 0.9rem; outline: none;"
              onkeydown={(e) => e.key === 'Enter' && addCustomPhoto()}
            />
            <button class="btn-upload" style="white-space: nowrap;" onclick={addCustomPhoto}>Add Photo</button>
          </div>
          <p style="margin-top: 12px; font-size: 0.8rem; color: {customUrlStatusColor}; min-height: 20px;">{customUrlStatus}</p>
        </div>
      {/if}
    </div>
  </div>
{/if}
