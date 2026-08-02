(function exposeStorage(global) {
  const KEYS = {
    queue: "productQueue",
    settings: "publisherSettings",
    logs: "publisherLogs"
  };

  const DEFAULT_SETTINGS = {
    publishUrl: "https://mms.pinduoduo.com/goods/goods_create/index",
    actionAfterFill: "none",
    stepDelayMs: 350,
    imageTimeoutMs: 30000,
    mappings: {}
  };

  async function get(key, fallback) {
    const value = await chrome.storage.local.get(key);
    return value[key] ?? fallback;
  }

  async function set(key, value) {
    await chrome.storage.local.set({ [key]: value });
    return value;
  }

  async function getQueue() {
    return get(KEYS.queue, []);
  }

  async function saveQueue(queue) {
    return set(KEYS.queue, queue);
  }

  async function getSettings() {
    return { ...DEFAULT_SETTINGS, ...(await get(KEYS.settings, {})) };
  }

  async function saveSettings(settings) {
    return set(KEYS.settings, { ...DEFAULT_SETTINGS, ...settings });
  }

  async function appendLog(entry) {
    const logs = await get(KEYS.logs, []);
    logs.unshift({ time: new Date().toISOString(), ...entry });
    await set(KEYS.logs, logs.slice(0, 500));
  }

  global.PDDStorage = {
    KEYS,
    DEFAULT_SETTINGS,
    get,
    set,
    getQueue,
    saveQueue,
    getSettings,
    saveSettings,
    appendLog
  };
})(globalThis);
