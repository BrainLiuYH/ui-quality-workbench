// Adapted with permission from SemineChen/yangao, commit
// beac836ba3c81b9a1d40bac8fe75af08444ab742.

export const MAX_NORMALIZED_PIXELS = 32_000_000

export function getImageDimensions(image, label = 'image') {
  if (!image) {
    throw new TypeError(`${label} is required`)
  }

  const width = Number(image.naturalWidth ?? image.videoWidth ?? image.width)
  const height = Number(image.naturalHeight ?? image.videoHeight ?? image.height)

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError(`${label} must be a decoded ImageBitmap or HTMLImageElement`)
  }

  return { width: Math.round(width), height: Math.round(height) }
}

/**
 * Build the shared coordinate space used by the comparison engine.
 *
 * Width is the only normalization axis: the narrower input is enlarged to the
 * wider input's width, and its height follows from the same scale. Neither
 * input is ever reduced or stretched non-proportionally. Both normalized
 * images are then top-left aligned on a transparent canvas tall enough for the
 * longer image.
 */
export function buildWidthNormalization(
  designImage,
  implementationImage,
  { maxPixels = MAX_NORMALIZED_PIXELS } = {},
) {
  const design = getImageDimensions(designImage, 'designImage')
  const implementation = getImageDimensions(implementationImage, 'implementationImage')
  const targetWidth = Math.max(design.width, implementation.width)
  const designScale = targetWidth / design.width
  const implementationScale = targetWidth / implementation.width
  const designHeight = Math.max(1, Math.round(design.height * designScale))
  const implementationHeight = Math.max(
    1,
    Math.round(implementation.height * implementationScale),
  )
  const canvasHeight = Math.max(designHeight, implementationHeight)
  const pixels = targetWidth * canvasHeight

  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
    const megapixels = Number.isFinite(pixels)
      ? (pixels / 1_000_000).toFixed(1)
      : 'an invalid number of'
    throw new RangeError(
      `Width-normalized comparison canvas would be ${targetWidth} × ${canvasHeight} ` +
      `(${megapixels} MP), exceeding the 32 MP safety limit. ` +
      'Use screenshots with closer widths/aspect ratios or crop them before analysis.',
    )
  }

  return {
    strategy: 'match-wider-width',
    alignment: 'top-left',
    background: 'transparent',
    targetWidth,
    designScale,
    implementationScale,
    designWidth: targetWidth,
    designHeight,
    implementationWidth: targetWidth,
    implementationHeight,
    canvasWidth: targetWidth,
    canvasHeight,
    pixels,
  }
}

export function buildComparisonProfile(designImage, implementationImage) {
  const design = getImageDimensions(designImage, 'designImage')
  const implementation = getImageDimensions(implementationImage, 'implementationImage')
  const normalization = buildWidthNormalization(designImage, implementationImage)
  const implementationAspect = implementation.height / implementation.width
  const mobilePortrait = implementationAspect > 1.45 && implementation.width <= 1600
  const ignoreTop = mobilePortrait
    ? Math.round(Math.min(implementation.height * 0.075, implementation.width * 0.12))
    : 0
  const widthsDiffer = design.width !== implementation.width
  const heightsDiffer = normalization.designHeight !== normalization.implementationHeight

  return {
    mode: widthsDiffer ? 'width-normalized' : 'same-width',
    label: widthsDiffer ? '等比放大至同宽' : heightsDiffer ? '同宽顶部对齐' : '原尺寸对比',
    ignoreTop,
    mobilePortrait,
    designWidth: design.width,
    designHeight: design.height,
    implementationWidth: implementation.width,
    implementationHeight: implementation.height,
    targetWidth: normalization.targetWidth,
    targetHeight: normalization.canvasHeight,
    designScale: normalization.designScale,
    implementationScale: normalization.implementationScale,
    designNormalizedHeight: normalization.designHeight,
    implementationNormalizedHeight: normalization.implementationHeight,
    comparisonWidth: normalization.canvasWidth,
    comparisonHeight: normalization.canvasHeight,
    widthsDiffer,
    heightsDiffer,
    alignment: normalization.alignment,
  }
}

export function isStatusBarOnly(box, profile) {
  const bottom = profile?.ignoreTop || 0
  if (!bottom || !box) return false

  const height = Math.max(1, box.h)
  const overlap = Math.max(
    0,
    Math.min(box.y + height, bottom) - Math.max(0, box.y),
  )
  const buffer = Math.max(
    4,
    Math.round((profile?.comparisonWidth || profile?.implementationWidth || 1000) * 0.015),
  )

  return box.y + height <= bottom + buffer ||
    box.y + height / 2 < bottom ||
    overlap / height >= 0.72
}

export function excludeStatusBarIssues(issues, profile) {
  return issues.filter((issue) => !isStatusBarOnly(issue.box, profile))
}
