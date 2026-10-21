// Librarian desk: dashboard, issue/return, loans, catalogue, members, reservations, fines.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const VIEWS = ["overview", "circulation", "loans", "catalogue", "members", "reservations", "fines"];
const filters = { loans: "active", reservations: "waiting", fines: "unpaid" };
const FEED_DOTS = { issued: "", returned: "violet", renewed: "violet", reserved: "amber", reservation_ready: "amber", hold_expired: "amber", fine: "amber", fine_paid: "", joined: "violet", catalogued: "violet" };
let me = null;
let gate = false; // the sign-in modal can't be dismissed
let subjects = [];

/* ---------------- feedback ---------------- */
function toast(message, kind = "ok") {
  const el = document.createElement("div");
  el.className = `hot-toast hot-toast--${kind}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 4500);
}

async function attempt(work, button) {
  if (button) button.disabled = true;
  try {
    return await work();
  } catch (err) {
    if (err.status === 401) return showGate();
    toast(err.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

const debounce = (fn, ms = 250) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/* ---------------- building blocks ---------------- */
const thumb = (book) =>
  `<span class="el__thumb cover-thumb" ${book?.cover_id ? `style="background-image:url('${coverUrl(book.cover_id, "S")}')"` : ""}></span>`;
const avatar = (name) => `<span class="el__av el__av--ring">${esc(initials(name))}</span>`;
const pill = (text, tone = "") => `<span class="el__pill${tone ? " el__pill--" + tone : ""}">${esc(text)}</span>`;
const empty = (text) => `<p class="desk-empty">${text}</p>`;

function row({ lead, title, sub, actions = "", tone = "", attrs = "" }) {
  return `<div class="el el--row el--row-strip el--row-hit${tone ? " el--row-strip--" + tone : ""}" ${attrs}>
    ${lead}
    <span class="el__mid"><span class="el__row-title">${title}</span><span class="el__row-sub">${sub}</span></span>
    <span class="el__actions">${actions}</span>
  </div>`;
}

function dueState(loan) {
  if (loan.returned_on) return [loan.fine ? `fine ${rupees(loan.fine)}` : "on time", loan.fine ? "warn" : "ok", ""];
  if (loan.days_overdue) return [`${loan.days_overdue}d late · ${rupees(loan.accruing)}`, "err", "err"];
  const days = Math.round((new Date(loan.due_on + "T00:00") - new Date().setHours(0, 0, 0, 0)) / 86400000);
  return [days === 0 ? "due today" : `due in ${days}d`, days <= 2 ? "warn" : "ok", days <= 2 ? "warn" : "ok"];
}

function loanRow(loan, { showMember = true } = {}) {
  const [label, tone, strip] = dueState(loan);
  const who = showMember ? `${esc(loan.member.name)} · ${esc(loan.member.card_no)} · ` : "";
  const when = loan.returned_on
    ? `returned ${shortDate(loan.returned_on)}`
    : `issued ${shortDate(loan.issued_on)} · due ${shortDate(loan.due_on)}${loan.renewals ? " · renewed" : ""}`;
  return row({
    lead: thumb(loan.book),
    title: `<button type="button" class="link" data-open-book="${loan.book.id}">${esc(loan.book.title)}</button>`,
    sub: `${who}${esc(loan.barcode)} · ${when}`,
    actions: pill(label, tone) + (loan.returned_on ? "" : `<button type="button" data-return="${esc(loan.barcode)}">Check in</button>`),
    tone: strip,
  });
}

/* ---------------- modal + command palette ---------------- */
let modalCleanup = null;
function openModal(html, { wide = false } = {}) {
  modalCleanup?.();
  modalCleanup = null;
  $("#modal-body").innerHTML = html;
  $(".desk-modal").classList.toggle("desk-modal--wide", wide);
  $(".desk-modal__x").hidden = gate;
  $("#modal").hidden = false;
  $("#modal-body").querySelector("input:not([type=radio]), select, textarea, button")?.focus();
}
function closeModal() {
  if (gate) return;
  modalCleanup?.();
  modalCleanup = null;
  $("#modal").hidden = true;
}

function openCmd() {
  if (gate) return;
  $("#cmd").hidden = false;
  $("#cmd-input").value = "";
  renderCmd("");
  $("#cmd-input").focus();
}
function closeCmd() {
  $("#cmd").hidden = true;
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close-modal]")) closeModal();
  if (e.target.closest("[data-close-cmd]")) closeCmd();
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openCmd();
  } else if (e.key === "Escape") {
    if (!$("#cmd").hidden) closeCmd();
    else closeModal();
  }
});
$("#cmd-open").addEventListener("click", openCmd);

const QUICK = [
  ["circulation", "ph-barcode", "Issue or return a book"],
  ["add-book", "ph-plus", "Add a title to the catalogue"],
  ["add-member", "ph-user-plus", "Register a member"],
  ["fines", "ph-coins", "Collect fines"],
];

async function renderCmd(q) {
  const list = $("#cmd-results");
  q = q.trim();
  if (!q) {
    list.innerHTML = QUICK.map(([act, icon, text]) => `<li><button type="button" class="hot-overlay__hit" data-act="${act}"><i class="ph ${icon}"></i> ${text}</button></li>`).join("");
    return;
  }
  const hits = [];
  if (/^SM\d{3,}$/i.test(q)) hits.push(`<li><button type="button" class="hot-overlay__hit" data-copy="${esc(q.toUpperCase())}"><i class="ph ph-barcode"></i> Scan copy ${esc(q.toUpperCase())}</button></li>`);
  if (/^(LIB|STAFF)\d+$/i.test(q)) hits.push(`<li><button type="button" class="hot-overlay__hit" data-card="${esc(q.toUpperCase())}"><i class="ph ph-identification-card"></i> Open card ${esc(q.toUpperCase())}</button></li>`);
  const [books, members] = await Promise.all([
    api(`/api/books?q=${encodeURIComponent(q)}&limit=5`).catch(() => ({ items: [] })),
    api(`/api/desk/members?q=${encodeURIComponent(q)}&limit=5`).catch(() => []),
  ]);
  if ($("#cmd-input").value.trim() !== q) return; // a newer query is on its way
  for (const b of books.items)
    hits.push(`<li><button type="button" class="hot-overlay__hit" data-open-book="${b.id}"><i class="ph ph-book"></i> ${esc(b.title)} <small>· ${esc(b.author)} · ${b.available}/${b.copies} on shelf</small></button></li>`);
  for (const m of members)
    hits.push(`<li><button type="button" class="hot-overlay__hit" data-card="${esc(m.card_no)}"><i class="ph ph-user"></i> ${esc(m.name)} <small>· ${esc(m.card_no)} · ${esc(m.label)}</small></button></li>`);
  list.innerHTML = hits.join("") || `<li class="desk-empty">Nothing matches “${esc(q)}”.</li>`;
}
$("#cmd-input").addEventListener("input", debounce((e) => renderCmd(e.target.value), 200));
$("#cmd-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#cmd-results button")?.click();
});
$("#cmd-results").addEventListener("click", (e) => {
  const hit = e.target.closest("button");
  if (!hit) return;
  closeCmd();
  const act = hit.dataset.act;
  if (act === "add-book") return addBook();
  if (act === "add-member") return addMember();
  if (act) return (location.hash = act);
});

/* ---------------- global actions (rows, modals, palette) ---------------- */
document.addEventListener("click", (e) => {
  const t = e.target;
  const book = t.closest("[data-open-book]");
  const card = t.closest("[data-card]");
  const copy = t.closest("[data-copy]");
  const ret = t.closest("[data-return]");
  const collect = t.closest("[data-collect]");
  if (book) {
    closeCmd();
    return openBook(book.dataset.openBook);
  }
  if (card) {
    closeCmd();
    return openMember(card.dataset.card);
  }
  if (copy) {
    closeCmd();
    return openCopy(copy.dataset.copy);
  }
  if (ret)
    return attempt(async () => {
      const loan = await api("/api/desk/return", { method: "POST", body: { barcode: ret.dataset.return } });
      announceReturn(loan);
      refreshVisible();
    }, ret);
  if (collect)
    return attempt(async () => {
      const fine = await api(`/api/desk/fines/${collect.dataset.collect}/pay`, { method: "POST" });
      toast(`Collected ${rupees(fine.amount)} from ${fine.member.name}.`);
      refreshVisible();
    }, collect);
});

function announceReturn(loan) {
  const parts = [`Checked in “${loan.book.title}” from ${loan.member.name}.`];
  if (loan.fine) parts.push(`Fine raised: ${rupees(loan.fine)}.`);
  if (loan.next === "on_hold") parts.push("Copy is now on hold for the next reader.");
  toast(parts.join(" "), loan.fine ? "warn" : "ok");
  logSession(`Returned “${loan.book.title}” · ${loan.member.name}`, loan.book, loan.fine ? `fine ${rupees(loan.fine)}` : "checked in", loan.fine ? "warn" : "ok");
}

function refreshVisible() {
  const view = VIEWS.find((v) => !$(`#view-${v}`).hidden);
  LOADERS[view]?.();
  if (!$("#modal").hidden && $("#modal-body").dataset.reload) reloadModal();
}

