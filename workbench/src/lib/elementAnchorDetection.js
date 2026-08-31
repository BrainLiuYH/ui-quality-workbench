const MAX_DETECTION_SIDE = 640;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeRect(rect, width, height) {
  const left = clamp(Math.floor(Number(rect?.x) || 0), 0, Math.max(0, width - 1));
  const top = clamp(Math.floor(Number(rect?.y) || 0), 0, Math.max(0, height - 1));
  const right = clamp(Math.ceil((Number(rect?.x) || 0) + (Number(rect?.width) || 1)), left + 1, width);
  const bottom = clamp(Math.ceil((Number(rect?.y) || 0) + (Number(rect?.height) || 1)), top + 1, height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function intersectionArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function estimateBackground(data, width, height) {
  const band = Math.max(2, Math.round(Math.min(width, height) * 0.09));
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 12_000)));
  const buckets = new Map();

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (x >= band && x < width - band && y >= band && y < height - band) continue;
      const index = (y * width + x) * 4;
      if (data[index + 3] < 32) continue;
      const key = `${data[index] >> 4}:${data[index + 1] >> 4}:${data[index + 2] >> 4}`;
      const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      bucket.count += 1;
      bucket.r += data[index];
      bucket.g += data[index + 1];
      bucket.b += data[index + 2];
      buckets.set(key, bucket);
    }
  }

  let dominant = null;
  for (const bucket of buckets.values()) {
    if (!dominant || bucket.count > dominant.count) dominant = bucket;
  }
  if (!dominant) return { r: 255, g: 255, b: 255 };
  return {
    r: dominant.r / dominant.count,
    g: dominant.g / dominant.count,
    b: dominant.b / dominant.count,
  };
}

function buildSalienceMask(data, width, height, background) {
  const count = width * height;
  const distances = new Uint8Array(count);
  const ringSamples = [];
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.08));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const index = pixel * 4;
      if (data[index + 3] < 32) continue;
      const distance = Math.max(
        Math.abs(data[index] - background.r),
        Math.abs(data[index + 1] - background.g),
        Math.abs(data[index + 2] - background.b),
      );
      distances[pixel] = Math.min(255, Math.round(distance));
      if (x < ring || x >= width - ring || y < ring || y >= height - ring) {
        ringSamples.push(distance);
      }
    }
  }

  ringSamples.sort((a, b) => a - b);
  const noise = ringSamples.length
    ? ringSamples[Math.floor((ringSamples.length - 1) * 0.82)]
    : 0;
  const colorThreshold = clamp(Math.round(noise + 9), 12, 42);
  const edgeThreshold = clamp(Math.round(colorThreshold * 0.72), 9, 30);
  const mask = new Uint8Array(count);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const index = pixel * 4;
      if (data[index + 3] < 32) continue;
      let edge = 0;
      if (x + 1 < width) {
        const next = index + 4;
        edge = Math.max(edge,
          Math.abs(data[index] - data[next]),
          Math.abs(data[index + 1] - data[next + 1]),
          Math.abs(data[index + 2] - data[next + 2]));
      }
      if (y + 1 < height) {
        const next = index + width * 4;
        edge = Math.max(edge,
          Math.abs(data[index] - data[next]),
          Math.abs(data[index + 1] - data[next + 1]),
          Math.abs(data[index + 2] - data[next + 2]));
      }
      if (distances[pixel] >= colorThreshold || edge >= edgeThreshold) mask[pixel] = 1;
    }
  }
  return mask;
}

function dilateMask(mask, width, height, radiusX, radiusY) {
  const horizontal = new Uint8Array(mask.length);
  const output = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    let active = 0;
    for (let x = -radiusX; x < width + radiusX; x += 1) {
      const addX = x + radiusX;
      const removeX = x - radiusX - 1;
      if (addX >= 0 && addX < width) active += mask[y * width + addX];
      if (removeX >= 0 && removeX < width) active -= mask[y * width + removeX];
      if (x >= 0 && x < width && active > 0) horizontal[y * width + x] = 1;
    }
  }

  for (let x = 0; x < width; x += 1) {
    let active = 0;
    for (let y = -radiusY; y < height + radiusY; y += 1) {
      const addY = y + radiusY;
      const removeY = y - radiusY - 1;
      if (addY >= 0 && addY < height) active += horizontal[addY * width + x];
      if (removeY >= 0 && removeY < height) active -= horizontal[removeY * width + x];
      if (y >= 0 && y < height && active > 0) output[y * width + x] = 1;
    }
  }
  return output;
}

