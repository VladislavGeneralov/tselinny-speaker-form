// Purchase page → Apps Script web app (TSELINNY_EVENTS/BUY_PAGE.md, PROTOCOL.md «Закупка»).
// buy.html?d=<docId>&k=<key>&lang=<en|ru|kk>. Load and save go through POST (text/plain, no preflight),
// so link previews in messengers never change anything. Draft lives in localStorage per docId.
(() => {
  "use strict";

  const WEBAPP_URL = "https://script.google.com/macros/s/AKfycbyRav8ow-BPFPI6V8MrIQiX0MBx0O_aObw_MBmNUvCNuXPowz78Epwz18eBa9ucahQ/exec";
  const MAX_ROWS = 50;
  const START_ROWS = 3;
  const KEYS = ["name", "comment", "qty", "link"];

  const STR = window.I18N;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const q = new URLSearchParams(location.search);
  const D = q.get("d") || "";
  const K = q.get("k") || "";
  const DRAFT_KEY = "buyDraft_" + D;

  let lang = pickLang();
  const t = key => (STR[lang] && STR[lang][key]) ?? STR.en[key] ?? key;

  const form = $("#buy_form");
  const rowsBox = $("#buy_rows");
  let info = null;      // buyLoad answer
  let closed = null;    // null | "deadline" | "link"
  let busy = false;

  /* ---------------- language ---------------- */

  function pickLang() {
    let l = q.get("lang");
    if (l === "kz") l = "kk";
    if (l && STR[l]) return l;
    const saved = localStorage.getItem("speakerFormLang");
    if (saved && STR[saved]) return saved;
    const nav = (navigator.language || "en").slice(0, 2);
    return nav === "ru" ? "ru" : nav === "kk" ? "kk" : "en";
  }

  function applyI18n(root = document) {
    $$("[data-i18n]", root).forEach(el => { el.textContent = t(el.dataset.i18n); });
    $$("[data-i18n-ph]", root).forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    $$("[data-i18n-href]", root).forEach(el => { el.href = t(el.dataset.i18nHref); });
    $$(".bdel", root).forEach(b => { b.title = t("buy_del"); b.setAttribute("aria-label", t("buy_del")); });
  }

  function setLang(next) {
    lang = next;
    localStorage.setItem("speakerFormLang", lang);
    document.documentElement.lang = lang;
    document.title = t("buy_title") + " — Tselinny";
    $$(".langs button").forEach(b => b.classList.toggle("on", b.dataset.lang === lang));
    applyI18n();
    renderTexts();
  }

  $(".langs").addEventListener("click", e => {
    const b = e.target.closest("button[data-lang]");
    if (b) setLang(b.dataset.lang);
  });

  // Texts built from data (not plain data-i18n): rules lists, closed message, «sent at».
  function renderTexts() {
    const list = (ul, key) => { ul.innerHTML = t(key).split("\n").map(s => "<li>" + esc(s) + "</li>").join(""); };
    list($("#buy_rules"), "buy_rules");
    list($("#buy_how"), "buy_how");
    if (closed === "link") $("#buy_closed").textContent = t("buy_bad_link");
    if (closed === "deadline") $("#buy_closed").textContent = t("buy_closed").replace("{deadline}", info.deadline || "");
    if (info && info.deadline) $("#buy_edit_note").textContent = t("buy_edit_until").replace("{deadline}", info.deadline);
    else $("#buy_edit_note").textContent = t("buy_edit_nodl");
    renderSent();
  }

  // Once sent, the form is gone for good — changes go through a Tselinny staff member (Vlad 10.11).
  function showThanks() {
    form.hidden = true;
    $("#buy_loading").hidden = true;
    $("h1").hidden = true;
    $("#buy_done").hidden = false;
    renderTexts();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderSent() {
    const p = $("#buy_sent");
    p.hidden = !(info && info.sentAt);
    if (p.hidden) return;
    const d = new Date(info.sentAt), z = n => String(n).padStart(2, "0");
    const when = z(d.getDate()) + "." + z(d.getMonth() + 1) + " " + z(d.getHours()) + ":" + z(d.getMinutes());
    p.textContent = t("buy_sent").replace("{when}", when).replace("{deadline}", info.deadline || "—");
  }

  /* ---------------- rows ---------------- */

  function addRow(item) {
    const row = $("#row_tpl").content.firstElementChild.cloneNode(true);
    KEYS.forEach(k => { $(`input[data-k="${k}"]`, row).value = (item && item[k]) || ""; });
    applyI18n(row);
    rowsBox.append(row);
    renumber();
    return row;
  }

  function renumber() {
    const rows = $$(".brow", rowsBox);
    rows.forEach((r, i) => { $(".bnum", r).textContent = i + 1; });
    $("#buy_add").hidden = rows.length >= MAX_ROWS;
  }

  function fill(items) {
    rowsBox.innerHTML = "";
    const list = (items || []).filter(x => x && KEYS.some(k => String(x[k] || "").trim()));
    list.slice(0, MAX_ROWS).forEach(addRow);
    for (let i = list.length; i < START_ROWS; i++) addRow(null);
  }

  // All rows as typed (empty ones included) — for the draft.
  function readRows() {
    return $$(".brow", rowsBox).map(r => {
      const o = {};
      KEYS.forEach(k => { o[k] = $(`input[data-k="${k}"]`, r).value.trim(); });
      return o;
    });
  }

  const isEmpty = x => KEYS.every(k => !x[k]);
  const nonEmptyRows = () => { const all = readRows(); return $$(".brow", rowsBox).filter((r, i) => !isEmpty(all[i])); };
  const filled = items => items.filter(x => !isEmpty(x));
  const same = (a, b) => JSON.stringify(filled(a || [])) === JSON.stringify(filled(b || []));

  $("#buy_add").addEventListener("click", () => {
    const row = addRow(null);
    $("input", row).focus();
    saveDraft();
  });

  rowsBox.addEventListener("click", e => {
    const b = e.target.closest(".bdel");
    if (!b) return;
    b.closest(".brow").remove();
    if (!$$(".brow", rowsBox).length) addRow(null);
    renumber();
    saveDraft();
  });

  rowsBox.addEventListener("input", e => {
    const r = e.target.closest(".brow.invalid");
    if (r) clearRowErr(r);
    $("#buy_rows_err").hidden = true;
    saveDraft();
  });

  /* ---------------- draft (localStorage, per docId) ---------------- */

  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ items: readRows(), at: Date.now() })); } catch (e) { /* private mode */ }
    $("#buy_draft").hidden = !(info && !same(readRows(), info.items));
  }

  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (e) { return null; }
  }

  /* ---------------- validation ---------------- */

  function rowErr(row, keys, msgKey) {
    row.classList.add("invalid");
    keys.forEach(k => $(`input[data-k="${k}"]`, row).classList.add("bad"));
    let p = $(".err", row);
    if (!p) { p = document.createElement("p"); p.className = "err"; row.append(p); }
    p.textContent = (p.textContent ? p.textContent + " · " : "") + t(msgKey);
  }

  function clearRowErr(row) {
    row.classList.remove("invalid");
    $$("input.bad", row).forEach(i => i.classList.remove("bad"));
    const p = $(".err", row);
    if (p) p.remove();
  }

  // Same rules as the server: fully empty rows are ignored; name or link + quantity; link starts with http.
  function validate() {
    $$(".brow", rowsBox).forEach(clearRowErr);
    $("#buy_rows_err").hidden = true;
    let first = null;
    const rows = nonEmptyRows();
    rows.forEach(r => {
      const x = {};
      KEYS.forEach(k => { x[k] = $(`input[data-k="${k}"]`, r).value.trim(); });
      if (!x.name && !x.link) rowErr(r, ["name", "link"], "err_name_or_link");
      if (!x.qty) rowErr(r, ["qty"], "err_qty");
      if (x.link && !/^https?:\/\//i.test(x.link)) rowErr(r, ["link"], "err_link_http");
      if (!first && r.classList.contains("invalid")) first = r;
    });
    if (!rows.length) { $("#buy_rows_err").hidden = false; first = $("#buy_rows_err"); }
    return first;
  }

  // Server errors: items.N.field — N counts non-empty rows only.
  function markServer(fields) {
    const rows = nonEmptyRows();
    fields.forEach(f => {
      if (f === "items.empty") { $("#buy_rows_err").hidden = false; return; }
      const m = /^items\.(\d+)\.(name|qty|link)/.exec(f);
      const r = m && rows[m[1] - 1];
      if (!r) return;
      if (m[2] === "name") rowErr(r, ["name", "link"], "err_name_or_link");
      else if (m[2] === "qty") rowErr(r, ["qty"], "err_qty");
      else rowErr(r, ["link"], "err_link_http");
    });
  }

  /* ---------------- server ---------------- */

  // text/plain = "simple" request: no CORS preflight (Apps Script can't answer OPTIONS).
  async function post(msg) {
    const r = await fetch(WEBAPP_URL, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(msg)
    });
    return r.json();
  }

  function setStatus(key, bad) {
    const p = $("#buy_status");
    p.hidden = !key;
    p.classList.toggle("bad", !!bad);
    if (key) p.textContent = t(key);
  }

  function showClosed(kind) {
    closed = kind;
    form.hidden = true;
    $("#buy_loading").hidden = true;
    $("#buy_closed").hidden = false;
    renderTexts();
  }

  async function load() {
    if (!D || !K) { showClosed("link"); return; }
    let res;
    try {
      res = await post({ v: 1, action: "buyLoad", d: D, k: K });
    } catch (e) {
      $("#buy_loading").textContent = t("buy_err_server");
      return;
    }
    if (!res.ok) {
      if (res.error === "invalid") showClosed("link");
      else $("#buy_loading").textContent = t("buy_err_server");
      return;
    }
    info = res;
    if (res.sentAt) { showThanks(); return; }
    if (res.closed) { showClosed("deadline"); return; }

    $("#buy_event").textContent = res.title || "";
    $("#buy_dates").textContent = res.dateRange || "—";
    $("#buy_deadline").textContent = res.deadline || "—";
    // A local draft newer than the last send (and different from it) wins; otherwise the last send.
    const draft = loadDraft();
    if (draft && draft.at > (res.sentAt || 0) && !same(draft.items, res.items)) {
      fill(draft.items);
      $("#buy_draft").hidden = false;
    } else {
      fill(res.items);
    }
    $("#buy_loading").hidden = true;
    form.hidden = false;
    renderTexts();
  }

  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (busy) return;
    const bad = validate();
    if (bad) {
      bad.scrollIntoView({ behavior: "smooth", block: "center" });
      setStatus("buy_err_invalid", true);
      return;
    }
    busy = true;
    $("#buy_send").disabled = true;
    setStatus("sending", false);
    const items = filled(readRows());
    let res;
    try {
      res = await post({ v: 1, action: "buySave", d: D, k: K, items });
    } catch (err) {
      res = { ok: false, error: "server" };
    }
    busy = false;
    $("#buy_send").disabled = false;
    if (!res.ok) {
      if (res.error === "closed") { info.deadline = res.deadline || info.deadline; showClosed("deadline"); return; }
      if (res.error === "invalid" && (res.fields || [])[0] === "key") { showClosed("link"); return; }
      if (res.error === "invalid") { markServer(res.fields || []); setStatus("buy_err_invalid", true); return; }
      setStatus("buy_err_server", true);
      return;
    }
    info.items = items;
    info.sentAt = res.sentAt;
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
    setStatus(null);
    showThanks();
  });

  /* ---------------- utils + init ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  setLang(lang);
  load();
})();