function reloadModal() {
  const [kind, key] = $("#modal-body").dataset.reload.split(":");
  ({ book: openBook, member: openMember, copy: openCopy })[kind]?.(key);
}

/* ---------------- routing ---------------- */
const LOADERS = {
  overview: loadOverview,
  circulation: () => $("#issue-form [name=card_no]").focus(),
  loans: loadLoans,
  catalogue: () => loadCatalogue(),
  members: loadMembers,
  reservations: loadReservations,
  fines: loadFines,
};

function route() {
  const view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  closeModal();
  closeCmd();
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  for (const a of $$("#nav a")) {
    const on = a.hash === "#" + view;
    a.classList.toggle("is-active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const section = $(`#view-${view}`);
  $("#view-title").textContent = section.dataset.title;
  $("#view-sub").textContent = section.dataset.sub;
  document.title = `${section.dataset.title} · Shelfmark Desk`;
  if (me) attempt(() => LOADERS[view]());
}
addEventListener("hashchange", route);
$("#refresh").addEventListener("click", (e) => attempt(async () => {
  await LOADERS[VIEWS.find((v) => !$(`#view-${v}`).hidden)]();
  toast("Up to date.");
}, e.currentTarget));

for (const seg of $$("[data-filter]")) {
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest(".segment__btn");
    if (!btn) return;
    $$(".segment__btn", seg).forEach((b) => b.classList.toggle("is-active", b === btn));
    filters[seg.dataset.filter] = btn.dataset.value;
    attempt(() => LOADERS[seg.dataset.filter]());
  });
}

