// Pixel-diff heuristics adapted with permission from SemineChen/yangao, commit
// beac836ba3c81b9a1d40bac8fe75af08444ab742.
// This module intentionally contains no DOM or rendering-state references so it
// can run in either a window or a Web Worker.

import { reportProgress, throwIfAborted, yieldToHost } from './runtime.js'

const ISSUE_PRIORITY = [
  '颜色', '尺寸', '位置', '文字', '圆角', '阴影', '边框', '图标', '布局', '内容',
]

function intersection(a, b) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  return Math.max(0, right - x) * Math.max(0, bottom - y)
}

function iou(a, b) {
  const overlap = intersection(a, b)
  return overlap / Math.max(1, a.w * a.h + b.w * b.h - overlap)
}

function smallOverlap(a, b) {
  return intersection(a, b) / Math.max(1, Math.min(a.w * a.h, b.w * b.h))
}

function toHex(rgb) {
  return `#${rgb
    .map((value) => Math.round(value).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

function toPercent(value) {
  return `${Math.round(value * 100)}%`
}

function rgbaVisualDelta(expected, actual, expectedIndex, actualIndex) {
  const expectedAlpha = expected[expectedIndex + 3] / 255
  const actualAlpha = actual[actualIndex + 3] / 255
  const colorDelta = (
    Math.abs(expected[expectedIndex] * expectedAlpha - actual[actualIndex] * actualAlpha) +
    Math.abs(expected[expectedIndex + 1] * expectedAlpha - actual[actualIndex + 1] * actualAlpha) +
    Math.abs(expected[expectedIndex + 2] * expectedAlpha - actual[actualIndex + 2] * actualAlpha)
  ) / 3

  // Alpha must remain independently visible. Otherwise an opaque white footer
  // and the transparent padding below a shorter image would compare as equal
  // after compositing on white, hiding the missing bottom region.
  return Math.max(colorDelta, Math.abs(expectedAlpha - actualAlpha) * 255)
}

function premultipliedLuminance(data, index) {
  const alpha = data[index + 3] / 255
  return alpha * (
    0.2126 * data[index] +
    0.7152 * data[index + 1] +
    0.0722 * data[index + 2]
  )
}

export async function diffRasters({
  designPixels,
  implementationPixels,
  width,
  height,
  outputWidth,
  outputHeight,
  profile,
  signal,
  onProgress,
}) {
  throwIfAborted(signal)

  const pixels = width * height
  const expectedLength = pixels * 4
  if (designPixels.length < expectedLength || implementationPixels.length < expectedLength) {
    throw new RangeError('Raster buffers do not match the supplied dimensions')
  }

  const widthNormalized = profile.mode === 'width-normalized'
  const tolerance = widthNormalized ? 2.8 : 1
  const analysisIgnoreTop = Math.round((profile.ignoreTop || 0) * height / outputHeight)
  const deltaMap = new Uint8Array(pixels)
  const designLuminance = new Uint8Array(pixels)
  const implementationLuminance = new Uint8Array(pixels)
  const edgeMap = new Uint8Array(pixels)
  let deltaSum = 0
  let strongDeltaCount = 0
  let deltaCount = 0

  reportProgress(onProgress, 'pixel-diff', 12)

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    for (let x = 0; x < width; x++) {
      const pixelIndex = rowOffset + x
      const rgbaIndex = pixelIndex * 4
      let visualDelta = rgbaVisualDelta(
        designPixels,
        implementationPixels,
        rgbaIndex,
        rgbaIndex,
      )

      if (widthNormalized && y >= analysisIgnoreTop) {
        for (let deltaY = -1; deltaY <= 1; deltaY++) {
          for (let deltaX = -1; deltaX <= 1; deltaX++) {
            const neighbourX = x + deltaX
            const neighbourY = y + deltaY
            if (neighbourX < 0 || neighbourY < 0 ||
              neighbourX >= width || neighbourY >= height) continue
            const neighbourIndex = (neighbourY * width + neighbourX) * 4
            const candidate = rgbaVisualDelta(
              designPixels,
              implementationPixels,
              neighbourIndex,
              rgbaIndex,
            )
            visualDelta = Math.min(visualDelta, candidate)
          }
        }
      }

      deltaMap[pixelIndex] = y < analysisIgnoreTop
        ? 0
        : Math.min(255, Math.round(visualDelta))

      if (y >= analysisIgnoreTop) {
        deltaSum += deltaMap[pixelIndex]
        if (deltaMap[pixelIndex] > 45) strongDeltaCount++
        deltaCount++
      }

      designLuminance[pixelIndex] = Math.round(
        premultipliedLuminance(designPixels, rgbaIndex),
      )
      implementationLuminance[pixelIndex] = Math.round(
        premultipliedLuminance(implementationPixels, rgbaIndex),
      )
    }

    if (y % 48 === 47) {
      reportProgress(onProgress, 'pixel-diff', 12 + 24 * y / Math.max(1, height - 1))
      await yieldToHost(signal)
    }
  }

  const meanDelta = deltaSum / Math.max(1, deltaCount)
  const strongRatio = strongDeltaCount / Math.max(1, deltaCount)
  const metrics = {
    meanDelta: Math.round(meanDelta * 10) / 10,
    strongRatio: Math.round(strongRatio * 1000) / 10,
  }

  if (widthNormalized && meanDelta < 1.5 && strongRatio < 0.002) {
    return { issues: [], coverage: 100, metrics }
  }

  reportProgress(onProgress, 'edge-diff', 38)
  if (!widthNormalized) {
    for (let y = analysisIgnoreTop; y < height - 1; y++) {
      for (let x = 0; x < width - 1; x++) {
        const pixelIndex = y * width + x
        const designGradient = Math.max(
          Math.abs(designLuminance[pixelIndex] - designLuminance[pixelIndex + 1]),
          Math.abs(designLuminance[pixelIndex] - designLuminance[pixelIndex + width]),
        )
        const implementationGradient = Math.max(
          Math.abs(implementationLuminance[pixelIndex] - implementationLuminance[pixelIndex + 1]),
          Math.abs(implementationLuminance[pixelIndex] - implementationLuminance[pixelIndex + width]),
        )
        edgeMap[pixelIndex] = Math.min(
          255,
          Math.abs(designGradient - implementationGradient),
        )
      }

      if (y % 64 === 63) {
        reportProgress(onProgress, 'edge-diff', 38 + 10 * y / Math.max(1, height - 1))
        await yieldToHost(signal)
      }
    }
  }

  const collectParts = async (cell, level) => {
    const columns = Math.ceil(width / cell)
    const rows = Math.ceil(height / cell)
    const hot = new Uint8Array(columns * rows)
    const scores = new Float32Array(columns * rows)
    const edges = new Float32Array(columns * rows)

    for (let cellY = 0; cellY < rows; cellY++) {
      for (let cellX = 0; cellX < columns; cellX++) {
        let sum = 0
        let sampleCount = 0
        let changed = 0
        let strong = 0
        let edgeChanged = 0

        for (let y = cellY * cell; y < Math.min(height, (cellY + 1) * cell); y += 2) {
          for (let x = cellX * cell; x < Math.min(width, (cellX + 1) * cell); x += 2) {
            const pixelIndex = y * width + x
            const delta = deltaMap[pixelIndex]
            const edge = edgeMap[pixelIndex]
            sum += delta
            sampleCount++
            if (delta > 10 * tolerance) changed++
            if (delta > 30 * tolerance) strong++
            if (edge > 18 * tolerance) edgeChanged++
          }
        }

        const safeCount = Math.max(1, sampleCount)
        const average = sum / safeCount
        const coverage = changed / safeCount
        const strongCoverage = strong / safeCount
        const edgeCoverage = edgeChanged / safeCount
        const index = cellY * columns + cellX
        const fine = level === 0
        const medium = level === 1
        scores[index] = average
        edges[index] = edgeCoverage
        hot[index] = (
          average > (fine ? 7 * tolerance : medium ? 9 * tolerance : 11 * tolerance) &&
          coverage > (fine ? 0.055 : medium ? 0.08 : 0.12)
        ) || strongCoverage > (fine ? 0.018 : medium ? 0.028 : 0.045) ||
          edgeCoverage > (fine ? 0.045 : medium ? 0.065 : 0.09)
          ? 1
          : 0
      }

      if (cellY % 32 === 31) await yieldToHost(signal)
    }

    const visited = new Uint8Array(hot.length)
    const parts = []

    for (let index = 0; index < hot.length; index++) {
      if (!hot[index] || visited[index]) continue
      const queue = [index]
      visited[index] = 1
      let minX = columns
      let minY = rows
      let maxX = 0
      let maxY = 0
      let sum = 0
      let edgeSum = 0
      let count = 0

      while (queue.length) {
        const current = queue.pop()
        const y = Math.floor(current / columns)
        const x = current % columns
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        sum += scores[current]
        edgeSum += edges[current]
        count++
        const links = level < 2
          ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0]]
          : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]

        for (const [deltaX, deltaY] of links) {
          const neighbourX = x + deltaX
          const neighbourY = y + deltaY
          const neighbourIndex = neighbourY * columns + neighbourX
          if (neighbourX >= 0 && neighbourY >= 0 &&
            neighbourX < columns && neighbourY < rows &&
            hot[neighbourIndex] && !visited[neighbourIndex]) {
            visited[neighbourIndex] = 1
            queue.push(neighbourIndex)
          }
        }
      }

      if (count >= (level === 0 ? 1 : 2)) {
        const padding = level === 0 ? 1 : 0
        const x = Math.max(0, (minX - padding) * cell)
        const y = Math.max(analysisIgnoreTop, (minY - padding) * cell)
        const partWidth = Math.min(
          width - x,
          (maxX - minX + 1 + padding * 2) * cell,
        )
        const partHeight = Math.min(
          height - y,
          (maxY - minY + 1 + padding * 2) * cell,
        )
        if (partHeight > 0) {
          parts.push({
            x,
            y,
            w: partWidth,
            h: partHeight,
            score: sum / count,
            edgeScore: edgeSum / count,
            cells: count,
            level,
            impact: (sum / count) * (1 + Math.sqrt(count)),
          })
        }
      }
    }

    return parts
  }

  reportProgress(onProgress, 'regions', 50)
  const base = Math.min(width, height)
  const cells = [
    Math.max(3, Math.round(base / 180)),
    Math.max(7, Math.round(base / 90)),
    Math.max(14, Math.round(base / 45)),
  ]
  const allParts = []

  for (let level = 0; level < cells.length; level++) {
    allParts.push(...await collectParts(cells[level], level))
    reportProgress(onProgress, 'regions', 50 + (level + 1) * 5)
    await yieldToHost(signal)
  }

  const parts = []
  for (const part of allParts.sort((a, b) => a.level - b.level || b.impact - a.impact)) {
    const duplicate = parts.some((existing) =>
      existing.level === part.level && iou(existing, part) > 0.7,
    )
    const finerCoverage = part.level
      ? parts
        .filter((existing) => existing.level < part.level)
        .reduce((sum, existing) => sum + intersection(existing, part), 0) /
          Math.max(1, part.w * part.h)
      : 0
    const largeLayout = part.w * part.h / (width * height) > 0.06
    if (!duplicate && (largeLayout || finerCoverage < 0.55)) parts.push(part)
  }

  const coverageFor = async (regions, returnUncovered = false) => {
    const stride = width + 1
    const difference = new Int32Array((width + 1) * (height + 1))

    for (const region of regions) {
      const x1 = Math.max(0, Math.floor(region.x))
      const y1 = Math.max(0, Math.floor(region.y))
      const x2 = Math.min(width, Math.ceil(region.x + region.w))
      const y2 = Math.min(height, Math.ceil(region.y + region.h))
      difference[y1 * stride + x1]++
      difference[y1 * stride + x2]--
      difference[y2 * stride + x1]--
      difference[y2 * stride + x2]++
    }

    let significant = 0
    let covered = 0
    const uncovered = returnUncovered ? new Uint8Array(pixels) : null

    for (let y = 0; y < height; y++) {
      let row = 0
      for (let x = 0; x < width; x++) {
        const differenceIndex = y * stride + x
        row += difference[differenceIndex]
        difference[differenceIndex] = y
          ? row + difference[differenceIndex - stride]
          : row
        const pixelIndex = y * width + x
        const isSignificant = deltaMap[pixelIndex] > 12 * tolerance ||
          edgeMap[pixelIndex] > 22 * tolerance
        if (isSignificant) {
          significant++
          if (difference[differenceIndex] > 0) covered++
          else if (uncovered) uncovered[pixelIndex] = 1
        }
      }
      if (y % 64 === 63) await yieldToHost(signal)
    }

    return {
      ratio: significant ? covered / significant : 1,
      uncovered,
    }
  }

  reportProgress(onProgress, 'coverage', 68)
  let coverage = await coverageFor(parts, true)

  if (coverage.ratio < (widthNormalized ? 0.9 : 0.96)) {
    const fallbackCell = Math.max(4, cells[0])
    const columns = Math.ceil(width / fallbackCell)
    const rows = Math.ceil(height / fallbackCell)
    const hot = new Uint8Array(columns * rows)

    for (let cellY = 0; cellY < rows; cellY++) {
      for (let cellX = 0; cellX < columns; cellX++) {
        let samples = 0
        let uncoveredSamples = 0
        for (let y = cellY * fallbackCell; y < Math.min(height, (cellY + 1) * fallbackCell); y += 2) {
          for (let x = cellX * fallbackCell; x < Math.min(width, (cellX + 1) * fallbackCell); x += 2) {
            samples++
            uncoveredSamples += coverage.uncovered[y * width + x]
          }
        }
        if (uncoveredSamples / Math.max(1, samples) > (widthNormalized ? 0.12 : 0.025)) {
          hot[cellY * columns + cellX] = 1
        }
      }
      if (cellY % 32 === 31) await yieldToHost(signal)
    }

    const seen = new Uint8Array(hot.length)
    for (let index = 0; index < hot.length; index++) {
      if (!hot[index] || seen[index]) continue
      const queue = [index]
      seen[index] = 1
      let minX = columns
      let minY = rows
      let maxX = 0
      let maxY = 0
      let count = 0

      while (queue.length) {
        const current = queue.pop()
        const cellY = Math.floor(current / columns)
        const cellX = current % columns
        minX = Math.min(minX, cellX)
        minY = Math.min(minY, cellY)
        maxX = Math.max(maxX, cellX)
        maxY = Math.max(maxY, cellY)
        count++

        for (const [deltaX, deltaY] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const neighbourX = cellX + deltaX
          const neighbourY = cellY + deltaY
          const neighbourIndex = neighbourY * columns + neighbourX
          if (neighbourX >= 0 && neighbourY >= 0 &&
            neighbourX < columns && neighbourY < rows &&
            hot[neighbourIndex] && !seen[neighbourIndex]) {
            seen[neighbourIndex] = 1
            queue.push(neighbourIndex)
          }
        }
      }

      const x = minX * fallbackCell
      const y = minY * fallbackCell
      const partWidth = Math.min(width - x, (maxX - minX + 1) * fallbackCell)
      const partHeight = Math.min(height - y, (maxY - minY + 1) * fallbackCell)
      parts.push({
        x,
        y,
        w: partWidth,
        h: partHeight,
        score: 18,
        edgeScore: 0.1,
        cells: count,
        level: 0,
        impact: 18 * (1 + Math.sqrt(count)),
        fallback: true,
      })
    }

    coverage = await coverageFor(parts, false)
  }

  const coveragePercent = Math.round(coverage.ratio * 100)
  const scaleX = outputWidth / width
  const scaleY = outputHeight / height

  function regionMetrics(data, part) {
    let edgeCount = 0
    let softCount = 0
    let perimeterCount = 0
    let cornerCount = 0
    let interiorCount = 0
    let sampleCount = 0
    let sumX = 0
    let sumY = 0
    let minX = part.x + part.w
    let minY = part.y + part.h
    let maxX = part.x
    let maxY = part.y
    const rgb = [0, 0, 0]
    let alphaWeight = 0
    let visibleAlphaCount = 0
    let opaqueAlphaCount = 0

    for (let y = part.y; y < Math.min(height, part.y + part.h); y += 2) {
      for (let x = part.x; x < Math.min(width, part.x + part.w); x += 2) {
        const rgbaIndex = (y * width + x) * 4
        const alpha = data[rgbaIndex + 3] / 255
        const luminance = alpha * (
          0.2126 * data[rgbaIndex] +
          0.7152 * data[rgbaIndex + 1] +
          0.0722 * data[rgbaIndex + 2]
        )
        const rightX = Math.min(width - 1, x + 2)
        const bottomY = Math.min(height - 1, y + 2)
        const rightIndex = (y * width + rightX) * 4
        const bottomIndex = (bottomY * width + x) * 4
        const rightAlpha = data[rightIndex + 3] / 255
        const bottomAlpha = data[bottomIndex + 3] / 255
        const rightLuminance = rightAlpha * (
          0.2126 * data[rightIndex] +
          0.7152 * data[rightIndex + 1] +
          0.0722 * data[rightIndex + 2]
        )
        const bottomLuminance = bottomAlpha * (
          0.2126 * data[bottomIndex] +
          0.7152 * data[bottomIndex + 1] +
          0.0722 * data[bottomIndex + 2]
        )
        const gradient = Math.max(
          Math.abs(luminance - rightLuminance),
          Math.abs(luminance - bottomLuminance),
        )

        // Transparent canvas padding has RGB bytes of 0, but that does not
        // make it black content. Weight color samples by alpha so absent
        // pixels cannot manufacture a #000000 color issue.
        rgb[0] += data[rgbaIndex] * alpha
        rgb[1] += data[rgbaIndex + 1] * alpha
        rgb[2] += data[rgbaIndex + 2] * alpha
        alphaWeight += alpha
        if (alpha >= 16 / 255) visibleAlphaCount++
        if (alpha >= 0.5) opaqueAlphaCount++
        sampleCount++

        if (gradient > 5 && gradient <= 24) softCount++
        if (gradient > 24) {
          edgeCount++
          sumX += x
          sumY += y
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
          const relativeX = (x - part.x) / Math.max(1, part.w)
          const relativeY = (y - part.y) / Math.max(1, part.h)
          if (relativeX < 0.14 || relativeX > 0.86 || relativeY < 0.14 || relativeY > 0.86) {
            perimeterCount++
          }
          if ((relativeX < 0.27 || relativeX > 0.73) &&
            (relativeY < 0.27 || relativeY > 0.73)) cornerCount++
          if (relativeX >= 0.2 && relativeX <= 0.8 &&
            relativeY >= 0.2 && relativeY <= 0.8) interiorCount++
        }
      }
    }

    const safeSamples = Math.max(1, sampleCount)
    const safeEdges = Math.max(1, edgeCount)
    const hasEdge = edgeCount > 2

    return {
      avg: alphaWeight > 0
        ? rgb.map((value) => value / alphaWeight)
        : null,
      alphaCoverage: visibleAlphaCount / safeSamples,
      meanAlpha: alphaWeight / safeSamples,
      opaqueAlphaCoverage: opaqueAlphaCount / safeSamples,
      density: edgeCount / safeSamples,
      soft: softCount / safeSamples,
      perimeter: perimeterCount / safeEdges,
      corner: cornerCount / safeEdges,
      interior: interiorCount / safeEdges,
      edgeCount,
      x: Math.round((hasEdge ? sumX / safeEdges : part.x + part.w / 2) * scaleX),
      y: Math.round((hasEdge ? sumY / safeEdges : part.y + part.h / 2) * scaleY),
      left: Math.round((hasEdge ? minX : part.x) * scaleX),
      top: Math.round((hasEdge ? minY : part.y) * scaleY),
      w: Math.round((hasEdge ? maxX - minX + 2 : part.w) * scaleX),
      h: Math.round((hasEdge ? maxY - minY + 2 : part.h) * scaleY),
    }
  }

  function regionPresenceMetrics(part) {
    let sampleCount = 0
    let designOnlyCount = 0
    let implementationOnlyCount = 0

    for (let y = part.y; y < Math.min(height, part.y + part.h); y += 2) {
      for (let x = part.x; x < Math.min(width, part.x + part.w); x += 2) {
        const rgbaIndex = (y * width + x) * 4
        const designAlpha = designPixels[rgbaIndex + 3] / 255
        const implementationAlpha = implementationPixels[rgbaIndex + 3] / 255
        sampleCount++

        // Require one side to have clearly visible alpha and the other to be
        // effectively absent. This avoids treating ordinary opacity changes
        // or anti-aliased edges as missing content.
        if (designAlpha >= 0.1 && implementationAlpha <= 0.01) {
          designOnlyCount++
        } else if (implementationAlpha >= 0.1 && designAlpha <= 0.01) {
          implementationOnlyCount++
        }
      }
    }

    const safeSamples = Math.max(1, sampleCount)
    return {
      designOnlyCoverage: designOnlyCount / safeSamples,
      implementationOnlyCoverage: implementationOnlyCount / safeSamples,
    }
  }

  reportProgress(onProgress, 'classify', 82)
  const rawIssues = []
  const sortedParts = parts.sort((a, b) => b.impact - a.impact)

  for (let index = 0; index < sortedParts.length; index++) {
    const part = sortedParts[index]
    const area = part.w * part.h / (width * height)
    const baseSeverity = part.score > 58 || area > 0.12
      ? '严重'
      : part.score > 30 || area > 0.035 ? '中等' : '轻微'
    const designMetrics = regionMetrics(designPixels, part)
    const implementationMetrics = regionMetrics(implementationPixels, part)
    const cellBoxX = Math.round(part.x * scaleX)
    const cellBoxY = Math.round(part.y * scaleY)
    const cellBox = {
      x: cellBoxX,
      y: cellBoxY,
      w: Math.min(outputWidth - cellBoxX, Math.max(1, Math.round(part.w * scaleX))),
      h: Math.min(outputHeight - cellBoxY, Math.max(1, Math.round(part.h * scaleY))),
    }
    const edgePadding = Math.max(2, Math.round(Math.min(outputWidth, outputHeight) / 360))
    const useEdgeBox = implementationMetrics.edgeCount >= 4 &&
      implementationMetrics.w >= 4 && implementationMetrics.h >= 4
    const edgeX = Math.max(0, implementationMetrics.left - edgePadding)
    const edgeY = Math.max(profile.ignoreTop || 0, implementationMetrics.top - edgePadding)
    const box = useEdgeBox
      ? {
          x: Math.round(edgeX),
          y: Math.round(edgeY),
          w: Math.min(
            outputWidth - Math.round(edgeX),
            implementationMetrics.w + edgePadding * 2,
          ),
          h: Math.min(
            outputHeight - Math.round(edgeY),
            implementationMetrics.h + edgePadding * 2,
          ),
        }
      : cellBox
    const baseIssue = { severity: baseSeverity, score: Math.round(part.score), box }
    const presence = regionPresenceMetrics(part)
    const designOnly = presence.designOnlyCoverage >= 0.08 &&
      presence.implementationOnlyCoverage <= 0.015
    const implementationOnly = presence.implementationOnlyCoverage >= 0.08 &&
      presence.designOnlyCoverage <= 0.015

    if (designOnly || implementationOnly) {
      const missingSide = designOnly ? '实现稿' : '设计稿'
      const presentSide = designOnly ? '设计稿' : '实现稿'
      const oneSidedCoverage = designOnly
        ? presence.designOnlyCoverage
        : presence.implementationOnlyCoverage
      const pageBottomRegion = part.y + part.h >= height - 1 && part.w >= width * 0.5
      rawIssues.push({
        ...baseIssue,
        type: '布局',
        element: pageBottomRegion ? '页面底部或高度区域' : '区域内容',
        design_value: designOnly
          ? '存在可见内容'
          : `其中 ${toPercent(oneSidedCoverage)} 的区域无对应可见内容`,
        implementation_value: implementationOnly
          ? `存在额外可见内容（单侧区域 ${toPercent(oneSidedCoverage)}）`
          : `其中 ${toPercent(oneSidedCoverage)} 的区域无对应可见内容`,
        text: `${pageBottomRegion ? '页面高度或底部区域' : '区域'}存在差异：` +
          `${missingSide}在该位置缺少${presentSide}中的对应可见内容` +
          `（单侧可见区域 ${toPercent(oneSidedCoverage)}）`,
        confidence: oneSidedCoverage * 100,
      })

      if (index % 12 === 11) {
        reportProgress(
          onProgress,
          'classify',
          82 + 12 * index / Math.max(1, sortedParts.length - 1),
        )
        await yieldToHost(signal)
      }
      continue
    }

    const colorsComparable = designMetrics.avg !== null &&
      implementationMetrics.avg !== null
    const designColor = colorsComparable ? toHex(designMetrics.avg) : '无可见颜色'
    const implementationColor = colorsComparable
      ? toHex(implementationMetrics.avg)
      : '无可见颜色'
    const colorDelta = colorsComparable
      ? designMetrics.avg.reduce(
          (sum, value, channel) =>
            sum + Math.abs(value - implementationMetrics.avg[channel]),
          0,
        ) / 3
      : 0
    const sizeDelta = Math.max(
      Math.abs(designMetrics.w - implementationMetrics.w),
      Math.abs(designMetrics.h - implementationMetrics.h),
    )
    const shift = Math.round(Math.hypot(
      designMetrics.x - implementationMetrics.x,
      designMetrics.y - implementationMetrics.y,
    ))
    const densityDelta = Math.abs(designMetrics.density - implementationMetrics.density)
    const cornerDelta = Math.abs(designMetrics.corner - implementationMetrics.corner)
    const softDelta = Math.abs(designMetrics.soft - implementationMetrics.soft)
    const perimeterDelta = Math.abs(designMetrics.perimeter - implementationMetrics.perimeter)
    const visibleAspect = box.w / Math.max(1, box.h)
    const regionAspect = cellBox.w / Math.max(1, cellBox.h)
    const shortestSide = Math.min(cellBox.w, cellBox.h)
    const longestSide = Math.max(cellBox.w, cellBox.h)
    const minimumTextureEdges = Math.max(8, Math.round(shortestSide / 4))
    const bothTextured = designMetrics.edgeCount >= minimumTextureEdges &&
      implementationMetrics.edgeCount >= minimumTextureEdges &&
      Math.min(designMetrics.density, implementationMetrics.density) >= 0.055
    const internallyTextured = Math.min(
      designMetrics.interior,
      implementationMetrics.interior,
    ) >= 0.3
    const mediaLike = area >= 0.025 && shortestSide >= 20 && bothTextured &&
      internallyTextured &&
      (longestSide >= 120 || area >= 0.06) &&
      (colorDelta > (widthNormalized ? 16 : 9) || densityDelta > 0.025 || part.score > 28)
    const verySlender = regionAspect > 9 || regionAspect < 1 / 9 ||
      visibleAspect > 9 || visibleAspect < 1 / 9 ||
      (shortestSide <= Math.max(5, Math.round(Math.min(outputWidth, outputHeight) / 180)) &&
        (regionAspect > 4.5 || regionAspect < 1 / 4.5))
    const colorThreshold = widthNormalized ? 12 : 5
    const colorCandidate = colorDelta > colorThreshold
      ? {
          type: '颜色',
          confidence: colorDelta,
          element: area > 0.12
            ? '大面积界面区域'
            : regionAspect > 3 ? '横向可见区域' : regionAspect < 0.5 ? '纵向可见区域' : '界面元素',
          design_value: designColor,
          implementation_value: implementationColor,
          text: `颜色差异：设计 ${designColor}，实现 ${implementationColor}`,
        }
      : null

    // A large region with dense internal edges on both sides is usually a
    // photo, illustration, chart, map, or other content whose pixels are not
    // directly comparable. Pixel evidence can prove that the visible content
    // differs, but cannot defensibly attribute that difference to layout,
    // typography, an icon, or a component style.
    if (mediaLike) {
      rawIssues.push({
        ...baseIssue,
        type: '内容',
        element: '高纹理可见内容区域',
        design_value: `可见轮廓密度 ${toPercent(designMetrics.density)}，平均颜色 ${designColor}`,
        implementation_value: `可见轮廓密度 ${toPercent(implementationMetrics.density)}，平均颜色 ${implementationColor}`,
        text: '该区域的可见内容差异较大；仅凭像素证据无法可靠归因到尺寸、位置、文字、图标或组件样式',
        confidence: Math.max(colorDelta, densityDelta * 100, part.score),
      })

      if (index % 12 === 11) {
        reportProgress(
          onProgress,
          'classify',
          82 + 12 * index / Math.max(1, sortedParts.length - 1),
        )
        await yieldToHost(signal)
      }
      continue
    }

    const candidates = []
    // A very thin connected fragment is not enough evidence for a standalone
    // element. It can be an anti-aliased edge or an internal contour of a
    // larger object, so do not turn it into a size/position result either.
    const geometryAllowed = !verySlender
    const normalized = profile.mode === 'width-normalized' ? '归一化 ' : ''
    const minimumGeometryDelta = Math.max(2, Math.round(shortestSide * 0.035))

    if (geometryAllowed && sizeDelta >= minimumGeometryDelta) {
      candidates.push({
        type: '尺寸',
        confidence: sizeDelta / Math.max(8, Math.min(designMetrics.w, designMetrics.h)) * 100,
        element: '可见元素轮廓',
        design_value: `${normalized}${designMetrics.w} × ${designMetrics.h}px`,
        implementation_value: `${implementationMetrics.w} × ${implementationMetrics.h}px`,
        text: `尺寸差异：设计${normalized}${designMetrics.w} × ${designMetrics.h}px，实现 ${implementationMetrics.w} × ${implementationMetrics.h}px`,
      })
    }
    if (geometryAllowed && shift >= minimumGeometryDelta) {
      candidates.push({
        type: '位置',
        confidence: shift / Math.max(8, Math.min(box.w, box.h)) * 100,
        element: '可见元素轮廓',
        design_value: `${normalized}重心坐标 ${designMetrics.x}, ${designMetrics.y}`,
        implementation_value: `重心坐标 ${implementationMetrics.x}, ${implementationMetrics.y}`,
        text: `位置差异：设计${normalized}重心 (${designMetrics.x}, ${designMetrics.y})，实现 (${implementationMetrics.x}, ${implementationMetrics.y})`,
      })
    }
    const textLikeGeometry = regionAspect >= 2.2 && regionAspect <= 14 &&
      cellBox.h >= 6 && cellBox.h <= Math.min(120, outputHeight * 0.09) &&
      cellBox.w <= outputWidth * 0.92
    const textLikeEdges = designMetrics.edgeCount >= 6 &&
      implementationMetrics.edgeCount >= 6 &&
      Math.min(designMetrics.density, implementationMetrics.density) >= 0.025 &&
      Math.max(designMetrics.density, implementationMetrics.density) <= 0.48

    if (!verySlender && textLikeGeometry && textLikeEdges && densityDelta > 0.02) {
      candidates.push({
        type: '文字',
        confidence: densityDelta * 160,
        element: '文字行轮廓',
        design_value: `轮廓密度 ${toPercent(designMetrics.density)}`,
        implementation_value: `轮廓密度 ${toPercent(implementationMetrics.density)}`,
        text: `文字轮廓差异：设计 ${toPercent(designMetrics.density)}，实现 ${toPercent(implementationMetrics.density)}`,
      })
    }
    const componentLike = !verySlender && regionAspect > 0.45 && regionAspect < 4 &&
      shortestSide >= 10 && longestSide <= 280 &&
      designMetrics.edgeCount >= 4 && implementationMetrics.edgeCount >= 4 &&
      Math.max(designMetrics.density, implementationMetrics.density) < 0.42

    if (componentLike && regionAspect > 0.55 && regionAspect < 1.8 && cornerDelta > 0.04) {
      candidates.push({
        type: '圆角',
        confidence: cornerDelta * 145,
        element: '组件角部',
        design_value: `角部轮廓占比 ${toPercent(designMetrics.corner)}`,
        implementation_value: `角部轮廓占比 ${toPercent(implementationMetrics.corner)}`,
        text: `圆角轮廓差异：设计 ${toPercent(designMetrics.corner)}，实现 ${toPercent(implementationMetrics.corner)}`,
      })
    }
    if (componentLike && softDelta > 0.04) {
      candidates.push({
        type: '阴影',
        confidence: softDelta * 120,
        element: '组件柔和外缘',
        design_value: `柔和外缘像素 ${toPercent(designMetrics.soft)}`,
        implementation_value: `柔和外缘像素 ${toPercent(implementationMetrics.soft)}`,
        text: `阴影外缘差异：设计 ${toPercent(designMetrics.soft)}，实现 ${toPercent(implementationMetrics.soft)}`,
      })
    }
    if (componentLike && perimeterDelta > 0.055) {
      candidates.push({
        type: '边框',
        confidence: perimeterDelta * 130,
        element: '组件边界',
        design_value: `边界轮廓占比 ${toPercent(designMetrics.perimeter)}`,
        implementation_value: `边界轮廓占比 ${toPercent(implementationMetrics.perimeter)}`,
        text: `边框轮廓差异：设计 ${toPercent(designMetrics.perimeter)}，实现 ${toPercent(implementationMetrics.perimeter)}`,
      })
    }
    const iconLike = componentLike && longestSide <= 120 && shortestSide <= 96 &&
      regionAspect >= 0.7 && regionAspect <= 1.45 &&
      Math.min(designMetrics.density, implementationMetrics.density) >= 0.025
    if (iconLike && densityDelta > 0.025) {
      candidates.push({
        type: '图标',
        confidence: densityDelta * 175,
        element: '小型图形或图标',
        design_value: `图形轮廓密度 ${toPercent(designMetrics.density)}`,
        implementation_value: `图形轮廓密度 ${toPercent(implementationMetrics.density)}`,
        text: `图标轮廓差异：设计 ${toPercent(designMetrics.density)}，实现 ${toPercent(implementationMetrics.density)}`,
      })
    }
    if (!verySlender && geometryAllowed && area > 0.07 &&
      (sizeDelta >= minimumGeometryDelta || shift >= minimumGeometryDelta)) {
      candidates.push({
        type: '布局',
        confidence: area * 80 + shift / 12,
        element: '大面积布局区域',
        design_value: `${normalized}区域重心 ${designMetrics.x}, ${designMetrics.y}`,
        implementation_value: `区域重心 ${implementationMetrics.x}, ${implementationMetrics.y}`,
        text: `布局差异：设计${normalized}区域重心 (${designMetrics.x}, ${designMetrics.y})，实现 (${implementationMetrics.x}, ${implementationMetrics.y})`,
      })
    }

    // Emit a single defensible interpretation for each detected region. A
    // color result wins for flat regions; otherwise use the strongest gated
    // geometric/role candidate. This avoids presenting the same pixels as a
    // simultaneous text, icon, border, shadow, and layout defect.
    const flatRegion = Math.max(designMetrics.density, implementationMetrics.density) < 0.045
    let selectedCandidate = null
    if (colorCandidate && flatRegion) {
      selectedCandidate = colorCandidate
    } else if (candidates.length) {
      selectedCandidate = candidates.sort((a, b) => b.confidence - a.confidence)[0]
      if (colorCandidate && colorCandidate.confidence > selectedCandidate.confidence * 1.35) {
        selectedCandidate = colorCandidate
      }
    } else if (colorCandidate) {
      selectedCandidate = colorCandidate
    } else if (!verySlender && (part.score > 14 || part.edgeScore > 0.08)) {
      selectedCandidate = {
        type: '内容',
        confidence: Math.max(part.score, part.edgeScore * 100),
        element: '可见内容区域',
        design_value: `可见轮廓密度 ${toPercent(designMetrics.density)}`,
        implementation_value: `可见轮廓密度 ${toPercent(implementationMetrics.density)}`,
        text: '该区域存在明显的可见差异，但现有像素证据不足以可靠归因到具体尺寸、位置或样式属性',
      }
    }

    if (selectedCandidate) rawIssues.push({ ...baseIssue, ...selectedCandidate })

    if (index % 12 === 11) {
      reportProgress(onProgress, 'classify', 82 + 12 * index / Math.max(1, sortedParts.length - 1))
      await yieldToHost(signal)
    }
  }

  const issues = []
  for (const issue of rawIssues.sort((a, b) =>
    b.score - a.score || ISSUE_PRIORITY.indexOf(a.type) - ISSUE_PRIORITY.indexOf(b.type),
  )) {
    const duplicate = issues.some((existing) =>
      iou(existing.box, issue.box) > 0.72 ||
      smallOverlap(existing.box, issue.box) > 0.9,
    )
    if (duplicate) continue
    const { confidence: _confidence, ...cleanIssue } = issue
    issues.push(cleanIssue)
  }

  throwIfAborted(signal)
  return {
    issues: issues.map((issue, index) => ({ id: `issue-${index + 1}`, ...issue })),
    coverage: coveragePercent,
    metrics,
  }
}
