// FastGallery Multi-Engine Layout Worker (Masonry Pinterest vs Uniform Grid Google Photos)
// Features: Stable 2-6 Column Grid, Clamped Aspect Ratios, Zero Lag

let cachedState = {
  photosLength: 0,
  containerWidth: 0,
  gap: 2,
  mode: 'masonry',
  rows: [],
};

self.onmessage = function (e) {
  const { photos, containerWidth, gap, mode } = e.data;
  if (!photos || photos.length === 0 || containerWidth <= 0) {
    cachedState.rows = [];
    cachedState.photosLength = 0;
    self.postMessage({ rows: [], totalHeight: 0 });
    return;
  }

  const gridGap = gap !== undefined ? gap : 2;
  const layoutMode = mode || 'masonry';

  // Stable Responsive Column Grid (Max 6 columns on large desktops, 5 on laptops, 2 on mobile)
  let cols = 2;
  if (containerWidth > 1500) {
    cols = 6;
  } else if (containerWidth > 1150) {
    cols = 5;
  } else if (containerWidth > 800) {
    cols = 4;
  } else if (containerWidth > 500) {
    cols = 3;
  }

  const totalGaps = (cols - 1) * gridGap;
  const availableWidth = containerWidth - totalGaps;
  const baseColWidth = Math.floor(availableWidth / cols);
  const remainderPixels = availableWidth % cols;

  if (layoutMode === 'masonry') {
    // -------------------------------------------------------------
    // 1. Masonry Engine (Pinterest Style: Full Uncropped Photos)
    // -------------------------------------------------------------
    const colHeights = new Array(cols).fill(0);
    const colItems = Array.from({ length: cols }, () => []);

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      let rawAR = photo.aspect_ratio || (photo.width && photo.height ? photo.width / photo.height : 1.5);
      
      // Clamp aspect ratio between 0.75 (portrait) and 2.0 (landscape) to prevent oversized stretching
      const ar = Math.max(0.75, Math.min(2.0, rawAR));

      const minCol = colHeights.indexOf(Math.min(...colHeights));
      const itemW = baseColWidth + (minCol < remainderPixels ? 1 : 0);
      
      // Calculate balanced item height (capped at 380px max)
      const maxH = Math.min(380, Math.floor(itemW * 1.35));
      const minH = Math.max(100, Math.floor(itemW * 0.5));
      const itemH = Math.max(minH, Math.min(maxH, Math.floor(itemW / ar)));

      let currentX = 0;
      for (let c = 0; c < minCol; c++) {
        currentX += (baseColWidth + (c < remainderPixels ? 1 : 0)) + gridGap;
      }

      colItems[minCol].push({
        photo: photo,
        x: currentX,
        y: colHeights[minCol],
        width: itemW,
        height: itemH,
      });

      colHeights[minCol] += itemH + gridGap;
    }

    const allItems = colItems.flat();
    allItems.sort((a, b) => a.y - b.y);

    const rows = [];
    let currentY = -1;
    let currentRow = null;

    for (let item of allItems) {
      if (item.y !== currentY) {
        if (currentRow) rows.push(currentRow);
        currentY = item.y;
        currentRow = { y: currentY, height: item.height, items: [item] };
      } else if (currentRow) {
        currentRow.items.push(item);
        currentRow.height = Math.max(currentRow.height, item.height);
      }
    }
    if (currentRow) rows.push(currentRow);

    const totalHeight = Math.max(...colHeights);

    cachedState = {
      photosLength: photos.length,
      containerWidth: containerWidth,
      gap: gridGap,
      mode: layoutMode,
      rows: rows,
    };

    self.postMessage({ rows: rows, totalHeight: totalHeight });
    return;
  }

  // -------------------------------------------------------------
  // 2. Uniform Responsive Grid Engine (Google Photos Style: Equal Rows)
  // -------------------------------------------------------------
  const targetAR = 1.6;
  const tileHeight = Math.floor(baseColWidth / targetAR);

  let rows = [];
  let currentY = 0;

  for (let i = 0; i < photos.length; i += cols) {
    const rowPhotos = photos.slice(i, i + cols);
    const layoutItems = [];
    let currentX = 0;

    for (let c = 0; c < rowPhotos.length; c++) {
      const photo = rowPhotos[c];
      const itemW = baseColWidth + (c < remainderPixels ? 1 : 0);

      layoutItems.push({
        photo: photo,
        x: currentX,
        y: currentY,
        width: itemW,
        height: tileHeight,
      });

      currentX += itemW + gridGap;
    }

    rows.push({
      y: currentY,
      height: tileHeight,
      items: layoutItems,
    });

    currentY += tileHeight + gridGap;
  }

  cachedState = {
    photosLength: photos.length,
    containerWidth: containerWidth,
    gap: gridGap,
    mode: layoutMode,
    rows: rows,
  };

  self.postMessage({ rows: rows, totalHeight: currentY });
};