/* ---------------- overview ---------------- */
async function loadOverview() {
  const d = await api("/api/desk/overview");
  const copies = d.copies || 1;
  const pct = (n) => Math.round((100 * (n || 0)) / copies);
  const onShelf = pct(d.items.available);
  const out = pct(d.items.loaned);
  const peak = Math.max(1, ...d.series.flatMap((s) => [s.issued, s.returned]));
  const today = d.series.at(-1);
  const spark = d.series
    .map((s, i) => `${((i * 120) / (d.series.length - 1)).toFixed(1)},${(37 - (s.issued / peak) * 33).toFixed(1)}`)
    .join(" ");

  $("#kpis").innerHTML = `
    <div class="el el--stat el--stat-big"><span class="el__v">${d.titles}</span><span class="el__l">Titles</span></div>
    <div class="el el--stat el--stat-arc"><span class="el__arc" style="background:conic-gradient(var(--cyan) 0 ${onShelf}%, rgba(255,255,255,.08) 0)"></span><span class="el__v">${onShelf}%</span><span class="el__l">On the shelf</span></div>
    <div class="el el--stat el--stat-triple stat-span-2"><div><strong>${d.on_loan}</strong><small>On loan</small></div><div><strong>${d.overdue_count}</strong><small>Overdue</small></div><div><strong>${d.waiting}</strong><small>Queued</small></div></div>
    <div class="el el--stat el--stat-bar el--stat-live"><span class="el__l">On-time returns <strong>${d.on_time_rate}</strong>%</span><span class="el__bar"><i style="width:${d.on_time_rate}%"></i></span></div>
    <div class="el el--stat el--stat-mini"><span class="el__dot"></span><span class="el__v">Desk open</span></div>
    <div class="el el--stat el--stat-spark"><svg viewBox="0 0 120 40" class="el__svg" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="2" points="${spark}" /></svg><span class="el__l">Issued · 14 days</span></div>
    <div class="el el--stat el--stat-delta"><span class="el__v">${rupees(d.fines_collected)}</span><span class="el__delta el__delta--up">last 30 days</span><span class="el__l">Fines collected</span></div>
    <div class="el el--stat el--stat-delta"><span class="el__v">${rupees(d.fines_due)}</span><span class="el__delta el__delta--down">outstanding</span><span class="el__l">Unpaid fines</span></div>
    <div class="el el--stat el--stat-donut"><svg class="el__stat-donut" viewBox="0 0 36 36" aria-hidden="true"><circle class="el__stat-donut__track" cx="18" cy="18" r="15.915" fill="none" /><circle class="el__stat-donut__prog" cx="18" cy="18" r="15.915" fill="none" transform="rotate(-90 18 18)" style="stroke-dasharray:${out} ${100 - out}" /></svg><span class="el__v">${out}%</span><span class="el__l">Copies out</span></div>
    <div class="el el--stat el--stat-delta"><span class="el__v">${d.members}</span><span class="el__delta el__delta--up">+${d.new_members} this month</span><span class="el__l">Members</span></div>
    <div class="el el--stat el--stat-vs"><div class="el__vs" role="img" aria-label="Issued and returned today">
      <div class="el__vs-col"><strong>${today.issued}</strong><small>Out</small></div><span class="el__vs-mid" aria-hidden="true">↔</span>
      <div class="el__vs-col"><strong>${today.returned}</strong><small>In</small></div></div><span class="el__l">Today</span></div>
    <div class="el el--stat el--stat-kpi stat-span-2"><div class="el__kpi-row">
      <div class="el__kpi-cell"><span class="el__kpi-v">${d.copies}</span><span class="el__kpi-l">Copies</span></div>
      <div class="el__kpi-cell"><span class="el__kpi-v">${d.items.on_hold || 0}</span><span class="el__kpi-l">On hold</span></div>
      <div class="el__kpi-cell"><span class="el__kpi-v">${d.items.lost || 0}</span><span class="el__kpi-l">Missing</span></div>
    </div></div>
    <div class="el el--stat el--stat-big"><span class="el__v">${d.holds.length}</span><span class="el__l">Holds ready</span></div>
    <div class="el el--stat el--stat-big"><span class="el__v el__v--text">${esc(d.by_subject[0]?.subject || "—")}</span><span class="el__l">Busiest shelf</span></div>`;

  $("#series").innerHTML = d.series
    .map((s) => `<span class="hot-chart__bar day" title="${shortDate(s.day)}: ${s.issued} issued, ${s.returned} returned">
        <i style="--p:${(s.issued / peak) * 100}%"></i><i class="ret" style="--p:${(s.returned / peak) * 100}%"></i></span>`)
    .join("");
  $("#series-axis").innerHTML = d.series.map((s, i) => `<span>${i % 2 ? "" : shortDate(s.day)}</span>`).join("");

  const top = Math.max(1, ...d.by_subject.map((s) => s.loans));
  $("#by-subject").innerHTML =
    d.by_subject
      .map((s) => `<div class="subject-bar"><span>${esc(s.subject)}</span><span class="el__bar"><i style="width:${(s.loans / top) * 100}%"></i></span><strong>${s.loans}</strong></div>`)
      .join("") || empty("Nothing on loan.");

  $("#overdue-count").textContent = d.overdue_count;
  $("#overdue").innerHTML = d.overdue.map((l) => loanRow(l)).join("") || empty("Nothing overdue. Lovely.");
  $("#holds").innerHTML =
    d.holds
      .map((r) => row({
        lead: thumb(r.book),
        title: `<button type="button" class="link" data-open-book="${r.book.id}">${esc(r.book.title)}</button>`,
        sub: `for <button type="button" class="link" data-card="${esc(r.member.card_no)}">${esc(r.member.name)}</button> · copy ${esc(r.barcode)}`,
        actions: pill(`until ${shortDate(r.hold_until)}`, "cyan"),
      }))
      .join("") || empty("No holds waiting.");
  $("#feed").innerHTML = d.activity
    .map((a) => `<div class="hot-feed__item"><span class="hot-feed__dot ${FEED_DOTS[a.kind] ? "hot-feed__dot--" + FEED_DOTS[a.kind] : ""}"></span><span>${esc(a.message)}</span><time datetime="${a.at}">${timeAgo(a.at)}</time></div>`)
    .join("");
}

