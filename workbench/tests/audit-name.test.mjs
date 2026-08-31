import test from "node:test";
import assert from "node:assert/strict";
import { cleanSourceName, deriveAuditName } from "../src/lib/auditName.js";

const source = (name, metadata = {}) => ({
  name,
  sourceType: "local",
  sourceLabel: "本地图片",
  width: 1080,
  height: 2400,
  ...metadata,
});

test("cleanSourceName removes image and role suffixes", () => {
  assert.equal(cleanSourceName("结算页-设计稿@2x.png"), "结算页");
  assert.equal(cleanSourceName("checkout_implementation_1080x2400.webp"), "checkout");
});

test("deriveAuditName uses a shared source name when both roles match", () => {
  assert.equal(deriveAuditName({
    design: source("结算页-设计稿.png"),
    implementation: source("结算页-实现稿.png"),
  }), "结算页 · 对比");
});

test("deriveAuditName keeps distinct source names honest", () => {
  assert.equal(deriveAuditName({
    design: source("Create Space.png"),
    implementation: source("Create Space-v2.png"),
  }), "Create Space ↔ Create Space v2");
});

test("deriveAuditName prefers meaningful web and Figma URL names", () => {
  assert.equal(deriveAuditName({
    design: source("figma-file-node.png", {
      sourceType: "figma",
      sourceLabel: "Figma Frame",
      sourceUrl: "https://figma.com/design/abc123/Create-Space?node-id=1-2",
    }),
    implementation: source("capture-example-com-1440x1024.png", {
      sourceType: "web",
      sourceLabel: "网页截图",
      sourceUrl: "https://example.com/create-space?state=default",
    }),
  }), "Create Space · 对比");
});

test("deriveAuditName handles partial and empty inputs", () => {
  assert.equal(deriveAuditName({}), "未命名走查");
  assert.equal(deriveAuditName({ design: source("home-design.png") }), "home · 待添加实现稿");
  assert.equal(deriveAuditName({ implementation: source("image.png") }), "本地图片 · 1080×2400 · 待添加设计稿");
});