function componentBounds(mask, originalMask, width, height) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];

  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    let read = 0;
    let write = 0;
    let left = width;
    let top = height;
    let right = 0;
    let bottom = 0;
    let originalCount = 0;
    queue[write++] = seed;
    visited[seed] = 1;

    while (read < write) {
      const pixel = queue[read++];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      if (originalMask[pixel]) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = Math.max(bottom, y + 1);
        originalCount += 1;
      }
      for (let oy = -1; oy <= 1; oy += 1) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let ox = -1; ox <= 1; ox += 1) {
          if (!ox && !oy) continue;
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (!mask[next] || visited[next]) continue;
          visited[next] = 1;
          queue[write++] = next;
        }
      }
    }

    if (originalCount >= 3 && right > left && bottom > top) {
      components.push({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        pixelCount: originalCount,
      });
    }
  }
  return components;
}

function perimeterSupport(mask, width, height, rect) {
  const inset = Math.max(1, Math.round(Math.min(rect.width, rect.height) * 0.08));
  let supported = 0;
  let total = 0;
  const left = clamp(rect.x, 0, width - 1);
  const right = clamp(rect.x + rect.width - 1, 0, width - 1);
  const top = clamp(rect.y, 0, height - 1);
  const bottom = clamp(rect.y + rect.height - 1, 0, height - 1);

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const nearEdge = x - left <= inset || right - x <= inset || y - top <= inset || bottom - y <= inset;
      if (!nearEdge) continue;
      total += 1;
      supported += mask[y * width + x];
    }
  }
  return total ? supported / total : 0;
}

function scoreCandidate(candidate, rough, mask, width, height) {
  const overlap = intersectionArea(candidate, rough);
  if (!overlap) return -Infinity;
  const roughArea = rough.width * rough.height;
  const candidateArea = candidate.width * candidate.height;
  const roughCenter = { x: rough.x + rough.width / 2, y: rough.y + rough.height / 2 };
  const candidateCenter = { x: candidate.x + candidate.width / 2, y: candidate.y + candidate.height / 2 };
  const centerDistance = Math.hypot(candidateCenter.x - roughCenter.x, candidateCenter.y - roughCenter.y);
  const centerScore = clamp(1 - centerDistance / Math.max(1, Math.hypot(rough.width, rough.height)), 0, 1);
  const sizeScore = Math.exp(-Math.abs(Math.log(Math.max(0.001, candidateArea / roughArea))) * 0.48);
  const containsCenter = roughCenter.x >= candidate.x && roughCenter.x <= candidate.x + candidate.width &&
    roughCenter.y >= candidate.y && roughCenter.y <= candidate.y + candidate.height;
  const frameScore = clamp(perimeterSupport(mask, width, height, candidate) * 3.2, 0, 1);
  const touchesSearchEdge = candidate.x <= 1 || candidate.y <= 1 ||
    candidate.x + candidate.width >= width - 1 || candidate.y + candidate.height >= height - 1;
  const density = candidate.pixelCount / Math.max(1, candidateArea);
  const densityScore = clamp(density / 0.22, 0, 1);

  return 0.34 * (overlap / roughArea) +
    0.12 * (overlap / candidateArea) +
    0.2 * centerScore +
    0.12 * sizeScore +
    0.08 * (containsCenter ? 1 : 0) +
    0.08 * frameScore +
    0.06 * densityScore -
    (touchesSearchEdge ? 0.28 : 0);
}

