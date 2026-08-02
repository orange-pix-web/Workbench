document.addEventListener("DOMContentLoaded", async () => {
  const settings = await PDDStorage.getSettings();
  document.querySelector("#publishUrl").value = settings.publishUrl;
  document.querySelector("#actionAfterFill").value = settings.actionAfterFill;
  document.querySelector("#stepDelayMs").value = settings.stepDelayMs;
  document.querySelector("#mappings").value = JSON.stringify(settings.mappings || {}, null, 2);
  document.querySelector("#save").addEventListener("click", save);
});

async function save() {
  const message = document.querySelector("#message");
  try {
    const mappings = JSON.parse(document.querySelector("#mappings").value || "{}");
    await PDDStorage.saveSettings({
      publishUrl: document.querySelector("#publishUrl").value.trim(),
      actionAfterFill: document.querySelector("#actionAfterFill").value,
      stepDelayMs: Number(document.querySelector("#stepDelayMs").value),
      mappings
    });
    message.textContent = "已保存";
  } catch (error) {
    message.style.color = "#b42318";
    message.textContent = `保存失败：${error.message}`;
  }
}
