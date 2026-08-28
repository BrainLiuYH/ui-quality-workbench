// Input comparability is intentionally evaluated before issue classification.
// A pixel difference is evidence that two rasters differ; it is not, by itself,
// evidence that either implementation is wrong. This module combines alpha
// coverage, low-frequency colour blocks, and edge structure so a local photo or
// video change does not automatically make an otherwise comparable page "low".

const ALPHA_VISIBLE = 16
const STRONG_PIXEL_DELTA = 52
const EDGE_THRESHOLD = 28
const TARGET_SAMPLES = 260_000

// These are deliberately conservative heuristics, not calibrated probabilities.
// They must be tuned against a labelled screenshot-pair data set before the
// resulting score is presented as a statistically meaningful confidence value.
const THRESHOLDS = Object.freeze({
  transparentRegion: 0.02,
  transparentBottom: 0.03,
  localizedCellCoverage: 0.08,
  changedCell: 0.28,
  structureCell: 0.1,
  widespreadCellCoverage: 0.42,
  widespreadAxisCoverage: 0.62,
  globalStrongPixelCoverage: 0.25,
})

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function round(value, precision = 4) {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function assertRaster(data, expectedLength, label) {
  if (!data || typeof data.length !== 'number' || data.length < expectedLength) {
    throw new RangeError(`${label} does not match the supplied raster dimensions`)
  }
}

function compositeChannel(channel, alpha) {
  const opacity = alpha / 255
  return channel * opacity + 255 * (1 - opacity)
}

function luminance(data, index) {
  const alpha = data[index + 3]
  const red = compositeChannel(data[index], alpha)
  const green = compositeChannel(data[index + 1], alpha)
  const blue = compositeChannel(data[index + 2], alpha)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function colourDelta(design, implementation, index) {
  const designAlpha = design[index + 3]
  const implementationAlpha = implementation[index + 3]
  return (
    Math.abs(
      compositeChannel(design[index], designAlpha) -
      compositeChannel(implementation[index], implementationAlpha),
    ) +
    Math.abs(
      compositeChannel(design[index + 1], designAlpha) -
      compositeChannel(implementation[index + 1], implementationAlpha),
    ) +
    Math.abs(
      compositeChannel(design[index + 2], designAlpha) -
      compositeChannel(implementation[index + 2], implementationAlpha),
    )
  ) / 3
}

function createCell() {
  return {
    samples: 0,
    union: 0,
    overlap: 0,
    oneSided: 0,
    designOnly: 0,
    implementationOnly: 0,
    deltaSum: 0,
    strong: 0,
    designRed: 0,
    designGreen: 0,
    designBlue: 0,
    implementationRed: 0,
    implementationGreen: 0,
    implementationBlue: 0,
    edgeSamples: 0,
    edgeDeltaSum: 0,
    edgePresenceMismatch: 0,
  }
}

function addOpaqueColour(cell, design, implementation, index) {
  const designAlpha = design[index + 3]
  const implementationAlpha = implementation[index + 3]
  cell.designRed += compositeChannel(design[index], designAlpha)
  cell.designGreen += compositeChannel(design[index + 1], designAlpha)
  cell.designBlue += compositeChannel(design[index + 2], designAlpha)
  cell.implementationRed += compositeChannel(implementation[index], implementationAlpha)
  cell.implementationGreen += compositeChannel(implementation[index + 1], implementationAlpha)
  cell.implementationBlue += compositeChannel(implementation[index + 2], implementationAlpha)
}

function edgeMagnitude(data, index, rightIndex, downIndex) {
  const center = luminance(data, index)
  return Math.max(
    Math.abs(center - luminance(data, rightIndex)),
    Math.abs(center - luminance(data, downIndex)),
  )
}

function spreadForMask(mask, columns, rows) {
  const occupiedColumns = new Uint8Array(columns)
  const occupiedRows = new Uint8Array(rows)
  let cells = 0

  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue
    cells++
    occupiedRows[Math.floor(index / columns)] = 1
    occupiedColumns[index % columns] = 1
  }

  const rowCount = occupiedRows.reduce((sum, value) => sum + value, 0)
  const columnCount = occupiedColumns.reduce((sum, value) => sum + value, 0)
  return {
    cells,
    rowRatio: rowCount / Math.max(1, rows),
    columnRatio: columnCount / Math.max(1, columns),
  }
}

function largestComponent(mask, columns, rows) {
  const visited = new Uint8Array(mask.length)
  let largest = null

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue

    const queue = [start]
    visited[start] = 1
    let count = 0
    let minColumn = columns
    let maxColumn = 0
    let minRow = rows
    let maxRow = 0

    while (queue.length) {
      const index = queue.pop()
      const row = Math.floor(index / columns)
      const column = index % columns
      count++
      minColumn = Math.min(minColumn, column)
      maxColumn = Math.max(maxColumn, column)
      minRow = Math.min(minRow, row)
      maxRow = Math.max(maxRow, row)

      for (const [deltaColumn, deltaRow] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nextColumn = column + deltaColumn
        const nextRow = row + deltaRow
        if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) {
          continue
        }
        const next = nextRow * columns + nextColumn
        if (mask[next] && !visited[next]) {
          visited[next] = 1
          queue.push(next)
        }
      }
    }

    if (!largest || count > largest.count) {
      largest = {
        count,
        columnRatio: (maxColumn - minColumn + 1) / columns,
        rowRatio: (maxRow - minRow + 1) / rows,
      }
    }
  }

  return largest || { count: 0, columnRatio: 0, rowRatio: 0 }
}

