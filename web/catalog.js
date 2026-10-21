// Shelfmark for members: search the stacks, open a title, reserve or renew, and keep an eye on your own shelf.
const PAGE = 24;
const COPY = { available: ["on the shelf", "ok"], loaned: ["on loan", ""], on_hold: ["on hold", "warn"], lost: ["missing", "err"] };
const NOTICE_ICONS = {
  reservation_ready: "ph-bell-ringing", overdue: "ph-warning", fine: "ph-coins",
  issued: "ph-book-open-text", renewed: "ph-arrows-clockwise", hold_expired: "ph-hourglass-medium",
};
const form = $("#search-form");
let me = null; // the signed-in member
let account = null; // their loans, reservations, fines and notices
let offset = 0;

/* ---------- views ---------- */
const onShelf = () => location.hash === "#shelf";

function route() {
  $("#view-browse").hidden = onShelf();
  $("#view-shelf").hidden = !onShelf();
  for (const tab of $$("#tabs .tab")) {
    if (tab.hash === (onShelf() ? "#shelf" : "#browse")) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  slide($("#tabs"));
  renderHeading();
  scrollTo({ top: 0 });
}
addEventListener("hashchange", () => {
  if (location.hash === "#account" || location.hash === "#join") return openAccount(location.hash.slice(1));
  route();
});

function renderHeading() {
  if (!onShelf()) {
    $("#kicker").textContent = "The catalogue";
    $("#heading").innerHTML = "Find your next <em>book</em>.";
  } else {
    $("#kicker").textContent = me ? `${me.label} member · card ${me.card_no}` : "Members";
    $("#heading").innerHTML = "My <em>shelf</em>.";
  }
}

/* ---------- search ---------- */
async function search(append = false) {
  offset = append ? offset + PAGE : 0;
  const params = new URLSearchParams([...new FormData(form)].filter(([, value]) => String(value).trim()));
  params.set("limit", PAGE);
  params.set("offset", offset);
  const data = await api(`/api/books?${params}`);
  const cards = data.items.map(bookCard).join("");
  if (append) $("#results").insertAdjacentHTML("beforeend", cards);
  else $("#results").innerHTML = cards || empty("Nothing on the shelves matches that. Try fewer words, another subject or any year.");
  $("#count").textContent = `${data.total} ${data.total === 1 ? "title" : "titles"}`;
  $("#more").hidden = offset + PAGE >= data.total;
}

const searchNow = () => attempt(() => search());
form.addEventListener("submit", (e) => {
  e.preventDefault();
  searchNow();
});
$("#more").addEventListener("click", (e) => attempt(() => search(true), e.currentTarget));

// Year boxes wait for a whole year (or nothing) so typing "1" doesn't search for the year 1.
const halfTyped = (input) => input.name.startsWith("year_") && input.value !== "" && input.value.replace("-", "").length < 3;
form.addEventListener("input", debounce((e) => {
  if (e.target.name?.startsWith("year_")) showYears();
  if (!halfTyped(e.target)) searchNow();
}));

function markSubject(subject) {
  form.elements.subject.value = subject;
  for (const chip of $$("#subjects .chip")) chip.setAttribute("aria-pressed", chip.dataset.subject === subject);
}

/* ---------- published: presets plus a typed range ---------- */
function showYears() {
  const [from, to] = [form.elements.year_from.value, form.elements.year_to.value];
  $("#published-label").textContent =
    from && to ? `${from} – ${to}` : from ? `From ${from}` : to ? `Up to ${to}` : "Any year";
  for (const option of $$("[data-years]")) {
    const [a, b] = option.dataset.years.split(":").map((v) => (v === "-" ? "" : v));
    option.setAttribute("aria-pressed", (a ?? "") === from && (b ?? "") === to);
  }
}

$("#published").addEventListener("click", (e) => {
  const option = e.target.closest("[data-years]");
  if (!option) return;
  const [from = "", to = ""] = option.dataset.years.split(":").map((v) => (v === "-" ? "" : v));
  form.elements.year_from.value = from;
  form.elements.year_to.value = to;
  showYears();
  $("#published").open = false;
  searchNow();
});

/* ---------- a title ---------- */
async function openBook(id) {
  const book = await api(`/api/books/${id}`).catch((e) => void toast(e.message, "error"));
  if (!book) return;
  const body = $("#book-body");
  body.dataset.id = book.id;
  fill(body, `
    <div class="book-detail">
      <div class="book-detail__cover">${coverImg(book, "L")}</div>
      <div class="book-detail__head">
        ${tag(book.subject)}
        <h2 class="sheet__h" id="book-title">${esc(book.title)}</h2>
        <p class="muted">${esc(book.author)}${book.year ? ` · ${book.year}` : ""}</p>
      </div>
      <div class="book-detail__body">
        <p class="book-detail__desc">${esc(book.description || "No summary yet.")}</p>
        <dl class="facts">
          <div><dt>Publisher</dt><dd>${esc(book.publisher || "—")}</dd></div>
          <div><dt>Pages</dt><dd>${book.pages ?? "—"}</dd></div>
          <div><dt>ISBN</dt><dd class="mono">${esc(book.isbn)}</dd></div>
        </dl>
        <div class="actions-row">${bookActions(book)}</div>
      </div>
    </div>
    <h3 class="sheet__sub">Copies <small>${book.available} of ${book.copies} on the shelf</small></h3>
    <div class="list">${book.items.map(copyRow).join("") || empty("No copies catalogued yet.")}</div>`);
  openSheet($("#book-sheet"));
}

function copyRow(item) {
  const [label, tone] = COPY[item.status];
  return row({
    lead: '<span class="glyph"><i class="ph ph-barcode"></i></span>',
    title: `<span class="mono">${esc(item.barcode)}</span>`,
    sub: `Rack ${esc(item.rack)}${item.due_on ? ` · due back ${shortDate(item.due_on)}` : ""}`,
    side: tag(label, tone),
  });
}

function bookActions(book) {
  const shelf = book.items.find((i) => i.status === "available");
  const rack = shelf ? `<span class="note"><i class="ph ph-map-pin"></i>Rack ${esc(shelf.rack)}</span>` : "";
  if (!account) {
    return shelf
      ? `${rack}<span class="muted">Borrow it at the desk with your library card.</span>`
      : '<button type="button" class="btn" data-signin>Sign in to reserve</button>';
  }
  const loan = account.loans.find((l) => !l.returned_on && l.book.id === book.id);
  if (loan) return tag(`on your shelf · due ${shortDate(loan.due_on)}`, loan.days_overdue ? "err" : "ok");
  const held = account.reservations.find((r) => r.book.id === book.id && (r.status === "waiting" || r.status === "ready"));
  if (held?.status === "ready") {
    return `${tag(`ready at the desk until ${shortDate(held.hold_until)}`, "ok")}
      <button type="button" class="btn btn--sm btn--ghost" data-cancel="${held.id}">Cancel hold</button>`;
  }
  if (held) {
    return `${tag(`#${held.position} in the queue`)}
      <button type="button" class="btn btn--sm btn--ghost" data-cancel="${held.id}">Leave the queue</button>`;
  }
  if (shelf) return `${rack}<span class="muted">Pick it up at the desk with card ${esc(me.card_no)}.</span>`;
  return `<button type="button" class="btn" data-reserve="${book.id}"><i class="ph ph-bookmark-simple"></i>Reserve</button>
    <span class="muted">${book.queue ? `${book.queue} ahead of you` : "You'd be first in line"}</span>`;
}

/* ---------- who's signed in ---------- */
async function refresh(animate = true) {
  me = await api("/api/auth/me").catch(() => null);
  account = me ? await api("/api/me").catch(() => null) : null;
  renderWho();
  renderStrip();
  renderShelf(animate);
  renderHeading();
}

// Coming back to the tab picks up anything the desk did meanwhile (a loan issued, a hold ready).
document.addEventListener("visibilitychange", () => document.hidden || refresh(false));

function renderWho() {
  const badge = $("#shelf-badge");
  badge.hidden = !account?.unread;
  badge.textContent = account?.unread || "";
  slide($("#tabs"));
  if (!me) return ($("#who").innerHTML = '<button type="button" class="btn btn--sm" data-signin>Sign in</button>');
  $("#who").innerHTML = `
    <a class="user" href="#shelf">${avatar(me.name)}<span>${esc(firstName(me.name))}</span></a>
    <button type="button" class="icon-btn" data-signout aria-label="Sign out" title="Sign out"><i class="ph ph-sign-out"></i></button>`;
}

// One line above the search when something needs the member's attention.
function renderStrip() {
  const ready = account?.reservations.find((r) => r.status === "ready");
  const late = account ? account.loans.filter((l) => !l.returned_on && l.days_overdue > 0) : [];
  const lines = [];
  if (ready) lines.push(`<b>“${esc(ready.book.title)}”</b> is waiting for you at the desk until ${shortDate(ready.hold_until)}.`);
  if (late.length) {
    const owed = rupees(late.reduce((sum, l) => sum + l.accruing, 0));
    lines.push(`<b>${late.length} ${late.length === 1 ? "book is" : "books are"} overdue</b>, ${owed} in late fees so far.`);
  }
  $("#strip").innerHTML = lines.length
    ? `<div class="strip"><span class="strip__icon"><i class="ph ${ready ? "ph-bell-ringing" : "ph-warning"}"></i></span>
        <p class="strip__text">${lines.join(" ")}</p><a class="btn btn--sm btn--light" href="#shelf">My shelf</a></div>`
    : "";
}

/* ---------- my shelf ---------- */
const bookLink = (b) => `<a class="link" href="?book=${b.id}" data-book="${b.id}">${esc(b.title)}</a>`;

const section = (icon, title, hint, body) => `
  <section class="card">
    <div class="card__head"><h2 class="card__title"><i class="ph ${icon}"></i>${title}</h2>${hint ? `<span class="card__hint">${hint}</span>` : ""}</div>
    <div class="list">${body}</div>
  </section>`;

function loanRow(l) {
  const late = l.days_overdue > 0;
  const days = Math.round((new Date(l.due_on + "T00:00") - new Date().setHours(0, 0, 0, 0)) / 864e5);
  const status = late
    ? tag(`${l.days_overdue}d late · ${rupees(l.accruing)}`, "err")
    : tag(days === 0 ? "due today" : `due ${shortDate(l.due_on)}`, days <= 2 ? "warn" : "");
  return row({
    lead: thumb(l.book),
    title: bookLink(l.book),
    sub: `Borrowed ${shortDate(l.issued_on)}${l.renewals ? " · renewed" : ""}`,
    side: status + (late || l.renewals ? "" : `<button type="button" class="btn btn--sm btn--light" data-renew="${l.id}">Renew</button>`),
  });
}

function reservationRow(r) {
  const ready = r.status === "ready";
  return row({
    lead: thumb(r.book),
    title: bookLink(r.book),
    sub: ready ? `Copy ${esc(r.barcode)} is at the desk` : `Reserved ${shortDate(r.created_at)}`,
    side: (ready ? tag(`ready until ${shortDate(r.hold_until)}`, "ok") : tag(`#${r.position} in queue`)) +
      `<button type="button" class="btn btn--sm btn--ghost" data-cancel="${r.id}">Cancel</button>`,
  });
}

