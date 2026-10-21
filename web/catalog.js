// Member catalogue: search, book detail, reservations, renewals, notices, reading-room preferences.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const scroller = $("#scroller");

const SUBJECTS = {
  "Fantasy": ["ph-castle-turret", "Maps with <b>dragons in the margins</b>, wizards who <i>should know better</i> and quests that begin with a knock at the door."],
  "Science Fiction": ["ph-rocket-launch", "Futures that <i>already feel like the present</i>: desert planets, <b>thinking machines</b> and the cost of every shortcut."],
  "Mystery": ["ph-detective", "A body in the library, <b>twelve suspects</b> on a snowbound train and a detective who notices <i>the dog that didn't bark</i>."],
  "Romance": ["ph-heart-half", "Letters, ballrooms and <i>very long walks</i>. Proud people, <b>second chances</b> and the slow work of changing your mind."],
  "Horror": ["ph-skull", "Hotels that <b>remember</b>, houses that <i>won't let go</i>, and the thing at the end of the garden only you can see."],
  "Historical Fiction": ["ph-scroll", "Revolutions, <i>Tudor courts</i> and wartime Paris, told by the people <b>history forgot to mention</b>."],
  "Poetry": ["ph-feather", "From <i>Gitanjali</i> to <b>the waste land</b>: short lines, long echoes and the occasional raven at the window."],
  "Biography": ["ph-identification-card", "Lives worth borrowing: <b>scientists, presidents, rebels</b> and a girl in an attic who <i>kept writing anyway</i>."],
  "History": ["ph-hourglass-medium", "Empires, plagues and <i>silk roads</i>: how we got <b>from foragers to footnotes</b> in a few hundred pages."],
  "Science": ["ph-atom", "Genes, galaxies and <b>the stuff in between</b>, explained by the people who <i>actually ran the experiments</i>."],
  "Philosophy": ["ph-brain", "Big questions, <i>small paperbacks</i>: how to live, what we can know and <b>whether any of it matters</b>."],
  "Programming": ["ph-terminal-window", "The shelf this system was <b>designed from</b>: patterns, <i>clean code</i> and the craft of object-oriented design."],
};
const STATUS = { available: "on the shelf", loaned: "on loan", on_hold: "on hold", lost: "missing" };

let me = null; // signed-in user
let account = null; // /api/me payload for members
let stats = null;

/* ---------------- toasts ---------------- */
function toast(message, error = false) {
  const el = document.createElement("div");
  el.className = "hyp-toast" + (error ? " is-error" : "");
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 4200);
}

