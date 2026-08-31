import { buildWidthNormalization } from "../engine/profile.js";

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_NORMALIZED_PIXELS = 32_000_000;

export function validateImageFile(file) {
  if (!(file instanceof Blob)) throw new Error("请选择有效的图片文件。");
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) throw new Error("仅支持 PNG、JPEG 和 WebP 图片。");
  if (!file.size) throw new Error("图片文件为空。");
  if (file.size > MAX_FILE_BYTES) throw new Error("图片文件不能超过 40 MB。");
  return file;
}

export function selectSingleImageFile(files) {
  const candidates = Array.from(files || []);
  if (candidates.length !== 1) throw new Error("每个区域一次只能拖入一张图片。");
  return validateImageFile(candidates[0]);
}

export async function createImageSource(file, metadata = {}) {
  validateImageFile(file);

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("图片解码失败，请确认文件没有损坏。");
  }

  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close?.();
  if (!width || !height) throw new Error("图片尺寸无效。");
  if (width * height > MAX_PIXELS) throw new Error("图片像素超过 3200 万，请先缩小尺寸后重试。");

  return {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    file,
    name: file.name || metadata.name || "image.png",
    type: file.type,
    size: file.size,
    width,
    height,
    objectUrl: URL.createObjectURL(file),
    sourceType: metadata.sourceType || "local",
    sourceLabel: metadata.sourceLabel || "本地图片",
    sourceUrl: metadata.sourceUrl || "",
    capturedAt: metadata.capturedAt || new Date().toISOString(),
  };
}

export function disposeImageSource(source) {
  if (source?.objectUrl) URL.revokeObjectURL(source.objectUrl);
}

export function decodeImageSource(source) {
  if (!source?.file) return Promise.reject(new Error("图片输入不存在。"));
  return createImageBitmap(source.file);
}

export function deriveComparisonProfile(design, implementation, { alignment = "top-left", anchors = null } = {}) {
  if (!design || !implementation) return null;
  const normalization = buildWidthNormalization(design, implementation, {
    alignment,
    anchors,
    maxPixels: Number.MAX_SAFE_INTEGER,
  });
  const targetWidth = normalization.targetWidth;
  const targetHeight = normalization.canvasHeight;
  const normalizedPixels = normalization.pixels;
  const widthsDiffer = design.width !== implementation.width;
  const heightsDiffer = normalization.designHeight !== normalization.implementationHeight;
  const bottomAligned = normalization.alignment === "bottom-left";

  return {
    mode: widthsDiffer ? "width-normalized" : "same-width",
    label: alignment === "element"
      ? normalization.anchorReady ? "按选中元素对齐" : "等待框选对应元素"
      : widthsDiffer
      ? `等比放大至同宽${heightsDiffer ? ` · ${bottomAligned ? "底部" : "顶部"}对齐` : ""}`
      : heightsDiffer
        ? `同宽${bottomAligned ? "底部" : "顶部"}对齐`
        : "原尺寸对比",
    targetWidth,
    targetHeight,
    normalizedPixels,
    exceedsSafetyLimit: !Number.isSafeInteger(normalizedPixels) || normalizedPixels > MAX_NORMALIZED_PIXELS,
    designScale: normalization.designScale,
    implementationScale: normalization.implementationScale,
    designNormalizedWidth: targetWidth,
    designNormalizedHeight: normalization.designHeight,
    implementationNormalizedWidth: targetWidth,
    implementationNormalizedHeight: normalization.implementationHeight,
    designOffsetX: normalization.designOffsetX,
    designOffsetY: normalization.designOffsetY,
    implementationOffsetX: normalization.implementationOffsetX,
    implementationOffsetY: normalization.implementationOffsetY,
    comparisonWidth: normalization.canvasWidth,
    comparisonHeight: normalization.canvasHeight,
    widthsDiffer,
    heightsDiffer,
    alignment,
    verticalAlignment: alignment === "element" ? "element" : bottomAligned ? "bottom" : "top",
    anchorReady: normalization.anchorReady,
    anchors: normalization.anchors,
    anchorDelta: normalization.anchorDelta,
    overlapRect: normalization.overlapRect,
    sharedAreaRatio: normalization.sharedAreaRatio,
  };
}

export const imageLimits = {
  acceptedTypes: [...ACCEPTED_IMAGE_TYPES],
  maxFileBytes: MAX_FILE_BYTES,
  maxPixels: MAX_PIXELS,
  maxNormalizedPixels: MAX_NORMALIZED_PIXELS,
};
