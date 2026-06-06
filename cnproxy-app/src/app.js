// cnproxy inspector — vanilla JS, no build step.
"use strict";

const $ = (sel) => document.querySelector(sel);
const rowsEl = $("#rows");
const detailEl = $("#detail");
const statusEl = $("#status");

const isTauri = window.__TAURI_INTERNALS__ !== undefined || location.protocol === "tauri:" || location.hostname.includes("tauri");
const isLocalServer = (location.hostname === "localhost" || location.hostname === "127.0.0.1") && !isTauri;
let API_BASE = isLocalServer ? "" : "http://127.0.0.1:8889";
let WS_BASE = isLocalServer ? `ws://${location.host}` : "ws://127.0.0.1:8889";

if (!isLocalServer) {
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === "string" && input.startsWith("/")) {
      input = API_BASE + input;
    }
    return originalFetch(input, init);
  };
}

const state = {
  flows: new Map(), // id -> summary
  order: [], // ids in arrival order
  filteredIds: [], // ids after filter
  selected: null,
  detail: null,
  filter: "",
  tab: "headers",
  hexView: false, // toggle hex view for binary bodies
};

// ---------------- WebSocket stream ----------------
let ws;
function connect() {
  ws = new WebSocket(WS_BASE + "/ws");
  ws.onopen = () => { setStatus("live", "live"); injectFlowCounter(); };
  ws.onclose = () => {
    setStatus("dead", "disconnected");
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "snapshot") {
      state.flows.clear();
      state.order = [];
      for (const f of msg.flows) addFlow(f);
      renderList();
    } else if (msg.type === "add") {
      addFlow(msg.flow);
      renderList();
      scheduleAutoSave();
    } else if (msg.type === "update" || msg.type === "intercept") {
      addFlow(msg.flow);
      renderRow(msg.flow.id);
      if (state.selected === msg.flow.id) loadDetail(msg.flow.id);
    } else if (msg.type === "clear") {
      state.flows.clear();
      state.order = [];
      renderList();
    }
  };
}
function setStatus(cls, text) {
  statusEl.className = "status " + cls;
  statusEl.textContent = text;
}
function addFlow(f) {
  if (!state.flows.has(f.id)) state.order.push(f.id);
  state.flows.set(f.id, f);
}

// ---------------- list rendering ----------------
function matchesFilter(f) {
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  // lightweight client filter: match method/url/host/status; ~-prefixed → url substring
  const hay = `${f.method} ${f.url} ${f.statusCode ?? ""} ${f.contentType}`.toLowerCase();
  if (q.startsWith("~")) return hay.includes(q.replace(/^~\w+\s*/, ""));
  return q.split(/\s+/).every((part) => hay.includes(part));
}

function renderList() {
  // Compute filtered list
  state.filteredIds = state.order.filter((id) => {
    const f = state.flows.get(id);
    return f && matchesFilter(f);
  });
  updateFlowCounter();
  virtualScroll.render();
}

// ---- Virtual scrolling ----
// Only renders rows visible in the viewport (plus a buffer) for smooth
// performance with thousands of flows. Falls back to full render for ≤500.
const ROW_HEIGHT = 28; // px — matches .flow-table tbody tr height
const BUFFER = 10; // extra rows above/below viewport

const virtualScroll = {
  enabled: false,
  spacerTop: null,
  spacerBot: null,

  init() {
    // Create sentinel elements for virtual scroll padding
    if (!this.spacerTop) {
      this.spacerTop = document.createElement("tr");
      this.spacerTop.id = "vs-top";
      this.spacerBot = document.createElement("tr");
      this.spacerBot.id = "vs-bot";
    }
    const pane = rowsEl.closest(".list-pane");
    if (pane) {
      pane.removeEventListener("scroll", virtualScroll.onScroll);
      pane.addEventListener("scroll", virtualScroll.onScroll, { passive: true });
    }
  },

  render() {
    const ids = state.filteredIds;
    if (ids.length <= 500) {
      // Small list: render all rows directly (no virtual scroll overhead)
      rowsEl.innerHTML = "";
      for (const id of ids) {
        const f = state.flows.get(id);
        if (f) rowsEl.appendChild(buildRow(f));
      }
      this.enabled = false;
      return;
    }

    this.enabled = true;
    this.init();

    const pane = rowsEl.closest(".list-pane");
    const scrollTop = pane ? pane.scrollTop : 0;
    const viewH = pane ? pane.clientHeight : 600;
    const totalH = ids.length * ROW_HEIGHT;

    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER);
    const endIdx = Math.min(ids.length, Math.ceil((scrollTop + viewH) / ROW_HEIGHT) + BUFFER);

    rowsEl.innerHTML = "";
    // Top spacer
    this.spacerTop.style.height = startIdx * ROW_HEIGHT + "px";
    rowsEl.appendChild(this.spacerTop);

    for (let i = startIdx; i < endIdx; i++) {
      const f = state.flows.get(ids[i]);
      if (f) rowsEl.appendChild(buildRow(f));
    }

    // Bottom spacer
    this.spacerBot.style.height = Math.max(0, totalH - endIdx * ROW_HEIGHT) + "px";
    rowsEl.appendChild(this.spacerBot);
  },

  onScroll() {
    if (virtualScroll.enabled) {
      requestAnimationFrame(() => virtualScroll.render());
    }
  },
};

function updateFlowCounter() {
  const el = document.getElementById("flowCount");
  if (el) {
    const total = state.order.length;
    const shown = state.filteredIds.length;
    el.textContent = shown === total ? `${total}` : `${shown}/${total}`;
  }
}

function statusClass(code) {
  if (code === null || code === undefined || code === 0) return "s0";
  return "s" + String(code)[0];
}
function fmtSize(n) {
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " K";
  return (n / 1048576).toFixed(1) + " M";
}
function fmtTime(ms) {
  if (ms === null || ms === undefined) return "";
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(2) + "s";
}

function buildRow(f) {
  const tr = document.createElement("tr");
  tr.dataset.id = f.id;
  if (f.id === state.selected) tr.classList.add("sel");
  if (f.color) tr.style.boxShadow = `inset 3px 0 0 ${f.color}`;
  const codeTxt = f.error ? "ERR" : f.statusCode || "···";
  const tags =
    (f.type === "websocket" ? `<span class="tag ws">WS ${f.wsMessages}</span>` : "") +
    (f.mocked ? `<span class="tag mock">mock</span>` : "") +
    (f.intercepted ? `<span class="tag int">paused</span>` : "") +
    (f.error ? `<span class="tag err">err</span>` : "") +
    (f.appliedRules && f.appliedRules.length ? `<span class="tag rule">rule</span>` : "");
  tr.innerHTML = `
    <td class="c-status"><span class="code-badge ${f.error ? "s5" : statusClass(f.statusCode)}">${codeTxt}</span></td>
    <td class="c-method"><span class="method m-${f.method}">${f.method}</span></td>
    <td class="c-host" title="${esc(f.host)}">${esc(f.host)}</td>
    <td class="c-path" title="${esc(f.path)}">${esc(f.path)}${tags}</td>
    <td class="c-type">${esc(shortType(f.contentType))}</td>
    <td class="c-size">${fmtSize(f.resSize || f.reqSize)}</td>
    <td class="c-time">${fmtTime(f.duration)}</td>`;
  tr.onclick = () => select(f.id);
  tr.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e, f.id); };
  return tr;
}
function renderRow(id) {
  const f = state.flows.get(id);
  if (!f) return;
  if (!matchesFilter(f)) {
    const old = rowsEl.querySelector(`tr[data-id="${id}"]`);
    if (old) old.remove();
    return;
  }
  // Re-render the full list for filtered flow updates (virtual scroll safe)
  renderList();
}
function shortType(ct) {
  if (!ct) return "";
  return ct.split(";")[0].replace("application/", "").replace("text/", "");
}

