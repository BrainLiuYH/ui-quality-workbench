import assert from "node:assert/strict";
import test from "node:test";
import { deriveComparisonProfile, imageLimits, selectSingleImageFile, validateImageFile } from "../src/lib/imageSources.js";

test("validateImageFile accepts supported non-empty image blobs", () => {
  const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  assert.equal(validateImageFile(image), image);
});

test("validateImageFile rejects empty and unsupported blobs", () => {
  assert.throws(() => validateImageFile(new Blob([], { type: "image/png" })), /文件为空/);
  assert.throws(() => validateImageFile(new Blob(["text"], { type: "text/plain" })), /仅支持/);
});

test("selectSingleImageFile rejects empty and multi-file drops", () => {
  const first = new Blob([new Uint8Array([1])], { type: "image/png" });
  const second = new Blob([new Uint8Array([2])], { type: "image/webp" });
  assert.equal(selectSingleImageFile([first]), first);
  assert.throws(() => selectSingleImageFile([]), /一次只能拖入一张/);
  assert.throws(() => selectSingleImageFile([first, second]), /一次只能拖入一张/);
});

test("published image limits match the drag-and-drop contract", () => {
  assert.deepEqual([...imageLimits.acceptedTypes].sort(), ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(imageLimits.maxFileBytes, 40 * 1024 * 1024);
  assert.equal(imageLimits.maxPixels, 32 * 1024 * 1024);
  assert.equal(imageLimits.maxNormalizedPixels, 32_000_000);
});

test("deriveComparisonProfile enlarges only the narrower image to the wider width", () => {
  const profile = deriveComparisonProfile(
    { width: 720, height: 1000 },
    { width: 1440, height: 1800 },
  );

  assert.equal(profile.mode, "width-normalized");
  assert.equal(profile.targetWidth, 1440);
  assert.equal(profile.targetHeight, 2000);
  assert.equal(profile.designScale, 2);
  assert.equal(profile.implementationScale, 1);
  assert.equal(profile.designNormalizedHeight, 2000);
  assert.equal(profile.implementationNormalizedHeight, 1800);
  assert.equal(profile.alignment, "top-left");
  assert.equal(profile.exceedsSafetyLimit, false);
});

test("deriveComparisonProfile applies the same max-width rule regardless of source role", () => {
  const profile = deriveComparisonProfile(
    { width: 1600, height: 900 },
    { width: 800, height: 600 },
  );

  assert.equal(profile.targetWidth, 1600);
  assert.equal(profile.targetHeight, 1200);
  assert.equal(profile.designScale, 1);
  assert.equal(profile.implementationScale, 2);
  assert.equal(profile.designNormalizedHeight, 900);
  assert.equal(profile.implementationNormalizedHeight, 1200);
});

test("deriveComparisonProfile can anchor unequal heights to the bottom edge", () => {
  const profile = deriveComparisonProfile(
    { width: 720, height: 1000 },
    { width: 1440, height: 1800 },
    { alignment: "bottom-left" },
  );

  assert.equal(profile.alignment, "bottom-left");
  assert.equal(profile.verticalAlignment, "bottom");
  assert.equal(profile.designOffsetY, 0);
  assert.equal(profile.implementationOffsetY, 200);
  assert.equal(profile.designOffsetY + profile.designNormalizedHeight, profile.targetHeight);
  assert.equal(profile.implementationOffsetY + profile.implementationNormalizedHeight, profile.targetHeight);
  assert.match(profile.label, /底部对齐/);
});

test("deriveComparisonProfile aligns matching element centers without scaling", () => {
  const profile = deriveComparisonProfile(
    { width: 100, height: 100 },
    { width: 100, height: 100 },
    {
      alignment: "element",
      anchors: {
        design: { x: 40, y: 40, width: 20, height: 20 },
        implementation: { x: 50, y: 60, width: 20, height: 20 },
      },
    },
  );

  assert.equal(profile.anchorReady, true);
  assert.deepEqual(profile.anchorDelta, { x: -10, y: -20 });
  assert.equal(profile.designOffsetX, 10);
  assert.equal(profile.designOffsetY, 20);
  assert.equal(profile.implementationOffsetX, 0);
  assert.equal(profile.implementationOffsetY, 0);
  assert.equal(profile.comparisonWidth, 110);
  assert.equal(profile.comparisonHeight, 120);
  assert.deepEqual(profile.overlapRect, { x: 10, y: 20, width: 90, height: 80 });
  assert.equal(profile.designScale, 1);
  assert.equal(profile.implementationScale, 1);
});

test("deriveComparisonProfile leaves equal-width inputs at their original scale", () => {
  const profile = deriveComparisonProfile(
    { width: 1280, height: 720 },
    { width: 1280, height: 800 },
  );

  assert.equal(profile.mode, "same-width");
  assert.equal(profile.label, "同宽顶部对齐");
  assert.equal(profile.designScale, 1);
  assert.equal(profile.implementationScale, 1);
  assert.equal(profile.targetHeight, 800);
});

test("deriveComparisonProfile flags an unsafe normalized comparison canvas", () => {
  const profile = deriveComparisonProfile(
    { width: 1000, height: 9000 },
    { width: 4000, height: 1000 },
  );

  assert.equal(profile.targetWidth, 4000);
  assert.equal(profile.targetHeight, 36000);
  assert.equal(profile.normalizedPixels, 144_000_000);
  assert.equal(profile.exceedsSafetyLimit, true);
});
