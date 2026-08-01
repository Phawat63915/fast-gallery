self.onmessage = function (e) {
  const { photos, containerWidth, targetRowHeight, gap } = e.data;
  if (!photos || photos.length === 0 || containerWidth <= 0) {
    self.postMessage({ rows: [], totalHeight: 0 });
    return;
  }

  const rows = [];
  let currentRow = [];
  let currentAspectRatioSum = 0;
  let currentY = 0;
  const gridGap = gap !== undefined ? gap : 3;

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const ar = photo.aspect_ratio || 1.5;
    currentRow.push(photo);
    currentAspectRatioSum += ar;

    const availableWidth = containerWidth - (currentRow.length - 1) * gridGap;
    const projectedHeight = availableWidth / currentAspectRatioSum;

    if (projectedHeight <= targetRowHeight || i === photos.length - 1) {
      let rowHeight = Math.max(140, Math.min(300, projectedHeight));
      if (i === photos.length - 1 && projectedHeight > targetRowHeight * 1.35) {
        rowHeight = targetRowHeight;
      }

      let currentX = 0;
      const layoutItems = [];

      for (let j = 0; j < currentRow.length; j++) {
        const item = currentRow[j];
        const itemAR = item.aspect_ratio || 1.5;
        let itemWidth = Math.floor(rowHeight * itemAR);

        if (j === currentRow.length - 1 && projectedHeight <= targetRowHeight) {
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

  self.postMessage({ rows: rows, totalHeight: currentY });
};
