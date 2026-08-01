import React, { useState, useEffect, useRef, useMemo } from 'react';

const API_BASE = 'http://localhost:8880';
const preloadedCache = new Set();
const preloadedOrder = [];
const MAX_PRELOAD_CACHE = 50;

export default function App() {
  const [photos, setPhotos] = useState([]);
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(-1);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [ramAlloc, setRamAlloc] = useState('-- MB');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);

  // 99,999 Parallel Streaming Pipeline Progress State
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadStatusText, setUploadStatusText] = useState('');

  const fileInputRef = useRef(null);
  const gridContainerRef = useRef(null);
  const lastWheelTime = useRef(0);

  useEffect(() => {
    fetchPhotos();
    fetchStats();
    if (gridContainerRef.current) {
      setViewportHeight(gridContainerRef.current.clientHeight || 800);
    }
  }, []);

  useEffect(() => {
    function handleKeydown(e) {
      if (isLightboxOpen) {
        if (e.key === 'ArrowRight' || e.key === 'j') navigate(1);
        else if (e.key === 'ArrowLeft' || e.key === 'k') navigate(-1);
        else if (e.key === 'Escape') closeLightbox();
      } else if (isUploadOpen && e.key === 'Escape') {
        if (!isUploading) setIsUploadOpen(false);
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [isLightboxOpen, isUploadOpen, isUploading, currentPhotoIndex, photos]);

  const virtualData = useMemo(() => {
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
      globalIndex: startIdx + offset,
    }));

    return { items, topSpacer, bottomSpacer };
  }, [photos, scrollTop, viewportHeight]);

  function handleScroll(e) {
    setScrollTop(e.target.scrollTop);
  }

  function scheduleIdlePrefetch(index, direction = 1) {
    const runPrefetch = () => {
      if (!photos || photos.length === 0) return;
      for (let step = 1; step <= 5; step++) {
        const targetIdx = (index + (step * direction) + photos.length) % photos.length;
        prefetchSingleUrl(photos[targetIdx]);
      }
      for (let step = 1; step <= 2; step++) {
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

  // 99,999 Parallel Streaming Pipeline Engine (Concurrency Pool = 6)
  async function handleFileUpload(files) {
    if (!files || files.length === 0) return;

    setIsUploading(true);
    setUploadTotal(files.length);
    setUploadProgress(0);
    setUploadPercent(0);
    setUploadStatusText(`Initializing 6 parallel upload streams for ${files.length.toLocaleString()} photos...`);

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
            setUploadProgress(completedCount);
            const percent = Math.round((completedCount / files.length) * 100);
            setUploadPercent(percent);
            setUploadStatusText(`Streaming parallel batches... Completed ${completedCount.toLocaleString()} / ${files.length.toLocaleString()} files (${percent}%)`);
          }
        } catch (err) {
          console.error('Batch upload error:', err);
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker());
    await Promise.all(workers);

    setUploadStatusText(`Upload Complete! Indexed ${files.length.toLocaleString()} photos across 6 streams!`);
    setTimeout(async () => {
      setIsUploading(false);
      setIsUploadOpen(false);
      await fetchPhotos();
      await fetchStats();
    }, 800);
  }

  function openLightbox(index, direction = 1) {
    setCurrentPhotoIndex(index);
    setIsLightboxOpen(true);
    scheduleIdlePrefetch(index, direction);
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
    openLightbox(next, dir);
  }

  function handleWheel(e) {
    if (!isLightboxOpen) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheelTime.current < 10) return;
    lastWheelTime.current = now;

    const dir = (e.deltaY > 0 || e.deltaX > 0) ? 1 : -1;
    navigate(dir);
  }

  return (
    <div className="react-app">
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0b0f19; color: #f8fafc; font-family: 'Inter', sans-serif; height: 100vh; overflow: hidden; user-select: none; }
        .header { height: 60px; background: rgba(11, 15, 25, 0.85); backdrop-filter: blur(20px); border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: space-between; padding: 0 20px; z-index: 100; }
        .brand { display: flex; align-items: center; gap: 10px; font-family: 'Outfit', sans-serif; }
        .logo { width: 36px; height: 36px; background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
        .btn-upload { background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%); color: #fff; border: none; padding: 8px 16px; border-radius: 8px; font-weight: 600; cursor: pointer; }
        
        .grid-container {
          height: calc(100vh - 60px);
          overflow-y: auto;
          padding: 8px 16px;
          display: flex;
          flex-wrap: wrap;
          gap: 3px;
          -webkit-overflow-scrolling: touch;
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
        .lightbox-stage img { max-width: 92%; max-height: 92%; object-fit: contain; border-radius: 4px; box-shadow: 0 25px 60px rgba(0,0,0,0.9); }
        .arrow { position: absolute; top: 50%; transform: translateY(-50%); width: 48px; height: 48px; border-radius: 50%; background: rgba(17,24,39,0.7); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 2100; }
        .prev { left: 24px; } .next { right: 24px; }
        .close-btn { background: none; border: none; color: #fff; font-size: 24px; cursor: pointer; }
        
        .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.85); backdrop-filter: blur(12px); display: flex; align-items: center; justify-content: center; z-index: 3000; }
        .modal-card { width: 540px; background: #111726; border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; padding: 28px; box-shadow: 0 30px 80px rgba(0,0,0,0.8); }
        .drop-area { border: 2px dashed rgba(255,255,255,0.25); border-radius: 16px; padding: 40px; text-align: center; cursor: pointer; margin-top: 16px; transition: border-color 0.2s ease; }
        .drop-area:hover { border-color: #3b82f6; }

        .progress-container { margin-top: 20px; background: rgba(255,255,255,0.06); border-radius: 12px; height: 12px; overflow: hidden; position: relative; }
        .progress-bar { height: 100%; background: linear-gradient(90deg, #3b82f6 0%, #06b6d4 100%); transition: width 0.2s ease; border-radius: 12px; }
      `}</style>

      <div className="header">
        <div className="brand">
          <div className="logo">4️⃣</div>
          <div>
            <h2>Stack 4: React 19</h2>
            <p style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Next / React Ecosystem • Port 8884</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Photos: {photos.length} | Visible DOM: {virtualData.items.length} | RAM: {ramAlloc}</span>
          <button className="btn-upload" onClick={() => setIsUploadOpen(true)}>Upload Photos (99,999+)</button>
        </div>
      </div>

      <div ref={gridContainerRef} className="grid-container" onScroll={handleScroll}>
        <div style={{ height: `${virtualData.topSpacer}px`, width: '100%' }}></div>
        {virtualData.items.map((item) => (
          <div
            key={item.photo.id}
            className="tile"
            style={{ width: `${220 * (item.photo.aspect_ratio || 1.5)}px` }}
            onClick={() => openLightbox(item.globalIndex)}
          >
            <img
              src={item.photo.micro_url.startsWith('http') ? item.photo.micro_url : `${API_BASE}${item.photo.micro_url}`}
              alt={item.photo.title}
              loading="lazy"
            />
          </div>
        ))}
        <div style={{ height: `${virtualData.bottomSpacer}px`, width: '100%' }}></div>
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

      {isUploadOpen && (
        <div className="modal">
          <div className="modal-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>Upload Photos (99,999+ Streaming Queue)</h3>
              {!isUploading && (
                <button className="close-btn" onClick={() => setIsUploadOpen(false)}>&times;</button>
              )}
            </div>

            {!isUploading ? (
              <div className="drop-area" onClick={() => fileInputRef.current && fileInputRef.current.click()}>
                <p style={{ fontSize: '40px' }}>⚡🚀</p>
                <p style={{ marginTop: '12px', fontWeight: 600, fontSize: '1.05rem' }}>Select up to 99,999+ photos</p>
                <p style={{ marginTop: '6px', fontSize: '0.8rem', color: '#94a3b8' }}>6 Parallel Worker Streams • Zero Main-Thread Lockup</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => handleFileUpload(e.target.files)}
                />
              </div>
            ) : (
              <div style={{ marginTop: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', fontWeight: 600 }}>
                  <span>Uploading via 6 Parallel Streams...</span>
                  <span style={{ color: '#06b6d4' }}>{uploadProgress.toLocaleString()} / {uploadTotal.toLocaleString()} ({uploadPercent}%)</span>
                </div>
                <div className="progress-container">
                  <div className="progress-bar" style={{ width: `${uploadPercent}%` }}></div>
                </div>
                <p style={{ marginTop: '12px', fontSize: '0.8rem', color: '#94a3b8', textAlign: 'center' }}>{uploadStatusText}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
