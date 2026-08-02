const $ = (selector) => document.querySelector(selector);
let pendingImageTarget = null;

document.addEventListener("DOMContentLoaded", async () => {
  await render();
  $("#file").addEventListener("change", importFile);
  $("#download-template").addEventListener("click", downloadTemplate);
  $("#start").addEventListener("click", openNext);
  $("#clear-completed").addEventListener("click", clearCompleted);
  $("#export-log").addEventListener("click", exportLogs);
  $("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("#local-images").addEventListener("change", importLocalImages);
});

async function importFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const rows = file.name.toLowerCase().endsWith(".json") ? parseJson(text) : parseCsv(text);
    const tasks = rows.map(normalizeProduct);
    const queue = await PDDStorage.getQueue();
    await PDDStorage.saveQueue([...queue, ...tasks]);
    show(`已导入 ${tasks.length} 个商品`, false);
    await render();
  } catch (error) {
    show(`导入失败：${error.message}`);
  } finally {
    event.target.value = "";
  }
}

function parseJson(text) {
  const value = JSON.parse(text);
  const rows = Array.isArray(value) ? value : value.products;
  if (!Array.isArray(rows)) throw new Error("JSON 必须是数组，或包含 products 数组");
  return rows;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const nonEmpty = rows.filter((item) => item.some((cell) => cell.trim()));
  if (nonEmpty.length < 2) throw new Error("CSV 没有商品数据");
  const headers = nonEmpty[0].map((item) => item.trim());
  return nonEmpty.slice(1).map((values) => Object.fromEntries(headers.map((key, i) => [key, values[i] ?? ""])));
}

function normalizeProduct(row, index) {
  const aliases = {
    商品标题: "title", 标题: "title", 类目: "category_path", 主图: "carousel_images",
    轮播图: "carousel_images", 详情图: "detail_images", 视频: "video_url",
    价格: "price", 拼单价: "price", 库存: "stock", 市场价: "market_price",
    商品属性: "attributes_json", SKU: "sku_json", 物流模板: "logistics_template",
    发货时效: "shipping_hours", 商品描述: "description"
  };
  const product = {};
  for (const [key, value] of Object.entries(row)) product[aliases[key] || key] = value;
  if (!String(product.title || "").trim()) throw new Error(`第 ${index + 1} 行缺少 title/商品标题`);
  for (const key of ["carousel_images", "detail_images"]) {
    if (typeof product[key] === "string") product[key] = product[key].split(/[|;\n]/).map((x) => x.trim()).filter(Boolean);
  }
  for (const key of ["attributes_json", "sku_json"]) {
    if (typeof product[key] === "string" && product[key].trim()) {
      try { product[key.replace("_json", "")] = JSON.parse(product[key]); }
      catch { throw new Error(`第 ${index + 1} 行的 ${key} 不是合法 JSON`); }
    }
    delete product[key];
  }
  return {
    id: crypto.randomUUID(), status: "pending", attempts: 0,
    createdAt: new Date().toISOString(), product
  };
}

async function openNext() {
  const queue = await PDDStorage.getQueue();
  const task = queue.find((item) => item.status === "pending" || item.status === "failed");
  if (!task) return show("没有待处理商品");
  queue.forEach((item) => { if (item.status === "running") item.status = "pending"; });
  task.status = "running";
  task.attempts = (task.attempts || 0) + 1;
  task.startedAt = new Date().toISOString();
  await PDDStorage.saveQueue(queue);
  const settings = await PDDStorage.getSettings();
  await chrome.tabs.create({ url: settings.publishUrl });
  window.close();
}

async function clearCompleted() {
  const queue = await PDDStorage.getQueue();
  const completed = queue.filter((item) => item.status === "completed");
  const ids = completed.flatMap((item) => [...(item.product.local_carousel_images || []), ...(item.product.local_detail_images || [])].map((asset) => asset.id));
  if (ids.length) await chrome.runtime.sendMessage({ type: "DELETE_ASSETS", ids });
  await PDDStorage.saveQueue(queue.filter((item) => item.status !== "completed"));
  await render();
}

