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
  selected: null,
  detail: null,
  filter: "",
  tab: "headers",
};

// ---------------- WebSocket stream ----------------
let ws;
function connect() {
  ws = new WebSocket(WS_BASE + "/ws");
  ws.onopen = () => setStatus("live", "live");
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
  rowsEl.innerHTML = "";
  for (const id of state.order) {
    const f = state.flows.get(id);
    if (f && matchesFilter(f)) rowsEl.appendChild(buildRow(f));
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
  return tr;
}
function renderRow(id) {
  const old = rowsEl.querySelector(`tr[data-id="${id}"]`);
  const f = state.flows.get(id);
  if (!f) return;
  if (!matchesFilter(f)) { if (old) old.remove(); return; }
  if (old) old.replaceWith(buildRow(f));
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
  // Bodies are captured already-decoded (gzip/br/deflate decompressed server-side), so render text.
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (/json/.test(ct)) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
  }
  out += `<pre class="body">${esc(text)}</pre>`;
  return out;
}

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
    const r = await (await fetch("/api/import/har", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(har) })).json();
    flash(`imported ${r.flows} flows`);
  } catch {
    flash("invalid HAR");
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

// ── Initial load ────────────────────────────────────────────────────────────────
// In Tauri mode, wait for the sidecar engine to report its ports.
if (isTauri && window.__TAURI__) {
  setStatus("", "waiting for engine…");
  window.__TAURI__.event.listen("cnproxy-ready", (ev) => {
    const info = ev.payload;
    API_BASE = `http://127.0.0.1:${info.webPort}`;
    WS_BASE = `ws://127.0.0.1:${info.webPort}`;
    loadWorkspace();
    loadOptions();
    connect();

    // Inject Tauri-specific toolbar buttons after the sidecar is ready
    injectTauriToolbar();
  });
} else {
  loadWorkspace();
  loadOptions();
  connect();
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
