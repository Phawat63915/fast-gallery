// FastGallery Multi-Engine Layout Worker (Masonry Pinterest vs Uniform Grid Google Photos)
// Features: 0% Cropping Masonry Waterfall, Pixel-Perfect Symmetric Grid, Zero Lag

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

  let cols = 2; // Mobile Portrait default (2 columns)
  if (containerWidth > 1400) {
    cols = 5;
  } else if (containerWidth > 1000) {
    cols = 4;
  } else if (containerWidth > 580) {
    cols = 3;
  }

  const totalGaps = (cols - 1) * gridGap;
  const colWidth = Math.floor((containerWidth - totalGaps) / cols);

  if (layoutMode === 'masonry') {
    // -------------------------------------------------------------
    // 1. Pinterest / Unsplash Masonry Engine (0% Cropping, Full Photo)
    // -------------------------------------------------------------
    const colHeights = new Array(cols).fill(0);
    const colItems = Array.from({ length: cols }, () => []);

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const ar = photo.aspect_ratio || (photo.width && photo.height ? photo.width / photo.height : 1.5);
      const minCol = colHeights.indexOf(Math.min(...colHeights));

      const itemW = colWidth;
      const itemH = Math.max(60, Math.min(600, Math.floor(colWidth / ar)));
      const x = minCol * (colWidth + gridGap);
      const y = colHeights[minCol];

      colItems[minCol].push({
        photo: photo,
        x: x,
        y: y,
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
  // 2. Uniform Responsive Grid Engine (Google / Apple Photos Mode)
  // -------------------------------------------------------------
  const targetAR = 1.6;
  const tileHeight = Math.floor(colWidth / targetAR);
  const extraPixels = containerWidth - (colWidth * cols + totalGaps);

  let rows = [];
  let currentY = 0;

  for (let i = 0; i < photos.length; i += cols) {
    const rowPhotos = photos.slice(i, i + cols);
    const layoutItems = [];
    let currentX = 0;

    for (let c = 0; c < rowPhotos.length; c++) {
      const photo = rowPhotos[c];
      const itemW = colWidth + (c === rowPhotos.length - 1 && rowPhotos.length === cols ? extraPixels : 0);

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