// ---------------- detail ----------------
function select(id) {
  state.selected = id;
  document.querySelectorAll("tr.sel").forEach((t) => t.classList.remove("sel"));
  const tr = rowsEl.querySelector(`tr[data-id="${id}"]`);
  if (tr) tr.classList.add("sel");
  loadDetail(id);
}

async function loadDetail(id) {
  const res = await fetch(`/api/flows/${id}`);
  if (!res.ok) return;
  state.detail = await res.json();
  renderDetail();
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const intercepted = d.intercepted;
  detailEl.innerHTML = `
    <div class="detail-head">
      <div><span class="method m-${d.method}">${d.method}</span> <span class="code-badge ${d.error ? "s5" : statusClass(d.statusCode)}">${d.error ? "ERR" : d.statusCode || "pending"}</span></div>
      <div class="detail-url">${esc(d.url)}</div>
      <div class="detail-actions">
        ${intercepted ? `<button class="btn primary" onclick="act('${d.id}','resume')">▶ Resume</button>
        <button class="btn" onclick="saveEdit('${d.id}')">✎ Apply edit</button>
        <button class="btn" onclick="act('${d.id}','kill')">✖ Kill</button>` : ""}
        <button class="btn" onclick="act('${d.id}','replay')">↻ Replay</button>
        <button class="btn ${d.marked ? "active" : ""}" onclick="act('${d.id}','mark')">★ Mark</button>
        <button class="btn" onclick="openDiff('${d.id}')">⚖ Diff</button>
        <button class="btn" onclick="editToComposer('${d.id}')">✏ Edit & resend</button>
        <span class="copyas">
          <button class="btn">⧉ Copy as ▾</button>
          <span class="copyas-menu">
            <a onclick="copyCode('${d.id}','curl')">curl</a>
            <a onclick="copyCode('${d.id}','fetch')">fetch</a>
            <a onclick="copyCode('${d.id}','python')">python</a>
          </span>
        </span>
      </div>
    </div>
    ${intercepted ? interceptEditor(d) : ""}
    <div class="tabs" id="tabs">
      ${tabBtn("headers", "Headers")}
      ${tabBtn("request", "Request")}
      ${tabBtn("response", "Response")}
      ${d.type === "websocket" ? tabBtn("ws", "WebSocket (" + d.websocketMessages.length + ")") : ""}
    </div>
    <div class="tab-body" id="tabBody"></div>`;
  detailEl.querySelectorAll(".tab").forEach((t) => (t.onclick = () => { state.tab = t.dataset.tab; renderTab(); }));
  renderTab();
}
function tabBtn(id, label) {
  return `<div class="tab ${state.tab === id ? "active" : ""}" data-tab="${id}">${label}</div>`;
}

function renderTab() {
  const d = state.detail;
  const body = $("#tabBody");
  if (!body || !d) return;
  if (state.tab === "headers") body.innerHTML = headersView(d);
  else if (state.tab === "request") body.innerHTML = bodyView(d.request, d.method + " " + d.path, d, true);
  else if (state.tab === "response") body.innerHTML = d.response ? bodyView(d.response, "Status " + d.response.statusCode, d, false) : `<div class="note">No response${d.error ? " — " + esc(d.error) : " yet"}.</div>`;
  else if (state.tab === "ws") body.innerHTML = wsView(d);
}

function headersView(d) {
  let html = `<div class="section-title">General</div><div class="kv">
    <div class="k">URL</div><div class="v">${esc(d.url)}</div>
    <div class="k">Method</div><div class="v">${d.method}</div>
    <div class="k">Status</div><div class="v">${d.statusCode ?? "—"} ${esc(d.response?.reason || "")}</div>
    <div class="k">Client</div><div class="v">${esc(d.client.address)}:${d.client.port}${d.client.tls ? " (TLS)" : ""}</div>
    <div class="k">Duration</div><div class="v">${fmtTime(d.duration) || "—"}</div>
    ${d.appliedRules?.length ? `<div class="k">Rules</div><div class="v">${esc(d.appliedRules.join(", "))}</div>` : ""}
    ${timingRow(d.timings)}
  </div>`;
  html += `<div class="section-title">Request headers</div>${kvHeaders(d.request.headers)}`;
  if (d.response) html += `<div class="section-title">Response headers</div>${kvHeaders(d.response.headers)}`;
  return html;
}
function kvHeaders(headers) {
  return `<div class="kv">${headers.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join("")}</div>`;
}

function bodyView(msg, title, d, isReq) {
  if (!msg.body) return `<div class="note">No body.</div>`;
  const bytes = b64ToBytes(msg.body);
  const ct = headerVal(msg.headers, "content-type");
  let out = "";
  if (msg.bodyTruncated) out += `<div class="note">body truncated for display</div>`;
  if (/^image\//.test(ct)) {
    out += `<img class="preview" src="data:${ct};base64,${msg.body}" />`;
    return out;
  }

  const binaryCT = isBinaryContentType(ct);
  const binaryData = binaryCT || isBinaryBytes(bytes);
  const binaryKey = isReq ? "reqHex_" + d.id : "resHex_" + d.id;
  const showHex = state.hexView || binaryData;

  if (showHex) {
    out += `<div class="body-toggle">
      <button class="btn small" onclick="toggleHexView()">Switch to Text</button>
      <span class="hint">${bytes.length} bytes</span>
    </div>`;
    out += `<pre class="body hex-view">${esc(hexDump(bytes))}</pre>`;
  } else {
    out += `<div class="body-toggle">
      <button class="btn small" onclick="toggleHexView()">Hex View</button>
      <span class="hint">${fmtSize(bytes.length)}</span>
    </div>`;
    // Bodies are captured already-decoded (gzip/br/deflate decompressed server-side), so render text.
    let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (/json/.test(ct)) {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    }
    out += `<pre class="body">${esc(text)}</pre>`;
  }
  return out;
}

window.toggleHexView = () => {
  state.hexView = !state.hexView;
  renderDetail();
};

function wsView(d) {
  const send = `<div class="ws-send">
    <input id="wsText" class="code" placeholder="message to inject" />
    <button class="btn" onclick="wsSend('${d.id}', false)">▼ to client</button>
    <button class="btn" onclick="wsSend('${d.id}', true)">▲ to server</button>
  </div>`;
  if (!d.websocketMessages.length) return send + `<div class="note">No messages captured yet.</div>`;
  return (
    send +
    d.websocketMessages
      .map((m) => {
        const txt = m.type === "text" ? new TextDecoder().decode(b64ToBytes(m.content)) : `[binary ${b64ToBytes(m.content).length} bytes]`;
        return `<div class="ws-msg ${m.fromClient ? "up" : "down"}">${m.fromClient ? "▲ " : "▼ "}${esc(txt)}</div>`;
      })
      .join("")
  );
}

