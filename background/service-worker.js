const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "FETCH_AS_DATA_URL") return false;

  fetchAsDataUrl(message.url, message.timeoutMs)
    .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function fetchAsDataUrl(rawUrl, timeoutMs = 30000) {
  const url = new URL(rawUrl);
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`不支持的图片协议：${url.protocol}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.href, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer"
    });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") && !blob.type.startsWith("video/")) {
      throw new Error(`不是图片或视频：${blob.type || "未知类型"}`);
    }
    return await blobToDataUrl(blob);
  } finally {
    clearTimeout(timer);
  }
}

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
  });
}
