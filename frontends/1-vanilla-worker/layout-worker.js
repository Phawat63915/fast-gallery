// FastGallery Worker Engine: Google / Apple Photos Style Uniform Responsive Grid
// Features: Pixel-Perfect Symmetric Columns, 0% Distortion, Zero Blank Margins

let cachedState = {
  photosLength: 0,
  containerWidth: 0,
  gap: 2,
  rows: [],
};

self.onmessage = function (e) {
  const { photos, containerWidth, gap } = e.data;
  if (!photos || photos.length === 0 || containerWidth <= 0) {
    cachedState.rows = [];
    cachedState.photosLength = 0;
    self.postMessage({ rows: [], totalHeight: 0 });
    return;
  }

  const gridGap = gap !== undefined ? gap : 2;

  // Responsive column counts (Google Photos style)
  let cols = 2; // Mobile Portrait default (2 perfectly symmetric columns)
  if (containerWidth > 1400) {
    cols = 5;
  } else if (containerWidth > 1000) {
    cols = 4;
  } else if (containerWidth > 580) {
    cols = 3;
  }

  // Uniform tile aspect ratio (1.6 for widescreen 16:9 photos)
  const targetAR = 1.6;

  const totalGaps = (cols - 1) * gridGap;
  const colWidth = Math.floor((containerWidth - totalGaps) / cols);
  const extraPixels = containerWidth - (colWidth * cols + totalGaps);
  const tileHeight = Math.floor(colWidth / targetAR);

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
    rows: rows,
  };

  self.postMessage({ rows: rows, totalHeight: currentY });
};
