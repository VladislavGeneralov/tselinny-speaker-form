// Speaker form — LOCAL version: validates and shows the payload, sends nothing.
(() => {
  "use strict";

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
    localStorage.setItem("speakerFormLang", lang);
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

  /* ---------------- uploader ---------------- */

  // Each file later travels to Drive through Apps Script in its own request (~50 MB cap
  // per request, base64 adds ~1/3) → 30 MB per file is the real limit.
  const MAX_BYTES = 30 * 1024 * 1024;
  const MORE_MAX = 10;   // files per block on the "more photos" step

  function makeUploader(box, { multiple = false, max = 1 } = {}) {
    box._files = [];
    box.innerHTML =
      `<button type="button" class="pill" data-i18n="${multiple ? "upload" : "upload_one"}"></button>` +
      `<input type="file" accept="image/*"${multiple ? " multiple" : ""}>` +
      '<div class="thumbs"></div><p class="err" hidden></p>';
    const btn = $("button", box), input = $("input", box), thumbs = $(".thumbs", box), err = $(".err", box);

    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      let tooBig = false;
      for (const f of input.files) {
        if (!f.type.startsWith("image/")) continue;
        if (f.size > MAX_BYTES) { tooBig = true; continue; }
        if (!multiple) clear();                 // single mode: new pick replaces the old one
        if (box._files.length >= max) break;
        box._files.push({ file: f, url: URL.createObjectURL(f) });
      }
      input.value = "";        // allow picking the same file again after removing it
      err.dataset.i18n = "err_file_big";
      err.textContent = t("err_file_big");
      err.hidden = !tooBig;
      draw();
    });
    thumbs.addEventListener("click", e => {
      const b = e.target.closest("button[data-i]");
      if (!b) return;
      const [gone] = box._files.splice(+b.dataset.i, 1);
      URL.revokeObjectURL(gone.url);
      draw();
    });

    function clear() {
      box._files.forEach(x => URL.revokeObjectURL(x.url));
      box._files = [];
    }
    function draw() {
      thumbs.innerHTML = box._files.map((x, i) =>
        `<div class="thumb"><img src="${x.url}" alt=""><span title="${esc(x.file.name)}">${esc(x.file.name)}</span>` +
        `<button type="button" data-i="${i}" aria-label="×">×</button></div>`).join("");
      if (!multiple) {
        btn.dataset.i18n = box._files.length ? "replace" : "upload_one";
        btn.textContent = t(btn.dataset.i18n);
      }
    }
    applyI18n(box);
  }

  const fileMeta = box => box._files.map(x => ({ name: x.file.name, size: x.file.size, type: x.file.type }));
  const oneFile = box => fileMeta(box)[0] || null;

  /* ---------------- speakers ---------------- */

  function addSpeaker() {
    const id = ++state.speakerSeq;
    const node = $("#speaker_tpl").content.firstElementChild.cloneNode(true);
    // give every control a unique id so its label is clickable
    $$(".field", node).forEach((f, i) => {
      const ctl = $("input, textarea", f), lab = $("label", f);
      if (ctl && lab) { ctl.id = `sp${id}_${i}`; lab.htmlFor = ctl.id; }
    });
    $(".remove", node).addEventListener("click", () => {
      $$(".uploader", node).forEach(u => u._files.forEach(x => URL.revokeObjectURL(x.url)));
      node.remove();
      renumberSpeakers();
    });
    $("#speakers").append(node);
    makeUploader($(".sp-photos", node));
    applyI18n(node);
    renumberSpeakers();
  }

  function renumberSpeakers() {
    const all = $$("#speakers .speaker");
    all.forEach((s, i) => {
      $(".num", s).textContent = all.length > 1 ? String(i + 1) : "";
      $(".remove", s).hidden = all.length === 1;
    });
  }

  $("#add_speaker").addEventListener("click", addSpeaker);

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
  }

  $("#tech_presets").addEventListener("change", e => {
    const cb = e.target.closest('input[name="tech"]');
    const qty = cb && $(".tech-count", cb.closest(".tech-row"));
    if (qty) qty.hidden = !cb.checked;
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
    const em = $(".field[data-email]", form);
    const ev = $("input", em).value.trim();
    if (ev && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ev)) { setErr(em, "err_email"); bad.push(em); }
    if (!state.dates.size) { setErr($("#dates_field"), "err_dates"); bad.push($("#dates_field")); }
    // report in document order
    return bad.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  }

  /* ---------------- collect ---------------- */

  const val = id => $("#" + id).value.trim();
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
      speakers: $$("#speakers .speaker").map(s => ({
        name: $(".sp-name", s).value.trim(),
        web: $(".sp-web", s).value.trim(),
        bio: $(".sp-bio", s).value.trim(),
        photo: oneFile($(".sp-photos", s)),
        morePhotos: $(".sp-more", s).checked
      })),
      promoImage: oneFile($("#promo")),
      promoMore: $("#promo_more").checked,
      dates,
      dateRange: dateRange(dates),
      duration: val("duration"),
      languages: checkedValues("language"),
      languageOther: checkedValues("language").includes("other") ? val("language_other") : "",
      ageLimit: val("age"),
      capacity: parseInt(val("capacity"), 10) || 1,
      participantRequirements: val("participant_req"),
      techPresets: techPresets(),
      techRequirements: val("tech_req"),
      interpreter: interp,
      interpreterOther: interp === "other" ? val("interpreter_other") : "",
      ticketing: val("ticketing"),
      accessibility: val("access"),
      feminatives: $("#fem").checked
    };
  }

  form.addEventListener("submit", e => {
    e.preventDefault();
    const bad = validate();
    if (bad.length) {
      bad[0].scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    showDone(collect());
  });

  /* ---------------- after submit: thanks + "more photos" step ---------------- */

  function showDone(data) {
    form.hidden = true;
    $("#out_pre").textContent = JSON.stringify(data, null, 2);
    const list = $("#more_list");
    list.innerHTML = "";
    data.speakers.forEach((s, i) => { if (s.morePhotos) addMoreBlock(s.name, `speaker ${i + 1}`); });
    if (data.promoMore) addMoreBlock(null, "promo");
    $("#more").hidden = !list.children.length;
    $("#more_status").textContent = "";
    $("#done").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function addMoreBlock(name, key) {
    const b = document.createElement("div");
    b.className = "more-block";
    b.dataset.key = key;
    b.innerHTML = (name === null
      ? '<p class="more-name" data-i18n="promo"></p>'
      : `<p class="more-name">${esc(name)}</p>`) + '<div class="uploader"></div>';
    $("#more_list").append(b);
    makeUploader($(".uploader", b), { multiple: true, max: MORE_MAX });
    applyI18n(b);
  }

  // Local version: show what would be uploaded, one file per request, in this order.
  $("#more_upload").addEventListener("click", () => {
    const queue = $$("#more_list .more-block").flatMap(b =>
      $(".uploader", b)._files.map(x => `${b.dataset.key}: ${x.file.name} (${(x.file.size / 1048576).toFixed(1)} MB)`));
    $("#more_status").textContent = `${t("local_queue")} ${queue.length}\n${queue.join("\n")}`;
  });

  $("#back_local").addEventListener("click", () => {
    $("#done").hidden = true;
    form.hidden = false;
  });

  /* ---------------- utils + init ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  makeUploader($("#promo"));
  addSpeaker();
  setLang(lang);
})();