/* ---------------- circulation ---------------- */
const issueForm = $("#issue-form");
const returnForm = $("#return-form");

async function previewMember(card) {
  const box = $("#issue-member");
  if (!card) return (box.innerHTML = "");
  try {
    const d = await api(`/api/desk/members/${encodeURIComponent(card)}`);
    const u = d.user;
    const onLoan = d.loans.filter((l) => !l.returned_on).length;
    const late = d.loans.filter((l) => !l.returned_on && l.days_overdue).length;
    box.innerHTML = row({
      lead: avatar(u.name),
      title: esc(u.name),
      sub: `${esc(u.label)} · ${onLoan}/${u.max_books} on loan · ${u.loan_days}-day loans`,
      actions: (u.active ? "" : pill("suspended", "err")) + (d.fines_due ? pill(`${rupees(d.fines_due)} due`, "warn") : "") + (late ? pill(`${late} overdue`, "err") : pill("good standing", "ok")),
    });
  } catch (err) {
    box.innerHTML = `<p class="preview__error">${esc(err.message)}</p>`;
  }
}

async function previewCopy(barcode, box) {
  if (!barcode) return (box.innerHTML = "");
  try {
    const c = await api(`/api/desk/items/${encodeURIComponent(barcode)}`);
    const status = { available: ["on the shelf", "ok"], loaned: ["on loan", "warn"], on_hold: ["on hold", "cyan"], lost: ["missing", "err"] }[c.status];
    let sub = `${esc(c.book.author)} · rack ${esc(c.rack)}`;
    if (c.loan) sub += ` · with ${esc(c.loan.member.name)}, due ${shortDate(c.loan.due_on)}`;
    if (c.hold) sub += ` · held for ${esc(c.hold.member.name)}`;
    const extra = c.loan?.days_overdue ? pill(`${c.loan.days_overdue}d late · ${rupees(c.loan.accruing)}`, "err") : "";
    box.innerHTML = row({ lead: thumb(c.book), title: esc(c.book.title), sub, actions: extra + pill(status[0], status[1]) });
  } catch (err) {
    box.innerHTML = `<p class="preview__error">${esc(err.message)}</p>`;
  }
}

issueForm.card_no.addEventListener("change", (e) => previewMember(e.target.value.trim()));
issueForm.barcode.addEventListener("change", (e) => previewCopy(e.target.value.trim(), $("#issue-copy")));
returnForm.barcode.addEventListener("change", (e) => previewCopy(e.target.value.trim(), $("#return-copy")));
issueForm.card_no.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault(); // scanners end with Enter: look the member up, then wait for the book
  previewMember(e.target.value.trim());
  issueForm.barcode.focus();
});

issueForm.addEventListener("submit", (e) => {
  e.preventDefault();
  attempt(async () => {
    const body = { card_no: issueForm.card_no.value.trim(), barcode: issueForm.barcode.value.trim() };
    const loan = await api("/api/desk/issue", { method: "POST", body });
    toast(`Issued “${loan.book.title}” to ${loan.member.name}. Due ${shortDate(loan.due_on)}.`);
    logSession(`Issued “${loan.book.title}” · ${loan.member.name}`, loan.book, `due ${shortDate(loan.due_on)}`, "ok");
    issueForm.barcode.value = "";
    $("#issue-copy").innerHTML = "";
    previewMember(body.card_no);
    issueForm.barcode.focus();
  }, $("button.btn--primary", issueForm));
});

returnForm.addEventListener("submit", (e) => {
  e.preventDefault();
  attempt(async () => {
    const loan = await api("/api/desk/return", { method: "POST", body: { barcode: returnForm.barcode.value.trim() } });
    announceReturn(loan);
    returnForm.reset();
    $("#return-copy").innerHTML = "";
    returnForm.barcode.focus();
  }, $("button.btn--secondary", returnForm));
});

const sessionLog = [];
function logSession(text, book, label, tone) {
  sessionLog.unshift(row({ lead: thumb(book), title: esc(text), sub: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), actions: pill(label, tone) }));
  $("#session-log").innerHTML = sessionLog.slice(0, 12).join("");
}

// Camera scanning where the browser ships a barcode detector; USB scanners work everywhere as keyboards.
if ("BarcodeDetector" in window) $$(".scan").forEach((b) => (b.hidden = false));
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-scan]");
  if (btn) scanInto(btn.closest("form")[btn.dataset.scan]);
});