async function attempt(work, button) {
  if (button) button.disabled = true;
  try {
    return await work();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

/* ---------------- reading-room preferences ---------------- */
const MODES = { 1: "", 2: "sepiamode", 3: "darkmode" };
function applyMode(value) {
  document.body.className = MODES[value] || "";
  $("#hyp-mode").value = value;
  store.set("shelfmark.mode", value);
}
function applyPalette(value) {
  $("#hyp-color").className = value;
  $("#palette").value = value;
  store.set("shelfmark.palette", value);
}
function applyContrast(on) {
  $(".hyp").classList.toggle("contrastmode", on);
  const btn = $("#contrastmode");
  btn.setAttribute("aria-pressed", on);
  btn.textContent = on ? "on" : "off";
  store.set("shelfmark.contrast", on ? "1" : "");
}
function applyFont(size) {
  const px = Math.min(22, Math.max(11, size));
  document.documentElement.style.setProperty("--fontSize", px + "px");
  document.documentElement.style.setProperty("--lineHeight", Math.round(px * 1.57) + "px");
  store.set("shelfmark.font", px);
}

applyMode(store.get("shelfmark.mode", "1"));
applyPalette(store.get("shelfmark.palette", "defaultPalette"));
applyContrast(Boolean(store.get("shelfmark.contrast")));
applyFont(Number(store.get("shelfmark.font", 14)));
$("#hyp-mode").addEventListener("input", (e) => applyMode(e.target.value));
$("#palette").addEventListener("change", (e) => applyPalette(e.target.value));
$("#contrastmode").addEventListener("click", () => applyContrast(!$(".hyp").classList.contains("contrastmode")));
const fontNow = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fontSize")) || 14;
$("#font-up").addEventListener("click", () => applyFont(fontNow() + 1));
$("#font-down").addEventListener("click", () => applyFont(fontNow() - 1));
$("#font-reset").addEventListener("click", () => applyFont(14));

/* ---------------- main menu ---------------- */
const menu = $("#main-menu");
let menuOpener = null;
function openMenu(focusAccount = false) {
  menuOpener = document.activeElement;
  menu.classList.add("is-open");
  $("#menu-toggle").setAttribute("aria-expanded", "true");
  (focusAccount ? $("#account-body input, #account-body button") : $("#menu-close"))?.focus();
}
function closeMenu() {
  menu.classList.remove("is-open");
  $("#menu-toggle").setAttribute("aria-expanded", "false");
  menuOpener?.focus?.();
}
$("#menu-toggle").addEventListener("click", () => (menu.classList.contains("is-open") ? closeMenu() : openMenu()));
$("#menu-close").addEventListener("click", closeMenu);
$("#personalize").addEventListener("click", (e) => {
  e.preventDefault();
  openMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menu.classList.contains("is-open")) closeMenu();
});
document.addEventListener("click", (e) => {
  const link = e.target.closest('a[href="#account"]');
  if (!link) return;
  e.preventDefault();
  if (link.id === "power-link" && me) return signOut();
  if (link.id === "event" && me) return $("#shelf").scrollIntoView();
  openMenu(true);
});

/* ---------------- dialogs ---------------- */
for (const dialog of $$("dialog")) {
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog || e.target.closest("[data-close]")) dialog.close();
  });
}
$$("[data-handbook]").forEach((link) =>
  link.addEventListener("click", (e) => {
    e.preventDefault();
    const handbook = $("#handbook");
    handbook.showModal();
    $(`#hb-${link.dataset.handbook}`, handbook).scrollIntoView({ block: "start" });
  })
);

/* ---------------- shared bits ---------------- */
function availability(b) {
  if (b.available === undefined) return "";
  if (b.available > 0) return `<span class="book-avail">${b.available} on shelf</span>`;
  return `<span class="book-avail is-out">out${b.queue ? ` · ${b.queue} waiting` : ""}</span>`;
}

const bookCard = (b) => `
  <button type="button" class="book" data-book="${b.id}">
    <span class="book-cover${b.cover_id ? "" : " is-blank"}">${
      b.cover_id ? `<img src="${coverUrl(b.cover_id)}" alt="" loading="lazy" />` : esc(b.title)
    }${availability(b)}</span>
    <span class="book-title">${esc(b.title)}</span>
    <span class="book-author">${esc(b.author)}</span>
  </button>`;

const empty = (text) => `<p class="empty">${text}</p>`;

document.addEventListener("click", (e) => {
  const card = e.target.closest("[data-book]");
  if (card) openBook(card.dataset.book);
});

/* ---------------- search ---------------- */
const form = $("#search-form");
let offset = 0;
const PAGE = 18;

function searchParams() {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form)) if (String(value).trim()) params.set(key, key === "available" ? "true" : value);
  return params;
}

async function runSearch(append = false) {
  offset = append ? offset + PAGE : 0;
  const params = searchParams();
  params.set("limit", PAGE);
  params.set("offset", offset);
  const data = await api("/api/books?" + params);
  const html = data.items.map(bookCard).join("");
  $("#results").innerHTML = append ? $("#results").innerHTML + html : html || empty("Nothing on the shelves matches that. Try fewer words.");
  $("#search-count").textContent = `${data.total} title${data.total === 1 ? "" : "s"} found`;
  $("#more").hidden = offset + PAGE >= data.total;
}

let debounce;
form.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => runSearch().catch((e) => toast(e.message, true)), 250);
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch().catch((err) => toast(err.message, true));
});
$("#more").addEventListener("click", (e) => attempt(() => runSearch(true), e.currentTarget));

function searchSubject(subject) {
  form.reset();
  $("#subject-filter").value = subject;
  runSearch().catch((e) => toast(e.message, true));
  $("#search").scrollIntoView();
}

