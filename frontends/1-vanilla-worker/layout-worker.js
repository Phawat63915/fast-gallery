// FastGallery Resolution-Aware Multi-Engine Layout Worker
// Features: Dynamic Zoom Scaling (Target 240px), Strict Portrait Height Clamping, Anti-Pixelation Protection

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

  // Dynamic Responsive Column Math (Target ~240px - scales dynamically when zooming Ctrl +/-)
  const targetColWidth = 240;
  let cols = Math.max(2, Math.floor((containerWidth + gridGap) / (targetColWidth + gridGap)));

  const totalGaps = (cols - 1) * gridGap;
  const availableWidth = containerWidth - totalGaps;
  const baseColWidth = Math.floor(availableWidth / cols);
  const remainderPixels = availableWidth % cols;

  if (layoutMode === 'masonry') {
    // -------------------------------------------------------------
    // 1. Resolution-Aware Masonry Engine (Clamped Portrait Height & Anti-Pixelation)
    // -------------------------------------------------------------
    const colHeights = new Array(cols).fill(0);
    const colItems = Array.from({ length: cols }, () => []);

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      let rawAR = photo.aspect_ratio || (photo.width && photo.height ? photo.width / photo.height : 1.5);
      
      // Strict Portrait Height Clamping & Anti-Pixelation Rule:
      // Portrait photos (rawAR < 1.0) are clamped so their height NEVER exceeds standard landscape photo height!
      let effectiveAR = rawAR;
      if (rawAR < 1.0) {
        effectiveAR = Math.max(1.0, rawAR);
      }

      const minCol = colHeights.indexOf(Math.min(...colHeights));
      const itemW = baseColWidth + (minCol < remainderPixels ? 1 : 0);
      
      // Standard landscape height cap (~260px max)
      let maxH = Math.min(260, Math.floor(itemW * 0.9));

      // Anti-pixelation cap: If photo native height is small, don't stretch it bigger than native height!
      if (photo.height && photo.height > 0 && photo.height < 500) {
        maxH = Math.min(maxH, photo.height);
      }

      const minH = Math.max(70, Math.floor(itemW * 0.45));
      const itemH = Math.max(minH, Math.min(maxH, Math.floor(itemW / effectiveAR)));

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
    self.postMessage({ rows: rows, totalHeight: totalHeight });
    return;
  }

  // -------------------------------------------------------------
  // 2. Resolution-Aware Smart Grid Engine (Multi-Span 4K & Anti-Blur)
  // -------------------------------------------------------------
  const colOccupiedY = new Array(cols).fill(0);
  const allLayoutItems = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const rawAR = photo.aspect_ratio || (photo.width && photo.height ? photo.width / photo.height : 1.5);
    const photoW = photo.width || 1200;
    
    let colSpan = 1;
    if (photoW >= 1200 && rawAR >= 1.35 && cols >= 4) {
      colSpan = 2;
    }

    let bestCol = 0;
    let minY = Infinity;

    for (let c = 0; c <= cols - colSpan; c++) {
      let maxHInSpan = 0;
      for (let s = 0; s < colSpan; s++) {
        maxHInSpan = Math.max(maxHInSpan, colOccupiedY[c + s]);
      }
      if (maxHInSpan < minY) {
        minY = maxHInSpan;
        bestCol = c;
      }
    }

    let itemW = 0;
    for (let s = 0; s < colSpan; s++) {
      itemW += baseColWidth + ((bestCol + s) < remainderPixels ? 1 : 0);
    }
    itemW += (colSpan - 1) * gridGap;

    let itemH = Math.floor(itemW / Math.max(0.75, Math.min(2.4, rawAR)));
    if (colSpan === 2) {
      itemH = Math.min(300, Math.max(160, itemH));
    } else {
      itemH = Math.min(240, Math.max(110, itemH));
    }

    let currentX = 0;
    for (let c = 0; c < bestCol; c++) {
      currentX += (baseColWidth + (c < remainderPixels ? 1 : 0)) + gridGap;
    }

    const itemY = minY;

    allLayoutItems.push({
      photo: photo,
      x: currentX,
      y: itemY,
      width: itemW,
      height: itemH,
    });

    for (let s = 0; s < colSpan; s++) {
      colOccupiedY[bestCol + s] = itemY + itemH + gridGap;
    }
  }

  allLayoutItems.sort((a, b) => a.y - b.y);

  const rows = [];
  let currentY = -1;
  let currentRow = null;

  for (let item of allLayoutItems) {
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

  const totalHeight = Math.max(...colOccupiedY);

  cachedState = {
    photosLength: photos.length,
    containerWidth: containerWidth,
    gap: gridGap,
    mode: layoutMode,
    rows: rows,
  };

  self.postMessage({ rows: rows, totalHeight: totalHeight });
};