async function scanInto(input) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch {
    return toast("Camera unavailable. Type or scan the code instead.", "error");
  }
  openModal(`<h3 id="modal-title">Scan a barcode</h3><p class="sec__hint">Hold the code steady in front of the camera.</p><video class="scan-video" autoplay playsinline muted></video>`);
  const video = $(".scan-video");
  video.srcObject = stream;
  const detector = new BarcodeDetector({ formats: ["code_128", "ean_13", "qr_code"] });
  let live = true;
  modalCleanup = () => {
    live = false;
    stream.getTracks().forEach((t) => t.stop());
  };
  while (live) {
    const [code] = await detector.detect(video).catch(() => []);
    if (code) {
      input.value = code.rawValue;
      closeModal();
      input.dispatchEvent(new Event("change"));
      input.focus();
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ---------------- loans ---------------- */
async function loadLoans() {
  const q = $("#loans-q").value.trim();
  const loans = await api(`/api/desk/loans?status=${filters.loans}&q=${encodeURIComponent(q)}`);
  $("#loans").innerHTML = loans.map((l) => loanRow(l)).join("") || empty("No loans match.");
}
$("#loans-q").addEventListener("input", debounce(() => attempt(loadLoans)));

/* ---------------- catalogue ---------------- */
let catOffset = 0;
async function loadCatalogue(append = false) {
  catOffset = append ? catOffset + 30 : 0;
  const params = new URLSearchParams({ q: $("#cat-q").value.trim(), subject: $("#cat-subject").value, limit: 30, offset: catOffset });
  const data = await api(`/api/books?${params}`);
  const html = data.items
    .map((b) => row({
      lead: thumb(b),
      title: `<button type="button" class="link" data-open-book="${b.id}">${esc(b.title)}</button>`,
      sub: `${esc(b.author)} · ${esc(b.subject)} · ${b.year ?? "—"} · ISBN ${esc(b.isbn)}`,
      actions: (b.queue ? pill(`${b.queue} queued`, "cyan") : "") + pill(`${b.available}/${b.copies} on shelf`, b.available ? "ok" : "err") + `<button type="button" data-open-book="${b.id}">Open</button>`,
    }))
    .join("");
  $("#catalogue").innerHTML = append ? $("#catalogue").innerHTML + html : html || empty("No titles match.");
  $("#cat-more").hidden = catOffset + 30 >= data.total;
}
$("#cat-q").addEventListener("input", debounce(() => attempt(() => loadCatalogue())));
$("#cat-subject").addEventListener("change", () => attempt(() => loadCatalogue()));
$("#cat-more").addEventListener("click", (e) => attempt(() => loadCatalogue(true), e.currentTarget));
$("#add-book").addEventListener("click", () => addBook());

const COPY_STATUS = { available: ["on the shelf", "ok"], loaned: ["on loan", "warn"], on_hold: ["on hold", "cyan"], lost: ["missing", "err"] };

async function openBook(id) {
  const b = await api(`/api/books/${id}`).catch((e) => toast(e.message, "error"));
  if (!b) return;
  const rack = b.items[0]?.rack || "";
  openModal(`
    <div class="book-head">
      <span class="book-head__cover cover-thumb" ${b.cover_id ? `style="background-image:url('${coverUrl(b.cover_id)}')"` : ""}></span>
      <div>
        <span class="chip chip--outline">${esc(b.subject)}</span>
        <h3 id="modal-title">${esc(b.title)}</h3>
        <p class="sec__hint">${esc(b.author)} · ${b.year ?? "—"} · ${esc(b.publisher || "—")} · ${b.pages ?? "—"} pages · ISBN ${esc(b.isbn)}</p>
        <p class="sec__hint">${b.available}/${b.copies} on the shelf${b.queue ? ` · ${b.queue} member(s) queued` : ""}</p>
      </div>
    </div>
    <h4 class="modal-h">Copies</h4>
    <div class="row-list row-list--tight">${b.items
      .map((i) => {
        const [label, tone] = COPY_STATUS[i.status];
        const action = i.status === "available" ? `<button type="button" data-lost="${esc(i.barcode)}">Mark missing</button>`
          : i.status === "lost" ? `<button type="button" data-found="${esc(i.barcode)}">Found it</button>`
          : i.status === "loaned" ? `<button type="button" data-return="${esc(i.barcode)}">Check in</button>` : "";
        return row({ lead: `<span class="el__ico copy-ico"><i class="ph ph-barcode"></i></span>`, title: `<button type="button" class="link mono" data-copy="${esc(i.barcode)}">${esc(i.barcode)}</button>`, sub: `rack ${esc(i.rack)}${i.due_on ? ` · due ${shortDate(i.due_on)}` : ""}`, actions: pill(label, tone) + action });
      })
      .join("") || empty("No copies yet.")}</div>
    <form class="inline-form" id="copies-form">
      <label class="field">Add copies<input name="count" type="number" min="1" max="20" value="1" required /></label>
      <label class="field">Rack<input name="rack" value="${esc(rack)}" placeholder="FAN-01A" required maxlength="20" /></label>
      <button class="btn btn--secondary">Add</button>
    </form>
    <details class="row-details edit-details">
      <summary class="row-details__sum el el--row el--row-hit"><span class="el__mid"><span class="el__row-title">Edit details</span><span class="el__row-sub">Title, author, subject, publisher, year, pages, summary</span></span><span class="el__chev row-details__chev">›</span></summary>
      <form class="row-details__body form-grid" id="edit-form">
        <label class="field">Title<input name="title" value="${esc(b.title)}" required maxlength="300" /></label>
        <label class="field">Author<input name="author" value="${esc(b.author)}" required maxlength="200" /></label>
        <label class="field">Subject<input name="subject" value="${esc(b.subject)}" list="subject-list" required maxlength="60" /></label>
        <label class="field">Publisher<input name="publisher" value="${esc(b.publisher || "")}" maxlength="200" /></label>
        <label class="field">Year<input name="year" type="number" value="${b.year ?? ""}" /></label>
        <label class="field">Pages<input name="pages" type="number" min="1" value="${b.pages ?? ""}" /></label>
        <label class="field field--wide">Summary<textarea name="description" rows="4" maxlength="4000">${esc(b.description || "")}</textarea></label>
        <button class="btn btn--primary">Save changes</button>
      </form>
    </details>`, { wide: true });
  $("#modal-body").dataset.reload = `book:${id}`;

  $("#copies-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    attempt(async () => {
      await api(`/api/desk/books/${id}/copies`, { method: "POST", body: { count: Number(f.count.value), rack: f.rack.value } });
      toast(`Added ${f.count.value} cop${f.count.value === "1" ? "y" : "ies"} of “${b.title}”.`);
      openBook(id);
    }, $("button", f));
  });
  $("#edit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(new FormData(f));
    for (const k of ["year", "pages"]) body[k] = body[k] ? Number(body[k]) : null;
    attempt(async () => {
      await api(`/api/desk/books/${id}`, { method: "PATCH", body });
      toast("Saved.");
      openBook(id);
      if (!$("#view-catalogue").hidden) loadCatalogue();
    }, $("button", f));
  });
}

