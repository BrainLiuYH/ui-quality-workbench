const TOKEN_KEY = "ui-quality-workbench.bridge-token";

function consumeFragmentToken() {
  if (typeof window === "undefined") return "";
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = fragment.get("token") || "";
  if (!token) return "";

  window.sessionStorage.setItem(TOKEN_KEY, token);
  fragment.delete("token");
  const remaining = fragment.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`);
  return token;
}

let bridgeToken = consumeFragmentToken();

export function getBridgeToken() {
  if (bridgeToken) return bridgeToken;
  if (typeof window === "undefined") return "";
  bridgeToken = window.sessionStorage.getItem(TOKEN_KEY) || "";
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
    throw new Error("当前页面未通过 Skill 本地服务启动，仅支持本地图片上传。请重新运行 Skill 启动脚本。");
  }

  const headers = new Headers(options.headers || {});
  headers.set("X-Workbench-Token", token);
  const response = await fetch(path, { ...options, headers });
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
