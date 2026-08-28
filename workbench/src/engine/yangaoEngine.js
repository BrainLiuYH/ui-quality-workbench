// Core analysis adapted with permission from SemineChen/yangao at the fixed
// upstream commit beac836ba3c81b9a1d40bac8fe75af08444ab742.
// UI, export, and duplicated upstream presentation helpers are intentionally
// excluded. This file is the stable React-facing entry point.

import { groupIssues } from './group-issues.js'
import { diffRasters } from './pixel-diff.js'
import { assessComparability } from './comparability.js'
import {
  MAX_NORMALIZED_PIXELS,
  buildComparisonProfile,
  buildWidthNormalization,
  excludeStatusBarIssues,
  getImageDimensions,
} from './profile.js'
import { reportProgress, throwIfAborted, yieldToHost } from './runtime.js'

const MAX_ANALYSIS_SIDE = 1800

function createRasterCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height)
  }

  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }

  throw new Error(
    'Canvas is unavailable. Run the engine in a browser or a Worker with OffscreenCanvas support.',
  )
}

function getRasterContext(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Unable to create a 2D canvas context')
  return context
}

function readRaster(image, width, height, drawWidth, drawHeight) {
  const canvas = createRasterCanvas(width, height)
  const context = getRasterContext(canvas)
  // Canvas starts transparent, but clearing explicitly keeps repeated browser
  // implementations deterministic. Alpha is included in pixel comparison, so
  // the unmatched bottom of the shorter image remains observable even when the
  // longer image happens to end in solid white.
  context.clearRect(0, 0, width, height)
  context.drawImage(image, 0, 0, drawWidth, drawHeight)
  return context.getImageData(0, 0, width, height).data
}

/**
 * Compare two decoded browser images.
 *
 * @param {object} input
 * @param {ImageBitmap|HTMLImageElement} input.designImage
 * @param {ImageBitmap|HTMLImageElement} input.implementationImage
 * @param {AbortSignal} [input.signal]
 * @param {(progress: {phase: string, percent: number}) => void} [input.onProgress]
 * @returns {Promise<{profile: object, coverage: number|null, issues: object[], groups: object[], comparability: object}>}
 */
export async function analyzeImages({
  designImage,
  implementationImage,
  signal,
  onProgress,
}) {
  throwIfAborted(signal)
  reportProgress(onProgress, 'prepare', 0)

  const normalization = buildWidthNormalization(designImage, implementationImage)
  const sourceProfile = buildComparisonProfile(designImage, implementationImage)
  const baseProfile = {
    ...sourceProfile,
    sourceIgnoreTop: sourceProfile.ignoreTop,
    ignoreTop: Math.round(sourceProfile.ignoreTop * normalization.implementationScale),
    normalization,
    targetWidth: normalization.targetWidth,
    targetHeight: normalization.canvasHeight,
    designScale: normalization.designScale,
    implementationScale: normalization.implementationScale,
    designNormalizedHeight: normalization.designHeight,
    implementationNormalizedHeight: normalization.implementationHeight,
    normalizedDesignHeight: normalization.designHeight,
    normalizedImplementationHeight: normalization.implementationHeight,
    comparisonWidth: normalization.canvasWidth,
    comparisonHeight: normalization.canvasHeight,
  }
  const ratio = Math.min(
    1,
    MAX_ANALYSIS_SIDE /
      Math.max(normalization.canvasWidth, normalization.canvasHeight),
  )
  const width = Math.max(1, Math.round(normalization.canvasWidth * ratio))
  const height = Math.max(1, Math.round(normalization.canvasHeight * ratio))
  const designHeight = Math.max(1, Math.round(normalization.designHeight * ratio))
  const implementationHeight = Math.max(
    1,
    Math.round(normalization.implementationHeight * ratio),
  )

  await yieldToHost(signal)
  reportProgress(onProgress, 'rasterize', 5)

  let designPixels
  let implementationPixels
  try {
    designPixels = readRaster(designImage, width, height, width, designHeight)
    implementationPixels = readRaster(
      implementationImage,
      width,
      height,
      width,
      implementationHeight,
    )
  } catch (error) {
    if (error?.name === 'SecurityError') {
      throw new Error(
        'The image cannot be analyzed because its pixels are blocked by browser cross-origin rules.',
        { cause: error },
      )
    }
    throw error
  }

  await yieldToHost(signal)
  reportProgress(onProgress, 'comparability', 10)
  const comparability = assessComparability({
    designPixels,
    implementationPixels,
    width,
    height,
    profile: baseProfile,
  })

  // A low score means the rasters may represent different pages or states.
  // Pixel differences are still real, but classifying them as UI defects would
  // overstate what the image evidence can prove, so stop before classification.
  if (comparability.status === 'low') {
    const profile = { ...baseProfile, comparability }
    reportProgress(onProgress, 'complete', 100)
    return {
      profile,
      coverage: null,
      issues: [],
      groups: [],
      comparability,
    }
  }

  await yieldToHost(signal)
  const diff = await diffRasters({
    designPixels,
    implementationPixels,
    width,
    height,
    outputWidth: normalization.canvasWidth,
    outputHeight: normalization.canvasHeight,
    profile: baseProfile,
    signal,
    onProgress,
  })

  throwIfAborted(signal)
  reportProgress(onProgress, 'group', 96)
  const profile = { ...baseProfile, ...diff.metrics, comparability }
  const issues = excludeStatusBarIssues(diff.issues, profile)
  const groups = groupIssues(issues, {
    width: normalization.canvasWidth,
    height: normalization.canvasHeight,
  })

  throwIfAborted(signal)
  reportProgress(onProgress, 'complete', 100)
  return {
    profile,
    coverage: diff.coverage,
    issues,
    groups,
    comparability,
  }
}

export {
  MAX_NORMALIZED_PIXELS,
  buildComparisonProfile,
  buildWidthNormalization,
  excludeStatusBarIssues,
  getImageDimensions,
  groupIssues,
  assessComparability,
}
