/** 按文件头识别 base64 图片的 MIME，支持 png / gif / jpeg / webp，识别失败回退 png。 */
export function sniffBase64ImageMime(base64: string | undefined | null, fallback = "image/png"): string {
  let text = String(base64 || "").trim();
  if (text.startsWith("data:")) {
    const comma = text.indexOf(",");
    text = comma >= 0 ? text.slice(comma + 1) : "";
  }
  if (text.startsWith("iVBORw0KGgo")) return "image/png";
  if (text.startsWith("R0lGODlh") || text.startsWith("R0lGODdh")) return "image/gif";
  if (text.startsWith("/9j/")) return "image/jpeg";
  if (text.startsWith("UklGR")) {
    try {
      if (atob(text.slice(0, 16)).slice(8, 12) === "WEBP") return "image/webp";
    } catch {
      // 非法 base64，走 fallback
    }
  }
  return fallback;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

export function imageExtensionForMime(mime: string | undefined | null, fallback = "png"): string {
  const normalized = String(mime || "").split(";", 1)[0].trim().toLowerCase();
  return EXTENSION_BY_MIME[normalized] || fallback;
}

/** 从图片 URL 路径推断扩展名（blob:/data: 等无法推断时返回 fallback）。 */
export function imageExtensionFromUrl(url: string | undefined | null, fallback = "png"): string {
  const value = String(url || "");
  if (value.startsWith("data:")) {
    return imageExtensionForMime(value.slice(5).split(/[;,]/, 1)[0], fallback);
  }
  if (!value || value.startsWith("blob:")) return fallback;
  try {
    const path = new URL(value, "http://localhost").pathname;
    const match = path.match(/\.(png|gif|jpe?g|webp)$/i);
    if (!match) return fallback;
    const ext = match[1].toLowerCase();
    return ext === "jpeg" ? "jpg" : ext;
  } catch {
    return fallback;
  }
}
