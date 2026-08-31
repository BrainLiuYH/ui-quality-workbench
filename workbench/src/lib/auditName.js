const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp)$/iu;
const SCALE_SUFFIX = /(?:[\s._-]*@\d+(?:\.\d+)?x)$/iu;
const SIZE_SUFFIX = /(?:[\s._-]*\d{2,5}\s*[x×]\s*\d{2,5})$/iu;
const ROLE_PREFIX = /^(?:设计稿|设计|期望|实现稿|实现截图|实现|实际|design|expected|spec|implementation|actual)[\s._-]+/iu;
const ROLE_SUFFIX = /[\s._-]+(?:设计稿|设计|期望|实现稿|实现截图|实现|实际|design|expected|spec|implementation|actual)$/iu;
const GENERIC_NAME = /^(?:image|img\s*\d*|screenshot\s*\d*|screen\s*shot\s*\d*|capture\s*\d*|untitled|download\s*\d*)$/iu;
const MAX_TITLE_LENGTH = 52;

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function compact(value, limit = MAX_TITLE_LENGTH) {
  const text = value.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function cleanSourceName(value) {
  let name = safeDecode(String(value || "").trim())
    .split(/[\\/]/u)
    .pop()
    ?.replace(/[?#].*$/u, "") || "";
  name = name
    .replace(IMAGE_EXTENSION, "")
    .replace(SCALE_SUFFIX, "")
    .replace(SIZE_SUFFIX, "")
    .replace(ROLE_PREFIX, "")
    .replace(ROLE_SUFFIX, "")
    .replace(/[._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return name;
}

function nameFromSourceUrl(source) {
  if (!source?.sourceUrl) return "";
  try {
    const url = new URL(source.sourceUrl);
    const segments = url.pathname.split("/").filter(Boolean).map(safeDecode);
    if (source.sourceType === "figma" && segments.length >= 3) {
      return cleanSourceName(segments[2]);
    }
    if (source.sourceType === "web") {
      const lastSegment = segments.at(-1) || "";
      const pathName = cleanSourceName(lastSegment);
      if (pathName && !/^index$/iu.test(pathName)) return pathName;
      return url.hostname.replace(/^www\./iu, "");
    }
  } catch {
    return "";
  }
  return "";
}

function sourceDescriptor(source, fallbackLabel) {
  if (!source) return "";
  const urlName = nameFromSourceUrl(source);
  const fileName = cleanSourceName(source.name);
  const preferred = urlName || fileName;
  if (preferred && !GENERIC_NAME.test(preferred)) return preferred;
  const label = source.sourceLabel || fallbackLabel;
  const dimensions = source.width && source.height ? `${source.width}×${source.height}` : "";
  return [label, dimensions].filter(Boolean).join(" · ") || fallbackLabel;
}

function sameName(left, right) {
  return left.localeCompare(right, undefined, { sensitivity: "base" }) === 0;
}

export function deriveAuditName(sources = {}) {
  const design = sourceDescriptor(sources.design, "设计稿");
  const implementation = sourceDescriptor(sources.implementation, "实现稿");

  if (design && implementation) {
    if (sameName(design, implementation)) return compact(`${design} · 对比`);
    const available = MAX_TITLE_LENGTH - 3;
    const partLimit = Math.max(12, Math.floor(available / 2));
    return `${compact(design, partLimit)} ↔ ${compact(implementation, partLimit)}`;
  }
  if (design) return compact(`${design} · 待添加实现稿`);
  if (implementation) return compact(`${implementation} · 待添加设计稿`);
  return "未命名走查";
}
