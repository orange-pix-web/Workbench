const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "FETCH_AS_DATA_URL") {
    fetchAsDataUrl(message.url, message.timeoutMs)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "STORE_ASSET") {
    storeAsset(message.asset)
      .then((id) => sendResponse({ ok: true, id }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_ASSET") {
    getAsset(message.id)
      .then((asset) => sendResponse(asset ? { ok: true, asset } : { ok: false, error: "本地图片不存在" }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "DELETE_ASSETS") {
    deleteAssets(message.ids || [])
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

const DB_NAME = "pdd-local-publisher";
const STORE_NAME = "assets";

function openAssetDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeAsset(asset) {
  if (!asset?.dataUrl?.startsWith("data:")) throw new Error("本地图片数据无效");
  const id = crypto.randomUUID();
  const db = await openAssetDb();
  await transactionPromise(db, "readwrite", (store) => store.put({ id, name: asset.name, type: asset.type, dataUrl: asset.dataUrl, createdAt: Date.now() }));
  db.close();
  return id;
}

async function getAsset(id) {
  const db = await openAssetDb();
  const value = await transactionPromise(db, "readonly", (store) => store.get(id));
  db.close();
  return value;
}

async function deleteAssets(ids) {
  const db = await openAssetDb();
  await Promise.all(ids.map((id) => transactionPromise(db, "readwrite", (store) => store.delete(id))));
  db.close();
}

function transactionPromise(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

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