/* ---------------- book detail ---------------- */
async function openBook(id) {
  const dialog = $("#book-dialog");
  const book = await api(`/api/books/${id}`).catch((e) => toast(e.message, true));
  if (!book) return;
  $("#book-body").innerHTML = `
    <div class="detail">
      <div>
        <div class="detail-cover">${book.cover_id ? `<img src="${coverUrl(book.cover_id, "L")}" alt="Cover of ${esc(book.title)}" style="width:100%;height:100%;object-fit:cover;display:block" />` : ""}</div>
        <div class="detail-isbn"><svg id="isbn-code" role="img" aria-label="ISBN ${esc(book.isbn)}"></svg></div>
      </div>
      <div>
        <span class="hyp-tag">${esc(book.subject)}</span>
        <h2 id="book-title">${esc(book.title)}</h2>
        <p class="by">${esc(book.author)}</p>
        <ul class="detail-meta">
          <li><span>published</span>${book.year ?? "—"}</li>
          <li><span>publisher</span>${esc(book.publisher || "—")}</li>
          <li><span>pages</span>${book.pages ?? "—"}</li>
          <li><span>isbn</span>${esc(book.isbn)}</li>
        </ul>
        <p class="detail-desc">${esc(book.description || "No summary yet.")}</p>
        <table class="copies">
          <thead><tr><th>copy</th><th>rack</th><th>status</th><th>due back</th></tr></thead>
          <tbody>${book.items
            .map(
              (i) => `<tr><td>${esc(i.barcode)}</td><td>${esc(i.rack)}</td>
                <td><span class="hyp-tag ${i.status === "available" ? "" : "hyp-tag--hot"}">${STATUS[i.status] || i.status}</span></td>
                <td>${i.due_on ? shortDate(i.due_on) : "—"}</td></tr>`
            )
            .join("") || '<tr><td colspan="4">No copies catalogued yet.</td></tr>'}</tbody>
        </table>
        <div class="detail-actions">${bookActions(book)}</div>
      </div>
    </div>`;
  try {
    JsBarcode("#isbn-code", book.isbn, { format: "EAN13", height: 46, fontSize: 14, margin: 0, flat: true });
  } catch {
    JsBarcode("#isbn-code", book.isbn, { format: "CODE128", height: 46, fontSize: 14, margin: 0 });
  }
  $("#book-body").dataset.id = book.id;
  if (!dialog.open) dialog.showModal();
}

function bookActions(book) {
  const shelf = book.items.find((i) => i.status === "available");
  const where = shelf ? `<span class="hyp-tag">on the shelf · rack ${esc(shelf.rack)}</span>` : "";
  if (me?.role === "librarian") return `${where}<a class="hyp-btn" href="/desk">manage at the desk</a>`;
  if (!account) {
    return shelf
      ? `${where}<span>Borrow it at the desk with your library card.</span>`
      : `<button type="button" class="hyp-btn" data-signin>sign in to reserve</button>`;
  }
  const loan = account.loans.find((l) => !l.returned_on && l.book.id === book.id);
  if (loan) return `<span class="hyp-tag hyp-tag--hot">on your shelf · due ${shortDate(loan.due_on)}</span>`;
  const res = account.reservations.find((r) => r.book.id === book.id && ["waiting", "ready"].includes(r.status));
  if (res?.status === "ready")
    return `<span class="hyp-tag hyp-tag--hot">ready at the desk until ${shortDate(res.hold_until)}</span>
            <button type="button" class="hyp-btn hyp-btn--ghost" data-cancel="${res.id}">cancel hold</button>`;
  if (res)
    return `<span class="hyp-tag">reserved · #${res.position} in the queue</span>
            <button type="button" class="hyp-btn hyp-btn--ghost" data-cancel="${res.id}">leave queue</button>`;
  if (shelf) return `${where}<span>Pick it up at the desk with card ${esc(me.card_no)}.</span>`;
  return `<button type="button" class="hyp-btn" data-reserve="${book.id}">reserve this title</button>
          <span>${book.queue ? `${book.queue} ahead of you` : "you'd be first in line"}</span>`;
}

