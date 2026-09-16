// Adapted with permission from SemineChen/yangao, commit
// beac836ba3c81b9a1d40bac8fe75af08444ab742.

export const MAX_NORMALIZED_PIXELS = 32_000_000
const SUPPORTED_ALIGNMENTS = new Set(['top-left', 'bottom-left', 'element'])
const SUPPORTED_SCALE_MODES = new Set(['width-normalized', 'responsive'])

export function suggestScaleMode(designImage, implementationImage) {
  const design = getImageDimensions(designImage, 'designImage')
  const implementation = getImageDimensions(implementationImage, 'implementationImage')
  if (design.width === implementation.width) return 'width-normalized'
  // A hint, not proof of matching DPR: keep the choice visible and editable.
  const portrait = [design, implementation].every(({ width, height }) =>
    height / width > 1.45 && width <= 1600)
  const widthRatio = Math.max(design.width, implementation.width) /
    Math.min(design.width, implementation.width)
  return portrait && widthRatio <= 1.15 ? 'responsive' : 'width-normalized'
}

function assertAlignment(alignment) {
  if (!SUPPORTED_ALIGNMENTS.has(alignment)) {
    throw new TypeError('alignment must be "top-left", "bottom-left", or "element"')
  }
  return alignment
}

function normalizeAnchor(anchor, width, height) {
  if (!anchor || typeof anchor !== 'object') return null
  const x = Number(anchor.x)
  const y = Number(anchor.y)
  const w = Number(anchor.width ?? anchor.w)
  const h = Number(anchor.height ?? anchor.h)
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null

  const left = Math.max(0, Math.min(width - 1, x))
  const top = Math.max(0, Math.min(height - 1, y))
  const right = Math.max(left + 1, Math.min(width, x + w))
  const bottom = Math.max(top + 1, Math.min(height, y + h))
  const fallbackAnchorX = left + (right - left) / 2
  const fallbackAnchorY = top + (bottom - top) / 2
  const requestedAnchorX = Number(anchor.anchorX)
  const requestedAnchorY = Number(anchor.anchorY)
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    anchorX: Number.isFinite(requestedAnchorX)
      ? Math.max(left, Math.min(right, requestedAnchorX))
      : fallbackAnchorX,
    anchorY: Number.isFinite(requestedAnchorY)
      ? Math.max(top, Math.min(bottom, requestedAnchorY))
      : fallbackAnchorY,
  }
}

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
 * In responsive mode retain both images' source pixels (same-DPR assumption).
 * In width-normalized mode enlarge only the narrower input proportionally.
 * Neither mode crops or stretches the original images non-uniformly.
 */
export function buildWidthNormalization(
  designImage,
  implementationImage,
  { maxPixels = MAX_NORMALIZED_PIXELS, alignment = 'top-left', anchors = null,
    scaleMode = 'width-normalized' } = {},
) {
  assertAlignment(alignment)
  if (!SUPPORTED_SCALE_MODES.has(scaleMode)) {
    throw new TypeError('scaleMode must be "width-normalized" or "responsive"')
  }
  const design = getImageDimensions(designImage, 'designImage')
  const implementation = getImageDimensions(implementationImage, 'implementationImage')
  const targetWidth = Math.max(design.width, implementation.width)
  const designScale = scaleMode === 'responsive' ? 1 : targetWidth / design.width
  const implementationScale = scaleMode === 'responsive' ? 1 : targetWidth / implementation.width
  const designWidth = Math.round(design.width * designScale)
  const implementationWidth = Math.round(implementation.width * implementationScale)
  const designHeight = Math.max(1, Math.round(design.height * designScale))
  const implementationHeight = Math.max(
    1,
    Math.round(implementation.height * implementationScale),
  )
  let canvasWidth = targetWidth
  let canvasHeight = Math.max(designHeight, implementationHeight)
  const bottomAligned = alignment === 'bottom-left'
  let designOffsetX = 0
  let designOffsetY = bottomAligned ? canvasHeight - designHeight : 0
  let implementationOffsetX = 0
  let implementationOffsetY = bottomAligned ? canvasHeight - implementationHeight : 0
  const normalizedAnchors = {
    design: normalizeAnchor(anchors?.design, designWidth, designHeight),
    implementation: normalizeAnchor(
      anchors?.implementation,
      implementationWidth,
      implementationHeight,
    ),
  }
  const anchorReady = Boolean(normalizedAnchors.design && normalizedAnchors.implementation)
  let anchorDelta = null

  if (alignment === 'element' && anchorReady) {
    const designCenterX = normalizedAnchors.design.anchorX
    const designCenterY = normalizedAnchors.design.anchorY
    const implementationCenterX = normalizedAnchors.implementation.anchorX
    const implementationCenterY = normalizedAnchors.implementation.anchorY
    const deltaX = Math.round(designCenterX - implementationCenterX)
    const deltaY = Math.round(designCenterY - implementationCenterY)
    const minX = Math.min(0, deltaX)
    const minY = Math.min(0, deltaY)
    const maxX = Math.max(designWidth, deltaX + implementationWidth)
    const maxY = Math.max(designHeight, deltaY + implementationHeight)

    canvasWidth = maxX - minX
    canvasHeight = maxY - minY
    designOffsetX = -minX
    designOffsetY = -minY
    implementationOffsetX = deltaX - minX
    implementationOffsetY = deltaY - minY
    anchorDelta = { x: deltaX, y: deltaY }
  }

  const overlapLeft = Math.max(designOffsetX, implementationOffsetX)
  const overlapTop = Math.max(designOffsetY, implementationOffsetY)
  const overlapRight = Math.min(
    designOffsetX + designWidth,
    implementationOffsetX + implementationWidth,
  )
  const overlapBottom = Math.min(
    designOffsetY + designHeight,
    implementationOffsetY + implementationHeight,
  )
  const overlapRect = {
    x: overlapLeft,
    y: overlapTop,
    width: Math.max(0, overlapRight - overlapLeft),
    height: Math.max(0, overlapBottom - overlapTop),
  }
  const overlapArea = overlapRect.width * overlapRect.height
  const smallerImageArea = Math.min(
    designWidth * designHeight,
    implementationWidth * implementationHeight,
  )
  const sharedAreaRatio = overlapArea / Math.max(1, smallerImageArea)

  const pixels = canvasWidth * canvasHeight

  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
    const megapixels = Number.isFinite(pixels)
      ? (pixels / 1_000_000).toFixed(1)
      : 'an invalid number of'
    throw new RangeError(
      `Comparison canvas would be ${canvasWidth} × ${canvasHeight} ` +
      `(${megapixels} MP), exceeding the 32 MP safety limit. ` +
      'Use screenshots with closer widths/aspect ratios or crop them before analysis.',
    )
  }

  return {
    strategy: scaleMode === 'responsive' ? 'keep-native-pixels' : alignment === 'element'
      ? 'match-wider-width-and-element-anchor' : 'match-wider-width',
    scaleMode,
    alignment,
    verticalAlignment: alignment === 'element' ? 'element' : bottomAligned ? 'bottom' : 'top',
    background: 'transparent',
    targetWidth,
    designScale,
    implementationScale,
    designWidth,
    designHeight,
    implementationWidth,
    implementationHeight,
    designOffsetX,
    designOffsetY,
    implementationOffsetX,
    implementationOffsetY,
    canvasWidth,
    canvasHeight,
    anchorReady,
    anchors: normalizedAnchors,
    anchorDelta,
    overlapRect,
    sharedAreaRatio,
    pixels,
  }
}