function reason(code, level, message) {
  return { code, level, message }
}

/**
 * Estimate whether two already-normalized RGBA rasters represent comparable UI
 * states. Ratios in `metrics` use the 0..1 range; colour deltas use 0..255.
 *
 * This gate identifies suspicious inputs. It must not be used to manufacture
 * UI findings or to decide which screenshot is correct.
 */
export function assessComparability({
  designPixels,
  implementationPixels,
  width,
  height,
  profile,
}) {
  const rasterWidth = Math.round(Number(width))
  const rasterHeight = Math.round(Number(height))
  if (!Number.isFinite(rasterWidth) || !Number.isFinite(rasterHeight) ||
    rasterWidth <= 0 || rasterHeight <= 0) {
    throw new TypeError('width and height must be positive finite numbers')
  }

  const expectedLength = rasterWidth * rasterHeight * 4
  assertRaster(designPixels, expectedLength, 'designPixels')
  assertRaster(implementationPixels, expectedLength, 'implementationPixels')

  const profileHeight = Number(profile?.comparisonHeight) || rasterHeight
  const ignoredTop = clamp(
    Math.round((Number(profile?.ignoreTop) || 0) * rasterHeight / profileHeight),
    0,
    Math.max(0, rasterHeight - 1),
  )
  const analysisHeight = rasterHeight - ignoredTop
  const columns = Math.max(1, Math.min(12, rasterWidth))
  const rows = Math.max(
    1,
    Math.min(
      analysisHeight,
      20,
      Math.max(8, Math.round(12 * analysisHeight / Math.max(1, rasterWidth))),
    ),
  )
  const cells = Array.from({ length: columns * rows }, createCell)
  const rowTotals = Array.from({ length: rows }, () => ({
    union: 0,
    oneSided: 0,
    designOnly: 0,
    implementationOnly: 0,
  }))
  const stride = Math.max(
    1,
    Math.ceil(Math.sqrt(rasterWidth * analysisHeight / TARGET_SAMPLES)),
  )

  let sampledPixels = 0
  let unionPixels = 0
  let overlapPixels = 0
  let oneSidedPixels = 0
  let designOnlyPixels = 0
  let implementationOnlyPixels = 0
  let deltaSum = 0
  let strongPixels = 0

  for (let y = ignoredTop; y < rasterHeight; y += stride) {
    const row = Math.min(rows - 1, Math.floor((y - ignoredTop) * rows / analysisHeight))
    for (let x = 0; x < rasterWidth; x += stride) {
      const column = Math.min(columns - 1, Math.floor(x * columns / rasterWidth))
      const cell = cells[row * columns + column]
      const index = (y * rasterWidth + x) * 4
      const designVisible = designPixels[index + 3] >= ALPHA_VISIBLE
      const implementationVisible = implementationPixels[index + 3] >= ALPHA_VISIBLE
      sampledPixels++
      cell.samples++

      if (!designVisible && !implementationVisible) continue

      unionPixels++
      cell.union++
      rowTotals[row].union++

      if (designVisible !== implementationVisible) {
        oneSidedPixels++
        cell.oneSided++
        rowTotals[row].oneSided++
        if (designVisible) {
          designOnlyPixels++
          cell.designOnly++
          rowTotals[row].designOnly++
        } else {
          implementationOnlyPixels++
          cell.implementationOnly++
          rowTotals[row].implementationOnly++
        }
        continue
      }

      overlapPixels++
      cell.overlap++
      addOpaqueColour(cell, designPixels, implementationPixels, index)
      const delta = colourDelta(designPixels, implementationPixels, index)
      deltaSum += delta
      cell.deltaSum += delta
      if (delta >= STRONG_PIXEL_DELTA) {
        strongPixels++
        cell.strong++
      }

      const rightX = Math.min(rasterWidth - 1, x + stride)
      const downY = Math.min(rasterHeight - 1, y + stride)
      if (rightX === x || downY === y) continue
      const rightIndex = (y * rasterWidth + rightX) * 4
      const downIndex = (downY * rasterWidth + x) * 4
      const neighboursVisible = [
        designPixels[rightIndex + 3],
        designPixels[downIndex + 3],
        implementationPixels[rightIndex + 3],
        implementationPixels[downIndex + 3],
      ].every((alpha) => alpha >= ALPHA_VISIBLE)
      if (!neighboursVisible) continue

      const designEdge = edgeMagnitude(designPixels, index, rightIndex, downIndex)
      const implementationEdge = edgeMagnitude(
        implementationPixels,
        index,
        rightIndex,
        downIndex,
      )
      cell.edgeSamples++
      cell.edgeDeltaSum += Math.abs(designEdge - implementationEdge) / 255
      if ((designEdge >= EDGE_THRESHOLD) !== (implementationEdge >= EDGE_THRESHOLD)) {
        cell.edgePresenceMismatch++
      }
    }
  }

  const changedMask = new Uint8Array(cells.length)
  const structureMask = new Uint8Array(cells.length)
  let lowFrequencyCells = 0
  let totalEdgeSamples = 0
  let totalEdgeDelta = 0
  let totalEdgePresenceMismatch = 0

  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index]
    if (!cell.union) continue
    totalEdgeSamples += cell.edgeSamples
    totalEdgeDelta += cell.edgeDeltaSum
    totalEdgePresenceMismatch += cell.edgePresenceMismatch
    const missingRatio = cell.oneSided / cell.union
    const strongRatio = cell.strong / Math.max(1, cell.overlap)
    const edgeDelta = cell.edgeDeltaSum / Math.max(1, cell.edgeSamples)
    const edgePresenceMismatch = cell.edgePresenceMismatch / Math.max(1, cell.edgeSamples)
    const lowFrequencyDelta = cell.overlap
      ? (
        Math.abs(cell.designRed - cell.implementationRed) +
        Math.abs(cell.designGreen - cell.implementationGreen) +
        Math.abs(cell.designBlue - cell.implementationBlue)
      ) / (3 * cell.overlap)
      : 0

    const lowFrequencyChanged = lowFrequencyDelta >= 20
    const strongChanged = strongRatio >= THRESHOLDS.changedCell
    const edgeChanged = edgeDelta >= 0.16 || edgePresenceMismatch >= 0.24
    const structureChanged = (
      edgeDelta >= 0.06 || edgePresenceMismatch >= THRESHOLDS.structureCell
    ) &&
      (strongRatio >= 0.12 || lowFrequencyDelta >= 10)

    if (lowFrequencyChanged) lowFrequencyCells++
    if (missingRatio >= 0.25 ||
      (Number(lowFrequencyChanged) + Number(strongChanged) + Number(edgeChanged) >= 2)) {
      changedMask[index] = 1
    }
    if (structureChanged) structureMask[index] = 1
  }

  const changedSpread = spreadForMask(changedMask, columns, rows)
  const structureSpread = spreadForMask(structureMask, columns, rows)
  const validCellCount = Math.max(1, cells.filter((cell) => cell.union > 0).length)
  const changedCellRatio = changedSpread.cells / validCellCount
  const structureChangedCellRatio = structureSpread.cells / validCellCount
  const largest = largestComponent(changedMask, columns, rows)
  const strongPixelRatio = strongPixels / Math.max(1, overlapPixels)
  const oneSidedTransparentRatio = oneSidedPixels / Math.max(1, unionPixels)
  const meanColourDelta = deltaSum / Math.max(1, overlapPixels)

  let unmatchedBottomRows = 0
  let bottomDesignOnly = 0
  let bottomImplementationOnly = 0
  for (let row = rows - 1; row >= 0; row--) {
    const total = rowTotals[row]
    if (!total.union || total.oneSided / total.union < 0.72) break
    unmatchedBottomRows++
    bottomDesignOnly += total.designOnly
    bottomImplementationOnly += total.implementationOnly
  }
  const unmatchedBottomRatio = unmatchedBottomRows / rows
  const bottomMissingSide = unmatchedBottomRows === 0
    ? null
    : bottomDesignOnly > bottomImplementationOnly
      ? 'implementation'
      : bottomImplementationOnly > bottomDesignOnly
        ? 'design'
        : 'mixed'
  const bottomExplainsMissing = (bottomDesignOnly + bottomImplementationOnly) /
    Math.max(1, oneSidedPixels)
  const changedCellCoverage = changedSpread.cells / Math.max(1, columns * rows)
  const spatialSupport = changedCellRatio * Math.min(
    changedSpread.rowRatio,
    changedSpread.columnRatio,
  )
  const structureSupport = structureChangedCellRatio * Math.min(
    structureSpread.rowRatio,
    structureSpread.columnRatio,
  )
  const localizedChange = changedCellRatio >= THRESHOLDS.localizedCellCoverage &&
    changedCellRatio < 0.62 &&
    (changedSpread.rowRatio < 0.55 || changedSpread.columnRatio < 0.55) &&
    oneSidedTransparentRatio < THRESHOLDS.transparentRegion
  const widespreadVisual = changedCellRatio >= THRESHOLDS.widespreadCellCoverage &&
    changedSpread.rowRatio >= THRESHOLDS.widespreadAxisCoverage &&
    changedSpread.columnRatio >= THRESHOLDS.widespreadAxisCoverage
  const widespreadStructure = structureChangedCellRatio >= 0.28 &&
    structureSpread.rowRatio >= THRESHOLDS.widespreadAxisCoverage &&
    structureSpread.columnRatio >= THRESHOLDS.widespreadAxisCoverage
  const globalStrongDifference = strongPixelRatio >= THRESHOLDS.globalStrongPixelCoverage &&
    changedSpread.rowRatio >= 0.55 && changedSpread.columnRatio >= 0.55

  let score = 100
  score -= Math.min(32, oneSidedTransparentRatio * 70)
  score -= Math.min(24, strongPixelRatio * 26)
  score -= Math.min(18, changedCellRatio * 18)
  score -= Math.min(28, spatialSupport * 42)
  score -= Math.min(18, structureSupport * 30)

  const reasons = []
  if (unmatchedBottomRatio >= THRESHOLDS.transparentBottom && bottomExplainsMissing >= 0.55) {
    reasons.push(reason(
      'TRANSPARENT_BOTTOM_MISMATCH',
      'warning',
      `一侧截图底部约 ${Math.round(unmatchedBottomRatio * 100)}% 没有对应像素，应先确认页面高度或滚动范围。`,
    ))
  } else if (oneSidedTransparentRatio >= THRESHOLDS.transparentRegion) {
    reasons.push(reason(
      'TRANSPARENT_REGION_MISMATCH',
      'warning',
      `约 ${Math.round(oneSidedTransparentRatio * 100)}% 的可见区域只存在于一张图中。`,
    ))
  }

  if (globalStrongDifference) {
    reasons.push(reason(
      'GLOBAL_STRONG_DIFFERENCE',
      widespreadVisual ? 'blocking' : 'warning',
      `强像素差异覆盖约 ${Math.round(strongPixelRatio * 100)}%，且分布在页面多个区域。`,
    ))
  }

  if (widespreadStructure) {
    reasons.push(reason(
      'WIDESPREAD_STRUCTURE_DIFFERENCE',
      'blocking',
      '粗粒度边缘结构在页面横向和纵向均出现广泛变化，可能不是同一界面状态。',
    ))
  } else if (localizedChange) {
    reasons.push(reason(
      'LOCALIZED_CONTENT_DIFFERENCE',
      'warning',
      '差异集中在局部连续区域，可能是图片、视频封面或动态内容；不能据此判定整页不可比。',
    ))
  }

  const lowComparability = widespreadVisual &&
    (widespreadStructure || globalStrongDifference || lowFrequencyCells / validCellCount >= 0.4)
  const meaningfulMismatch = oneSidedTransparentRatio >= THRESHOLDS.transparentRegion ||
    localizedChange || globalStrongDifference || changedCellRatio >= 0.16

  if (lowComparability) {
    score = Math.min(score, 44)
  } else if (meaningfulMismatch) {
    score = Math.min(score, 79)
  } else {
    score = Math.max(score, 80)
  }

  score = clamp(Math.round(score), 0, 100)
  const status = score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low'

  if (!reasons.length) {
    reasons.push(reason(
      status === 'high' ? 'COMPARABLE_INPUTS' : 'MINOR_VISUAL_VARIATION',
      'info',
      status === 'high'
        ? '未发现足以阻止走查的输入级差异。'
        : '存在视觉变化，但当前证据不足以判断为整页不可比。',
    ))
  }

  return {
    status,
    score,
    reasons,
    metrics: {
      sampledPixels,
      sampleStride: stride,
      ignoredTop,
      gridColumns: columns,
      gridRows: rows,
      opaqueOverlapRatio: round(overlapPixels / Math.max(1, unionPixels)),
      oneSidedTransparentRatio: round(oneSidedTransparentRatio),
      designOnlyRatio: round(designOnlyPixels / Math.max(1, unionPixels)),
      implementationOnlyRatio: round(
        implementationOnlyPixels / Math.max(1, unionPixels),
      ),
      unmatchedBottomRatio: round(unmatchedBottomRatio),
      bottomMissingSide,
      meanColourDelta: round(meanColourDelta, 1),
      strongPixelRatio: round(strongPixelRatio),
      meanEdgeMagnitudeDelta: round(totalEdgeDelta / Math.max(1, totalEdgeSamples)),
      edgePresenceMismatchRatio: round(
        totalEdgePresenceMismatch / Math.max(1, totalEdgeSamples),
      ),
      changedCellRatio: round(changedCellRatio),
      changedCellCoverage: round(changedCellCoverage),
      changedRowRatio: round(changedSpread.rowRatio),
      changedColumnRatio: round(changedSpread.columnRatio),
      largestChangedComponentRatio: round(largest.count / validCellCount),
      largestChangedComponentRowRatio: round(largest.rowRatio),
      largestChangedComponentColumnRatio: round(largest.columnRatio),
      structureChangedCellRatio: round(structureChangedCellRatio),
      structureChangedRowRatio: round(structureSpread.rowRatio),
      structureChangedColumnRatio: round(structureSpread.columnRatio),
    },
  }
}

export { THRESHOLDS as COMPARABILITY_THRESHOLDS }