document.addEventListener("click", (e) => {
  const reserve = e.target.closest("[data-reserve]");
  const cancel = e.target.closest("[data-cancel]");
  const renew = e.target.closest("[data-renew]");
  if (e.target.closest("[data-signin]")) {
    $("#book-dialog").close();
    openMenu(true);
  }
  if (reserve)
    attempt(async () => {
      const r = await api(`/api/books/${reserve.dataset.reserve}/reserve`, { method: "POST" });
      toast(`Reserved “${r.book.title}”. You're #${r.position} in the queue.`);
      await refreshAccount();
      openBook(reserve.dataset.reserve);
    }, reserve);
  if (cancel)
    attempt(async () => {
      await api(`/api/reservations/${cancel.dataset.cancel}/cancel`, { method: "POST" });
      toast("Reservation cancelled.");
      await refreshAccount();
      if ($("#book-dialog").open) openBook($("#book-body").dataset.id);
    }, cancel);
  if (renew)
    attempt(async () => {
      const loan = await api(`/api/loans/${renew.dataset.renew}/renew`, { method: "POST" });
      toast(`Renewed “${loan.book.title}”. Now due ${shortDate(loan.due_on)}.`);
      await refreshAccount();
    }, renew);
});

/* ---------------- account ---------------- */
async function refreshAccount() {
  me = await api("/api/auth/me").catch(() => null);
  account = me && me.role !== "librarian" ? await api("/api/me") : null;
  renderAccount();
  renderShelf();
  renderBadges();
}

function renderBadges() {
  const [notif, loans] = [$("#notif-link div"), $("#loans-link div")];
  const unread = account?.unread || 0;
  const active = account ? account.loans.filter((l) => !l.returned_on) : [];
  notif.hidden = !unread;
  notif.textContent = unread;
  loans.hidden = !active.length;
  loans.textContent = active.length;
  $("#power-link").dataset.tip = me ? "sign out" : "sign in";
  $("#card-link").dataset.tip = me ? "my card" : "join";
  $("#card-link i").className = me ? "ph ph-identification-card" : "ph ph-user-plus";

  const event = $("#event-text");
  if (!me) event.innerHTML = "member<br />sign in<div>your card awaits</div>";
  else if (me.role === "librarian") event.innerHTML = "the<br />desk<div>librarian tools</div>";
  else {
    const ready = account.reservations.find((r) => r.status === "ready");
    const late = active.filter((l) => l.days_overdue > 0);
    if (ready) event.innerHTML = `hold<br />ready<div>pick up by ${shortDate(ready.hold_until)}</div>`;
    else if (late.length) event.innerHTML = `${late.length} book${late.length > 1 ? "s" : ""}<br />overdue<div>${rupees(late.reduce((s, l) => s + l.accruing, 0))} and counting</div>`;
    else event.innerHTML = `my<br />shelf<div>${active.length} on loan</div>`;
  }
  $("#event").href = me?.role === "librarian" ? "/desk" : "#account";
}