const returnedRow = (l) =>
  row({ lead: thumb(l.book), title: bookLink(l.book), sub: `Returned ${shortDate(l.returned_on)}`, side: l.fine ? tag(`fine ${rupees(l.fine)}`, "warn") : tag("on time", "ok") });

const fineRow = (f) => row({ title: esc(f.book.title), sub: `${f.days} day${f.days === 1 ? "" : "s"} late`, side: tag(rupees(f.amount), "err") });

const noticeRow = (n) => `
  <div class="notice${n.read ? "" : " is-new"}"><i class="ph ${NOTICE_ICONS[n.kind] || "ph-info"}" aria-hidden="true"></i>
    <span>${esc(n.message)}</span><time datetime="${n.created_at}">${timeAgo(n.created_at)}</time></div>`;

function renderShelf(animate = true) {
  const view = $("#view-shelf");
  if (!account) {
    view.innerHTML = `<div class="card prompt"><i class="ph ph-books"></i><h2>Sign in to see your shelf</h2>
      <p class="muted">Your loans and due dates, reservations, fines and notices, all in one place.</p>
      <button type="button" class="btn" data-signin>Sign in</button></div>`;
    return;
  }
  const active = account.loans.filter((l) => !l.returned_on);
  const returned = account.loans.filter((l) => l.returned_on).slice(0, 5);
  const open = account.reservations.filter((r) => r.status === "waiting" || r.status === "ready");
  const unpaid = account.fines.filter((f) => !f.paid_on);
  fill(view, `
    <div class="shelf">
      <div class="shelf__main">
        ${section("ph-book-open", "On loan", `${active.length} of ${me.max_books}`,
          active.map(loanRow).join("") || empty("Nothing on loan. Find something to read in Browse."))}
        ${section("ph-bookmark-simple", "Reservations", open.length ? `${open.length} open` : "",
          open.map(reservationRow).join("") || empty("When every copy of a title is out, reserve it and we'll hold the next one for you."))}
        ${returned.length ? section("ph-clock-counter-clockwise", "Recently returned", "", returned.map(returnedRow).join("")) : ""}
      </div>
      <aside class="shelf__side">
        <section class="tile libcard" aria-label="Library card">
          <div class="libcard__top"><span class="logo"><span class="logo__mark">✦</span>SHELFMARK</span><span class="libcard__kind">${esc(me.label)}</span></div>
          <p class="libcard__name">${esc(me.name)}</p>
          <svg id="card-code" role="img" aria-label="Card number ${esc(me.card_no)}"></svg>
          <div class="libcard__foot"><span>${esc(me.card_no)}</span><span>${me.max_books} books · ${me.loan_days} days</span></div>
        </section>
        <section class="card">
          <div class="card__head"><h2 class="card__title"><i class="ph ph-coins"></i>Fines</h2><span class="card__hint">${rupees(me.fine_per_day)} a day when late</span></div>
          <p class="big-number">${rupees(account.fines_due)}</p>
          <p class="muted">${account.fines_due ? "Settle it at the desk. Unpaid fines pause borrowing." : "All clear."}</p>
          ${unpaid.length ? `<div class="list">${unpaid.map(fineRow).join("")}</div>` : ""}
        </section>
        <section class="card">
          <div class="card__head"><h2 class="card__title"><i class="ph ph-bell"></i>Notices</h2>
            ${account.unread ? '<button type="button" class="btn btn--sm btn--ghost" data-read>Mark all read</button>' : ""}</div>
          <div class="list">${account.notifications.slice(0, 6).map(noticeRow).join("") || empty("No notices yet.")}</div>
        </section>
      </aside>
    </div>`, animate);
  JsBarcode("#card-code", me.card_no, { format: "CODE128", height: 54, margin: 0, displayValue: false, background: "transparent", lineColor: "#f6f0e6" });
}