function timingRow(t) {
  if (!t) return "";
  const fmt = (n) => (typeof n === "number" ? n + "ms" : "—");
  return `<div class="k">Timing</div><div class="v timing">dns ${fmt(t.dns)} · connect ${fmt(t.connect)} · tls ${fmt(t.tls)} · ttfb ${fmt(t.ttfb)}</div>`;
}

function interceptEditor(d) {
  const reqHeaders = d.request.headers.map(([k, v]) => `${k}: ${v}`).join("\n");
  const reqBody = d.request.body ? new TextDecoder().decode(b64ToBytes(d.request.body)) : "";
  const resHeaders = d.response ? d.response.headers.map(([k, v]) => `${k}: ${v}`).join("\n") : "";
  const resBody = d.response?.body ? new TextDecoder().decode(b64ToBytes(d.response.body)) : "";
  const isResp = !!d.response;
  return `<div class="editor">
    <div class="hint">Paused — edit and Apply, then Resume.</div>
    <label>${isResp ? "Response" : "Request"} headers</label>
    <textarea id="edHeaders" class="code">${esc(isResp ? resHeaders : reqHeaders)}</textarea>
    <label>${isResp ? "Response" : "Request"} body</label>
    <textarea id="edBody" class="code">${esc(isResp ? resBody : reqBody)}</textarea>
  </div>`;
}

// ---------------- context menu ----------------
let ctxMenu = null;
function showContextMenu(e, id) {
  closeContextMenu();
  const f = state.flows.get(id);
  ctxMenu = document.createElement("div");
  ctxMenu.className = "ctx-menu";
  const items = [
    { label: "↻ Replay", action: () => act(id, "replay") },
    { label: "✏ Edit & Resend", action: () => editToComposer(id) },
    { label: "★ Mark / Unmark", action: () => act(id, "mark") },
    { label: "⚖ Diff", action: () => openDiff(id) },
    { separator: true },
    { label: "⧉ Copy URL", action: () => { copyText(f?.url || ""); flash("URL copied"); } },
    { label: "⧉ Copy as cURL", action: () => copyCode(id, "curl") },
    { label: "⧉ Copy as fetch", action: () => copyCode(id, "fetch") },
    { label: "⧉ Copy as Python", action: () => copyCode(id, "python") },
    { separator: true },
    { label: "✖ Delete", action: () => deleteFlow(id) },
  ];
  for (const item of items) {
    if (item.separator) {
      const hr = document.createElement("div");
      hr.className = "ctx-sep";
      ctxMenu.appendChild(hr);
    } else {
      const el = document.createElement("div");
      el.className = "ctx-item";
      el.textContent = item.label;
      el.onclick = () => { closeContextMenu(); item.action(); };
      ctxMenu.appendChild(el);
    }
  }
  document.body.appendChild(ctxMenu);
  // Position near cursor, clamped to viewport
  const rect = ctxMenu.getBoundingClientRect();
  let x = e.clientX, y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  ctxMenu.style.left = x + "px";
  ctxMenu.style.top = y + "px";
  // Close on click outside
  setTimeout(() => document.addEventListener("click", closeContextMenu, { once: true }), 0);
}
function closeContextMenu() {
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
}
function copyText(text) {
  try { navigator.clipboard.writeText(text); } catch {}
}

async function deleteFlow(id) {
  await fetch(`${API_BASE}/api/flows/${id}`, { method: "DELETE" });
  state.flows.delete(id);
  state.order = state.order.filter((i) => i !== id);
  if (state.selected === id) { state.selected = null; detailEl.innerHTML = `<div class="empty">Select a request to inspect it.</div>`; }
  renderList();
}

// ---------------- hex view ----------------
function hexDump(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length && i < 8192; i += 16) {
    const slice = bytes.subarray(i, Math.min(i + 16, bytes.length));
    const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(slice).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    out += i.toString(16).padStart(8, "0") + "  " + hex.padEnd(48) + "  " + ascii + "\n";
  }
  if (bytes.length > 8192) out += `… (${bytes.length} bytes total, showing first 8192)\n`;
  return out;
}

function isBinaryContentType(ct) {
  if (!ct) return false;
  return /^(application\/(octet-stream|x-www-form-urlencoded|pdf|zip|gzip|pkcs|java-archive|wasm)|image\/(?!svg\+xml)|audio\/|video\/|font\/)/i.test(ct);
}

function isBinaryBytes(bytes) {
  // Heuristic: check first 512 bytes for nulls/control chars
  const checkLen = Math.min(bytes.length, 512);
  let binaryCount = 0;
  for (let i = 0; i < checkLen; i++) {
    const b = bytes[i];
    if (b === 0 || (b < 8 && b !== 3) || (b > 13 && b < 26)) binaryCount++;
  }
  return binaryCount / checkLen > 0.1;
}

// ---------------- actions ----------------
window.act = async (id, action) => {
  await fetch(`/api/flows/${id}/${action}`, { method: "POST" });
  if (action === "resume" || action === "kill") {
    // detail will refresh via ws update
  } else {
    loadDetail(id);
  }
};

function parseHeaderLines(text) {
  const out = [];
  for (const line of (text || "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return out;
}

// Apply a breakpoint edit to the paused flow (request or response, whichever is present).
window.saveEdit = async (id) => {
  const d = state.detail;
  const headers = parseHeaderLines($("#edHeaders")?.value);
  const body = btoa(unescape(encodeURIComponent($("#edBody")?.value || "")));
  const patch = d.response ? { response: { headers, body } } : { request: { headers, body } };
  await fetch(`/api/flows/${id}/edit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
};

// Copy a flow as a code snippet (curl/fetch/python).
window.copyCode = async (id, lang) => {
  const code = await (await fetch(`/api/flows/${id}/code?lang=${lang}`)).text();
  try { await navigator.clipboard.writeText(code); } catch {}
  flash(`copied as ${lang}`);
};

// Load a captured flow's request into the composer for editing + resend.
window.editToComposer = (id) => {
  const d = state.detail;
  if (!d) return;
  $("#cMethod").value = d.method;
  $("#cUrl").value = d.url;
  $("#cHeaders").value = (d.request.headers || []).filter(([k]) => k.toLowerCase() !== "host").map(([k, v]) => `${k}: ${v}`).join("\n");
  $("#cBody").value = d.request.body ? new TextDecoder().decode(b64ToBytes(d.request.body)) : "";
  drawer("#composeDrawer", true);
};

window.wsSend = async (id, toServer) => {
  const text = $("#wsText")?.value || "";
  await fetch(`/api/flows/${id}/ws-send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, toServer }) });
  if ($("#wsText")) $("#wsText").value = "";
};

