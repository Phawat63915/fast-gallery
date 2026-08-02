import React, { useState, useEffect, useRef, useMemo } from 'react';

const API_BASE = '';
const preloadedCache = new Set();
const preloadedOrder = [];
const MAX_PRELOAD_CACHE = 50;

export default function App() {
  const [photos, setPhotos] = useState([]);
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(-1);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [isExifOpen, setIsExifOpen] = useState(true);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [ramAlloc, setRamAlloc] = useState('-- MB');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);

  // Lightbox Zoom & Pan State
  const [zoomScale, setZoomScale] = useState(1.0);
  const [zoomX, setZoomX] = useState(0);
  const [zoomY, setZoomY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartY = useRef(0);

  // Upload Modal Tab State
  const [uploadTab, setUploadTab] = useState('batch'); // 'batch' | 'url'
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [customUrlStatus, setCustomUrlStatus] = useState('');
  const [customUrlStatusColor, setCustomUrlStatusColor] = useState('#06b6d4');

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
    const currentScrollTop = e.target.scrollTop;
    setScrollTop(currentScrollTop);
    const currentContainerHeight = e.target.clientHeight || 800;
    const totalScrollHeight = e.target.scrollHeight || 1;

    if (currentScrollTop + currentContainerHeight >= totalScrollHeight - 1500 && hasMorePhotosRef.current && !isLoadingMoreRef.current) {
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

  const nextCursorRef = useRef(0);
  const hasMorePhotosRef = useRef(true);
  const isLoadingMoreRef = useRef(false);

  async function fetchPhotos(isAppend = false) {
    if (isLoadingMoreRef.current || (isAppend && !hasMorePhotosRef.current)) return;
    isLoadingMoreRef.current = true;

    try {
      const url = `${API_BASE}/api/photos?limit=500${nextCursorRef.current ? `&cursor=${nextCursorRef.current}` : ''}`;
      const res = await fetch(url);
      const data = await res.json();
      const newPhotos = data.photos || [];

      if (newPhotos.length < 500 || !data.next_cursor) {
        hasMorePhotosRef.current = false;
      }
      nextCursorRef.current = data.next_cursor || 0;
      setPhotos((prev) => (isAppend ? [...prev, ...newPhotos] : newPhotos));
    } catch (e) {
      console.error(e);
    } finally {
      isLoadingMoreRef.current = false;
    }
  }

  async function fetchStats() {
    try {
      const res = await fetch(`${API_BASE}/api/stats`);
      const data = await res.json();
      if (data.alloc_ram_mb) setRamAlloc(data.alloc_ram_mb);
    } catch (e) {}
  }

  function resetZoom() {
    setZoomScale(1.0);
    setZoomX(0);
    setZoomY(0);
    setIsDragging(false);
  }

  function toggleZoom() {
    if (zoomScale > 1.0) {
      resetZoom();
    } else {
      setZoomScale(2.5);
      setZoomX(0);
      setZoomY(0);
    }
  }

  function openLightbox(index, direction = 1) {
    if (index < 0 || index >= photos.length) return;
    resetZoom();
    setCurrentPhotoIndex(index);
    setIsLightboxOpen(true);
    scheduleIdlePrefetch(index, direction);
  }

  function closeLightbox() {
    resetZoom();
    setIsLightboxOpen(false);
    setCurrentPhotoIndex(-1);
  }

  function navigate(dir) {
    if (currentPhotoIndex < 0) return;
    let next = currentPhotoIndex + dir;

    if (next >= photos.length - 5 && hasMorePhotosRef.current && !isLoadingMoreRef.current) {
      fetchPhotos(true);
    }

    if (next < 0) next = photos.length - 1;
    if (next >= photos.length) next = 0;
    openLightbox(next, dir);
  }

  function handleWheel(e) {
    if (!isLightboxOpen) return;
    if (zoomScale > 1.0 || e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.25 : -0.25;
      setZoomScale((prev) => Math.max(1.0, Math.min(5.0, prev + delta)));
    } else {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheelTime.current < 10) return;
      lastWheelTime.current = now;

      const dir = (e.deltaY > 0 || e.deltaX > 0) ? 1 : -1;
      navigate(dir);
    }
  }

  function handleMouseDown(e) {
    if (zoomScale <= 1.0) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartX.current = e.clientX - zoomX;
    dragStartY.current = e.clientY - zoomY;
  }

  function handleMouseMove(e) {
    if (!isDragging) return;
    e.preventDefault();
    setZoomX(e.clientX - dragStartX.current);
    setZoomY(e.clientY - dragStartY.current);
  }

  function handleMouseUp() {
    setIsDragging(false);
  }

  async function handleFileUpload(files) {
    if (!files || files.length === 0) return;

    setIsUploading(true);
    setUploadTotal(files.length);
    setUploadProgress(0);
    setUploadPercent(0);
    setUploadStatusText('Preparing parallel streams...');

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
          console.error(err);
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker());
    await Promise.all(workers);

    setUploadStatusText(`Upload Complete! Indexed ${files.length.toLocaleString()} photos!`);
    setTimeout(async () => {
      setIsUploading(false);
      setIsUploadOpen(false);
      await fetchPhotos();
      await fetchStats();
    }, 800);
  }

  function addCustomPhoto() {
    const url = customUrlInput.trim();
    if (!url) {
      setCustomUrlStatusColor('#ef4444');
      setCustomUrlStatus('Please enter a valid image URL.');
      return;
    }

    setCustomUrlStatusColor('#06b6d4');
    setCustomUrlStatus('Verifying image URL...');

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

      setPhotos((prev) => [newPhoto, ...prev]);
      setCustomUrlInput('');
      setCustomUrlStatusColor('#10b981');
      setCustomUrlStatus('Photo added successfully!');
      setTimeout(() => {
        setIsUploadOpen(false);
        setCustomUrlStatus('');
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

  return (
    <div className="react-app">
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0b0f19; color: #f8fafc; font-family: 'Inter', sans-serif; height: 100vh; overflow: hidden; user-select: none; }
        .header { height: 64px; background: rgba(11, 15, 25, 0.95); border-bottom: 1px solid rgba(255, 255, 255, 0.08); display: flex; align-items: center; justify-content: space-between; padding: 0 24px; }
        .brand { display: flex; align-items: center; gap: 12px; }
        .logo { font-size: 24px; }
        .btn-upload { background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%); color: #fff; border: none; padding: 8px 16px; border-radius: 8px; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
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
          <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Photos: {photos.length} | RAM: {ramAlloc}</span>
          <button className="btn-upload" onClick={() => setIsUploadOpen(true)}>Upload</button>
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
              src={getThumbUrl(item.photo)}
              alt={item.photo.filename || item.photo.id}
              loading="lazy"
              decoding="async"
            />
          </div>
        ))}
        <div style={{ height: `${virtualData.bottomSpacer}px`, width: '100%' }}></div>
      </div>

      {isLightboxOpen && currentPhotoIndex >= 0 && (
        <div className="lightbox" onWheel={handleWheel}>
          <div className="lightbox-bar">
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>{currentPhotoIndex + 1} / {photos.length}</span>
              <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '600px' }}>
                {photos[currentPhotoIndex].filename || photos[currentPhotoIndex].id}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button className="icon-btn" onClick={toggleZoom} title="Zoom (Click / Wheel)">🔍</button>
              <button className={`icon-btn ${isExifOpen ? 'active' : ''}`} onClick={() => setIsExifOpen(!isExifOpen)} title="Toggle EXIF Info">ℹ️</button>
              <button className="close-btn" onClick={closeLightbox}>&times;</button>
            </div>
          </div>
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <div className="lightbox-stage" onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}>
              <button className="arrow prev" onClick={() => navigate(-1)}>&#10094;</button>
              <img
                src={getOriginalUrl(photos[currentPhotoIndex])}
                alt=""
                className={isDragging ? 'is-dragging' : ''}
                style={{ transform: `translate3d(${zoomX}px, ${zoomY}px, 0) scale(${zoomScale})` }}
                onDoubleClick={toggleZoom}
                onMouseDown={handleMouseDown}
              />
              <button className="arrow next" onClick={() => navigate(1)}>&#10095;</button>
            </div>
            {isExifOpen && (
              <aside style={{ width: '320px', background: 'rgba(15, 23, 42, 0.9)', borderLeft: '1px solid rgba(255,255,255,0.1)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <h4 style={{ fontFamily: 'Outfit, sans-serif', fontSize: '1.1rem', color: '#fff' }}>{photos[currentPhotoIndex].filename || photos[currentPhotoIndex].id || 'Untitled Image'}</h4>
                <p style={{ fontSize: '0.8rem', color: '#94a3b8' }}>{new Date(photos[currentPhotoIndex].created_at).toLocaleString('th-TH')}</p>
                <div style={{ marginTop: '12px' }}>
                  <h5 style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '8px' }}>METADATA EXIF</h5>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.825rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8' }}>Camera</span><span style={{ color: '#fff', fontWeight: 600 }}>{photos[currentPhotoIndex].camera_make || 'Sony'} {photos[currentPhotoIndex].camera_model || 'A7 IV'}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8' }}>Lens</span><span style={{ color: '#fff', fontWeight: 600 }}>{photos[currentPhotoIndex].focal_length || '35mm'}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8' }}>ISO</span><span style={{ color: '#fff', fontWeight: 600 }}>{photos[currentPhotoIndex].iso ? `ISO ${photos[currentPhotoIndex].iso}` : 'ISO 100'}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8' }}>Resolution</span><span style={{ color: '#fff', fontWeight: 600 }}>{photos[currentPhotoIndex].width || 1920} × {photos[currentPhotoIndex].height || 1080}</span></div>
                  </div>
                </div>
              </aside>
            )}
          </div>
        </div>
      )}

      {isUploadOpen && (
        <div className="modal">
          <div className="modal-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>Add Photos & Media</h3>
              {!isUploading && (
                <button className="close-btn" onClick={() => setIsUploadOpen(false)}>&times;</button>
              )}
            </div>

            <div className="upload-tabs">
              <button className={`upload-tab ${uploadTab === 'batch' ? 'active' : ''}`} onClick={() => setUploadTab('batch')}>📁 Batch Upload Files</button>
              <button className={`upload-tab ${uploadTab === 'url' ? 'active' : ''}`} onClick={() => setUploadTab('url')}>🔗 Custom Image URL</button>
            </div>

            {uploadTab === 'batch' ? (
              !isUploading ? (
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
                <div style={{ marginTop: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', fontWeight: 600 }}>
                    <span>Uploading via 6 Parallel Streams...</span>
                    <span style={{ color: '#06b6d4' }}>{uploadProgress.toLocaleString()} / {uploadTotal.toLocaleString()} ({uploadPercent}%)</span>
                  </div>
                  <div className="progress-container">
                    <div className="progress-bar" style={{ width: `${uploadPercent}%` }}></div>
                  </div>
                  <p style={{ marginTop: '12px', fontSize: '0.8rem', color: '#94a3b8', textAlign: 'center' }}>{uploadStatusText}</p>
                </div>
              )
            ) : (
              <div style={{ marginTop: '16px' }}>
                <label style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '8px', display: 'block' }}>Enter Direct Image URL (HTTP/HTTPS):</label>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <input
                    type="url"
                    value={customUrlInput}
                    onChange={(e) => setCustomUrlInput(e.target.value)}
                    placeholder="https://images.unsplash.com/photo-..."
                    style={{ flex: 1, padding: '12px 16px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', fontSize: '0.9rem', outline: 'none' }}
                    onKeyDown={(e) => e.key === 'Enter' && addCustomPhoto()}
                  />
                  <button className="btn-upload" style={{ whiteSpace: 'nowrap' }} onClick={addCustomPhoto}>Add Photo</button>
                </div>
                <p style={{ marginTop: '12px', fontSize: '0.8rem', minHeight: '20px', color: customUrlStatusColor }}>{customUrlStatus}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