/* ---------- sign in, join, sign out ---------- */
function showPane(pane) {
  for (const tab of $$("[data-pane]")) tab.setAttribute("aria-pressed", tab.dataset.pane === pane);
  slide($(".sheet__tabs"));
  $("#signin-form").hidden = pane !== "signin";
  $("#join-form").hidden = pane !== "join";
}

function openAccount(pane = "account") {
  if (location.hash === "#account" || location.hash === "#join") history.replaceState(null, "", location.pathname + location.search);
  if (me) return (location.hash = "shelf");
  openSheet($("#account"));
  showPane(pane === "join" ? "join" : "signin");
  $(`#${pane === "join" ? "join" : "signin"}-form input`).focus();
}

$("#account").addEventListener("click", (e) => {
  const pane = e.target.closest("[data-pane]");
  const demo = e.target.closest("[data-demo]");
  if (pane) showPane(pane.dataset.pane);
  if (demo) {
    showPane("signin");
    const f = $("#signin-form");
    f.login.value = demo.dataset.demo;
    f.password.value = "shelfmark";
    f.requestSubmit();
  }
});

for (const f of [$("#signin-form"), $("#join-form")]) {
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const join = f.id === "join-form";
    const button = $("button", f);
    $(".form-error", f).textContent = "";
    button.disabled = true;
    try {
      const user = await api(join ? "/api/auth/register" : "/api/auth/login", { method: "POST", body: Object.fromEntries(new FormData(f)) });
      closeSheet($("#account"));
      f.reset();
      await afterChange();
      toast(join ? `Welcome to Shelfmark! Your card number is ${user.card_no}.` : `Welcome back, ${firstName(user.name)}.`);
    } catch (err) {
      $(".form-error", f).textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

async function signOut() {
  await api("/api/auth/logout", { method: "POST" });
  await afterChange();
  toast("Signed out. See you soon.");
}

async function afterChange() {
  await refresh();
  if ($("#book-sheet").open) await openBook($("#book-body").dataset.id);
}

addEventListener("signedout", () => refresh().then(() => openAccount()));

/* ---------- clicks ---------- */
document.addEventListener("click", (e) => {
  const t = e.target;
  const book = t.closest("[data-book]");
  const subject = t.closest("[data-subject]");
  const reserve = t.closest("[data-reserve]");
  const cancel = t.closest("[data-cancel]");
  const renew = t.closest("[data-renew]");
  const read = t.closest("[data-read]");
  if (book) {
    e.preventDefault();
    openBook(book.dataset.book);
  } else if (subject) {
    markSubject(subject.dataset.subject);
    searchNow();
  } else if (t.closest("[data-signin]")) {
    openAccount();
  } else if (t.closest("[data-signout]")) {
    attempt(signOut);
  } else if (reserve) {
    attempt(async () => {
      const r = await api(`/api/books/${reserve.dataset.reserve}/reserve`, { method: "POST" });
      toast(`Reserved “${r.book.title}”. You're #${r.position} in the queue.`);
      await afterChange();
    }, reserve);
  } else if (cancel) {
    attempt(async () => {
      await api(`/api/reservations/${cancel.dataset.cancel}/cancel`, { method: "POST" });
      toast("Reservation cancelled.");
      await afterChange();
    }, cancel);
  } else if (renew) {
    attempt(async () => {
      const loan = await api(`/api/loans/${renew.dataset.renew}/renew`, { method: "POST" });
      toast(`Renewed “${loan.book.title}”. It's now due ${shortDate(loan.due_on)}.`);
      await afterChange();
    }, renew);
  } else if (read) {
    attempt(async () => {
      await api("/api/me/notifications/read", { method: "POST" });
      await refresh(false);
    }, read);
  }
});

/* ---------- boot ---------- */
(async function boot() {
  // Links can ask for a book (?book=), a subject (?subject=) or the sign-in (#account, #join). Read them once and
  // tidy the address bar, so a reload later doesn't pop the same book open again.
  const params = new URLSearchParams(location.search);
  const wants = location.hash === "#account" || location.hash === "#join" ? location.hash.slice(1) : "";
  history.replaceState(null, "", location.pathname + (wants ? "" : location.hash));
  route();

  let stats;
  try {
    stats = await api("/api/stats");
  } catch {
    return toast("The catalogue is waking up. Refresh in a few seconds.", "error");
  }
  $("#subjects").insertAdjacentHTML(
    "beforeend",
    stats.subjects.map((s) => `<button type="button" class="chip" data-subject="${esc(s.name)}" aria-pressed="false">${esc(s.name)}</button>`).join("")
  );
  $("#years-hint").textContent = `Type a range, like 1950 to 2000. Our books run from ${stats.years.min} to ${stats.years.max}.`;
  if (params.has("subject")) {
    markSubject(params.get("subject"));
    $('#subjects [aria-pressed="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }

  await Promise.all([refresh(), attempt(() => search())]);
  if (params.has("book")) openBook(params.get("book"));
  else if (wants) openAccount(wants);
})();