export function buildComparisonProfile(
  designImage,
  implementationImage,
  { alignment = 'top-left', anchors = null, scaleMode = 'width-normalized' } = {},
) {
  const design = getImageDimensions(designImage, 'designImage')
  const implementation = getImageDimensions(implementationImage, 'implementationImage')
  const normalization = buildWidthNormalization(
    designImage,
    implementationImage,
    { alignment, anchors, scaleMode },
  )
  const implementationAspect = implementation.height / implementation.width
  const mobilePortrait = implementationAspect > 1.45 && implementation.width <= 1600
  const ignoreTop = mobilePortrait
    ? Math.round(Math.min(implementation.height * 0.075, implementation.width * 0.12))
    : 0
  const widthsDiffer = design.width !== implementation.width
  const heightsDiffer = normalization.designHeight !== normalization.implementationHeight

  return {
    mode: widthsDiffer ? scaleMode : 'same-width',
    label: alignment === 'element'
      ? normalization.anchorReady ? '按选中元素对齐' : '等待框选对应元素'
      : widthsDiffer && scaleMode === 'responsive'
      ? `原像素对比 · ${normalization.verticalAlignment === 'bottom' ? '底部' : '顶部'}对齐`
      : widthsDiffer
      ? `等比放大至同宽${heightsDiffer ? ` · ${normalization.verticalAlignment === 'bottom' ? '底部' : '顶部'}对齐` : ''}`
      : heightsDiffer
        ? `同宽${normalization.verticalAlignment === 'bottom' ? '底部' : '顶部'}对齐`
        : '原尺寸对比',
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
    designNormalizedWidth: normalization.designWidth,
    implementationNormalizedHeight: normalization.implementationHeight,
    implementationNormalizedWidth: normalization.implementationWidth,
    designOffsetX: normalization.designOffsetX,
    designOffsetY: normalization.designOffsetY,
    implementationOffsetX: normalization.implementationOffsetX,
    implementationOffsetY: normalization.implementationOffsetY,
    comparisonWidth: normalization.canvasWidth,
    comparisonHeight: normalization.canvasHeight,
    widthsDiffer,
    heightsDiffer,
    alignment: normalization.alignment,
    verticalAlignment: normalization.verticalAlignment,
    anchorReady: normalization.anchorReady,
    anchors: normalization.anchors,
    anchorDelta: normalization.anchorDelta,
    overlapRect: normalization.overlapRect,
    sharedAreaRatio: normalization.sharedAreaRatio,
  }
}

export function isStatusBarOnly(box, profile) {
  const height = profile?.ignoreTop || 0
  if (!height || !box) return false

  const start = profile?.ignoreTopStart || 0
  const end = start + height

  const boxHeight = Math.max(1, box.h)
  const overlap = Math.max(
    0,
    Math.min(box.y + boxHeight, end) - Math.max(start, box.y),
  )
  const buffer = Math.max(
    4,
    // Diff regions are assembled from coarse cells, so a system-bar fragment
    // can extend slightly below the ignored pixels. Keep a small mobile-width
    // guard band without reaching the first real application row.
    Math.round((profile?.comparisonWidth || profile?.implementationWidth || 1000) * 0.025),
  )

  return (box.y >= start - buffer && box.y + boxHeight <= end + buffer) ||
    (box.y + boxHeight / 2 >= start && box.y + boxHeight / 2 < end) ||
    overlap / boxHeight >= 0.72
}

export function excludeStatusBarIssues(issues, profile) {
  return issues.filter((issue) => !isStatusBarOnly(issue.box, profile))
}
