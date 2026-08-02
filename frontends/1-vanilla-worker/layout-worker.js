let cachedState = {
  photosLength: 0,
  containerWidth: 0,
  targetRowHeight: 220,
  gap: 3,
  rows: [],
  currentRow: [],
  currentAspectRatioSum: 0,
  currentY: 0,
};

self.onmessage = function (e) {
  const { photos, containerWidth, targetRowHeight, gap, isAppend } = e.data;
  if (!photos || photos.length === 0 || containerWidth <= 0) {
    cachedState.rows = [];
    cachedState.photosLength = 0;
    cachedState.currentY = 0;
    self.postMessage({ rows: [], totalHeight: 0 });
    return;
  }

  const gridGap = gap !== undefined ? gap : 3;
  const targetH = targetRowHeight || 220;

  let startIndex = 0;
  let rows = [];
  let currentRow = [];
  let currentAspectRatioSum = 0;
  let currentY = 0;

  const canAppend = isAppend &&
    cachedState.containerWidth === containerWidth &&
    cachedState.targetRowHeight === targetH &&
    cachedState.gap === gridGap &&
    photos.length > cachedState.photosLength;

  if (canAppend) {
    rows = cachedState.rows;
    currentRow = cachedState.currentRow;
    currentAspectRatioSum = cachedState.currentAspectRatioSum;
    currentY = cachedState.currentY;
    startIndex = cachedState.photosLength;
  }

  for (let i = startIndex; i < photos.length; i++) {
    const photo = photos[i];
    const ar = photo.aspect_ratio || 1.5;
    currentRow.push(photo);
    currentAspectRatioSum += ar;

    const availableWidth = containerWidth - (currentRow.length - 1) * gridGap;
    const projectedHeight = availableWidth / currentAspectRatioSum;

    if (projectedHeight <= targetH || i === photos.length - 1) {
      let rowHeight = Math.max(140, Math.min(300, projectedHeight));
      if (i === photos.length - 1 && projectedHeight > targetH * 1.35) {
        rowHeight = targetH;
      }

      let currentX = 0;
      const layoutItems = [];

      for (let j = 0; j < currentRow.length; j++) {
        const item = currentRow[j];
        const itemAR = item.aspect_ratio || 1.5;
        let itemWidth = Math.floor(rowHeight * itemAR);

        if (j === currentRow.length - 1 && projectedHeight <= targetH) {
          const usedWidth = layoutItems.reduce((acc, it) => acc + it.width + gridGap, 0);
          const remaining = containerWidth - usedWidth;
          if (remaining > 0) itemWidth = remaining;
        }

        layoutItems.push({
          photo: item,
          x: currentX,
          y: currentY,
          width: itemWidth,
          height: Math.floor(rowHeight),
        });

        currentX += itemWidth + gridGap;
      }

      rows.push({ y: currentY, height: rowHeight, items: layoutItems });
      currentY += Math.floor(rowHeight) + gridGap;
      currentRow = [];
      currentAspectRatioSum = 0;
    }
  }

  cachedState = {
    photosLength: photos.length,
    containerWidth: containerWidth,
    targetRowHeight: targetH,
    gap: gridGap,
    rows: rows,
    currentRow: currentRow,
    currentAspectRatioSum: currentAspectRatioSum,
    currentY: currentY,
  };

  self.postMessage({ rows: rows, totalHeight: currentY });
};