function renderAccount() {
  const body = $("#account-body");
  if (me?.role === "librarian") {
    body.innerHTML = `<p>You're signed in as <b>${esc(me.name)}</b>, a librarian.</p>
      <a class="hyp-btn" href="/desk">open the desk</a><button type="button" class="hyp-btn hyp-btn--ghost" data-signout>sign out</button>`;
    return;
  }
  if (me) {
    const active = account.loans.filter((l) => !l.returned_on).length;
    body.innerHTML = `
      <div class="member-card">
        <span class="kind">${esc(me.label)} member</span>
        <h3>${esc(me.name)}</h3>
        <div>${esc(me.email)} · since ${shortDate(me.joined_on)} ${new Date(me.joined_on).getFullYear()}</div>
        <dl>
          <div><dt>on loan</dt><dd>${active} / ${me.max_books}</dd></div>
          <div><dt>loan period</dt><dd>${me.loan_days} days</dd></div>
          <div><dt>late fee</dt><dd>${rupees(me.fine_per_day)}/day</dd></div>
        </dl>
        <div class="barcode"><svg id="card-code" role="img" aria-label="Card number ${esc(me.card_no)}"></svg></div>
      </div>
      <p style="margin-top:30px"><button type="button" class="hyp-btn" data-signout>sign out</button></p>`;
    JsBarcode("#card-code", me.card_no, { format: "CODE128", height: 56, fontSize: 15, margin: 0 });
    return;
  }
  body.innerHTML = `
    <div class="hyp-tabs" role="tablist">
      <button type="button" class="hyp-chip" role="tab" aria-pressed="true" data-tab="signin">sign in</button>
      <button type="button" class="hyp-chip" role="tab" aria-pressed="false" data-tab="join">join</button>
    </div>
    <form class="hyp-form" id="signin-form">
      <label>email<input class="hyp-input" name="email" type="email" autocomplete="username" required /></label>
      <label>password<input class="hyp-input" name="password" type="password" autocomplete="current-password" required /></label>
      <p class="hyp-form-error" role="alert"></p>
      <button class="hyp-btn">sign in</button>
    </form>
    <form class="hyp-form" id="join-form" hidden>
      <label>full name<input class="hyp-input" name="name" autocomplete="name" required minlength="2" /></label>
      <label>email<input class="hyp-input" name="email" type="email" autocomplete="email" required /></label>
      <label>password (8+ characters)<input class="hyp-input" name="password" type="password" autocomplete="new-password" required minlength="8" /></label>
      <p class="hyp-form-error" role="alert"></p>
      <button class="hyp-btn">get my card</button>
    </form>
    <p class="demo-note">Demo cards: <code>student@shelfmark.test</code> or <code>faculty@shelfmark.test</code>, password <code>shelfmark</code>.
      <button type="button" class="hyp-chip" data-demo="student@shelfmark.test">use student</button></p>`;
}

$("#account-body").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  const demo = e.target.closest("[data-demo]");
  if (tab) {
    $$("[data-tab]").forEach((t) => t.setAttribute("aria-pressed", t === tab));
    $("#signin-form").hidden = tab.dataset.tab !== "signin";
    $("#join-form").hidden = tab.dataset.tab !== "join";
  }
  if (demo) {
    const f = $("#signin-form");
    f.email.value = demo.dataset.demo;
    f.password.value = "shelfmark";
    f.requestSubmit();
  }
  if (e.target.closest("[data-signout]")) signOut();
});

$("#account-body").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const error = $(".hyp-form-error", f);
  const join = f.id === "join-form";
  error.textContent = "";
  try {
    const user = await api(join ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      body: Object.fromEntries(new FormData(f)),
    });
    if (user.role === "librarian") return (location.href = "/desk");
    await refreshAccount();
    closeMenu();
    toast(join ? `Welcome to Shelfmark! Your card number is ${user.card_no}.` : `Welcome back, ${user.name.split(" ")[0]}.`);
  } catch (err) {
    error.textContent = err.message;
  }
});

async function signOut() {
  await api("/api/auth/logout", { method: "POST" });
  await refreshAccount();
  toast("Signed out. See you soon.");
}

/* ---------------- my shelf ---------------- */
const coverStyle = (b) => (b.cover_id ? `style="background-image:url('${coverUrl(b.cover_id, "S")}')"` : "");

function loanRow(l) {
  const late = l.days_overdue > 0;
  return `<div class="row">
    <span class="row-cover" ${coverStyle(l.book)}></span>
    <div class="row-main">
      <button type="button" class="row-title" data-book="${l.book.id}">${esc(l.book.title)}</button>
      <div class="row-sub">
        <span class="hyp-tag ${late ? "hyp-tag--hot" : ""}">${late ? `${l.days_overdue}d overdue · ${rupees(l.accruing)}` : `due ${shortDate(l.due_on)}`}</span>
        <span>${esc(l.barcode)} · borrowed ${shortDate(l.issued_on)}${l.renewals ? " · renewed" : ""}</span>
      </div>
    </div>
    <div class="row-actions">${late || l.renewals ? "" : `<button type="button" class="hyp-chip" data-renew="${l.id}">renew</button>`}</div>
  </div>`;
}

