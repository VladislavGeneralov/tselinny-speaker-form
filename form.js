// Speaker form → Apps Script web app (TSELINNY_EVENTS/PROTOCOL.md, v1).
// Empty WEBAPP_URL = local mode: validates and shows the payload, sends nothing.
(() => {
  "use strict";

  const WEBAPP_URL = "https://script.google.com/macros/s/AKfycbyRav8ow-BPFPI6V8MrIQiX0MBx0O_aObw_MBmNUvCNuXPowz78Epwz18eBa9ucahQ/exec";
  const T0 = Date.now();        // elapsedMs for the server's bot check
  // One id per page: staged photos live under it on the server, and a retried submit with the same id
  // never makes a duplicate event.
  const submissionId = randomHex(16);
  let busy = false;             // a submit or an upload is in flight
  // org.html (<body data-org>) = organiser page (ORG_PAGE.md): the same form prefilled with the speaker's
  // answers + organiser fields, saved once into ORG. Everything ORG-only is guarded by this flag.
  const ORG = document.body.hasAttribute("data-org");

  const STR = window.I18N;
  const LOCALE = { en: "en-GB", ru: "ru-RU", kk: "kk-KZ" };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let lang = pickLang();
  const t = key => (STR[lang] && STR[lang][key]) ?? STR.en[key] ?? key;

  const form = $("#form");
  const state = {
    dates: new Set(),            // "YYYY-MM-DD"
    view: monthOf(new Date()),   // { y, m } shown in the calendar
    speakerSeq: 0
  };

  /* ---------------- language ---------------- */

  function pickLang() {
    if (ORG) return "ru"; // the organiser page is Russian only
    const q = new URLSearchParams(location.search).get("lang");
    if (q && STR[q]) return q;
    const saved = localStorage.getItem("speakerFormLang");
    if (saved && STR[saved]) return saved;
    const nav = (navigator.language || "en").slice(0, 2);
    return nav === "ru" ? "ru" : nav === "kk" ? "kk" : "en";
  }

  function applyI18n(root = document) {
    $$("[data-i18n]", root).forEach(el => { el.textContent = t(el.dataset.i18n); });
    $$("[data-i18n-ph]", root).forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    $$("[data-i18n-href]", root).forEach(el => { el.href = t(el.dataset.i18nHref); });
  }

  function setLang(next) {
    lang = next;
    if (!ORG) localStorage.setItem("speakerFormLang", lang);
    document.documentElement.lang = lang === "kk" ? "kk" : lang;
    $$(".langs button").forEach(b => b.classList.toggle("on", b.dataset.lang === lang));
    applyI18n();
    renderTechPresets();
    renderCal();
  }

  $(".langs").addEventListener("click", e => {
    const b = e.target.closest("button[data-lang]");
    if (b) setLang(b.dataset.lang);
  });

  /* ---------------- uploader: background "stage" upload right after picking (PROTOCOL v2) ---------------- */

  // Each file travels to Drive through Apps Script in its own request (~50 MB cap per request,
  // base64 adds ~1/3) → 30 MB per file is the real limit.
  const MAX_BYTES = 30 * 1024 * 1024;
  const MAX_FILES = 10;      // per speaker and for promo
  const PARALLEL = 2;        // stage requests in flight at once
  const queue = [];          // entries waiting for a free slot
  let active = 0;
  let onPhotosChange = null; // set while Submit waits for uploads

  // entry x: { file, url, box, status: "wait" | "up" | "ok" | "err" | "gone", stagedId, ctrl, started }
  function makeUploader(box) {
    box._files = [];
    box.innerHTML =
      '<button type="button" class="pill" data-i18n="upload"></button>' +
      '<input type="file" accept="image/*" multiple>' +
      '<div class="thumbs"></div><p class="err" hidden></p>';
    const btn = $("button", box), input = $("input", box), thumbs = $(".thumbs", box), err = $(".err", box);
    box._draw = draw;

    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      let tooBig = false;
      for (const f of input.files) {
        if (!f.type.startsWith("image/")) continue;
        if (f.size > MAX_BYTES) { tooBig = true; continue; }
        if (box._files.length >= MAX_FILES) break;
        const x = { file: f, url: URL.createObjectURL(f), box, status: "wait" };
        box._files.push(x);
        stage(x);
      }
      input.value = "";        // allow picking the same file again after removing it
      err.dataset.i18n = "err_file_big";
      err.textContent = t("err_file_big");
      err.hidden = !tooBig;
      draw();
    });
    thumbs.addEventListener("click", e => {
      const th = e.target.closest(".thumb");
      const x = th && box._files[+th.dataset.i];
      if (!x) return;
      if (e.target.closest("button.rm")) forget(x);
      else if (e.target.closest("button.retry")) stage(x);
      draw();
    });

    function draw() {
      thumbs.innerHTML = box._files.map((x, i) =>
        `<div class="thumb ${x.status}" data-i="${i}"><div class="pic"><img src="${x.url}" alt="">` +
        (x.status === "ok" ? '<i class="tick"></i>' : x.status === "err" ? "" : '<i class="spin"></i>') +
        `</div><span class="st" title="${esc(x.file.name)}">${esc(statusText(x))}</span>` +
        (x.status === "err" ? `<button type="button" class="retry">${esc(t("retry"))}</button>` : "") +
        '<button type="button" class="rm" aria-label="×">×</button></div>').join("");
    }
    applyI18n(box);
  }

  const allPhotos = () => $$(".uploader").flatMap(b => b._files || []);
  const mbText = n => (n / 1048576).toFixed(1).replace(".", lang === "en" ? "." : ",") + " " + t("mb");
  const clock = since => {
    const s = since ? Math.floor((Date.now() - since) / 1000) : 0;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  function statusText(x) {
    if (x.status === "ok") return t("st_done");
    if (x.status === "err") return x.file.name;
    return `${mbText(x.file.size)} · ${clock(x.started)}`;
  }

  // running timers under thumbs that are still uploading (text only, no re-render)
  setInterval(() => $$(".uploader").forEach(b => (b._files || []).forEach((x, i) => {
    if (x.status !== "up" && x.status !== "wait") return;
    const st = $(`.thumb[data-i="${i}"] .st`, b);
    if (st) st.textContent = statusText(x);
  })), 1000);

  function stage(x) {
    x.status = "wait";
    x.stagedId = null;
    x.started = 0;
    queue.push(x);
    pump();
  }

  function pump() {
    while (active < PARALLEL && queue.length) {
      const x = queue.shift();
      if (x.status === "wait") run(x);
    }
  }

  async function run(x) {
    active++;
    x.status = "up";
    x.started = Date.now();
    x.ctrl = new AbortController();
    x.box._draw();
    try {
      if (!WEBAPP_URL) {                       // local mode: pretend it went through
        await new Promise(r => setTimeout(r, 400));
        if (x.status === "up") { x.stagedId = "local:" + x.file.name; x.status = "ok"; }
      } else {
        const data = await toBase64(x.file);
        const msg = { v: 1, action: "stage", submissionId, fileName: x.file.name,
                      mimeType: x.file.type || "image/jpeg", data };
        let res = null;
        for (let a = 0; a < 2 && x.status === "up" && !res; a++) {   // one retry on a network error
          try { res = await postJSON(msg, x.ctrl.signal); }
          catch (e) { if (x.ctrl.signal.aborted) throw e; }
        }
        if (x.status === "up") {
          if (res && res.ok && res.stagedId) { x.stagedId = res.stagedId; x.status = "ok"; }
          else x.status = "err";
        }
      }
    } catch (e) {
      if (x.status === "up") x.status = "err";
    } finally {
      active--;
      if (x.status !== "gone") x.box._draw();
      pump();
      if (onPhotosChange) onPhotosChange();
    }
  }

  // Removed / replaced: abort its upload and forget it (the server bins leftovers on submit).
  function forget(x) {
    if (x.ctrl) x.ctrl.abort();
    x.status = "gone";
    const i = x.box._files.indexOf(x);
    if (i >= 0) x.box._files.splice(i, 1);
    URL.revokeObjectURL(x.url);
    if (onPhotosChange) onPhotosChange();
  }

  const stagedIds = box => ((box && box._files) || []).filter(x => x.status === "ok").map(x => x.stagedId);

  /* ---------------- speakers ---------------- */

  // src (organiser page only) = index of this speaker in the submission; photos follow it on save.
  function addSpeaker(src) {
    const id = ++state.speakerSeq;
    const node = $("#speaker_tpl").content.firstElementChild.cloneNode(true);
    // give every control a unique id so its label is clickable
    $$(".field", node).forEach((f, i) => {
      const ctl = $("input, textarea", f), lab = $("label", f);
      if (ctl && lab) { ctl.id = `sp${id}_${i}`; lab.htmlFor = ctl.id; }
    });
    $(".remove", node).addEventListener("click", () => {
      $$(".uploader", node).forEach(u => [...u._files].forEach(forget));
      node.remove();
      renumberSpeakers();
    });
    $("#speakers").append(node);
    if (ORG) orgSpeakerPhotos(node, src);
    else makeUploader($(".sp-photos", node));
    applyI18n(node);
    renumberSpeakers();
    return node;
  }

  function renumberSpeakers() {
    const all = $$("#speakers .speaker");
    all.forEach((s, i) => {
      $(".num", s).textContent = all.length > 1 ? String(i + 1) : "";
      $(".remove", s).hidden = all.length === 1;
    });
  }

  $("#add_speaker").addEventListener("click", () => addSpeaker());

  /* ---------------- "Other" text inputs ---------------- */

  form.addEventListener("change", e => {
    const el = e.target;
    if (el.name === "venue" || el.name === "language" || el.name === "interpreter") {
      $$(`input[name="${el.name}"][data-other]`).forEach(o => {
        const box = $("#" + o.dataset.other);
        box.hidden = !o.checked;
        if (o.checked && el === o) box.focus();
      });
    }
  });

  /* ---------------- capacity stepper ---------------- */

  $(".stepper").addEventListener("click", e => {
    const b = e.target.closest("button[data-step]");
    if (!b) return;
    const inp = $("#capacity");
    inp.value = Math.max(1, (parseInt(inp.value, 10) || 1) + +b.dataset.step);
  });

  /* ---------------- tech presets ---------------- */

  function renderTechPresets() {
    const box = $("#tech_presets");
    const list = window.TECH_PRESETS || [];
    // keep ticks and quantities across language switches
    const checked = new Set($$("input:checked", box).map(i => i.value));
    const counts = Object.fromEntries($$("select[data-for]", box).map(s => [s.dataset.for, s.value]));
    box.hidden = list.length === 0;
    box.innerHTML = list.map(p => {
      const on = checked.has(p.id);
      let qty = "";
      if (p.count) {
        const [min, max] = p.count;
        const cur = counts[p.id] || String(min);
        const opts = Array.from({ length: max - min + 1 }, (_, i) => min + i)
          .map(n => `<option${String(n) === cur ? " selected" : ""}>${n}</option>`).join("");
        qty = `<label class="tech-count"${on ? "" : " hidden"}>${esc(t("count"))}` +
              `<select data-for="${esc(p.id)}">${opts}</select></label>`;
      }
      return `<div class="tech-row"><label class="choice"><input type="checkbox" name="tech" value="${esc(p.id)}"${on ? " checked" : ""}>` +
             `<span>${esc(p[lang] || p.en || p.id)}</span></label>${qty}</div>`;
    }).join("");
    $("#tech_other_box").hidden = !techOtherOn();
  }

  const techOtherOn = () => !!$('#tech_presets input[name="tech"][value="other"]:checked');

  $("#tech_presets").addEventListener("change", e => {
    const cb = e.target.closest('input[name="tech"]');
    const qty = cb && $(".tech-count", cb.closest(".tech-row"));
    if (qty) qty.hidden = !cb.checked;
    if (cb && cb.value === "other") {
      $("#tech_other_box").hidden = !cb.checked;
      if (cb.checked) $("#tech_req").focus();
    }
  });

  const techPresets = () => $$('#tech_presets input[name="tech"]:checked').map(cb => {
    const sel = $("select", cb.closest(".tech-row"));
    return sel ? { id: cb.value, count: +sel.value } : { id: cb.value };
  });

  /* ---------------- calendar ---------------- */

  function monthOf(d) { return { y: d.getFullYear(), m: d.getMonth() }; }
  const pad = n => String(n).padStart(2, "0");
  const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local date, no UTC shift
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  function renderCal() {
    const { y, m } = state.view;
    const loc = LOCALE[lang];
    const first = new Date(y, m, 1);
    const title = cap(new Intl.DateTimeFormat(loc, { month: "long", year: "numeric" }).format(first));
    const wdFmt = new Intl.DateTimeFormat(loc, { weekday: "short" });
    const weekdays = Array.from({ length: 7 }, (_, i) => wdFmt.format(new Date(2024, 0, 1 + i))); // 2024-01-01 is a Monday
    const lead = (first.getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    const today = isoOf(new Date());

    let html =
      `<div class="cal-head"><button type="button" class="cal-nav" data-nav="-1" aria-label="‹">‹</button>` +
      `<span class="cal-title">${esc(title)}</span>` +
      `<button type="button" class="cal-nav" data-nav="1" aria-label="›">›</button></div><div class="cal-grid">` +
      weekdays.map(w => `<span class="cal-wd">${esc(w)}</span>`).join("") +
      "<span></span>".repeat(lead);
    for (let d = 1; d <= days; d++) {
      const k = isoOf(new Date(y, m, d));
      const on = state.dates.has(k);
      html += `<button type="button" class="cal-day${on ? " on" : ""}${k === today ? " today" : ""}" data-iso="${k}" aria-pressed="${on}">${d}</button>`;
    }
    $("#cal").innerHTML = html + "</div>";
    renderDateSummary();
  }

  $("#cal").addEventListener("click", e => {
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      const d = new Date(state.view.y, state.view.m + +nav.dataset.nav, 1);
      state.view = monthOf(d);
      renderCal();
      return;
    }
    const day = e.target.closest("[data-iso]");
    if (day) {
      const k = day.dataset.iso;
      state.dates.has(k) ? state.dates.delete(k) : state.dates.add(k);
      renderCal();
      if (state.dates.size) clearErr($("#dates_field"));
    }
  });

  $("#cal_clear").addEventListener("click", () => { state.dates.clear(); renderCal(); });

  const sortedDates = () => [...state.dates].sort();

  // "01.11.2026" · "01.11–20.12.2026" · "28.12.2026–10.01.2027" (site-template style)
  function dateRange(list) {
    if (!list.length) return "";
    const p = s => { const [y, m, d] = s.split("-"); return { y, m, d }; };
    const a = p(list[0]), b = p(list[list.length - 1]);
    if (list.length === 1) return `${a.d}.${a.m}.${a.y}`;
    if (a.y === b.y) return `${a.d}.${a.m}–${b.d}.${b.m}.${b.y}`;
    return `${a.d}.${a.m}.${a.y}–${b.d}.${b.m}.${b.y}`;
  }

  function renderDateSummary() {
    const list = sortedDates();
    $("#cal_sum").textContent = list.length ? `${list.length} · ${dateRange(list)}` : "";
    $("#cal_clear").hidden = !list.length;
    if (ORG) { renderSchedule(); renderPriceInfo(); }
  }

  /* ---------------- validation ---------------- */

  function setErr(field, key) {
    let p = $(":scope > .err", field);
    if (!p) { p = document.createElement("p"); p.className = "err"; field.append(p); }
    p.dataset.i18n = key;
    p.textContent = t(key);
    field.classList.add("invalid");
  }
  function clearErr(field) {
    field.classList.remove("invalid");
    const p = $(":scope > .err", field);
    if (p) p.remove();
  }

  form.addEventListener("input", e => {
    const f = e.target.closest(".field.invalid");
    if (f) clearErr(f);
  });

  function validate() {
    const bad = [];
    $$(".field", form).forEach(clearErr);
    $$(".field[data-required]", form).forEach(f => {
      const ctl = $("input, textarea", f);
      if (!ctl.value.trim()) { setErr(f, "err_required"); bad.push(f); }
    });
    const em = $(".field[data-email]", form); // absent on the organiser page (contact is read-only there)
    const ev = em ? $("input", em).value.trim() : "";
    if (ev && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ev)) { setErr(em, "err_email"); bad.push(em); }
    if (!state.dates.size) { setErr($("#dates_field"), "err_dates"); bad.push($("#dates_field")); }
    // interpreter: required; «Other» needs its text too
    const interp = checkedValues("interpreter")[0];
    if (!interp || (interp === "other" && !val("interpreter_other"))) {
      setErr($("#interp_field"), "err_required");
      bad.push($("#interp_field"));
    }
    if (ORG) orgValidate(bad);
    // report in document order
    return bad.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  }

  /* ---------------- collect ---------------- */

  const val = id => { const el = $("#" + id); return el ? el.value.trim() : ""; };
  const checkedValues = name => $$(`input[name="${name}"]:checked`, form).map(i => i.value);

  function collect() {
    const dates = sortedDates();
    const interp = (checkedValues("interpreter")[0]) || "";
    return {
      contact: { name: val("contact_name"), email: val("email"), phone: val("phone") },
      venues: checkedValues("venue"),
      venueOther: checkedValues("venue").includes("other") ? val("venue_other") : "",
      title: val("event_title"),
      description: val("event_desc"),
      sessionLength: val("duration"),
      dates,
      speakers: $$("#speakers .speaker").map(s => ({
        name: $(".sp-name", s).value.trim(),
        web: $(".sp-web", s).value.trim(),
        bio: $(".sp-bio", s).value.trim(),
        photos: stagedIds($(".sp-photos", s))
      })),
      promo: { images: stagedIds($("#promo")) },
      languages: checkedValues("language"),
      languageOther: checkedValues("language").includes("other") ? val("language_other") : "",
      ageLimit: val("age"),
      capacity: parseInt(val("capacity"), 10) || 1,
      participantRequirements: val("participant_req"),
      interpreter: interp,
      interpreterOther: interp === "other" ? val("interpreter_other") : "",
      ticketing: val("ticketing"),
      accessibility: val("access"),
      feminatives: $("#fem") ? $("#fem").checked : !!org.fem, // no checkbox on the organiser page
      tech: { presets: techPresets(), text: techOtherOn() ? val("tech_req") : "" }
    };
  }

  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (busy) return;
    const bad = validate();
    if (bad.length) {
      bad[0].scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (ORG) { orgSubmit(); return; }
    if (!(await photosReady())) return;
    const data = collect();
    if (!WEBAPP_URL) { showDone(data, null); return; }

    setBusy(true);
    setSendStatus("sending", false);
    let res;
    try {
      res = await postJSON({ v: 1, action: "submit", submissionId, hp: $("#hp").value,
                             elapsedMs: Date.now() - T0, lang, data });
    } catch (err) {
      res = { ok: false, error: "server" };
    }
    setBusy(false);
    if (!res.ok) {
      if (res.error === "invalid") { markServerFields(res.fields || []); setSendStatus("err_invalid", true); }
      else setSendStatus("err_server", true);
      return;
    }
    setSendStatus(null);
    if (res.buyUrl && res.d && res.k) showBuyQuestion(data, res);
    else showDone(data, res);
  });

  // Submit waits for background uploads; false = some photo failed (retry or remove it first).
  async function photosReady() {
    const failed = () => allPhotos().find(x => x.status === "err");
    const pending = () => allPhotos().some(x => x.status === "up" || x.status === "wait");
    if (!failed() && pending()) {
      setBusy(true);
      setSendStatus("wait_photos", false);
      // «Дожидаемся загрузки фото: осталось 2 из 5» (Vlad: a counter, not a timer)
      const show = () => {
        const all = allPhotos();
        const left = all.filter(x => x.status === "up" || x.status === "wait").length;
        $("#send_status").textContent = t("wait_photos") + ": " +
          t("wait_left").replace("{n}", left).replace("{m}", all.length);
      };
      show();
      await new Promise(resolve => {
        onPhotosChange = () => { show(); if (!pending() || failed()) resolve(); };
        onPhotosChange();
      });
      onPhotosChange = null;
      setBusy(false);
      setSendStatus(null);
    }
    const f = failed();
    if (f) {
      setSendStatus("err_photos", true);
      f.box.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
    }
    return true;
  }

  /* ---------------- sending ---------------- */

  // text/plain = "simple" request: no CORS preflight (Apps Script can't answer OPTIONS).
  async function postJSON(msg, signal) {
    const r = await fetch(WEBAPP_URL, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(msg), signal
    });
    return r.json();
  }

  function randomHex(bytes) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, "0")).join("");
  }

  function setBusy(on) {
    busy = on;
    $("#submit_btn").disabled = on;
  }

  function setSendStatus(key, bad) {
    const p = $("#send_status");
    p.hidden = !key;
    p.classList.toggle("bad", !!bad);
    if (key) { p.dataset.i18n = key; p.textContent = t(key); }
  }

  // Server-side validation errors → the same red marks as local validation.
  function markServerFields(fields) {
    const fieldOf = id => $("#" + id).closest(".field");
    fields.forEach(f => {
      let el = null, key = "err_required";
      if (f === "contact.name") el = fieldOf("contact_name");
      else if (f === "contact.email") { el = fieldOf("email"); key = "err_email"; }
      else if (f === "contact.phone") el = fieldOf("phone");
      else if (f === "title") el = fieldOf("event_title");
      else if (f === "description") el = fieldOf("event_desc");
      else if (f === "dates") { el = $("#dates_field"); key = "err_dates"; }
      else if (f === "ticketing" && ORG) { el = $("#ticket_field"); key = "err_org_ticket"; }
      else if (f === "siteCategories") { el = $("#cats_field"); key = "err_org_cats"; }
      else if (f === "eduCategory") el = $("#edu_field");
      else if (/^schedule\./.test(f)) { el = $("#dates_field"); key = "err_org_times"; }
      else {
        const m = /^speakers\.(\d+)\.name$/.exec(f);
        const s = m && $$("#speakers .speaker")[m[1] - 1];
        if (s) el = $(".sp-name", s).closest(".field");
      }
      if (el) setErr(el, key);
    });
  }

  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  // Closing the tab while photos upload or the form is being sent loses them — ask first.
  window.addEventListener("beforeunload", e => {
    if (form.hidden) return;   // already sent
    if (busy || allPhotos().some(x => x.status === "up" || x.status === "wait")) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ---------------- after submit: purchase question, then thanks ---------------- */

  // «Нужна закупка?» Да/Нет → buyAnswer (RAW «ЗАКУПКА» status). Да → «Заполнить сейчас» opens the
  // purchase page in this tab, «Позже» → thanks + «the team will send the link». No mail to the speaker.
  function showBuyQuestion(data, res) {
    form.hidden = true;
    $("main.wrap > h1").hidden = true;
    $(".req-note").hidden = true;
    $("#buyq").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    const status = $("#buyq_status");
    $("#buyq_1").onclick = async e => {
      const b = e.target.closest("button[data-ans]");
      if (!b) return;
      $$("#buyq button").forEach(x => { x.disabled = true; });
      status.textContent = t("sending");
      status.hidden = false;
      try { await postJSON({ v: 1, action: "buyAnswer", d: res.d, k: res.k, answer: b.dataset.ans }); }
      catch (err) { /* status stays «нет ответа»; the team has the link in RAW anyway */ }
      status.hidden = true;
      $$("#buyq button").forEach(x => { x.disabled = false; });
      if (b.dataset.ans === "no") { $("#buyq").hidden = true; showDone(data, res); }
      else { $("#buyq_1").hidden = true; $("#buyq_2").hidden = false; }
    };
    $("#buy_now").onclick = () => {
      const u = new URL(res.buyUrl);
      u.searchParams.set("lang", lang); // the language the speaker has now
      location.href = u.toString();
    };
    $("#buy_later").onclick = () => {
      $("#buyq").hidden = true;
      $("#done_later").hidden = false;
      showDone(data, res);
    };
  }

  function showDone(data, res) {
    form.hidden = true;
    const local = !res;
    $(".out").hidden = !local;
    if (local) $("#out_pre").textContent = JSON.stringify(data, null, 2);
    $("#done").hidden = false;
    // thanks screen: no form title, no «* required» note (Vlad)
    $("main.wrap > h1").hidden = true;
    $(".req-note").hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $("#back_local").addEventListener("click", () => {
    $("#done").hidden = true;
    $("main.wrap > h1").hidden = false;
    $(".req-note").hidden = false;
    form.hidden = false;
  });

  /* ---------------- organiser page (org.html, ORG_PAGE.md) ---------------- */

  const SITE_CATS = ["Exhibition", "Film", "Performance", "Special Commission", "Lecture", "Workshop",
                     "Discussion", "Children & Teens", "Live Concert"];
  const EDU_CATS = [["Children & Families", "Children & Families"], ["Teens", "Teens"], ["Adults", "Adults"],
                    ["Talks", "Talks"], ["none", "без категории"]];
  const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const org = { d: "", k: "", photos: null, times: {}, fem: false }; // times: iso → «19:00–21:00»

  function orgSpeakerPhotos(node, src) {
    if (Number.isInteger(src)) node.dataset.src = src;
    const n = Number.isInteger(src) && org.photos ? (org.photos.speakers[src] || 0) : 0;
    $(".sp-photos", node).textContent = Number.isInteger(src)
      ? (n ? "Ссылок на фото: " + n + " (перенесутся в ORG)" : "Спикер фото не прислал")
      : "Новый спикер — без фото (можно добавить в папку «Фото» и вставить ссылку в ORG)";
  }

  // one time input per selected date (ORG «РАСПИСАНИЕ»)
  function renderSchedule() {
    const box = $("#org_schedule");
    const list = sortedDates();
    if (!list.length) { box.innerHTML = ""; return; }
    box.innerHTML = '<p class="org-sched-title">Время у каждой даты</p>' + list.map(iso => {
      const [y, m, d] = iso.split("-");
      const wd = WEEKDAYS[new Date(+y, m - 1, +d).getDay()];
      return `<label class="org-row"><span>${d}.${m}.${y}, ${wd}</span>` +
             `<input type="text" data-iso="${iso}" value="${esc(org.times[iso] || "")}" placeholder="19:00–21:00"></label>`;
    }).join("") + (list.length > 1 ? '<button type="button" class="link-btn" id="org_fill_times">Проставить первое время во все пустые</button>' : "");
  }

  // live lines under the price hints (Vlad 10.11): chosen ticket type; number of dates + price × dates
  const TICKET_RU = { free: "свободный вход", registration: "нужна регистрация", ticketed: "вход по билетам" };
  function renderPriceInfo() {
    const tk = checkedValues("ticket_org")[0];
    $("#org_price_info").textContent = tk ? "Выбрано: " + TICKET_RU[tk] : "Тип билетов ещё не выбран";
    const n = state.dates.size;
    const price = val("org_price").replace(/[\s ]/g, "");
    let line;
    if (!n) line = "Даты не выбраны";
    else if (n === 1) line = "Выбрано 1 мероприятие, можно не заполнять";
    else if (/^\d+$/.test(price)) {
      const fmt = x => x.toLocaleString("ru-RU");
      line = `Выбрано дат: ${n} · ${fmt(+price)} × ${n} = ${fmt(+price * n)}`;
    } else line = `Выбрано дат: ${n} · впишите цену за одно занятие — посчитаю цену × ${n}`;
    $("#org_course_info").textContent = line;
  }

  if (ORG) {
    $("#org_price").addEventListener("input", renderPriceInfo);
    form.addEventListener("change", e => { if (e.target.name === "ticket_org") renderPriceInfo(); });
    $("#org_schedule").addEventListener("input", e => {
      const i = e.target.closest("input[data-iso]");
      if (i) { org.times[i.dataset.iso] = i.value; i.classList.remove("bad"); }
    });
    $("#org_schedule").addEventListener("click", e => {
      if (!e.target.closest("#org_fill_times")) return;
      const first = sortedDates().map(iso => (org.times[iso] || "").trim()).find(Boolean);
      if (!first) return;
      sortedDates().forEach(iso => { if (!(org.times[iso] || "").trim()) org.times[iso] = first; });
      renderSchedule();
      clearErr($("#dates_field"));
    });
  }

  function orgValidate(bad) {
    const mark = (id, key) => { const f = $("#" + id); setErr(f, key); bad.push(f); };
    if (!checkedValues("ticket_org").length) mark("ticket_field", "err_org_ticket");
    if (!checkedValues("org_cat").length) mark("cats_field", "err_org_cats");
    if (!checkedValues("org_edu").length) mark("edu_field", "err_required");
    if (state.dates.size) {
      const empty = $$("#org_schedule input[data-iso]").filter(i => !i.value.trim());
      empty.forEach(i => i.classList.add("bad"));
      if (empty.length) mark("dates_field", "err_org_times");
    }
  }

  function collectOrg() {
    const data = collect();
    delete data.contact; // read-only here; the server keeps the speaker's own
    data.speakers.forEach((s, i) => {
      const src = $$("#speakers .speaker")[i].dataset.src;
      s.src = src === undefined || src === "" ? null : +src;
      delete s.photos;
    });
    delete data.promo;
    return Object.assign(data, {
      ticketing: checkedValues("ticket_org")[0] || "",
      siteCategories: checkedValues("org_cat"),
      eduCategory: checkedValues("org_edu")[0] || "",
      schedule: sortedDates().map(iso => ({ date: iso, time: (org.times[iso] || "").trim() })),
      pricePerSession: val("org_price"),
      priceCourse: val("org_price_course"),
      photobankBrief: val("org_photobank"),
      posterBrief: val("org_poster")
    });
  }

  async function orgSubmit() {
    setBusy(true);
    setSendStatus("sending", false);
    let res;
    try {
      res = await postJSON({ v: 1, action: "orgSave", d: org.d, k: org.k, data: collectOrg() });
    } catch (err) {
      res = { ok: false, error: "server" };
    }
    setBusy(false);
    if (res.ok) { setSendStatus(null); orgDone(res.savedAt, res.docUrl, false); return; }
    if (res.error === "saved") { setSendStatus(null); orgDone(res.savedAt, res.docUrl, true); return; }
    if (res.error === "invalid" && (res.fields || [])[0] === "key") { orgMessage("Ссылка недействительна."); return; }
    if (res.error === "invalid") { markServerFields(res.fields || []); setSendStatus("err_invalid", true); return; }
    setSendStatus("org_err_server", true);
  }

  function orgMessage(text) {
    form.hidden = true;
    const p = $("#org_msg");
    p.textContent = text;
    p.hidden = false;
  }

  function orgDone(savedAt, docUrl, already) {
    form.hidden = true;
    $("#org_msg").hidden = true;
    $("#org_title").hidden = true;
    $("#org_doc_top").hidden = true;
    $(".req-note").hidden = true;
    $(".out").hidden = true;
    $("#org_done_title").textContent = already ? "Заявка уже проверена" : "Сохранено";
    $("#org_done_text").textContent = (already ? "Проверена" + (savedAt ? " " + savedAt : "") : "Сохранено " + savedAt) +
      ". Дальше правки — во вкладке ORG документа.";
    $("#org_doc_link").href = docUrl || "#";
    $("#done").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // the organiser page opens prefilled with the speaker's answers (the submit payload, PROTOCOL.md)
  function prefill(d, res) {
    const setVal = (id, v) => { const el = $("#" + id); if (el) el.value = v == null ? "" : v; };
    const tick = (name, values) => $$(`input[name="${name}"]`, form).forEach(i => { i.checked = values.includes(i.value); });
    const showOther = name => $$(`input[name="${name}"][data-other]`, form).forEach(o => { $("#" + o.dataset.other).hidden = !o.checked; });
    const c = d.contact || {};
    $("#org_contact").textContent = [c.name, c.email, c.phone].filter(Boolean).join(", ");

    tick("venue", d.venues || []); setVal("venue_other", d.venueOther); showOther("venue");
    setVal("event_title", d.title); setVal("event_desc", d.description); setVal("duration", d.sessionLength);
    (d.speakers || []).forEach((s, i) => {
      const node = addSpeaker(i);
      $(".sp-name", node).value = s.name || "";
      $(".sp-web", node).value = s.web || "";
      $(".sp-bio", node).value = s.bio || "";
    });
    if (!$$("#speakers .speaker").length) addSpeaker();

    const p = res.photos || {};
    $("#org_photos").textContent = "Загружено фото: " + (p.inFolder || 0) + " (файлов в папке «Фото»)";
    $("#org_photo_link").href = p.folderUrl || "#";

    tick("language", d.languages || []); setVal("language_other", d.languageOther); showOther("language");
    setVal("age", d.ageLimit); setVal("capacity", d.capacity || 1);
    setVal("participant_req", d.participantRequirements);
    tick("interpreter", d.interpreter ? [d.interpreter] : []); setVal("interpreter_other", d.interpreterOther); showOther("interpreter");
    setVal("access", d.accessibility);
    org.fem = !!d.feminatives; // not shown on this page (Vlad 10.11), saved as the speaker chose

    // tech: tick + mic count, then re-render so quantity selects show up
    const presets = (d.tech && d.tech.presets) || [];
    $$('#tech_presets input[name="tech"]').forEach(cb => {
      const p = presets.find(x => x && x.id === cb.value);
      cb.checked = !!p;
      const sel = $("select", cb.closest(".tech-row"));
      if (p && sel && p.count) sel.value = String(p.count);
    });
    renderTechPresets();
    setVal("tech_req", d.tech && d.tech.text);

    // ticket type: only the three final ones; the speaker's «обсудим отдельно» → hint
    const TICKET_NAMES = { free: "свободный вход", registration: "нужна регистрация", ticketed: "вход по билетам", tbd: "обсудим отдельно" };
    tick("ticket_org", d.ticketing && d.ticketing !== "tbd" ? [d.ticketing] : []);
    $("#ticket_hint").textContent = "Спикер выбрал: «" + (TICKET_NAMES[d.ticketing] || "—") + "»" +
      (d.ticketing === "tbd" || !d.ticketing ? " — выберите одно из трёх" : "");

    $("#org_cats").innerHTML = SITE_CATS.map(cat =>
      `<label class="choice"><input type="checkbox" name="org_cat" value="${esc(cat)}"><span>${esc(cat)}</span></label>`).join("");
    $("#org_edu").innerHTML = EDU_CATS.map(([v, label]) =>
      `<label class="choice radio"><input type="radio" name="org_edu" value="${esc(v)}"><span>${esc(label)}</span></label>`).join("");

    state.dates = new Set(d.dates || []);
    const first = [...state.dates].sort()[0];
    if (first) { const [y, m] = first.split("-"); state.view = { y: +y, m: m - 1 }; }
    renderCal();
  }

  async function orgInit() {
    const q = new URLSearchParams(location.search);
    org.d = q.get("d") || "";
    org.k = q.get("k") || "";
    if (!org.d || !org.k) { orgMessage("Ссылка недействительна."); return; }
    let res;
    try {
      res = await postJSON({ v: 1, action: "orgLoad", d: org.d, k: org.k });
    } catch (e) {
      orgMessage("Не удалось загрузить заявку. Проверьте интернет и обновите страницу.");
      return;
    }
    if (!res.ok) {
      orgMessage(res.error === "invalid" ? "Ссылка недействительна." : "Не удалось загрузить заявку (ошибка сервера). Обновите страницу.");
      return;
    }
    if (res.savedAt) { orgDone(res.savedAt, res.docUrl, true); return; }
    org.photos = res.photos || null;
    prefill(res.data || {}, res);
    $("#org_title").textContent = "Заявка" + (res.submittedAt ? " от " + res.submittedAt : "");
    $("#org_doc_top_link").href = res.docUrl || "#";
    $("#org_doc_top").hidden = false;
    $("#org_msg").hidden = true;
    form.hidden = false;
  }

  /* ---------------- utils + init ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  if (ORG) {
    setLang(lang);
    orgInit();
  } else {
    makeUploader($("#promo"));
    addSpeaker();
    setLang(lang);
  }
})();
