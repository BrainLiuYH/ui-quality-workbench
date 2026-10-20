const TOKEN_KEY = "ui-quality-workbench.bridge-token";

function consumeFragmentToken() {
  if (typeof window === "undefined") return "";
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = fragment.get("token") || "";
  if (!token) return "";

  try { window.sessionStorage.setItem(TOKEN_KEY, token); } catch { /* Private browser storage may be unavailable. */ }
  fragment.delete("token");
  const remaining = fragment.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`);
  return token;
}

const fragmentToken = consumeFragmentToken();
// Only the loopback Python service adds this meta tag. It also replaces stale
// tokens after a restart, even when a user opens a saved URL without a fragment.
let bridgeToken = (typeof document !== "undefined" && document.querySelector('meta[name="workbench-bridge-token"]')?.content) || fragmentToken;
if (bridgeToken && typeof window !== "undefined") {
  try { window.sessionStorage.setItem(TOKEN_KEY, bridgeToken); } catch { /* Keep the in-memory session. */ }
}

export function getBridgeToken() {
  if (bridgeToken) return bridgeToken;
  if (typeof window === "undefined") return "";
  try { bridgeToken = window.sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
  return bridgeToken;
}

async function readError(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => null);
    return payload?.message || payload?.error || `请求失败（${response.status}）`;
  }
  const message = await response.text().catch(() => "");
  return message.trim() || `请求失败（${response.status}）`;
}

async function bridgeFetch(path, options = {}) {
  const token = getBridgeToken();
  if (!token) {
    throw new Error("尚未连接本地服务。请从项目或 Skill 目录运行 start.py，并打开启动器返回的页面；Windows 可双击 start-windows.cmd。");
  }

  const headers = new Headers(options.headers || {});
  headers.set("X-Workbench-Token", token);
  let response;
  try { response = await fetch(path, { ...options, headers }); } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("本地服务连接已断开。请重新启动 start.py，并打开它返回的页面。");
  }
  if (response.status === 401) throw new Error("本地连接已过期。请刷新页面；若仍未连接，请打开启动器返回的新地址。");
  if (!response.headers.get("content-type")?.includes("application/json") && !response.headers.get("content-type")?.startsWith("image/")) {
    throw new Error("当前地址没有运行本地服务。请运行 start.py；开发预览或静态网页无法下载视频。");
  }
  if (!response.ok) throw new Error(await readError(response));
  return response;
}

export async function getLocalCapabilities({ signal } = {}) {
  const token = getBridgeToken();
  if (!token) {
    return {
      bridge: false,
      figma: { available: false, environmentToken: false },
      capture: { available: false, browser: null },
    };
  }
  const response = await bridgeFetch("/api/capabilities", { method: "GET", signal });
  return response.json();
}

async function requestImage(path, payload, fallbackName, { signal } = {}) {
  const response = await bridgeFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "image/png" },
    body: JSON.stringify(payload),
    signal,
  });
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("本地服务没有返回有效图片。");
  const disposition = response.headers.get("content-disposition") || "";
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const simpleName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const name = encodedName ? decodeURIComponent(encodedName) : simpleName || fallbackName;
  return new File([blob], name, { type: blob.type || "image/png", lastModified: Date.now() });
}

export function importFigmaFrame({ url, accessToken, scale = 2, signal }) {
  return requestImage(
    "/api/figma/import",
    { url, accessToken: accessToken || undefined, scale },
    "figma-frame.png",
    { signal },
  );
}

export function captureWebPage({ url, width = 1440, height = 1024, waitMs = 1500, signal }) {
  return requestImage(
    "/api/capture",
    { url, width, height, waitMs },
    "webpage-capture.png",
    { signal },
  );
}

async function requestDesktopAction(path, payload = {}) {
  const response = await bridgeFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

export function launchVideoDownloader(url = "") {
  return requestDesktopAction("/api/apps/ydl/launch", { url });
}

export function openVideoDownloadFolder() {
  return requestDesktopAction("/api/apps/ydl/folder");
}

export function chooseVideoDownloadFolder(directory) {
  return requestDesktopAction("/api/video/directory", { directory });
}

export function listVideoDirectories(directory = "") {
  return requestDesktopAction("/api/video/directories", { directory });
}

export function checkVideoEnvironment() {
  return requestDesktopAction("/api/video/check");
}

export function installVideoDependencies() {
  return requestDesktopAction("/api/video/install");
}

export function openVideoJobFolder(id) {
  return requestDesktopAction("/api/video/folder", { id });
}

export function parseVideo(url) {
  return requestDesktopAction("/api/video/parse", { url });
}

export function downloadVideo(parseId, quality) {
  return requestDesktopAction("/api/video/download", { parseId, quality });
}

export function cancelVideoJob(id) {
  return requestDesktopAction("/api/video/cancel", { id });
}

export async function getVideoJobs({ signal } = {}) {
  const response = await bridgeFetch("/api/video/jobs", { signal });
  return response.json();
}