document.addEventListener("click", (e) => {
  const lost = e.target.closest("[data-lost]");
  const found = e.target.closest("[data-found]");
  const target = lost || found;
  if (!target) return;
  attempt(async () => {
    const barcode = target.dataset.lost || target.dataset.found;
    const c = await api(`/api/desk/items/${barcode}`, { method: "PATCH", body: { lost: Boolean(lost) } });
    toast(lost ? `${barcode} marked missing.` : `${barcode} is back (${c.status === "on_hold" ? "held for a queued member" : "on the shelf"}).`);
    refreshVisible();
  }, target);
});

async function openCopy(barcode) {
  const c = await api(`/api/desk/items/${encodeURIComponent(barcode)}`).catch((e) => toast(e.message, "error"));
  if (!c) return;
  const [label, tone] = COPY_STATUS[c.status];
  openModal(`
    <div class="book-head">
      <span class="book-head__cover cover-thumb" ${c.book.cover_id ? `style="background-image:url('${coverUrl(c.book.cover_id)}')"` : ""}></span>
      <div>
        <span class="chip chip--outline mono">${esc(c.barcode)}</span>
        <h3 id="modal-title">${esc(c.book.title)}</h3>
        <p class="sec__hint">${esc(c.book.author)} · rack ${esc(c.rack)}</p>
        <p>${pill(label, tone)}</p>
      </div>
    </div>
    ${c.loan ? `<h4 class="modal-h">Current loan</h4><div class="row-list">${loanRow(c.loan)}</div>` : ""}
    ${c.hold ? `<h4 class="modal-h">Held for</h4><div class="row-list">${row({ lead: avatar(c.hold.member.name), title: `<button type="button" class="link" data-card="${esc(c.hold.member.card_no)}">${esc(c.hold.member.name)}</button>`, sub: `until ${shortDate(c.hold.hold_until)}`, actions: pill("ready", "cyan") })}</div>` : ""}
    <div class="modal-actions">
      <button type="button" class="btn btn--ghost" data-open-book="${c.book.id}">Open title</button>
      ${c.status === "available" ? `<button type="button" class="btn btn--primary" data-issue-copy="${esc(c.barcode)}">Issue this copy</button><button type="button" class="btn btn--danger" data-lost="${esc(c.barcode)}">Mark missing</button>` : ""}
      ${c.status === "lost" ? `<button type="button" class="btn btn--secondary" data-found="${esc(c.barcode)}">Found it</button>` : ""}
    </div>`);
  $("#modal-body").dataset.reload = `copy:${barcode}`;
}

document.addEventListener("click", (e) => {
  const issue = e.target.closest("[data-issue-copy], [data-issue-card]");
  if (!issue) return;
  closeModal();
  location.hash = "circulation";
  if (issue.dataset.issueCopy) {
    issueForm.barcode.value = issue.dataset.issueCopy;
    previewCopy(issue.dataset.issueCopy, $("#issue-copy"));
    issueForm.card_no.focus();
  } else {
    issueForm.card_no.value = issue.dataset.issueCard;
    previewMember(issue.dataset.issueCard);
    issueForm.barcode.focus();
  }
});

