const $ = (id) => document.getElementById(id);

const LABELS = {
  connected: "Connected to MCP server",
  connecting: "Connecting…",
  disconnected: "Waiting for mcp-teams (start your AI client)",
  unauthorized: "Refused by mcp-teams",
};

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: "popup:status" });
  if (!s) return;
  $("version").textContent = `v${s.version}`;
  $("state").className = `state ${s.state}`;
  $("state").textContent = LABELS[s.state] ?? s.state;
  if (s.lastError && s.state !== "connected") $("state").textContent += ` — ${s.lastError}`;
}

(async () => {
  const { token, port } = await chrome.storage.local.get(["token", "port"]);
  if (token) $("token").value = token;
  if (port) $("port").value = port;
  refresh();
  setInterval(refresh, 1500);
})();

$("save").addEventListener("click", async () => {
  const token = $("token").value.trim();
  const port = Number($("port").value) || undefined;
  await chrome.storage.local.set({ token, port });
  $("saved").textContent = "Saved";
  setTimeout(() => ($("saved").textContent = ""), 1500);
});
