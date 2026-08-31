function positiveNumber(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function getComparisonPlacement(profile, kind, source = {}) {
  if (!['design', 'implementation'].includes(kind)) {
    throw new TypeError('kind must be "design" or "implementation"');
  }

  const prefix = kind === 'design' ? 'design' : 'implementation';
  const sourceWidth = positiveNumber(source.width);
  const sourceHeight = positiveNumber(source.height);
  const canvasWidth = positiveNumber(profile?.comparisonWidth, positiveNumber(profile?.targetWidth, sourceWidth));
  const canvasHeight = positiveNumber(profile?.comparisonHeight, positiveNumber(profile?.targetHeight, sourceHeight));
  const width = positiveNumber(profile?.[`${prefix}NormalizedWidth`], canvasWidth);
  const height = positiveNumber(profile?.[`${prefix}NormalizedHeight`], sourceHeight);
  const scale = positiveNumber(profile?.[`${prefix}Scale`], width / sourceWidth);
  const offsetX = nonNegativeNumber(profile?.[`${prefix}OffsetX`]);
  const offsetY = nonNegativeNumber(profile?.[`${prefix}OffsetY`]);

  return {
    width,
    height,
    scale,
    offsetX,
    offsetY,
    canvasWidth,
    canvasHeight,
    right: offsetX + width,
    bottom: offsetY + height,
  };
}

export function intersectCanvasCropWithPlacement(rect, placement) {
  const x = nonNegativeNumber(rect?.x);
  const y = nonNegativeNumber(rect?.y);
  const width = positiveNumber(rect?.width);
  const height = positiveNumber(rect?.height);
  const left = Math.max(placement.offsetX, x);
  const top = Math.max(placement.offsetY, y);
  const right = Math.min(placement.right, x + width);
  const bottom = Math.min(placement.bottom, y + height);

  if (right <= left || bottom <= top) return null;

  return {
    canvas: {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    },
    source: {
      x: (left - placement.offsetX) / placement.scale,
      y: (top - placement.offsetY) / placement.scale,
      width: (right - left) / placement.scale,
      height: (bottom - top) / placement.scale,
    },
  };
}
