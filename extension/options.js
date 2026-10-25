const ext = globalThis.browser ?? globalThis.chrome;
const port = document.getElementById("port");
const url = document.getElementById("url");
const msg = document.getElementById("msg");
const radios = [...document.querySelectorAll('input[name="mode"]')];
const mode = () => radios.find((r) => r.checked)?.value || "desktop";
const show = () => {
  document.getElementById("desktop-opts").hidden = mode() !== "desktop";
  document.getElementById("web-opts").hidden = mode() !== "web";
};
radios.forEach((r) => r.addEventListener("change", show));

ext.storage.local.get({ port: 23120, mode: "desktop", webUrl: "" }).then((s) => {
  port.value = s.port;
  url.value = s.webUrl;
  (radios.find((r) => r.value === s.mode) || radios[0]).checked = true;
  show();
});

document.getElementById("save").addEventListener("click", async () => {
  if (mode() === "web") {
    let u;
    try { u = new URL(url.value.trim()); } catch { msg.textContent = "Enter the full web address, starting with https://"; return; }
    if (!/^https?:$/.test(u.protocol)) { msg.textContent = "The address must start with https://"; return; }
    const webUrl = u.href.split("#")[0];
    await ext.storage.local.set({ mode: "web", webUrl });
    msg.textContent = "Saved. Papers will open in the web version.";
    return;
  }
  const p = Number(port.value);
  if (!(p > 1024 && p < 65536)) { msg.textContent = "Enter a port between 1025 and 65535."; return; }
  await ext.storage.local.set({ mode: "desktop", port: p });
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/ext/ping`);
    msg.textContent = r.ok ? "Saved. Citeweave is running." : "Saved, but Citeweave did not answer on that port.";
  } catch {
    msg.textContent = "Saved. Citeweave is not running on that port right now.";
  }
});