export function detectElementBounds({ data, width, height, roughBox }) {
  if (!data || data.length < width * height * 4 || width < 2 || height < 2) {
    throw new TypeError("detectElementBounds requires an RGBA raster");
  }
  const rough = sanitizeRect(roughBox, width, height);
  const background = estimateBackground(data, width, height);
  const salience = buildSalienceMask(data, width, height, background);
  const base = Math.max(1, Math.round(Math.min(rough.width, rough.height) * 0.08));
  const variants = [
    [1, 1],
    [Math.max(2, base * 2), Math.max(1, base)],
    [Math.max(4, base * 4), Math.max(2, base * 2)],
  ];
  const seen = new Set();
  const candidates = [];

  for (const [radiusX, radiusY] of variants) {
    const expanded = dilateMask(salience, width, height, radiusX, radiusY);
    for (const component of componentBounds(expanded, salience, width, height)) {
      const key = `${component.x}:${component.y}:${component.width}:${component.height}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const areaRatio = component.width * component.height / Math.max(1, rough.width * rough.height);
      if (component.width < 4 || component.height < 3 || areaRatio < 0.08 || areaRatio > 12) continue;
      const score = scoreCandidate(component, rough, salience, width, height);
      if (Number.isFinite(score)) candidates.push({ ...component, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0.47) {
    return {
      ...rough,
      anchorX: rough.x + rough.width / 2,
      anchorY: rough.y + rough.height / 2,
      recognized: false,
      confidence: 0,
      method: "manual-fallback",
    };
  }

  const padding = Math.max(1, Math.round(Math.min(best.width, best.height) * 0.025));
  const left = clamp(best.x - padding, 0, width - 1);
  const top = clamp(best.y - padding, 0, height - 1);
  const right = clamp(best.x + best.width + padding, left + 1, width);
  const bottom = clamp(best.y + best.height + padding, top + 1, height);
  const confidence = clamp((best.score - 0.42) / 0.42, 0, 1);
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    anchorX: (left + right) / 2,
    anchorY: (top + bottom) / 2,
    recognized: true,
    confidence,
    method: "visual-component",
  };
}

function createDetectionCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("当前浏览器无法读取图片像素");
}

export async function recognizeElementAnchor(source, roughNormalizedBox, placement) {
  if (!source?.file || !placement?.scale) {
    return { ...roughNormalizedBox, roughBox: { ...roughNormalizedBox }, recognized: false, confidence: 0 };
  }
  const sourceRough = {
    x: roughNormalizedBox.x / placement.scale,
    y: roughNormalizedBox.y / placement.scale,
    width: roughNormalizedBox.width / placement.scale,
    height: roughNormalizedBox.height / placement.scale,
  };
  const marginX = Math.max(20, sourceRough.width * 0.8);
  const marginY = Math.max(20, sourceRough.height * 1.1);
  const crop = sanitizeRect({
    x: sourceRough.x - marginX,
    y: sourceRough.y - marginY,
    width: sourceRough.width + marginX * 2,
    height: sourceRough.height + marginY * 2,
  }, source.width, source.height);
  const detectionScale = Math.min(1, MAX_DETECTION_SIDE / Math.max(crop.width, crop.height));
  const width = Math.max(2, Math.round(crop.width * detectionScale));
  const height = Math.max(2, Math.round(crop.height * detectionScale));
  let bitmap;

  try {
    bitmap = await createImageBitmap(source.file);
    const canvas = createDetectionCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器无法分析元素边界");
    context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
    const raster = context.getImageData(0, 0, width, height);
    const detected = detectElementBounds({
      data: raster.data,
      width,
      height,
      roughBox: {
        x: (sourceRough.x - crop.x) * detectionScale,
        y: (sourceRough.y - crop.y) * detectionScale,
        width: sourceRough.width * detectionScale,
        height: sourceRough.height * detectionScale,
      },
    });
    const sourceRect = {
      x: crop.x + detected.x / detectionScale,
      y: crop.y + detected.y / detectionScale,
      width: detected.width / detectionScale,
      height: detected.height / detectionScale,
      anchorX: crop.x + detected.anchorX / detectionScale,
      anchorY: crop.y + detected.anchorY / detectionScale,
    };
    return {
      x: sourceRect.x * placement.scale,
      y: sourceRect.y * placement.scale,
      width: sourceRect.width * placement.scale,
      height: sourceRect.height * placement.scale,
      anchorX: sourceRect.anchorX * placement.scale,
      anchorY: sourceRect.anchorY * placement.scale,
      roughBox: { ...roughNormalizedBox },
      recognized: detected.recognized,
      confidence: detected.confidence,
      method: detected.method,
    };
  } finally {
    bitmap?.close?.();
  }
}