function addBook() {
  openModal(`
    <h3 id="modal-title">Add a title</h3>
    <p class="sec__hint">Type an ISBN and look it up on Open Library, or fill the details in yourself.</p>
    <form class="form-grid" id="book-form">
      <label class="field field--wide">ISBN<span class="field__row"><input name="isbn" required pattern="\\d{9}[\\dXx]|\\d{13}" placeholder="9780132350884" /><button type="button" class="btn btn--secondary" id="lookup">Look up</button></span></label>
      <label class="field field--wide">Title<input name="title" required maxlength="300" /></label>
      <label class="field">Author<input name="author" required maxlength="200" /></label>
      <label class="field">Subject<input name="subject" list="subject-list" required maxlength="60" /></label>
      <label class="field">Publisher<input name="publisher" maxlength="200" /></label>
      <label class="field">Year<input name="year" type="number" /></label>
      <label class="field">Pages<input name="pages" type="number" min="1" /></label>
      <label class="field">Copies<input name="copies" type="number" min="1" max="20" value="1" required /></label>
      <label class="field">Rack<input name="rack" required maxlength="20" placeholder="PRG-05A" /></label>
      <label class="field field--wide">Summary<textarea name="description" rows="3" maxlength="4000"></textarea></label>
      <input type="hidden" name="cover_id" />
      <button class="btn btn--primary">Add to catalogue</button>
    </form>`, { wide: true });
  const f = $("#book-form");
  $("#lookup").addEventListener("click", (e) => attempt(async () => {
    const isbn = f.isbn.value.replace(/[^0-9Xx]/g, "");
    const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`).then((r) => r.json());
    const data = res[`ISBN:${isbn}`];
    if (!data) throw new Error("Open Library doesn't know that ISBN. Fill the details in by hand.");
    f.isbn.value = isbn;
    f.title.value = data.title || "";
    f.author.value = data.authors?.map((a) => a.name).join(", ") || "";
    f.publisher.value = data.publishers?.[0]?.name || "";
    f.year.value = (data.publish_date || "").match(/\d{4}/)?.[0] || "";
    f.pages.value = data.number_of_pages || "";
    f.cover_id.value = (data.cover?.medium || "").match(/\/id\/(\d+)/)?.[1] || "";
    f.subject.value ||= subjects.find((s) => data.subjects?.some((x) => x.name.toLowerCase().includes(s.toLowerCase()))) || "";
    toast(`Found “${f.title.value}”.`);
  }, e.currentTarget));
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    body.isbn = body.isbn.toUpperCase();
    for (const k of ["year", "pages", "copies", "cover_id"]) body[k] = body[k] ? Number(body[k]) : null;
    attempt(async () => {
      const book = await api("/api/desk/books", { method: "POST", body });
      toast(`Catalogued “${book.title}” with ${book.copies} cop${book.copies === 1 ? "y" : "ies"}.`);
      openBook(book.id);
      if (!$("#view-catalogue").hidden) loadCatalogue();
    }, $("button.btn--primary", f));
  });
}

/* ---------------- members ---------------- */
async function loadMembers() {
  const members = await api(`/api/desk/members?q=${encodeURIComponent($("#mem-q").value.trim())}`);
  $("#members").innerHTML =
    members
      .map((m) => row({
        lead: avatar(m.name),
        title: `<button type="button" class="link" data-card="${esc(m.card_no)}">${esc(m.name)}</button>`,
        sub: `${esc(m.label)} · ${esc(m.card_no)} · ${esc(m.email)}`,
        actions:
          (m.active ? "" : pill("suspended", "err")) +
          (m.overdue ? pill(`${m.overdue} overdue`, "err") : "") +
          (m.fines_due ? pill(`${rupees(m.fines_due)} due`, "warn") : "") +
          pill(`${m.on_loan}/${m.max_books} on loan`, m.on_loan ? "cyan" : "") +
          `<button type="button" data-card="${esc(m.card_no)}">Open</button>`,
        tone: m.active ? "" : "err",
      }))
      .join("") || empty("No members match.");
}
$("#mem-q").addEventListener("input", debounce(() => attempt(loadMembers)));
$("#add-member").addEventListener("click", () => addMember());

async function openMember(card) {
  const d = await api(`/api/desk/members/${encodeURIComponent(card)}`).catch((e) => toast(e.message, "error"));
  if (!d) return;
  const u = d.user;
  const active = d.loans.filter((l) => !l.returned_on);
  const late = active.filter((l) => l.days_overdue).length;
  const open = d.reservations.filter((r) => ["waiting", "ready"].includes(r.status));
  const unpaid = d.fines.filter((f) => !f.paid_on);
  openModal(`
    <div class="card-pro card-pro--stats member-pro">
      <div class="card-pro__stats-head">
        ${avatar(u.name)}
        <div><p class="card-pro__name" id="modal-title">${esc(u.name)}</p><p class="card-pro__role">${esc(u.label)} · ${esc(u.email)} · joined ${shortDate(u.joined_on)}</p></div>
      </div>
      <dl class="card-pro__stats">
        <div><dt>On loan</dt><dd>${active.length}/${u.max_books}</dd></div>
        <div><dt>Overdue</dt><dd>${late}</dd></div>
        <div><dt>Fines due</dt><dd>${rupees(d.fines_due)}</dd></div>
      </dl>
      <div class="member-pro__foot">
        <div class="card-code"><svg id="member-code" role="img" aria-label="Card ${esc(u.card_no)}"></svg></div>
        <label class="switch"><input type="checkbox" id="member-active" ${u.active ? "checked" : ""} /><span class="switch__track" aria-hidden="true"></span><span>${u.active ? "Active" : "Suspended"}</span></label>
      </div>
    </div>
    <div class="modal-actions"><button type="button" class="btn btn--primary" data-issue-card="${esc(u.card_no)}">Issue a book to ${esc(u.name.split(" ")[0])}</button></div>
    <h4 class="modal-h">On loan</h4><div class="row-list row-list--tight">${active.map((l) => loanRow(l, { showMember: false })).join("") || empty("Nothing on loan.")}</div>
    ${unpaid.length ? `<h4 class="modal-h">Unpaid fines</h4><div class="row-list row-list--tight">${unpaid.map(fineRow).join("")}</div>` : ""}
    ${open.length ? `<h4 class="modal-h">Reservations</h4><div class="row-list row-list--tight">${open.map(reservationRow).join("")}</div>` : ""}`, { wide: true });
  $("#modal-body").dataset.reload = `member:${card}`;
  JsBarcode("#member-code", u.card_no, { format: "CODE128", height: 44, fontSize: 13, margin: 0, background: "transparent", lineColor: "#e2e8f0" });
  $("#member-active").addEventListener("change", (e) =>
    attempt(async () => {
      await api(`/api/desk/members/${u.id}`, { method: "PATCH", body: { active: e.target.checked } });
      toast(`${u.name} ${e.target.checked ? "reinstated" : "suspended"}.`);
      openMember(card);
      if (!$("#view-members").hidden) loadMembers();
    })
  );
}

function addMember() {
  openModal(`
    <h3 id="modal-title">Register a member</h3>
    <form class="form-grid" id="member-form">
      <div class="frm-radios field--wide" role="radiogroup" aria-label="Membership">
        <label class="radio-card"><input type="radio" name="kind" value="student" checked /><span class="radio-card__ui"><i class="ph ph-student"></i><span class="radio-card__t">Student</span><span class="radio-card__d">5 books · 10 days · ₹5/day</span></span></label>
        <label class="radio-card"><input type="radio" name="kind" value="faculty" /><span class="radio-card__ui"><i class="ph ph-chalkboard-teacher"></i><span class="radio-card__t">Faculty</span><span class="radio-card__d">10 books · 30 days · ₹2/day</span></span></label>
      </div>
      <label class="field field--wide">Full name<input name="name" required minlength="2" maxlength="120" /></label>
      <label class="field">Email<input name="email" type="email" required maxlength="160" /></label>
      <label class="field">Starting password<input name="password" required minlength="8" maxlength="128" value="welcome-${Math.random().toString(36).slice(2, 7)}" /></label>
      <button class="btn btn--primary">Issue library card</button>
    </form>`, { wide: true });
  $("#member-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    attempt(async () => {
      const m = await api("/api/desk/members", { method: "POST", body: Object.fromEntries(new FormData(f)) });
      toast(`Registered ${m.name}. Card ${m.card_no}.`);
      openMember(m.card_no);
      if (!$("#view-members").hidden) loadMembers();
    }, $("button", f));
  });
}

/* ---------------- reservations ---------------- */
function reservationRow(r) {
  const status = r.status === "waiting" ? pill(`#${r.position} in queue`, "cyan")
    : r.status === "ready" ? pill(`ready until ${shortDate(r.hold_until)}`, "ok")
    : pill(r.status, r.status === "fulfilled" ? "ok" : "");
  return row({
    lead: thumb(r.book),
    title: `<button type="button" class="link" data-open-book="${r.book.id}">${esc(r.book.title)}</button>`,
    sub: `<button type="button" class="link" data-card="${esc(r.member.card_no)}">${esc(r.member.name)}</button> · reserved ${shortDate(r.created_at)}${r.barcode ? ` · copy ${esc(r.barcode)}` : ""}`,
    actions: status,
  });
}

async function loadReservations() {
  const list = await api(`/api/desk/reservations?status=${filters.reservations}`);
  $("#reservations").innerHTML = list.map(reservationRow).join("") || empty("Nothing here right now.");
}

/* ---------------- fines ---------------- */
function fineRow(f) {
  return row({
    lead: avatar(f.member.name),
    title: `<button type="button" class="link" data-card="${esc(f.member.card_no)}">${esc(f.member.name)}</button> · ${esc(f.book.title)}`,
    sub: `${f.days} day(s) late · raised ${shortDate(f.created_on)}${f.paid_on ? ` · paid ${shortDate(f.paid_on)}` : ""}`,
    actions: pill(rupees(f.amount), f.paid_on ? "ok" : "warn") + (f.paid_on ? "" : `<button type="button" data-collect="${f.id}">Collect</button>`),
    tone: f.paid_on ? "" : "warn",
  });
}

async function loadFines() {
  const list = await api(`/api/desk/fines?status=${filters.fines}`);
  $("#fines").innerHTML = list.map(fineRow).join("") || empty(filters.fines === "unpaid" ? "No unpaid fines." : "No fines collected yet.");
}

/* ---------------- sign-in gate ---------------- */
function showGate() {
  gate = true;
  openModal(`
    <h3 id="modal-title">Librarian sign in</h3>
    <p class="sec__hint">The desk is for library staff. Members can use the <a href="/catalog">catalog</a>.</p>
    <form class="form-grid" id="gate-form">
      <label class="field field--wide">Email<input name="email" type="email" autocomplete="username" required value="librarian@shelfmark.test" /></label>
      <label class="field field--wide">Password<input name="password" type="password" autocomplete="current-password" required /></label>
      <p class="preview__error field--wide" id="gate-error" role="alert"></p>
      <button class="btn btn--primary">Open the desk</button>
    </form>
    <p class="sec__hint">Demo: <code>librarian@shelfmark.test</code> / <code>shelfmark</code></p>`);
  $("#gate-form").password.focus();
  $("#gate-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const user = await api("/api/auth/login", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
      if (user.role !== "librarian") {
        await api("/api/auth/logout", { method: "POST" });
        throw new Error("That's a member account. Members use the catalog.");
      }
      gate = false;
      closeModal();
      boot();
    } catch (err) {
      $("#gate-error").textContent = err.message;
    }
  });
}

function renderMe() {
  $("#desk-me").innerHTML = me
    ? `${avatar(me.name)}<span><strong>${esc(me.name)}</strong><small>${esc(me.label)} · ${esc(me.card_no)}</small></span>
       <button type="button" class="btn btn--icon-ghost" id="sign-out" aria-label="Sign out" title="Sign out"><i class="ph ph-sign-out"></i></button>`
    : "";
  $("#sign-out")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    me = null;
    renderMe();
    showGate();
  });
}

async function boot() {
  me = await api("/api/auth/me").catch(() => null);
  renderMe();
  if (me?.role !== "librarian") return showGate();
  if (!subjects.length) {
    const stats = await api("/api/stats");
    subjects = stats.subjects.map((s) => s.name);
    $("#cat-subject").insertAdjacentHTML("beforeend", subjects.map((s) => `<option>${esc(s)}</option>`).join(""));
    document.body.insertAdjacentHTML("beforeend", `<datalist id="subject-list">${subjects.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>`);
  }
  route();
}

route();
boot();
