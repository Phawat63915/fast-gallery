<script>
  import { onMount } from 'svelte';

  let photos = $state([]);
  let currentPhotoIndex = $state(-1);
  let isLightboxOpen = $state(false);
  let isUploadOpen = $state(false);
  let ramAlloc = $state('-- MB');
  let wheelThrottleTimer = 0;
  let fileInput;
  const preloadedCache = new Set();
  const preloadedOrder = [];
  const MAX_PRELOAD_CACHE = 50;

  const API_BASE = 'http://localhost:8880';

  onMount(async () => {
    await fetchPhotos();
    await fetchStats();
  });

  async function fetchPhotos() {
    try {
      const res = await fetch(`${API_BASE}/api/photos?limit=200`);
      const data = await res.json();
      photos = data.photos || [];
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchStats() {
    try {
      const res = await fetch(`${API_BASE}/api/stats`);
      const data = await res.json();
      if (data.alloc_ram_mb) ramAlloc = data.alloc_ram_mb;
    } catch (e) {}
  }

  function predictAndPrefetch(index, direction = 1, windowAhead = 5, windowBehind = 2) {
    if (!photos || photos.length === 0) return;

    for (let step = 1; step <= windowAhead; step++) {
      const targetIdx = (index + (step * direction) + photos.length) % photos.length;
      prefetchSingleUrl(photos[targetIdx]);
    }

    for (let step = 1; step <= windowBehind; step++) {
      const targetIdx = (index - (step * direction) + photos.length) % photos.length;
      prefetchSingleUrl(photos[targetIdx]);
    }
  }

  function prefetchSingleUrl(photo) {
    if (!photo) return;
    const url = (photo.original_url || photo.micro_url).startsWith('http')
      ? (photo.original_url || photo.micro_url)
      : `${API_BASE}${photo.original_url || photo.micro_url}`;
    if (!preloadedCache.has(url)) {
      if (preloadedOrder.length >= MAX_PRELOAD_CACHE) {
        const oldest = preloadedOrder.shift();
        preloadedCache.delete(oldest);
      }
      preloadedCache.add(url);
      preloadedOrder.push(url);
      const img = new Image();
      img.src = url;
      if (img.decode) {
        img.decode().catch(() => {});
      }
    }
  }

  async function handleFileUpload(files) {
    if (!files || files.length === 0) return;
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('photos', files[i]);
    }

    try {
      const res = await fetch(`${API_BASE}/api/upload`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.success) {
        isUploadOpen = false;
        await fetchPhotos();
        await fetchStats();
      }
    } catch (e) {
      console.error('Upload failed:', e);
    }
  }

  function openLightbox(index, direction = 1) {
    currentPhotoIndex = index;
    isLightboxOpen = true;
    predictAndPrefetch(index, direction, 5, 2);
  }

  function closeLightbox() {
    isLightboxOpen = false;
    currentPhotoIndex = -1;
  }

  function navigate(dir) {
    if (currentPhotoIndex < 0) return;
    let next = currentPhotoIndex + dir;
    if (next < 0) next = photos.length - 1;
    if (next >= photos.length) next = 0;
    openLightbox(next, dir);
  }

  function handleWheel(e) {
    if (!isLightboxOpen) return;
    e.preventDefault();
    const now = Date.now();
    if (now - wheelThrottleTimer < 40) return;
    wheelThrottleTimer = now;

    const dir = (e.deltaY > 0 || e.deltaX > 0) ? 1 : -1;
    navigate(dir);
  }

  function handleKeydown(e) {
    if (isLightboxOpen) {
      if (e.key === 'ArrowRight' || e.key === 'j') navigate(1);
      else if (e.key === 'ArrowLeft' || e.key === 'k') navigate(-1);
      else if (e.key === 'Escape') closeLightbox();
    } else if (isUploadOpen && e.key === 'Escape') {
      isUploadOpen = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<style>
  :global(*) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) { background: #0b0f19; color: #f8fafc; font-family: 'Inter', sans-serif; height: 100vh; overflow: hidden; user-select: none; }
  .header { height: 60px; background: rgba(11, 15, 25, 0.85); backdrop-filter: blur(20px); border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; padding: 0 20px; z-index: 100; }
  .brand { display: flex; align-items: center; gap: 10px; font-family: 'Outfit', sans-serif; }
  .logo { width: 36px; height: 36px; background: linear-gradient(135deg, #ef4444 0%, #f97316 100%); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
  .btn-upload { background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%); color: #fff; border: none; padding: 8px 16px; border-radius: 8px; font-weight: 600; cursor: pointer; }
  
  .grid-container {
    height: calc(100vh - 60px);
    overflow-y: auto;
    padding: 8px 16px;
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    -webkit-overflow-scrolling: touch;
    scroll-behavior: smooth;
    will-change: scroll-position;
  }
  
  .tile {
    height: 220px;
    flex-grow: 1;
    position: relative;
    overflow: hidden;
    cursor: pointer;
    border-radius: 2px;
    background: #0f172a;
    will-change: transform;
    backface-visibility: hidden;
    transform: translateZ(0);
  }
  
  .tile img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.25s ease; will-change: transform; }
  .tile:hover img { transform: scale(1.04); }
  .lightbox { position: fixed; inset: 0; background: rgba(4,7,13,0.96); backdrop-filter: blur(24px); z-index: 2000; display: flex; flex-direction: column; }
  .lightbox-bar { height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid rgba(255,255,255,0.1); }
  .lightbox-stage { flex: 1; display: flex; align-items: center; justify-content: center; position: relative; }
  .lightbox-stage img { max-width: 92%; max-height: 92%; object-fit: contain; border-radius: 4px; box-shadow: 0 25px 60px rgba(0,0,0,0.9); transition: opacity 0.15s ease-out; }
  .arrow { position: absolute; top: 50%; transform: translateY(-50%); width: 48px; height: 48px; border-radius: 50%; background: rgba(17,24,39,0.7); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 2100; }
  .prev { left: 24px; } .next { right: 24px; }
  .close-btn { background: none; border: none; color: #fff; font-size: 24px; cursor: pointer; }
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.8); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 3000; }
  .modal-card { width: 480px; background: #111726; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 24px; }
  .drop-area { border: 2px dashed rgba(255,255,255,0.2); border-radius: 12px; padding: 36px; text-align: center; cursor: pointer; margin-top: 16px; }
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
    <button class="btn-upload" onclick={() => isUploadOpen = true}>Upload Photos</button>
  </div>
</div>

<div class="grid-container">
  {#each photos as photo, i}
    <div class="tile" style="width: {220 * (photo.aspect_ratio || 1.5)}px;" onclick={() => openLightbox(i)}>
      <img src={photo.micro_url.startsWith('http') ? photo.micro_url : `${API_BASE}${photo.micro_url}`} alt={photo.title} loading="lazy" />
    </div>
  {/each}
</div>

{#if isLightboxOpen && currentPhotoIndex >= 0}
  <div class="lightbox" onwheel={handleWheel}>
    <div class="lightbox-bar">
      <span>{currentPhotoIndex + 1} / {photos.length} (Scroll Wheel Supported)</span>
      <button class="close-btn" onclick={closeLightbox}>&times;</button>
    </div>
    <div class="lightbox-stage">
      <button class="arrow prev" onclick={() => navigate(-1)}>&#10094;</button>
      <img src={photos[currentPhotoIndex].original_url.startsWith('http') ? photos[currentPhotoIndex].original_url : `${API_BASE}${photos[currentPhotoIndex].original_url}`} alt="" />
      <button class="arrow next" onclick={() => navigate(1)}>&#10095;</button>
    </div>
  </div>
{/if}

{#if isUploadOpen}
  <div class="modal">
    <div class="modal-card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3>Upload Photos (Svelte)</h3>
        <button class="close-btn" onclick={() => isUploadOpen = false}>&times;</button>
      </div>
      <div class="drop-area" onclick={() => fileInput.click()}>
        <p style="font-size: 32px;">📤</p>
        <p style="margin-top: 8px;">Click to select photos for upload</p>
        <input bind:this={fileInput} type="file" multiple accept="image/*" style="display:none;" onchange={(e) => handleFileUpload(e.target.files)} />
      </div>
    </div>
  </div>
{/if}
