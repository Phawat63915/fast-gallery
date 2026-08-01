<script>
  import { onMount } from 'svelte';

  let photos = $state([]);
  let currentPhotoIndex = $state(-1);
  let isLightboxOpen = $state(false);
  let ramAlloc = $state('-- MB');
  let fps = $state(60);

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

  function openLightbox(index) {
    currentPhotoIndex = index;
    isLightboxOpen = true;
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
    currentPhotoIndex = next;
  }

  function handleWheel(e) {
    if (!isLightboxOpen) return;
    e.preventDefault();
    if (e.deltaY > 0) navigate(1);
    else if (e.deltaY < 0) navigate(-1);
  }
</script>

<style>
  :global(*) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) { background: #0b0f19; color: #f8fafc; font-family: 'Inter', sans-serif; height: 100vh; overflow: hidden; }
  .header { height: 60px; background: rgba(11, 15, 25, 0.85); backdrop-filter: blur(20px); border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; padding: 0 20px; }
  .brand { display: flex; align-items: center; gap: 10px; font-family: 'Outfit', sans-serif; }
  .logo { width: 36px; height: 36px; background: linear-gradient(135deg, #ef4444 0%, #f97316 100%); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
  .grid-container { height: calc(100vh - 60px); overflow-y: auto; padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 3px; }
  .tile { height: 220px; flex-grow: 1; position: relative; overflow: hidden; cursor: pointer; border-radius: 2px; background: #0f172a; }
  .tile img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s ease; }
  .tile:hover img { transform: scale(1.04); }
  .lightbox { position: fixed; inset: 0; background: rgba(4,7,13,0.96); z-index: 2000; display: flex; flex-direction: column; }
  .lightbox-bar { height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid rgba(255,255,255,0.1); }
  .lightbox-stage { flex: 1; display: flex; align-items: center; justify-content: center; position: relative; }
  .lightbox-stage img { max-width: 90%; max-height: 90%; border-radius: 4px; box-shadow: 0 20px 50px rgba(0,0,0,0.8); }
  .arrow { position: absolute; top: 50%; transform: translateY(-50%); width: 48px; height: 48px; border-radius: 50%; background: rgba(255,255,255,0.1); border: none; color: #fff; font-size: 24px; cursor: pointer; }
  .prev { left: 24px; } .next { right: 24px; }
  .close-btn { background: none; border: none; color: #fff; font-size: 24px; cursor: pointer; }
</style>

<div class="header">
  <div class="brand">
    <div class="logo">2️⃣</div>
    <div>
      <h2>Stack 2: Svelte 5</h2>
      <p style="font-size: 0.7rem; color: #94a3b8;">Immich Choice • Port 8882</p>
    </div>
  </div>
  <div style="font-size: 0.8rem; color: #94a3b8;">
    Photos: {photos.length} | Go RAM: {ramAlloc}
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
