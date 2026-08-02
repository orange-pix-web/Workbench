(function initPublisher() {
  if (window.top !== window || document.querySelector("#pdd-local-publisher-panel")) return;

  const DEFAULT_MAPPINGS = {
    title: ["商品标题", "请输入商品标题", "标题"],
    description: ["商品描述", "商品详情", "描述"],
    price: ["拼单价", "商品价格", "价格"],
    market_price: ["市场价", "单买价"],
    stock: ["库存", "商品库存"],
    logistics_template: ["运费模板", "物流模板"],
    shipping_hours: ["承诺发货时间", "发货时效"],
    category_path: ["商品分类", "商品类目", "类目"]
  };

  let currentTask = null;
  let settings = null;
  let busy = false;

  boot().catch((error) => console.error("[PDD Local Publisher]", error));

  async function boot() {
    settings = await PDDStorage.getSettings();
    const queue = await PDDStorage.getQueue();
    currentTask = queue.find((item) => item.status === "running");
    if (!currentTask) return;
    createPanel();
    logLine("任务已载入，点击“填写页面”开始。", "ok");
  }

  function createPanel() {
    const panel = document.createElement("section");
    panel.id = "pdd-local-publisher-panel";
    const heading = document.createElement("h3"); heading.textContent = "PDD 本地上货";
    const title = document.createElement("div"); title.className = "pddlp-title"; title.textContent = currentTask.product.title;
    const actions = document.createElement("div"); actions.className = "pddlp-actions";
    actions.append(
      button("填写页面", "primary", fillPage),
      button("保存草稿", "", () => performFinalAction("draft")),
      button("提交发布", "danger", () => performFinalAction("submit")),
      button("标记失败", "", () => finishTask("failed", "用户手动标记失败"))
    );
    const status = document.createElement("div"); status.className = "pddlp-status";
    panel.append(heading, title, actions, status);
    document.body.append(panel);
  }

  function button(label, className, handler) {
    const element = document.createElement("button");
    element.textContent = label; element.className = className;
    element.addEventListener("click", () => runLocked(handler));
    return element;
  }

  async function runLocked(handler) {
    if (busy) return;
    busy = true;
    setButtonsDisabled(true);
    try { await handler(); }
    catch (error) {
      logLine(error.message, "error");
      await PDDStorage.appendLog({ taskId: currentTask.id, level: "error", message: error.message });
    } finally {
      busy = false;
      setButtonsDisabled(false);
    }
  }

  async function fillPage() {
    const product = currentTask.product;
    const mappings = mergeMappings(DEFAULT_MAPPINGS, settings.mappings || {});
    let filled = 0;
    for (const key of ["title", "description", "price", "market_price", "stock", "logistics_template", "shipping_hours", "category_path"]) {
      const value = product[key];
      if (value === undefined || value === null || value === "") continue;
      const field = findField(mappings[key] || [key]);
      if (!field) { logLine(`未找到字段：${key}`); continue; }
      setNativeValue(field, String(value));
      filled += 1;
      logLine(`已填写：${key}`, "ok");
      await delay(settings.stepDelayMs);
    }

    filled += await fillAttributes(product.attributes || {});
    filled += await fillSpecifications(product.skus || []);
    filled += await fillSkuFallback(product.skus || []);
    filled += await uploadImages(product.carousel_images || [], product.local_carousel_images || [], ["商品轮播图", "商品主图"]);
    filled += await uploadImages(product.detail_images || [], product.local_detail_images || [], ["商品详情图", "详情图"]);

    const validation = validate(product);
    logLine(`完成：${filled} 项；${validation.length ? `提醒 ${validation.join("、")}` : "基础校验通过"}`, validation.length ? "error" : "ok");
    await PDDStorage.appendLog({ taskId: currentTask.id, level: "info", message: `填写完成，共 ${filled} 项`, validation });

    if (settings.actionAfterFill !== "none" && validation.length === 0) {
      await performFinalAction(settings.actionAfterFill);
    }
  }

  async function fillAttributes(attributes) {
    let count = 0;
    for (const [name, value] of Object.entries(attributes)) {
      const field = findField([name]);
      if (!field) { logLine(`未找到属性：${name}`); continue; }
      if (isCustomSelect(field)) await selectCustomOption(field, String(value));
      else setNativeValue(field, String(value));
      count += 1;
      await delay(settings.stepDelayMs);
    }
    return count;
  }

  async function fillSkuFallback(skus) {
    if (!skus.length) return 0;
    const rows = findSkuRows();
    if (!rows.length) { logLine("检测到 SKU 数据，但页面 SKU 表格尚未生成"); return 0; }
    let count = 0;
    for (const sku of skus) {
      const specValues = Object.values(sku.spec || {}).map(normalize);
      const row = rows.find((candidate) => specValues.every((value) => normalizedText(candidate).includes(value))) || rows[skus.indexOf(sku)];
      if (!row) continue;
      const inputs = [...row.querySelectorAll("input:not([type=file])")].filter(isVisible);
      for (const input of inputs) {
        const context = `${fieldContext(input)} ${inputColumnHeader(input)}`;
        let value;
        if (/市场价|单买价/.test(context)) value = sku.market_price;
        else if (/库存/.test(context)) value = sku.stock;
        else if (/价格|拼单价|活动价/.test(context)) value = sku.price;
        if (value !== undefined && value !== "") { setNativeValue(input, String(value)); count += 1; }
      }
    }
    if (count) logLine(`已填写 SKU 表格 ${count} 个单元格`, "ok");
    return count;
  }

  async function fillSpecifications(skus) {
    const specifications = new Map();
    for (const sku of skus) {
      for (const [name, value] of Object.entries(sku.spec || {})) {
        if (!specifications.has(name)) specifications.set(name, new Set());
        specifications.get(name).add(String(value));
      }
    }
    if (!specifications.size) return 0;

    let count = 0;
    let specificationIndex = 0;
    for (const [name, values] of specifications) {
      let group = findSpecGroup(name);
      if (!group) {
        let typeInputs = findSpecTypeInputs();
        if (typeInputs.length <= specificationIndex) {
          const addButton = findButton(["添加规格", "添加商品规格", "新增规格", "添加规格项"]);
          if (addButton) {
            addButton.click();
            await delay(settings.stepDelayMs);
            typeInputs = findSpecTypeInputs();
          }
        }
        const typeInput = typeInputs[specificationIndex];
        if (typeInput) {
          await selectCustomOption(typeInput, name);
          await delay(settings.stepDelayMs);
          group = findSpecContainer(typeInput);
        } else {
          const addButton = findButton(["添加规格", "添加商品规格", "新增规格"]);
          if (addButton) {
          addButton.click();
          await delay(settings.stepDelayMs);
          group = findEmptySpecGroup();
          }
        }
      }
      if (!group) { logLine(`未找到规格组入口：${name}`); continue; }

      const nameInput = [...group.querySelectorAll("input")].find((input) => fieldContext(input).includes("规格名") || fieldContext(input).includes("属性名"));
      if (nameInput && !nameInput.value) {
        setNativeValue(nameInput, name);
        pressEnter(nameInput);
        count += 1;
        await delay(settings.stepDelayMs);
      }

      for (const value of values) {
        if (normalizedText(group).includes(normalize(value))) continue;
        const valueInput = [...group.querySelectorAll("input")].find((input) => {
          const context = fieldContext(input);
          return context.includes("规格值") || context.includes("属性值") || context.includes("添加选项");
        });
        if (!valueInput) { logLine(`未找到“${name}”的规格值输入框`); break; }
        setNativeValue(valueInput, value);
        pressEnter(valueInput);
        count += 1;
        await delay(settings.stepDelayMs);
      }
      logLine(`规格：${name}（${[...values].join("、")}）`, "ok");
      specificationIndex += 1;
    }
    // Give the page time to generate the Cartesian-product SKU table.
    await delay(Math.max(700, settings.stepDelayMs * 2));
    return count;
  }

  function findSpecGroup(name) {
    return [...document.querySelectorAll("section,fieldset,[class*=spec],[class*=sku],[class*=item]")]
      .filter(isVisible)
      .find((element) => normalizedText(element).includes(normalize(name)) && element.querySelector("input"));
  }

  function findSpecTypeInputs() {
    return [...document.querySelectorAll('input[readonly][placeholder*="规格类型"],input[data-testid="beast-core-select-htmlInput"][placeholder*="规格"]')].filter(isVisible);
  }

  function findSpecContainer(input) {
    let element = input.parentElement;
    for (let depth = 0; element && depth < 8; depth += 1, element = element.parentElement) {
      const text = normalizedText(element);
      if (element.querySelectorAll("input").length >= 2 || /规格值|属性值|添加选项/.test(text)) return element;
    }
    return input.parentElement?.parentElement || input.parentElement;
  }

  function findEmptySpecGroup() {
    const candidates = [...document.querySelectorAll("section,fieldset,[class*=spec],[class*=sku],[class*=item]")].filter(isVisible);
    return candidates.reverse().find((element) => [...element.querySelectorAll("input")].some((input) => /规格名|属性名/.test(fieldContext(input))));
  }

  function findButton(labels) {
    return [...document.querySelectorAll("button,[role=button]")].find((element) => isVisible(element) && labels.some((label) => normalizedText(element).includes(normalize(label))));
  }

  function pressEnter(element) {
    for (const type of ["keydown", "keypress", "keyup"]) element.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true }));
  }

  function findSkuRows() {
    return [...document.querySelectorAll("tr")].filter((row) => {
      const text = normalizedText(row);
      return isVisible(row) && row.querySelectorAll("input").length >= 2 && !/价格.*库存/.test(text);
    });
  }

  function inputColumnHeader(input) {
    const cell = input.closest("td");
    const table = input.closest("table");
    if (!cell || !table) return "";
    const headers = [...table.querySelectorAll("thead th")];
    return normalize(headers[cell.cellIndex]?.textContent || "");
  }

  async function uploadImages(urls, localAssets, sectionNames) {
    if (!urls.length && !localAssets.length) return 0;
    const input = await resolveFileInput(sectionNames);
    if (!input) { logLine(`未找到上传入口：${sectionNames[0]}`); return 0; }
    const files = [];
    for (const assetRef of localAssets) {
      try {
        const response = await chrome.runtime.sendMessage({ type: "GET_ASSET", id: assetRef.id });
        if (!response?.ok) throw new Error(response?.error || "读取失败");
        const asset = response.asset;
        files.push(dataUrlToFile(asset.dataUrl, asset.name || `local-${asset.id}`));
      } catch (error) { logLine(`本地图片 ${assetRef.name || assetRef.id} 失败：${error.message}`, "error"); }
    }
    for (let i = 0; i < urls.length; i += 1) {
      try {
        logLine(`下载图片 ${i + 1}/${urls.length}…`);
        const response = await chrome.runtime.sendMessage({ type: "FETCH_AS_DATA_URL", url: urls[i], timeoutMs: settings.imageTimeoutMs });
        if (!response?.ok) throw new Error(response?.error || "下载失败");
        files.push(dataUrlToFile(response.dataUrl, `product-${Date.now()}-${i}.${extensionFromDataUrl(response.dataUrl)}`));
      } catch (error) { logLine(`图片 ${i + 1} 失败：${error.message}`, "error"); }
    }
    if (!files.length) return 0;
    const transfer = new DataTransfer(); files.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    logLine(`已送入上传队列：${files.length} 张`, "ok");
    await delay(Math.max(1000, settings.stepDelayMs * files.length));
    return files.length;
  }

  function findFileInput(sectionNames) {
    const inputs = [...document.querySelectorAll('input[type="file"]')].filter(isVisibleOrAttached);
    for (const input of inputs) {
      const area = input.closest("section,fieldset,[class*=upload],[class*=form],[class*=item]") || input.parentElement;
      if (sectionNames.some((name) => normalizedText(area).includes(name))) return input;
    }
    return null;
  }

  async function resolveFileInput(sectionNames) {
    const existing = findFileInput(sectionNames);
    if (existing) return existing;

    const isDetail = sectionNames.some((name) => /详情/.test(name));
    if (!isDetail) return [...document.querySelectorAll('input[type="file"]')].filter(isVisibleOrAttached)[0] || null;

    const before = new Set(document.querySelectorAll('input[type="file"]'));
    const detailArea = findSmallestArea(["商品详情", "快捷编辑"]);
    const embeddedInput = detailArea?.querySelector('input[type="file"]');
    if (embeddedInput && isVisibleOrAttached(embeddedInput)) return embeddedInput;
    const uploadButton = detailArea ? [...detailArea.querySelectorAll("button,[role=button]")].find((element) => isVisible(element) && normalizedText(element) === normalize("本地上传")) : null;
    if (!uploadButton) {
      logLine("商品详情区域未找到“本地上传”按钮", "error");
      return null;
    }
    uploadButton.click();
    logLine("已打开商品详情本地上传入口");
    const newInput = await waitFor(() => {
      const inputs = [...document.querySelectorAll('input[type="file"]')].filter(isVisibleOrAttached);
      return inputs.find((input) => !before.has(input)) || inputs.find((input) => {
        const area = input.closest('[role=dialog],[class*=modal],[class*=dialog]');
        return area && isVisible(area);
      });
    }, 5000);
    return newInput || null;
  }

  function findSmallestArea(requiredTexts) {
    return [...document.querySelectorAll("section,fieldset,div")]
      .filter((element) => isVisible(element) && requiredTexts.every((text) => normalizedText(element).includes(normalize(text))))
      .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0] || null;
  }

  async function selectCustomOption(input, wantedText) {
    input.click();
    await delay(Math.max(150, settings.stepDelayMs));
    const wanted = normalize(wantedText);
    const candidates = [...document.querySelectorAll('[role="option"],li,[class*=option],[class*=Option],[data-testid*=option]')]
      .filter(isVisible)
      .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
    const option = candidates.find((element) => normalizedText(element) === wanted) || candidates.find((element) => normalizedText(element).includes(wanted));
    if (!option) throw new Error(`下拉选项中找不到：${wantedText}`);
    option.click();
    await delay(settings.stepDelayMs);
  }

  function isCustomSelect(input) {
    return input.matches('input[readonly],input[data-testid="beast-core-select-htmlInput"]');
  }

  function findField(names) {
    const controls = [...document.querySelectorAll('input:not([type="file"]):not([type="hidden"]),textarea,select,[contenteditable="true"]')].filter(isVisible);
    for (const control of controls) {
      const context = fieldContext(control);
      if (names.some((name) => context.includes(normalize(name)))) return control;
    }
    return null;
  }

  function fieldContext(control) {
    const parts = [control.placeholder, control.getAttribute("aria-label"), control.name, control.id];
    if (control.id) {
      const label = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
      if (label) parts.push(label.textContent);
    }
    let parent = control.parentElement;
    for (let i = 0; parent && i < 4; i += 1, parent = parent.parentElement) parts.push(parent.textContent?.slice(0, 180));
    return normalize(parts.filter(Boolean).join(" "));
  }

  function setNativeValue(element, value) {
    element.focus();
    if (element.matches("select")) {
      const option = [...element.options].find((item) => normalize(item.textContent).includes(normalize(value)) || item.value === value);
      if (option) element.value = option.value;
    } else if (element.isContentEditable) {
      element.textContent = value;
    } else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter ? setter.call(element, value) : (element.value = value);
    }
    for (const type of ["input", "change", "blur"]) element.dispatchEvent(new Event(type, { bubbles: true }));
  }

  async function performFinalAction(action) {
    const isSubmit = action === "submit";
    if (isSubmit && !confirm("确定要提交发布吗？提交后商品会进入平台审核。")) return;
    const labels = isSubmit ? ["提交并发布", "提交发布", "发布商品", "确认发布"] : ["保存草稿", "存草稿"];
    const target = [...document.querySelectorAll("button")].find((item) => isVisible(item) && labels.some((label) => normalizedText(item).includes(label)));
    if (!target) throw new Error(`未找到“${isSubmit ? "提交发布" : "保存草稿"}”按钮`);
    target.click();
    logLine(`已点击：${isSubmit ? "提交发布" : "保存草稿"}`, "ok");
    await delay(1500);
    const errorText = detectPageErrors();
    if (errorText) throw new Error(`页面提示：${errorText}`);
    await finishTask("completed");
  }

  async function finishTask(status, error = "") {
    const queue = await PDDStorage.getQueue();
    const task = queue.find((item) => item.id === currentTask.id);
    if (task) {
      task.status = status; task.finishedAt = new Date().toISOString();
      if (error) task.error = error; else delete task.error;
      await PDDStorage.saveQueue(queue);
      await PDDStorage.appendLog({ taskId: task.id, level: status === "failed" ? "error" : "info", message: error || "任务完成" });
    }
    logLine(status === "completed" ? "任务已完成，可从扩展打开下一个商品。" : `任务失败：${error}`, status === "completed" ? "ok" : "error");
  }

  function validate(product) {
    const errors = [];
    if (!product.title) errors.push("缺少标题");
    if (!product.carousel_images?.length && !product.local_carousel_images?.length) errors.push("缺少主图");
    if (!product.price && !product.skus?.length) errors.push("缺少价格/SKU");
    if (!product.stock && !product.skus?.length) errors.push("缺少库存/SKU");
    return errors;
  }

  function detectPageErrors() {
    const nodes = [...document.querySelectorAll('[class*=error],[class*=Error],[role="alert"]')].filter(isVisible);
    return nodes.map((node) => normalizedText(node)).filter(Boolean).slice(0, 3).join("；");
  }

  function dataUrlToFile(dataUrl, filename) {
    const [header, payload] = dataUrl.split(",");
    const mime = header.match(/data:([^;]+)/)?.[1] || "application/octet-stream";
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    return new File([bytes], filename, { type: mime });
  }

  function extensionFromDataUrl(dataUrl) {
    return ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" })[dataUrl.match(/data:([^;]+)/)?.[1]] || "bin";
  }

  function mergeMappings(base, custom) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(custom)) merged[key] = Array.isArray(value) ? value : [String(value)];
    return merged;
  }

  function normalizedText(element) { return normalize(element?.textContent || ""); }
  function normalize(text) { return String(text || "").replace(/\s+/g, "").toLowerCase(); }
  function isVisible(element) { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0; }
  // Upload controls are commonly visually hidden and triggered by a styled button.
  function isVisibleOrAttached(element) { return element.isConnected && !element.disabled; }
  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0)); }
  async function waitFor(getValue, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = getValue();
      if (value) return value;
      await delay(100);
    }
    return null;
  }
  function setButtonsDisabled(disabled) { document.querySelectorAll("#pdd-local-publisher-panel button").forEach((item) => { item.disabled = disabled; }); }
  function logLine(text, className = "") { const status = document.querySelector("#pdd-local-publisher-panel .pddlp-status"); if (!status) return; const line = document.createElement("div"); line.className = className; line.textContent = text; status.append(line); status.scrollTop = status.scrollHeight; }
})();