function reservationRow(r) {
  const ready = r.status === "ready";
  return `<div class="row">
    <span class="row-cover" ${coverStyle(r.book)}></span>
    <div class="row-main">
      <button type="button" class="row-title" data-book="${r.book.id}">${esc(r.book.title)}</button>
      <div class="row-sub"><span class="hyp-tag ${ready ? "hyp-tag--hot" : ""}">${
        ready ? `ready · until ${shortDate(r.hold_until)}` : `#${r.position} in queue`
      }</span><span>${ready ? `copy ${esc(r.barcode)} at the desk` : `reserved ${shortDate(r.created_at)}`}</span></div>
    </div>
    <div class="row-actions"><button type="button" class="hyp-chip" data-cancel="${r.id}">cancel</button></div>
  </div>`;
}

const NOTICE_ICONS = { reservation_ready: "ph-bell-ringing", overdue: "ph-warning", fine: "ph-coins", issued: "ph-book-open-text", renewed: "ph-arrows-clockwise", hold_expired: "ph-hourglass-medium" };

function renderShelf() {
  const body = $("#shelf-body");
  if (!account) {
    body.innerHTML = me?.role === "librarian"
      ? empty('Librarians manage loans at <a href="/desk">the desk</a>.')
      : `${empty("Sign in to see your loans, reservations, fines and notices.")}
         <p style="margin-top:20px"><button type="button" class="hyp-btn" data-signin>sign in</button></p>`;
    return;
  }
  const active = account.loans.filter((l) => !l.returned_on);
  const history = account.loans.filter((l) => l.returned_on).slice(0, 8);
  const open = account.reservations.filter((r) => ["waiting", "ready"].includes(r.status));
  const unpaid = account.fines.filter((f) => !f.paid_on);
  body.innerHTML = `
    <div class="shelf-grid">
      <div>
        <div class="shelf-block"><h3 class="shelf-h">on loan · ${active.length}/${me.max_books}</h3>
          ${active.map(loanRow).join("") || empty("Nothing on loan right now. The shelves are waiting.")}</div>
        <div class="shelf-block"><h3 class="shelf-h">reservations</h3>
          ${open.map(reservationRow).join("") || empty("No reservations. Reserve any title that's out on loan.")}</div>
        <div class="shelf-block"><h3 class="shelf-h">recently returned</h3>
          ${history.map((l) => `<div class="row"><span class="row-cover" ${coverStyle(l.book)}></span>
            <div class="row-main"><button type="button" class="row-title" data-book="${l.book.id}">${esc(l.book.title)}</button>
            <div class="row-sub"><span>returned ${shortDate(l.returned_on)}</span>${l.fine ? `<span class="hyp-tag hyp-tag--hot">fine ${rupees(l.fine)}</span>` : ""}</div></div></div>`).join("") || empty("Your reading history starts with your first loan.")}</div>
      </div>
      <div>
        <div class="shelf-block" id="notices"><h3 class="shelf-h">notices</h3>
          ${account.notifications.slice(0, 8).map((n) => `<div class="notice ${n.read ? "is-read" : ""}">
            <i class="ph ${NOTICE_ICONS[n.kind] || "ph-info"}"></i><span>${esc(n.message)}</span><time>${timeAgo(n.created_at)}</time></div>`).join("") || empty("No notices yet.")}
          ${account.unread ? '<p style="margin-top:16px"><button type="button" class="hyp-chip" data-read>mark all read</button></p>' : ""}
        </div>
        <div class="shelf-block"><h3 class="shelf-h">fines</h3>
          <div class="fine-total">${rupees(account.fines_due)}<small>${account.fines_due ? "due at the desk" : "all clear"}</small></div>
          ${unpaid.map((f) => `<div class="notice"><i class="ph ph-coins"></i><span>${esc(f.book.title)}: ${f.days} day(s) late</span><time>${rupees(f.amount)}</time></div>`).join("")}
          ${account.fines_due ? '<p class="menu-note">Unpaid fines pause borrowing until they are settled at the desk.</p>' : ""}
        </div>
      </div>
    </div>`;
}

$("#shelf-body").addEventListener("click", (e) => {
  const read = e.target.closest("[data-read]");
  if (read)
    attempt(async () => {
      await api("/api/me/notifications/read", { method: "POST" });
      await refreshAccount();
    }, read);
});

/* ---------------- subjects ---------------- */
function renderGenres() {
  $("#anchors").insertAdjacentHTML(
    "beforeend",
    stats.subjects.map((s) => `<a href="#subject-${slug(s.name)}">${esc(s.name.toLowerCase())}</a>`).join("")
  );
  $("#genres").innerHTML = stats.subjects
    .map((s, n) => {
      const [icon, desc] = SUBJECTS[s.name] || ["ph-books", ""];
      const id = slug(s.name);
      return `
      <section class="hyp-genre" id="subject-${id}" data-subject="${esc(s.name)}">
        <div class="hyp-genre-left"></div>
        <div class="hyp-genre-right">
          <div class="hyp-genre-top">
            <div class="hyp-genre-icon" aria-hidden="true"><i class="ph-duotone ${icon}"></i></div>
            <h2 style="margin:0"><button type="button" class="hyp-genre-name" data-subject-search="${esc(s.name)}" style="background:none;border:0;padding:0">${esc(s.name)}</button>
              <span class="hyp-tag hyp-genre-count">${s.titles} titles · ${s.available} free</span></h2>
            <div class="hyp-genre-desc">${desc}</div>
          </div>
          <div class="hyp-genre-bot">
            <input type="radio" name="tabs-${n}" id="t-${id}-1" checked /><label class="hyp-subgenre-label" for="t-${id}-1">most borrowed</label>
            <input type="radio" name="tabs-${n}" id="t-${id}-2" /><label class="hyp-subgenre-label" for="t-${id}-2">on the shelf</label>
            <input type="radio" name="tabs-${n}" id="t-${id}-3" /><label class="hyp-subgenre-label" for="t-${id}-3">a — z</label>
            <div class="hyp-subgenre"><div class="book-grid book-grid--mini">${s.top.map(bookCard).join("")}</div></div>
            <div class="hyp-subgenre" data-slot="shelf">${empty("Loading…")}</div>
            <div class="hyp-subgenre" data-slot="all">${empty("Loading…")}</div>
          </div>
        </div>
      </section>`;
    })
    .join("");

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        fillGenre(entry.target);
      }
    },
    { root: scroller, rootMargin: "400px 0px" }
  );
  $$(".hyp-genre").forEach((g) => io.observe(g));
}

async function fillGenre(section) {
  const data = await api(`/api/books?subject=${encodeURIComponent(section.dataset.subject)}&limit=60`).catch(() => null);
  if (!data) return;
  const onShelf = data.items.filter((b) => b.available > 0);
  $('[data-slot="shelf"]', section).innerHTML = onShelf.length
    ? `<div class="book-grid book-grid--mini">${onShelf.map(bookCard).join("")}</div>`
    : empty("Every copy is out. Reserve one to join the queue.");
  $('[data-slot="all"]', section).innerHTML = `<div class="book-grid book-grid--mini">${data.items.map(bookCard).join("")}</div>`;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z]+/g, "-");

document.addEventListener("click", (e) => {
  const subject = e.target.closest("[data-subject-search]");
  if (subject) searchSubject(subject.dataset.subjectSearch);
});

/* ---------------- boot ---------------- */
(async function boot() {
  try {
    stats = await api("/api/stats");
  } catch (e) {
    toast("The catalogue is waking up. Refresh in a few seconds.", true);
    return;
  }
  $("#sub-titles").textContent = `${stats.titles} titles`;
  $("#sub-subjects").textContent = `across ${stats.subjects.length} subjects`;
  $("#sub-members").textContent = `${stats.members} members`;
  const star = stats.popular.find((b) => b.cover_id);
  if (star) $("#banner-cover").style.backgroundImage = `url('${coverUrl(star.cover_id)}')`;
  $("#subject-filter").insertAdjacentHTML("beforeend", stats.subjects.map((s) => `<option>${esc(s.name)}</option>`).join(""));

  renderGenres();
  await Promise.all([refreshAccount().catch(() => renderAccount()), runSearch()]);

  const params = new URLSearchParams(location.search);
  if (params.get("book")) openBook(params.get("book"));
  if (location.hash === "#account") openMenu(true);
  else if (location.hash) $(location.hash)?.scrollIntoView();
})();