function chooseLocalImages(taskId, kind) {
  pendingImageTarget = { taskId, kind };
  $("#local-images").click();
}

async function importLocalImages(event) {
  const files = [...(event.target.files || [])];
  if (!files.length || !pendingImageTarget) return;
  try {
    const queue = await PDDStorage.getQueue();
    const task = queue.find((item) => item.id === pendingImageTarget.taskId);
    if (!task) throw new Error("任务不存在");
    const key = pendingImageTarget.kind === "carousel" ? "local_carousel_images" : "local_detail_images";
    task.product[key] ||= [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const dataUrl = await fileToDataUrl(file);
      const response = await chrome.runtime.sendMessage({ type: "STORE_ASSET", asset: { name: file.name, type: file.type, dataUrl } });
      if (!response?.ok) throw new Error(response?.error || `${file.name} 保存失败`);
      task.product[key].push({ id: response.id, name: file.name, type: file.type });
    }
    await PDDStorage.saveQueue(queue);
    show(`已添加 ${files.length} 张本地图片`, false);
    await render();
  } catch (error) { show(`图片导入失败：${error.message}`); }
  finally { event.target.value = ""; pendingImageTarget = null; }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function downloadTemplate() {
  const headers = ["title", "category_path", "carousel_images", "detail_images", "video_url", "price", "market_price", "stock", "attributes_json", "sku_json", "logistics_template", "shipping_hours", "description"];
  const sample = ["示例商品标题", "家居生活>清洁用品", "https://example.com/1.jpg|https://example.com/2.jpg", "https://example.com/detail.jpg", "", "25.60", "39.90", "100", "{\"品牌\":\"其他\"}", "[{\"spec\":{\"规格\":\"500g\"},\"price\":\"25.60\",\"stock\":100}]", "默认模板", "48", "示例商品描述"];
  const csv = `\uFEFF${headers.join(",")}\n${sample.map(csvEscape).join(",")}\n`;
  downloadBlob(csv, "pdd-products-template.csv", "text/csv;charset=utf-8");
}

async function exportLogs() {
  const logs = await PDDStorage.get(PDDStorage.KEYS.logs, []);
  downloadBlob(JSON.stringify(logs, null, 2), `pdd-publisher-logs-${Date.now()}.json`, "application/json");
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadBlob(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function render() {
  const queue = await PDDStorage.getQueue();
  $("#count").textContent = `${queue.length} 个任务`;
  $("#queue").replaceChildren(...queue.map((task) => {
    const item = document.createElement("article");
    item.className = `task ${task.status}`;
    const title = document.createElement("div"); title.className = "task-title"; title.textContent = task.product.title;
    const meta = document.createElement("div"); meta.className = "task-meta";
    const mainCount = task.product.local_carousel_images?.length || 0;
    const detailCount = task.product.local_detail_images?.length || 0;
    meta.textContent = `${statusText(task.status)} · 尝试 ${task.attempts || 0} 次 · 本地主图 ${mainCount} · 详情图 ${detailCount}${task.error ? ` · ${task.error}` : ""}`;
    const tools = document.createElement("div"); tools.className = "task-tools";
    const mainButton = document.createElement("button"); mainButton.textContent = "+ 本地主图"; mainButton.addEventListener("click", () => chooseLocalImages(task.id, "carousel"));
    const detailButton = document.createElement("button"); detailButton.textContent = "+ 本地详情图"; detailButton.addEventListener("click", () => chooseLocalImages(task.id, "detail"));
    tools.append(mainButton, detailButton);
    item.append(title, meta, tools); return item;
  }));
}

function statusText(status) {
  return ({ pending: "等待", running: "处理中", completed: "完成", failed: "失败" })[status] || status;
}

function show(message, error = true) {
  $("#message").textContent = message;
  $("#message").style.color = error ? "#b42318" : "#15803d";
}
