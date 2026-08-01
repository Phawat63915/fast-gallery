import React, { useState, useEffect, useRef } from 'react';

const API_BASE = 'http://localhost:8880';

export default function App() {
  const [photos, setPhotos] = useState([]);
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(-1);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [ramAlloc, setRamAlloc] = useState('-- MB');
  const wheelThrottle = useRef(0);

  useEffect(() => {
    fetchPhotos();
    fetchStats();
  }, []);

  useEffect(() => {
    function handleKeydown(e) {
      if (!isLightboxOpen) return;
      if (e.key === 'ArrowRight' || e.key === 'j') navigate(1);
      else if (e.key === 'ArrowLeft' || e.key === 'k') navigate(-1);
      else if (e.key === 'Escape') closeLightbox();
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [isLightboxOpen, currentPhotoIndex, photos]);

  async function fetchPhotos() {
    try {
      const res = await fetch(`${API_BASE}/api/photos?limit=200`);
      const data = await res.json();
      setPhotos(data.photos || []);
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchStats() {
    try {
      const res = await fetch(`${API_BASE}/api/stats`);
      const data = await res.json();
      if (data.alloc_ram_mb) setRamAlloc(data.alloc_ram_mb);
    } catch (e) {}
  }

  function openLightbox(index) {
    setCurrentPhotoIndex(index);
    setIsLightboxOpen(true);
  }

  function closeLightbox() {
    setIsLightboxOpen(false);
    setCurrentPhotoIndex(-1);
  }

  function navigate(dir) {
    if (currentPhotoIndex < 0) return;
    let next = currentPhotoIndex + dir;
    if (next < 0) next = photos.length - 1;
    if (next >= photos.length) next = 0;
    setCurrentPhotoIndex(next);
  }

  function handleWheel(e) {
    if (!isLightboxOpen) return;
    e.preventDefault();
    const now = Date.now();
    if (now - wheelThrottle.current < 100) return; // 100ms ultra-fast throttle
    wheelThrottle.current = now;

    if (e.deltaY > 0 || e.deltaX > 0) navigate(1);
    else if (e.deltaY < 0 || e.deltaX < 0) navigate(-1);
  }

  return (
    <div className="react-app">
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0b0f19; color: #f8fafc; font-family: 'Inter', sans-serif; height: 100vh; overflow: hidden; user-select: none; }
        .header { height: 60px; background: rgba(11, 15, 25, 0.85); backdrop-filter: blur(20px); border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; padding: 0 20px; }
        .brand { display: flex; align-items: center; gap: 10px; font-family: 'Outfit', sans-serif; }
        .logo { width: 36px; height: 36px; background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
        .grid-container { height: calc(100vh - 60px); overflow-y: auto; padding: 8px 16px; display: flex; flex-wrap: wrap; gap: 3px; }
        .tile { height: 220px; flex-grow: 1; position: relative; overflow: hidden; cursor: pointer; border-radius: 2px; background: #0f172a; }
        .tile img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s ease; }
        .tile:hover img { transform: scale(1.04); }
        .lightbox { position: fixed; inset: 0; background: rgba(4,7,13,0.96); backdrop-filter: blur(24px); z-index: 2000; display: flex; flex-direction: column; }
        .lightbox-bar { height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .lightbox-stage { flex: 1; display: flex; align-items: center; justify-content: center; position: relative; }
        .lightbox-stage img { max-width: 92%; max-height: 92%; object-fit: contain; border-radius: 4px; box-shadow: 0 25px 60px rgba(0,0,0,0.9); }
        .arrow { position: absolute; top: 50%; transform: translateY(-50%); width: 48px; height: 48px; border-radius: 50%; background: rgba(17,24,39,0.7); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 2100; }
        .prev { left: 24px; } .next { right: 24px; }
        .close-btn { background: none; border: none; color: #fff; font-size: 24px; cursor: pointer; }
      `}</style>

      <div className="header">
        <div className="brand">
          <div className="logo">4️⃣</div>
          <div>
            <h2>Stack 4: React 19</h2>
            <p style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Next / React Ecosystem • Port 8884</p>
          </div>
        </div>
        <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
          Photos: {photos.length} | Go RAM: {ramAlloc}
        </div>
      </div>

      <div className="grid-container">
        {photos.map((photo, index) => (
          <div
            key={photo.id}
            className="tile"
            style={{ width: `${220 * (photo.aspect_ratio || 1.5)}px` }}
            onClick={() => openLightbox(index)}
          >
            <img
              src={photo.micro_url.startsWith('http') ? photo.micro_url : `${API_BASE}${photo.micro_url}`}
              alt={photo.title}
              loading="lazy"
            />
          </div>
        ))}
      </div>

      {isLightboxOpen && currentPhotoIndex >= 0 && (
        <div className="lightbox" onWheel={handleWheel}>
          <div className="lightbox-bar">
            <span>{currentPhotoIndex + 1} / {photos.length} (Scroll Wheel Supported)</span>
            <button className="close-btn" onClick={closeLightbox}>&times;</button>
          </div>
          <div className="lightbox-stage">
            <button className="arrow prev" onClick={() => navigate(-1)}>&#10094;</button>
            <img
              src={
                photos[currentPhotoIndex].original_url.startsWith('http')
                  ? photos[currentPhotoIndex].original_url
                  : `${API_BASE}${photos[currentPhotoIndex].original_url}`
              }
              alt=""
            />
            <button className="arrow next" onClick={() => navigate(1)}>&#10095;</button>
          </div>
        </div>
      )}
    </div>
  );
}