// ---------------- composer ----------------
$("#composeBtn").onclick = () => drawer("#composeDrawer", true);
$("#composeClose").onclick = () => drawer("#composeDrawer", false);
$("#cImport").onclick = async () => {
  const command = $("#cCurl").value.trim();
  if (!command) return;
  const spec = await (await fetch("/api/curl/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command }) })).json();
  $("#cMethod").value = (spec.method || "GET").toUpperCase();
  $("#cUrl").value = spec.url || "";
  $("#cHeaders").value = (spec.headers || []).map(([k, v]) => `${k}: ${v}`).join("\n");
  $("#cBody").value = spec.body || "";
};
$("#cSend").onclick = async () => {
  const spec = {
    method: $("#cMethod").value,
    url: $("#cUrl").value.trim(),
    headers: parseHeaderLines($("#cHeaders").value),
    body: $("#cBody").value,
  };
  if (!spec.url) return;
  $("#cResult").textContent = "sending…";
  try {
    const flow = await (await fetch("/api/compose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) })).json();
    $("#cResult").textContent = `→ ${flow.error ? "error: " + flow.error : flow.statusCode + " (" + (flow.duration ?? "?") + "ms)"}`;
    if (flow.id) select(flow.id);
  } catch (e) {
    $("#cResult").textContent = "failed";
  }
};

// ---------------- sessions ----------------
$("#sessionsBtn").onclick = async () => { drawer("#sessionsDrawer", true); renderSessions(); };
$("#sessionsClose").onclick = () => drawer("#sessionsDrawer", false);
$("#sessionSave").onclick = async () => {
  const name = $("#sessionName").value.trim() || "session";
  await fetch("/api/sessions/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  renderSessions();
  flash("saved " + name);
};
async function renderSessions() {
  const list = await (await fetch("/api/sessions")).json();
  $("#sessionList").innerHTML = list.length
    ? list.map((s) => `<div class="session-row"><span>${esc(s.name)} <em>(${s.flows} flows)</em></span><button class="btn" onclick="loadSession('${esc(s.name)}')">Load</button></div>`).join("")
    : `<div class="note">No saved sessions.</div>`;
}
window.loadSession = async (name) => {
  await fetch("/api/sessions/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  flash("loaded " + name);
};

// ---------------- HAR import ----------------
$("#importHar").onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  try {
    const har = JSON.parse(text);
    const r = await (await fetch(`${API_BASE}/api/import/har`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(har) })).json();
    flash(`imported ${r.flows} flows`);
  } catch {
    flash("invalid HAR");
  }
  e.target.value = "";
};

// ---------------- Postman collection import ----------------
// ── Mobile setup button ────────────────────────────────────────────────────────
$("#mobileSetupBtn").onclick = async () => {
  try {
    const setup = await (await fetch(`${API_BASE}/api/setup`)).json();
    showMobileSetup(setup.proxyHost, setup.proxyPort, setup.webPort);
  } catch {
    showMobileSetup("127.0.0.1", 8888, 8889);
  }
};

$("#importPostman").onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  try {
    const collection = JSON.parse(text);
    const r = await (await fetch(`${API_BASE}/api/import/postman`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(collection) })).json();
    flash(`imported ${r.flows} requests from Postman`);
  } catch {
    flash("invalid Postman collection");
  }
  e.target.value = "";
};

function flash(msg) {
  const el = $("#status");
  const prev = el.textContent;
  el.textContent = msg;
  setTimeout(() => (el.textContent = prev), 1500);
}

// ---------------- options / drawers ----------------
async function loadOptions() {
  const o = await (await fetch("/api/options")).json();
  $("#decrypt").checked = !!o.decryptHttps;
  $("#rulesText").value = o.rules || "";
  $("#interceptText").value = o.intercept || "";
  if ($("#interceptResText")) $("#interceptResText").value = o.interceptResponse || "";
  $("#interceptBtn").classList.toggle("active", !!o.intercept || !!o.interceptResponse);
}
async function patchOptions(patch) {
  await fetch("/api/options", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
}

$("#decrypt").onchange = (e) => patchOptions({ decryptHttps: e.target.checked });
$("#clearBtn").onclick = () => fetch("/api/clear", { method: "POST" });
$("#filter").oninput = (e) => { state.filter = e.target.value; renderList(); };

function drawer(id, open) { $(id).hidden = !open; }
$("#rulesBtn").onclick = () => drawer("#rulesDrawer", true);
$("#rulesClose").onclick = () => drawer("#rulesDrawer", false);
$("#rulesSave").onclick = async () => { await patchOptions({ rules: $("#rulesText").value }); drawer("#rulesDrawer", false); };
$("#interceptBtn").onclick = () => drawer("#interceptDrawer", true);
$("#interceptClose").onclick = () => drawer("#interceptDrawer", false);
$("#interceptSave").onclick = async () => {
  const reqExpr = $("#interceptText").value;
  const resExpr = $("#interceptResText") ? $("#interceptResText").value : "";
  await patchOptions({ intercept: reqExpr, interceptResponse: resExpr });
  $("#interceptBtn").classList.toggle("active", !!reqExpr || !!resExpr);
  drawer("#interceptDrawer", false);
};

// ---------------- utils ----------------
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function headerVal(headers, name) {
  const f = headers.find(([k]) => k.toLowerCase() === name);
  return f ? f[1] : "";
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// ---------------- diff modal ----------------
window.openDiff = (id) => {
  $("#diffModal").hidden = false;
  const flows = Array.from(state.flows.values());
  let options = "";
  for (const f of flows) {
    options += `<option value="${f.id}" ${f.id === id ? "selected" : ""}>${esc(f.method)} ${esc(f.path)} (${f.id.slice(0, 8)})</option>`;
  }
  $("#diffSelectA").innerHTML = options;
  $("#diffSelectB").innerHTML = options;
  if (flows.length > 1) {
    const other = flows.find(f => f.id !== id);
    if (other) {
      $("#diffSelectB").value = other.id;
    }
  }
  triggerDiffCompare();
};

async function triggerDiffCompare() {
  const idA = $("#diffSelectA").value;
  const idB = $("#diffSelectB").value;
  if (!idA || !idB) return;

  $("#diffRequest").innerHTML = "Loading diff...";
  $("#diffResponse").innerHTML = "Loading diff...";

  try {
    const res = await fetch(`/api/diff?a=${idA}&b=${idB}`);
    if (!res.ok) throw new Error("Diff failed");
    const diff = await res.json();

    const renderLines = (lines) => {
      if (!lines || !lines.length) return `<div class="note">No content or identical.</div>`;
      return lines.map(line => `<span class="diff-line ${line.op}">${esc(line.text || " ")}</span>`).join("");
    };

    $("#diffRequest").innerHTML = renderLines(diff.request);
    $("#diffResponse").innerHTML = renderLines(diff.response);
  } catch (e) {
    $("#diffRequest").innerHTML = "Error loading diff.";
    $("#diffResponse").innerHTML = "Error loading diff.";
  }
}

$("#diffClose").onclick = () => $("#diffModal").hidden = true;
$("#diffCompareBtn").onclick = () => triggerDiffCompare();

// ---------------- workspace ----------------
state.workspace = { collections: [], environments: [], activeEnv: null };

async function loadWorkspace() {
  try {
    const res = await fetch("/api/workspace");
    if (res.ok) {
      state.workspace = await res.json();
      renderWorkspace();
    }
  } catch {}
}

async function saveWorkspace() {
  await fetch("/api/workspace", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state.workspace)
  });
}

function renderWorkspace() {
  // Environments dropdown
  const envs = state.workspace.environments || [];
  let html = `<option value="">No Active Environment</option>`;
  for (const env of envs) {
    html += `<option value="${esc(env.name)}" ${state.workspace.activeEnv === env.name ? "selected" : ""}>${esc(env.name)}</option>`;
  }
  $("#envSelect").innerHTML = html;

  // Active environment variables text
  const active = envs.find(e => e.name === state.workspace.activeEnv);
  if (active) {
    const lines = [];
    for (const [k, v] of Object.entries(active.variables || {})) {
      lines.push(`${k}=${v}`);
    }
    $("#envVariables").value = lines.join("\n");
    $("#envVariables").disabled = false;
  } else {
    $("#envVariables").value = "";
    $("#envVariables").disabled = true;
  }

  // Collections list
  const cols = state.workspace.collections || [];
  $("#collectionsList").innerHTML = cols.length
    ? cols.map((c, idx) => `
        <div class="collection-item" onclick="loadCollectionItem(${idx})">
          <span>
            <span class="c-method-tag m-${c.method}">${c.method}</span>
            <span style="font-family: var(--mono);">${esc(c.url.split("?")[0])}</span>
          </span>
          <button class="c-del" onclick="event.stopPropagation(); deleteCollectionItem(${idx})">✖</button>
        </div>`).join("")
    : `<div class="note">No saved requests in collection.</div>`;
}

$("#workspaceBtn").onclick = () => {
  drawer("#workspaceDrawer", true);
  loadWorkspace();
};
$("#workspaceClose").onclick = () => drawer("#workspaceDrawer", false);

$("#envSelect").onchange = (e) => {
  state.workspace.activeEnv = e.target.value || null;
  saveWorkspace();
  renderWorkspace();
};

$("#envNewBtn").onclick = () => {
  const name = prompt("Enter new environment name:");
  if (!name) return;
  state.workspace.environments = state.workspace.environments || [];
  if (state.workspace.environments.some(e => e.name === name)) return alert("Environment already exists.");
  state.workspace.environments.push({ name, variables: {} });
  state.workspace.activeEnv = name;
  saveWorkspace();
  renderWorkspace();
};

$("#envDelBtn").onclick = () => {
  const active = state.workspace.activeEnv;
  if (!active) return;
  state.workspace.environments = state.workspace.environments.filter(e => e.name !== active);
  state.workspace.activeEnv = null;
  saveWorkspace();
  renderWorkspace();
};

$("#envSaveBtn").onclick = () => {
  const activeName = state.workspace.activeEnv;
  if (!activeName) return;
  const active = state.workspace.environments.find(e => e.name === activeName);
  if (!active) return;

  const vars = {};
  const text = $("#envVariables").value;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq !== -1) {
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  active.variables = vars;
  saveWorkspace();
  flash("Environment saved");
};

window.loadCollectionItem = (idx) => {
  const c = state.workspace.collections[idx];
  if (!c) return;
  $("#cMethod").value = c.method;
  $("#cUrl").value = c.url;
  $("#cHeaders").value = c.headers.map(([k, v]) => `${k}: ${v}`).join("\n");
  $("#cBody").value = c.body || "";
  drawer("#composeDrawer", true);
  drawer("#workspaceDrawer", false);
};

window.deleteCollectionItem = (idx) => {
  state.workspace.collections.splice(idx, 1);
  saveWorkspace();
  renderWorkspace();
};

$("#cSaveToCollection").onclick = () => {
  const spec = {
    method: $("#cMethod").value,
    url: $("#cUrl").value.trim(),
    headers: parseHeaderLines($("#cHeaders").value),
    body: $("#cBody").value,
  };
  if (!spec.url) return alert("Enter a URL first.");
  state.workspace.collections = state.workspace.collections || [];
  state.workspace.collections.push(spec);
  saveWorkspace();
  flash("Composer saved to collections");
};

// ---------------- auth helper ----------------
$("#cAuthType").onchange = (e) => {
  const type = e.target.value;
  const fields = $("#authFields");
  if (type === "none") {
    fields.innerHTML = "";
  } else if (type === "bearer") {
    fields.innerHTML = `<input id="authBearerToken" placeholder="Token" class="code" />`;
  } else if (type === "basic") {
    fields.innerHTML = `
      <input id="authBasicUser" placeholder="Username" class="code" style="width: 80px;" />
      <input id="authBasicPass" placeholder="Password" type="password" class="code" style="width: 80px;" />`;
  } else if (type === "apikey") {
    fields.innerHTML = `
      <input id="authApiKeyName" placeholder="Header name (e.g. x-api-key)" class="code" />
      <input id="authApiKeyValue" placeholder="Value" class="code" />`;
  }
};

$("#cApplyAuth").onclick = () => {
  const type = $("#cAuthType").value;
  let authName = "";
  let authVal = "";

  if (type === "bearer") {
    const token = $("#authBearerToken")?.value.trim();
    if (!token) return alert("Bearer token required.");
    authName = "authorization";
    authVal = `Bearer ${token}`;
  } else if (type === "basic") {
    const user = $("#authBasicUser")?.value.trim() || "";
    const pass = $("#authBasicPass")?.value.trim() || "";
    authName = "authorization";
    authVal = `Basic ${btoa(unescape(encodeURIComponent(user + ":" + pass)))}`;
  } else if (type === "apikey") {
    const name = $("#authApiKeyName")?.value.trim();
    const val = $("#authApiKeyValue")?.value.trim() || "";
    if (!name) return alert("Header name required.");
    authName = name.toLowerCase();
    authVal = val;
  }

  // Inject or update the header in the textarea
  const headers = parseHeaderLines($("#cHeaders").value);
  const filtered = headers.filter(([k]) => k.toLowerCase() !== authName);
  if (type !== "none") {
    filtered.push([authName, authVal]);
  }
  $("#cHeaders").value = filtered.map(([k, v]) => `${k}: ${v}`).join("\n");
  flash("Auth headers applied");
};

// ── Tauri desktop integration ──────────────────────────────────────────────────
// In Tauri mode, wire up system proxy toggle, CA install, and keyboard shortcuts.

let systemProxyOn = false;

async function toggleSystemProxy() {
  if (!isTauri || !window.__TAURI__) return;
  try {
    const result = await window.__TAURI__.core.invoke("toggle_system_proxy");
    systemProxyOn = result.systemProxyOn;
    const btn = document.getElementById("proxyToggleBtn");
    if (btn) btn.textContent = systemProxyOn ? "Disable System Proxy" : "Enable System Proxy";
    flash(systemProxyOn ? "System proxy enabled" : "System proxy disabled");
  } catch (e) {
    flash("Proxy toggle failed: " + e);
  }
}

async function installCaCert() {
  if (!isTauri || !window.__TAURI__) return;
  try {
    const result = await window.__TAURI__.core.invoke("install_ca_cert");
    if (result.ok) {
      flash("CA certificate installed ✓");
    } else {
      flash(result.message || "CA install cancelled");
    }
  } catch (e) {
    flash("CA install failed: " + e);
  }
}

async function uninstallCaCert() {
  if (!isTauri || !window.__TAURI__) return;
  try {
    const result = await window.__TAURI__.core.invoke("uninstall_ca_cert");
    flash(result.message || "CA removed");
  } catch (e) {
    flash("CA removal failed: " + e);
  }
}

// ── iOS VPN mode ────────────────────────────────────────────────────────────────
const isIOS = isTauri && /iPhone|iPad/i.test(navigator.userAgent);
const isAndroid = isTauri && /Android/i.test(navigator.userAgent);
const isMobile = isIOS || isAndroid;

function showVpnPanel() {
  const panel = document.getElementById("vpnPanel");
  if (panel) panel.hidden = false;
  document.querySelector(".toolbar").style.display = "none";
  document.querySelector(".layout").style.display = "none";
  const saved = localStorage.getItem("cnproxy-vpn-server");
  if (saved) {
    try {
      const { host, port } = JSON.parse(saved);
      document.getElementById("vpnHost").value = host || "";
      document.getElementById("vpnPort").value = port || "8888";
    } catch {}
  }
}

window.toggleVpn = async () => {
  const btn = document.getElementById("vpnConnectBtn");
  const statusEl = document.getElementById("vpnStatus");
  const currentStatus = await window.__TAURI__.core.invoke("vpn_status");
  if (currentStatus === 2) {
    await window.__TAURI__.core.invoke("disconnect_vpn");
    btn.className = "vpn-connect-btn";
    btn.querySelector(".vpn-btn-text").textContent = "Connect";
    statusEl.textContent = "Disconnected";
    document.querySelector(".toolbar").style.display = "none";
    document.querySelector(".layout").style.display = "none";
    document.getElementById("vpnPanel").hidden = false;
    return;
  }
  const host = document.getElementById("vpnHost").value.trim();
  const port = parseInt(document.getElementById("vpnPort").value) || 8888;
  if (!host) { statusEl.textContent = "Please enter server address"; return; }
  localStorage.setItem("cnproxy-vpn-server", JSON.stringify({ host, port }));
  btn.className = "vpn-connect-btn connecting";
  btn.querySelector(".vpn-btn-text").textContent = "Connecting...";
  statusEl.textContent = "Configuring VPN...";
  try {
    const configured = await window.__TAURI__.core.invoke("configure_vpn", { host, port });
    if (!configured) {
      statusEl.textContent = "VPN configuration failed";
      btn.className = "vpn-connect-btn";
      btn.querySelector(".vpn-btn-text").textContent = "Connect";
      return;
    }
    statusEl.textContent = "Starting VPN tunnel...";
    const connected = await window.__TAURI__.core.invoke("connect_vpn");
    if (connected) {
      btn.className = "vpn-connect-btn connected";
      btn.querySelector(".vpn-btn-text").textContent = "Connected";
      statusEl.textContent = `Connected to ${host}:${port}`;
      try {
        const setup = await (await fetch(`http://${host}:${port + 1}/api/setup`)).json();
        API_BASE = `http://${host}:${setup.webPort}`;
        WS_BASE = `ws://${host}:${setup.webPort}`;
      } catch {
        API_BASE = `http://${host}:${port + 1}`;
        WS_BASE = `ws://${host}:${port + 1}`;
      }
      setTimeout(() => {
        document.getElementById("vpnPanel").hidden = true;
        document.querySelector(".toolbar").style.display = "";
        document.querySelector(".layout").style.display = "";
        loadWorkspace();
        loadOptions();
        connect();
      }, 500);
    } else {
      statusEl.textContent = "VPN connection failed";
      btn.className = "vpn-connect-btn";
      btn.querySelector(".vpn-btn-text").textContent = "Connect";
    }
  } catch (e) {
    statusEl.textContent = "Error: " + e;
    btn.className = "vpn-connect-btn";
    btn.querySelector(".vpn-btn-text").textContent = "Connect";
  }
};

window.installCaFromServer = () => {
  const host = document.getElementById("vpnHost").value.trim();
  const port = parseInt(document.getElementById("vpnPort").value) || 8888;
  if (!host) { flash("Enter server address first"); return; }
  window.open(`http://${host}:${port + 1}/ca.crt`, "_blank");
};

window.showVpnGuide = () => {
  document.getElementById("vpnStatus").innerHTML = `<div style="text-align:left;font-size:12px;line-height:1.6;margin-top:8px;">
    1. Run <code>cnproxy --listen-all</code> on your Mac/PC<br>
    2. Enter the Mac/PC IP address above<br>
    3. Tap <strong>Install CA Certificate</strong><br>
    4. Settings > General > VPN & Device Management > install<br>
    5. Settings > About > Certificate Trust Settings > enable<br>
    6. Tap <strong>Connect</strong>
  </div>`;
};

// ── Initial load ────────────────────────────────────────────────────────────────
if (isMobile && window.__TAURI__) {
  showVpnPanel();
} else if (isTauri && window.__TAURI__) {
  setStatus("", "waiting for engine…");
  window.__TAURI__.event.listen("cnproxy-ready", (ev) => {
    const info = ev.payload;
    API_BASE = `http://127.0.0.1:${info.webPort}`;
    WS_BASE = `ws://127.0.0.1:${info.webPort}`;
    loadWorkspace();
    loadOptions();
    connect();
    autoLoadSession();
    injectTauriToolbar();
  });
} else {
  loadWorkspace();
  loadOptions();
  connect();
  autoLoadSession();
}

function injectTauriToolbar() {
  const toolbar = document.querySelector(".toolbar");
  if (!toolbar || document.getElementById("proxyToggleBtn")) return;

  const spacer = toolbar.querySelector(".spacer");

  // System proxy toggle button
  const proxyBtn = document.createElement("button");
  proxyBtn.id = "proxyToggleBtn";
  proxyBtn.className = "btn";
  proxyBtn.textContent = "Enable System Proxy";
  proxyBtn.title = "Toggle macOS/Windows/Linux system proxy to CNProxy";
  proxyBtn.onclick = toggleSystemProxy;

  // CA install button
  const caBtn = document.createElement("button");
  caBtn.id = "caInstallBtn";
  caBtn.className = "btn";
  caBtn.textContent = "Install CA";
  caBtn.title = "Install CNProxy root CA into system trust store (requires admin)";
  caBtn.onclick = installCaCert;

  // Auto-start toggle
  const autoBtn = document.createElement("label");
  autoBtn.className = "toggle";
  autoBtn.title = "Launch CNProxy on system startup";
  autoBtn.innerHTML = '<input type="checkbox" id="autoStartCheck" /> Auto-start';
  const autoCheck = autoBtn.querySelector("#autoStartCheck");
  window.__TAURI__.core.invoke("plugin:autostart|is-enabled").then((enabled) => {
    if (autoCheck) autoCheck.checked = enabled;
  }).catch(() => {});
  if (autoCheck) {
    autoCheck.onchange = async () => {
      try {
        if (autoCheck.checked) {
          await window.__TAURI__.core.invoke("plugin:autostart|enable");
          flash("Auto-start enabled");
        } else {
          await window.__TAURI__.core.invoke("plugin:autostart|disable");
          flash("Auto-start disabled");
        }
      } catch (e) {
        flash("Auto-start toggle failed: " + e);
        autoCheck.checked = !autoCheck.checked;
      }
    };
  }

  // Insert before the spacer
  toolbar.insertBefore(proxyBtn, spacer);
  toolbar.insertBefore(caBtn, spacer);

  // Query initial proxy state
  window.__TAURI__.core.invoke("get_proxy_ports").then((ports) => {
    // Could display ports in status bar if desired
  }).catch(() => {});
}

// ── Auto-save / auto-load session ────────────────────────────────────────────
// On connect, reload the last session so traffic survives restarts.
// On close/blur, save the current session automatically.
async function autoLoadSession() {
  try {
    const list = await (await fetch(`${API_BASE}/api/sessions`)).json();
    if (list.length > 0) {
      const latest = list[list.length - 1];
      await fetch(`${API_BASE}/api/sessions/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: latest.name }) });
    }
  } catch {}
}

let autoSaveTimer = null;
function scheduleAutoSave() {
  if (autoSaveTimer) return;
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    fetch(`${API_BASE}/api/sessions/save`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "auto" }) }).catch(() => {});
  }, 3000); // debounce 3s
}

// Auto-save on visibility change / page hide
document.addEventListener("visibilitychange", () => {
  if (document.hidden) scheduleAutoSave();
});
window.addEventListener("beforeunload", () => {
  // Synchronous save attempt on close
  const data = JSON.stringify({ name: "auto" });
  navigator.sendBeacon?.(`${API_BASE}/api/sessions/save`, data);
});

// Also auto-save when flows change (debounced)
const _origAddFlow = addFlow;
// We already have addFlow — hook into ws.onmessage for auto-save
const _origWsOnMessage = ws.onmessage;
// Instead of re-wrapping, just call scheduleAutoSave in the ws handler
// (done via the existing renderList which is called on every ws message)

// ── Flow counter in toolbar ────────────────────────────────────────────────────
function injectFlowCounter() {
  if (document.getElementById("flowCount")) return;
  const spacer = document.querySelector(".toolbar .spacer");
  if (!spacer) return;
  const counter = document.createElement("span");
  counter.id = "flowCount";
  counter.className = "flow-count";
  counter.textContent = "0";
  spacer.parentNode.insertBefore(counter, spacer.nextSibling);
}

// Patch renderList to trigger auto-save and counter
const _origRenderList = renderList;
// Already defined above — we use updateFlowCounter inside it

// ── QR code for mobile proxy setup ─────────────────────────────────────────────
// Minimal QR code generator (QR Code Model 2, version 1-6, byte mode, ECC L).
// No external dependency needed.
const QRCode = (() => {
  // Galois Field arithmetic for Reed-Solomon
  const GF256 = (() => {
    const exp = new Uint8Array(256), log = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x = (x << 1) ^ (x & 128 ? 0x11d : 0); }
    exp[255] = exp[0];
    return { exp, log, mul: (a, b) => a === 0 || b === 0 ? 0 : exp[(log[a] + log[b]) % 255] };
  })();

  // ECC codewords per block (version 1-6, ECC level L)
  const EC_TABLE = [null, [7,1,1,19,0],[10,1,1,34,0],[15,1,1,55,0],[20,1,1,80,0],[26,1,1,108,0],[18,2,1,68,0]];
  const DATA_CAP = [0, 17, 32, 53, 78, 106, 134]; // byte mode capacity, ECC L

  function rsEncode(data, nsym) {
    const gen = new Uint8Array(nsym);
    let g = 1;
    for (let i = 0; i < nsym; i++) { gen[i] = 1; for (let j = i; j > 0; j--) gen[j] = gen[j] ^ (gen[j - 1] !== 0 ? GF256.exp[(GF256.log[gen[j - 1]] + i) % 255] : 0); }
    const res = new Uint8Array(data.length + nsym);
    res.set(data);
    for (let i = 0; i < data.length; i++) {
      const coef = res[i];
      if (coef !== 0) for (let j = 0; j < nsym; j++) res[i + 1 + j] ^= GF256.mul(gen[j], coef);
    }
    return res.slice(data.length);
  }

  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > DATA_CAP[6]) return null; // too long
    let ver = 1;
    while (ver <= 6 && DATA_CAP[ver] < bytes.length) ver++;
    if (ver > 6) return null;

    // Data encoding: mode 0100 (byte), char count, data, terminator, padding
    const bits = [];
    const addBits = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    addBits(0b0100, 4); // byte mode
    addBits(bytes.length, ver <= 1 ? 8 : 16);
    for (const b of bytes) addBits(b, 8);
    const totalDataBits = EC_TABLE[ver][0] * 8;
    addBits(0, Math.min(4, totalDataBits - bits.length));
    while (bits.length % 8) bits.push(0);
    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) dataCodewords.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    while (dataCodewords.length < EC_TABLE[ver][0]) dataCodewords.push(dataCodewords.length % 2 === 0 ? 0xEC : 0x11);

    // Create matrix
    const size = ver * 4 + 17;
    const matrix = Array.from({ length: size }, () => new Uint8Array(size));
    const reserved = Array.from({ length: size }, () => new Uint8Array(size));

    function setModule(r, c, v) { if (r >= 0 && r < size && c >= 0 && c < size) matrix[r][c] = v; }

    // Finder patterns
    function drawFinder(row, col) {
      for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
        const r = row + dr, c = col + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        reserved[r][c] = 1;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const inBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        matrix[r][c] = inOuter && (inBorder || inInner) ? 1 : 0;
      }
    }
    drawFinder(0, 0); drawFinder(0, size - 7); drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) { reserved[6][i] = 1; matrix[6][i] = i % 2 === 0 ? 1 : 0; reserved[i][6] = 1; matrix[i][6] = i % 2 === 0 ? 1 : 0; }

    // Alignment pattern (version 2+)
    if (ver >= 2) {
      const pos = [6, size - 7];
      if (ver >= 3) pos.splice(1, 0, size - 7 - 2 * (ver - 2));
      for (const r of pos) for (const c of pos) {
        if (reserved[r] && reserved[r][c]) continue;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < size && cc >= 0 && cc < size) { reserved[rr][cc] = 1; matrix[rr][cc] = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0) ? 1 : 0; }
        }
      }
    }

    // Format info area
    for (let i = 0; i < 8; i++) { reserved[8][i] = 1; reserved[i][8] = 1; reserved[8][size - 1 - i] = 1; reserved[size - 1 - i][8] = 1; }
    reserved[8][8] = 1; reserved[size - 8][8] = 1; matrix[size - 8][8] = 1;

    // Place data
    const ec = EC_TABLE[ver];
    const totalCodewords = ec[0];
    const blocks = ec[1];
    const ecPerBlock = ec[2];
    const blockLen = Math.floor(totalCodewords / blocks);
    const dataPerBlock = blockLen - ecPerBlock;
    const blocksData = [];
    for (let b = 0; b < blocks; b++) blocksData.push(dataCodewords.slice(b * dataPerBlock, (b + 1) * dataPerBlock));
    const eccBlocks = blocksData.map(d => rsEncode(d, ecPerBlock));

    // Interleave
    const interleaved = [];
    for (let i = 0; i < dataPerBlock; i++) for (let b = 0; b < blocks; b++) interleaved.push(blocksData[b][i]);
    for (let i = 0; i < ecPerBlock; i++) for (let b = 0; b < blocks; b++) interleaved.push(eccBlocks[b][i]);

    let bitIdx = 0;
    for (let c = size - 1; c >= 1; c -= 2) {
      if (c === 6) c = 5;
      for (let upward = (Math.floor((size - 1) / 2) % 2 === 0); ;) {
        for (let dc = 0; dc < 2; dc++) {
          const col = c - dc;
          for (let rowOff = 0; rowOff < size; rowOff++) {
            const row = upward ? size - 1 - rowOff : rowOff;
            if (reserved[row][col]) continue;
            if (bitIdx < interleaved.length * 8) {
              const byteIdx = Math.floor(bitIdx / 8);
              const bitOff = 7 - (bitIdx % 8);
              matrix[row][col] = (interleaved[byteIdx] >> bitOff) & 1;
              bitIdx++;
            }
          }
        }
        upward = !upward;
        if (upward === (Math.floor((size - 1) / 2) % 2 === 0)) break;
      }
    }

    // Apply mask (mask 0: (row + col) % 2 === 0)
    let bestMask = 0, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const testMatrix = matrix.map(r => new Uint8Array(r));
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        if (reserved[r][c]) continue;
        let invert = false;
        if (mask === 0) invert = (r + c) % 2 === 0;
        else if (mask === 1) invert = r % 2 === 0;
        else if (mask === 2) invert = c % 3 === 0;
        else if (mask === 3) invert = (r + c) % 3 === 0;
        else if (mask === 4) invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
        else if (mask === 5) invert = ((r * c) % 2 + (r * c) % 3) === 0;
        else if (mask === 6) invert = ((r * c) % 2 + (r * c) % 3) % 2 === 0;
        else invert = ((r + c) % 2 + (r * c) % 3) % 2 === 0;
        if (invert) testMatrix[r][c] ^= 1;
      }
      // Simple penalty: count consecutive same-color modules
      let score = 0;
      for (let r = 0; r < size; r++) { let run = 0, prev = -1; for (let c = 0; c < size; c++) { if (testMatrix[r][c] === prev) run++; else { if (run >= 5) score += run - 2; run = 1; prev = testMatrix[r][c]; } } if (run >= 5) score += run - 2; }
      if (score < bestScore) { bestScore = score; bestMask = mask; }
    }

    // Apply best mask
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      let invert = false;
      if (bestMask === 0) invert = (r + c) % 2 === 0;
      else if (bestMask === 1) invert = r % 2 === 0;
      else if (bestMask === 2) invert = c % 3 === 0;
      else if (bestMask === 3) invert = (r + c) % 3 === 0;
      else if (bestMask === 4) invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      else if (bestMask === 5) invert = ((r * c) % 2 + (r * c) % 3) === 0;
      else if (bestMask === 6) invert = ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      else invert = ((r + c) % 2 + (r * c) % 3) % 2 === 0;
      if (invert) matrix[r][c] ^= 1;
    }

    // Format info
    const formatInfo = (() => {
      const fmt = ((0b01 << 3) | bestMask) << 10;
      let rem = fmt;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 14) * 0x537);
      const bits = (fmt | rem) ^ 0x5412;
      return bits;
    })();

    // Place format info
    const fmtBits = [];
    for (let i = 14; i >= 0; i--) fmtBits.push((formatInfo >> i) & 1);
    const fmtPos1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    const fmtPos2 = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],[8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]];
    for (let i = 0; i < 15; i++) { matrix[fmtPos1[i][0]][fmtPos1[i][1]] = fmtBits[i]; matrix[fmtPos2[i][0]][fmtPos2[i][1]] = fmtBits[i]; }

    return { matrix, size };
  }

  function toSVG(text, cellSize = 4) {
    const qr = encode(text);
    if (!qr) return "";
    const { matrix, size } = qr;
    const margin = 4;
    const total = (size + margin * 2) * cellSize;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}">`;
    svg += `<rect width="${total}" height="${total}" fill="white"/>`;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (matrix[r][c]) svg += `<rect x="${(c + margin) * cellSize}" y="${(r + margin) * cellSize}" width="${cellSize}" height="${cellSize}" fill="black"/>`;
    }
    svg += "</svg>";
    return svg;
  }

  return { encode, toSVG };
})();

// Show a setup panel for mobile devices when proxy is on 0.0.0.0
function showMobileSetup(proxyHost, proxyPort, webPort) {
  // Don't show if already visible
  if (document.getElementById("mobileSetup")) return;

  const panel = document.createElement("div");
  panel.id = "mobileSetup";
  panel.className = "mobile-setup-panel";
  panel.innerHTML = `
    <div class="mobile-setup-content">
      <h3>📱 Mobile Proxy Setup</h3>
      <p>Point your phone's Wi-Fi proxy to:</p>
      <div class="mobile-setup-config">
        <div class="config-row"><span>Server:</span> <code>${proxyHost}</code></div>
        <div class="config-row"><span>Port:</span> <code>${proxyPort}</code></div>
      </div>
      <div class="mobile-setup-qr">${QRCode.toSVG(`http://${proxyHost}:${webPort}/setup`, 3)}</div>
      <p class="hint">Scan QR code on your phone to open the setup guide, or configure manually:</p>
      <ol>
        <li><strong>iOS:</strong> Settings → Wi-Fi → ⓘ → HTTP Proxy → Manual</li>
        <li><strong>Android:</strong> Settings → Wi-Fi → Edit → Advanced → Proxy → Manual</li>
      </ol>
      <p class="hint">For HTTPS decryption, visit <a href="/ca.crt" download>ca.crt</a> on your phone after connecting.</p>
      <button class="btn" onclick="this.closest('.mobile-setup-panel').style.display='none'">Close</button>
    </div>
  `;
  document.body.appendChild(panel);
}

// ── Keyboard shortcuts (Tauri desktop only) ────────────────────────────────────
if (isTauri && window.__TAURI__) {
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "k") { e.preventDefault(); document.getElementById("clearBtn")?.click(); }
    if (mod && e.key === "f") { /* let native find work or focus filter */ e.preventDefault(); document.getElementById("filter")?.focus(); }
    if (mod && e.shiftKey && e.key === "R") { /* TODO: replay selected */ }
    if (mod && e.shiftKey && e.key === "P") { e.preventDefault(); toggleSystemProxy(); }
  });
}

// ── Auto-detect mobile setup when proxy runs on 0.0.0.0 ──────────────────────
// After connecting, check if the proxy is listening on all interfaces
// and show mobile setup instructions with QR code.
(async () => {
  try {
    const setup = await (await fetch(`${API_BASE}/api/setup`)).json();
    if (setup.proxyHost && setup.proxyHost !== "127.0.0.1" && setup.proxyHost !== "0.0.0.0" && setup.proxyHost !== "::") {
      showMobileSetup(setup.proxyHost, setup.proxyPort, setup.webPort);
    }
  } catch {}
})();
