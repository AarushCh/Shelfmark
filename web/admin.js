// Shelfmark Admin, for library staff: the counter for issues and returns, plus loans, reservations, fines,
// members and the catalogue.
const COPY = { available: ["on the shelf", "ok"], loaned: ["on loan", ""], on_hold: ["on hold", "warn"], lost: ["missing", "err"] };
const filters = { loans: "active", reservations: "ready", fines: "unpaid" };
const LOADERS = {
  counter: loadCounter,
  loans: loadLoans,
  reservations: loadReservations,
  fines: loadFines,
  members: loadMembers,
  catalogue: (animate) => loadCatalogue(false, animate),
};
const issueForm = $("#issue-form");
const returnForm = $("#return-form");
let me = null;
let subjects = [];

/* ---------- views ---------- */
const current = () => (Object.hasOwn(LOADERS, location.hash.slice(1)) ? location.hash.slice(1) : "counter");

function route() {
  const view = current();
  for (const name in LOADERS) $(`#view-${name}`).hidden = name !== view;
  for (const tab of $$("#tabs .tab")) {
    if (tab.hash === `#${view}` && tab.pathname === location.pathname) {
      tab.setAttribute("aria-current", "page");
      tab.scrollIntoView({ inline: "nearest", block: "nearest" }); // the strip scrolls sideways on a phone
    } else tab.removeAttribute("aria-current");
  }
  slide($("#tabs"));
  document.title = `${$(`#view-${view}`).dataset.title} · Shelfmark Admin`;
  if (me) attempt(() => LOADERS[view]());
}

addEventListener("hashchange", () => {
  closeSheet($("#sheet"));
  route();
});

// Switch views without waiting for a hashchange, so focus can move into the new view straight away.
function go(view) {
  if (current() === view) return;
  history.pushState(null, "", `#${view}`);
  route();
}

function setFilter(name, value) {
  filters[name] = value;
  for (const b of $$(`[data-filter="${name}"] [data-value]`)) b.setAttribute("aria-pressed", b.dataset.value === value);
  slide($(`[data-filter="${name}"]`));
}

for (const group of $$("[data-filter]")) {
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-value]");
    if (!btn) return;
    setFilter(group.dataset.filter, btn.dataset.value);
    attempt(() => LOADERS[group.dataset.filter]());
  });
}

// A list waiting for its first data shows shimmering placeholder rows.
const loading = (list) => list.children.length || (list.innerHTML = '<div class="ghost-row"></div>'.repeat(4));

/* ---------- rows ---------- */
const bookLink = (b) => `<button type="button" class="link" data-book="${b.id}">${esc(b.title)}</button>`;
const memberLink = (m) => `<button type="button" class="link" data-member="${esc(m.card_no)}">${esc(m.name)}</button>`;
const code = (text) => `<span class="mono">${esc(text)}</span>`;

function dueTag(loan) {
  if (loan.returned_on) return loan.fine ? tag(`fine ${rupees(loan.fine)}`, "warn") : tag("on time", "ok");
  if (loan.days_overdue) return tag(`${loan.days_overdue}d late · ${rupees(loan.accruing)}`, "err");
  const days = Math.round((new Date(loan.due_on + "T00:00") - new Date().setHours(0, 0, 0, 0)) / 864e5);
  return tag(days === 0 ? "due today" : `due in ${days}d`, days <= 2 ? "warn" : "");
}

function loanRow(loan, withMember = true) {
  const when = loan.returned_on ? `returned ${shortDate(loan.returned_on)}` : `issued ${shortDate(loan.issued_on)}`;
  return row({
    lead: thumb(loan.book),
    title: bookLink(loan.book),
    sub: `${withMember ? memberLink(loan.member) + " · " : ""}${code(loan.barcode)} · ${when}`,
    side: dueTag(loan) + (loan.returned_on ? "" : `<button type="button" class="btn btn--sm btn--light" data-return="${esc(loan.barcode)}">Check in</button>`),
  });
}

function reservationRow(r) {
  if (r.status === "ready") {
    return row({
      lead: thumb(r.book),
      title: bookLink(r.book),
      sub: `for ${memberLink(r.member)} · ${code(r.barcode)} · until ${shortDate(r.hold_until)}`,
      side: `<button type="button" class="btn btn--sm" data-prefill="${esc(r.member.card_no)}" data-copy="${esc(r.barcode)}">Hand over</button>`,
    });
  }
  return row({
    lead: thumb(r.book),
    title: bookLink(r.book),
    sub: `${memberLink(r.member)} · reserved ${shortDate(r.created_at)}`,
    side: r.status === "waiting" ? tag(`#${r.position} in queue`) : tag(r.status, r.status === "fulfilled" ? "ok" : ""),
  });
}

const fineRow = (f) =>
  row({
    lead: avatar(f.member.name),
    title: memberLink(f.member),
    sub: `${esc(f.book.title)} · ${f.days} day${f.days === 1 ? "" : "s"} late${f.paid_on ? ` · paid ${shortDate(f.paid_on)}` : ""}`,
    side: tag(rupees(f.amount), f.paid_on ? "ok" : "warn") + (f.paid_on ? "" : `<button type="button" class="btn btn--sm" data-collect="${f.id}">Collect</button>`),
  });

const memberRow = (m) =>
  row({
    lead: avatar(m.name),
    title: memberLink(m),
    sub: `${esc(m.label)} · ${code(m.card_no)} · ${esc(m.email)}`,
    side: (m.active ? "" : tag("suspended", "err")) + (m.overdue ? tag(`${m.overdue} overdue`, "err") : "") +
      (m.fines_due ? tag(`${rupees(m.fines_due)} due`, "warn") : "") + tag(`${m.on_loan} of ${m.max_books} out`),
  });

const titleRow = (b) =>
  row({
    lead: thumb(b),
    title: bookLink(b),
    sub: `${esc(b.author)} · ${esc(b.subject)} · ${yearText(b.year)}`,
    side: (b.queue ? tag(`${b.queue} waiting`, "warn") : "") + tag(`${b.available} of ${b.copies} in`, b.available ? "ok" : "err"),
  });

function copyRow(item) {
  const [label, tone] = COPY[item.status];
  const action = { available: ["data-lost", "Mark missing"], lost: ["data-found", "Found it"], loaned: ["data-return", "Check in"] }[item.status];
  return row({
    lead: '<span class="glyph"><i class="ph ph-barcode"></i></span>',
    title: code(item.barcode),
    sub: `Rack ${esc(item.rack)}${item.due_on ? ` · due ${shortDate(item.due_on)}` : ""}`,
    side: tag(label, tone) + (action ? `<button type="button" class="btn btn--sm btn--light" ${action[0]}="${esc(item.barcode)}">${action[1]}</button>` : ""),
  });
}

/* ---------- counter ---------- */
let seen = new Set(); // activity already on screen, so only new events slide in

async function loadCounter(animate = true) {
  if (animate) [$("#ready"), $("#overdue"), $("#feed")].forEach(loading);
  const d = await api("/api/admin/overview");
  const kpis = [
    ["On loan", d.on_loan, "loans:active", ""],
    ["Overdue", d.overdue_count, "loans:overdue", d.overdue_count ? "err" : ""],
    ["Holds ready", d.holds.length, "reservations:ready", ""],
    ["Unpaid fines", d.fines_due, "fines:unpaid", d.fines_due ? "warn" : "", rupees],
  ];
  if (!$("#kpis").children.length) {
    $("#kpis").innerHTML = kpis
      .map(([label, , preset], i) => `
        <a class="kpi" href="#${preset.split(":")[0]}" data-preset="${preset}" style="--i:${i}">
          <span class="kpi__v">0</span><span class="kpi__l">${label}<i class="ph ph-arrow-up-right"></i></span>
        </a>`)
      .join("");
  }
  kpis.forEach(([, value, , tone, format], i) => {
    const tile = $("#kpis").children[i];
    tile.className = `kpi${tone ? " kpi--" + tone : ""}`;
    countTo($(".kpi__v", tile), value, format);
  });
  fill($("#ready"), d.holds.map(reservationRow).join("") || empty("No holds waiting at the desk."), animate);
  fill($("#overdue"), d.overdue.map((l) => loanRow(l)).join("") || empty("Nothing overdue. Lovely."), animate);
  const keys = d.activity.map((a) => a.at + a.message);
  fill($("#feed"), d.activity
    .map((a, i) => `<div class="feed__item${!animate && !seen.has(keys[i]) ? " is-new" : ""}" data-kind="${esc(a.kind)}">
        <span>${esc(a.message)}</span><time datetime="${a.at}">${timeAgo(a.at)}</time></div>`)
    .join("") || empty("Quiet so far."), animate);
  seen = new Set(keys);
}

// While the counter is on screen it keeps itself current, so members' renewals and reservations show up here.
setInterval(() => {
  if (me && current() === "counter" && !document.hidden && !$("#sheet").open) loadCounter(false).catch(() => null);
}, 20000);

function showError(box, err) {
  box.className = "preview preview--error";
  box.textContent = err.message;
}

// Each preview remembers what it was asked for, so a slow answer about a card or copy typed earlier is ignored.
async function previewMember(card) {
  const box = $("#issue-member");
  box.className = "preview";
  box.dataset.want = card;
  if (!card) return (box.innerHTML = "");
  try {
    const d = await api(`/api/admin/members/${encodeURIComponent(card)}`);
    if (box.dataset.want !== card) return;
    const u = d.user;
    const out = d.loans.filter((l) => !l.returned_on);
    const late = out.filter((l) => l.days_overdue).length;
    const verdict = !u.active ? tag("suspended", "err")
      : d.fines_due ? tag(`${rupees(d.fines_due)} unpaid`, "err")
      : out.length >= u.max_books ? tag("at the limit", "err")
      : tag("can borrow", "ok");
    box.innerHTML = row({
      lead: avatar(u.name),
      title: memberLink(u),
      sub: `${esc(u.label)} · ${out.length} of ${u.max_books} out${late ? ` · ${late} overdue` : ""}`,
      side: verdict,
    });
  } catch (err) {
    if (box.dataset.want === card) showError(box, err);
  }
}

async function previewCopy(barcode, box) {
  box.className = "preview";
  box.dataset.want = barcode;
  if (!barcode) return (box.innerHTML = "");
  try {
    const c = await api(`/api/admin/items/${encodeURIComponent(barcode)}`);
    if (box.dataset.want !== barcode) return;
    const [label, tone] = COPY[c.status];
    let sub = `Rack ${esc(c.rack)}`;
    if (c.loan) sub += ` · with ${esc(c.loan.member.name)}, due ${shortDate(c.loan.due_on)}`;
    if (c.hold) sub += ` · held for ${esc(c.hold.member.name)}`;
    const late = c.loan?.days_overdue ? tag(`${c.loan.days_overdue}d late`, "err") : "";
    box.innerHTML = row({ lead: thumb(c.book), title: bookLink(c.book), sub, side: late + tag(label, tone) });
  } catch (err) {
    if (box.dataset.want === barcode) showError(box, err);
  }
}

const value = (input) => input.value.trim();
issueForm.card_no.addEventListener("change", () => previewMember(value(issueForm.card_no)));
issueForm.barcode.addEventListener("change", () => previewCopy(value(issueForm.barcode), $("#issue-copy")));
returnForm.barcode.addEventListener("change", () => previewCopy(value(returnForm.barcode), $("#return-copy")));
// Scanners type the code and press Enter: after the card, move on to the book (the change event shows the member).
issueForm.card_no.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  issueForm.barcode.focus();
});

issueForm.addEventListener("submit", (e) => {
  e.preventDefault();
  attempt(async () => {
    const body = { card_no: value(issueForm.card_no), barcode: value(issueForm.barcode) };
    const loan = await api("/api/admin/issue", { method: "POST", body });
    toast(`Issued “${loan.book.title}” to ${loan.member.name}. It's due ${shortDate(loan.due_on)}.`);
    issueForm.barcode.value = "";
    $("#issue-copy").innerHTML = "";
    previewMember(body.card_no);
    issueForm.barcode.focus();
    refreshAll();
  }, $("[type=submit]", issueForm));
});

returnForm.addEventListener("submit", (e) => {
  e.preventDefault();
  attempt(async () => {
    const loan = await api("/api/admin/return", { method: "POST", body: { barcode: value(returnForm.barcode) } });
    announceReturn(loan);
    returnForm.reset();
    $("#return-copy").innerHTML = "";
    returnForm.barcode.focus();
    refreshAll();
  }, $("[type=submit]", returnForm));
});

function announceReturn(loan) {
  const parts = [`Checked in “${loan.book.title}” from ${loan.member.name}.`];
  if (loan.fine) parts.push(`Fine raised: ${rupees(loan.fine)}.`);
  if (loan.next === "on_hold") parts.push("It's now on hold for the next reader.");
  toast(parts.join(" "), loan.fine ? "warn" : "");
}

// "Hand over" and "Issue a book" fill the counter in, so the librarian only has to confirm.
function prefill(card = "", barcode = "") {
  $("#sheet").close(); // at once: a sheet still fading out would keep the counter from taking focus
  go("counter");
  issueForm.card_no.value = card;
  issueForm.barcode.value = barcode;
  previewMember(card);
  previewCopy(barcode, $("#issue-copy"));
  issueForm.scrollIntoView({ behavior: "smooth", block: "center" });
  (barcode ? $("[type=submit]", issueForm) : issueForm.barcode).focus({ preventScroll: true });
}

/* ---------- lists ---------- */
async function loadLoans(animate = true) {
  if (animate) loading($("#loans-list"));
  const q = encodeURIComponent($("#loans-q").value.trim());
  const loans = await api(`/api/admin/loans?status=${filters.loans}&q=${q}`);
  fill($("#loans-list"), loans.map((l) => loanRow(l)).join("") || empty("No loans match."), animate);
}

async function loadReservations(animate = true) {
  if (animate) loading($("#reservations-list"));
  const list = await api(`/api/admin/reservations?status=${filters.reservations}`);
  fill($("#reservations-list"), list.map(reservationRow).join("") ||
    empty(filters.reservations === "ready" ? "No holds waiting at the desk." : "Nothing here right now."), animate);
}

async function loadFines(animate = true) {
  if (animate) loading($("#fines-list"));
  const list = await api(`/api/admin/fines?status=${filters.fines}`);
  fill($("#fines-list"), list.map(fineRow).join("") || empty(filters.fines === "unpaid" ? "No unpaid fines." : "No fines collected yet."), animate);
}

async function loadMembers(animate = true) {
  if (animate) loading($("#members-list"));
  const list = await api(`/api/admin/members?q=${encodeURIComponent($("#members-q").value.trim())}`);
  fill($("#members-list"), list.map(memberRow).join("") || empty("No members match."), animate);
}

let catalogueOffset = 0;
async function loadCatalogue(append = false, animate = true) {
  if (animate && !append) loading($("#catalogue-list"));
  catalogueOffset = append ? catalogueOffset + 30 : 0;
  const params = new URLSearchParams({ q: $("#catalogue-q").value.trim(), subject: $("#catalogue-subject").value, limit: 30, offset: catalogueOffset });
  const data = await api(`/api/books?${params}`);
  const rows = data.items.map(titleRow).join("");
  if (append) $("#catalogue-list").insertAdjacentHTML("beforeend", rows);
  else fill($("#catalogue-list"), rows || empty("No titles match."), animate);
  $("#catalogue-more").hidden = catalogueOffset + 30 >= data.total;
}

$("#loans-q").addEventListener("input", debounce(() => attempt(() => loadLoans(false))));
$("#members-q").addEventListener("input", debounce(() => attempt(() => loadMembers(false))));
$("#catalogue-q").addEventListener("input", debounce(() => attempt(() => loadCatalogue(false, false))));
$("#catalogue-subject").addEventListener("change", () => attempt(() => loadCatalogue()));
$("#catalogue-more").addEventListener("click", (e) => attempt(() => loadCatalogue(true), e.currentTarget));

/* ---------- sheets ---------- */
function showSheet(html, reload = "") {
  fill($("#sheet-body"), html);
  $("#sheet-body").dataset.reload = reload;
  openSheet($("#sheet"));
}

// After a change, redraw what's on screen (quietly) and any open sheet.
function refreshAll() {
  attempt(() => LOADERS[current()](false));
  const [kind, key] = ($("#sheet-body").dataset.reload || "").split(":");
  if ($("#sheet").open && kind) (kind === "book" ? openBook : openMember)(key);
}

async function openBook(id) {
  const b = await api(`/api/books/${id}`).catch((e) => void toast(e.message, "error"));
  if (!b) return;
  showSheet(`
    <div class="book-detail book-detail--sm">
      <div class="book-detail__cover">${coverImg(b)}</div>
      <div class="book-detail__head">
        ${tag(b.subject)}
        <h2 class="sheet__h" id="sheet-title">${esc(b.title)}</h2>
        <p class="muted">${esc(b.author)} · ${yearText(b.year)} · ISBN ${code(b.isbn)}</p>
        <p class="muted">${b.available} of ${b.copies} on the shelf${b.queue ? ` · ${b.queue} waiting` : ""}</p>
      </div>
    </div>
    <h3 class="sheet__sub">Copies</h3>
    <div class="list">${b.items.map(copyRow).join("") || empty("No copies yet.")}</div>
    <form class="inline-form" id="copies-form">
      <label class="field">Add copies<input class="input" name="count" type="number" min="1" max="20" value="1" required /></label>
      <label class="field">On rack<input class="input input--code" name="rack" value="${esc(b.items.at(-1)?.rack || "")}" placeholder="FAN-01A" required maxlength="20" /></label>
      <button class="btn">Add</button>
    </form>
    <details class="fold">
      <summary>Edit details <i class="ph ph-caret-down"></i></summary>
      <form class="form-grid" id="edit-form">
        <label class="field wide">Title<input class="input" name="title" value="${esc(b.title)}" required maxlength="300" /></label>
        <label class="field">Author<input class="input" name="author" value="${esc(b.author)}" required maxlength="200" /></label>
        <label class="field">Subject<input class="input" name="subject" value="${esc(b.subject)}" list="subject-list" required maxlength="60" /></label>
        <label class="field">Publisher<input class="input" name="publisher" value="${esc(b.publisher || "")}" maxlength="200" /></label>
        <label class="field">Year<input class="input" name="year" type="number" value="${b.year ?? ""}" /></label>
        <label class="field wide">Summary<textarea class="input" name="description" rows="4" maxlength="4000">${esc(b.description || "")}</textarea></label>
        <div class="wide"><button class="btn">Save changes</button></div>
      </form>
    </details>`, `book:${id}`);

  $("#copies-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    attempt(async () => {
      await api(`/api/admin/books/${id}/copies`, { method: "POST", body: { count: Number(f.count.value), rack: f.rack.value.trim() } });
      toast(`Added ${f.count.value} ${f.count.value === "1" ? "copy" : "copies"} of “${b.title}”.`);
      refreshAll();
    }, $("button", f));
  });
  $("#edit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(new FormData(f));
    body.year = body.year ? Number(body.year) : null;
    attempt(async () => {
      await api(`/api/admin/books/${id}`, { method: "PATCH", body });
      toast("Saved.");
      refreshAll();
    }, $("button", f));
  });
}

async function openMember(card) {
  const d = await api(`/api/admin/members/${encodeURIComponent(card)}`).catch((e) => void toast(e.message, "error"));
  if (!d) return;
  const u = d.user;
  const out = d.loans.filter((l) => !l.returned_on);
  const late = out.filter((l) => l.days_overdue).length;
  const open = d.reservations.filter((r) => r.status === "waiting" || r.status === "ready");
  const unpaid = d.fines.filter((f) => !f.paid_on);
  showSheet(`
    <div class="person">
      ${avatar(u.name, "lg")}
      <div>
        <h2 class="sheet__h" id="sheet-title">${esc(u.name)}</h2>
        <p class="muted">${esc(u.label)} · ${code(u.card_no)} · ${esc(u.email)}</p>
      </div>
    </div>
    <dl class="facts">
      <div><dt>On loan</dt><dd>${out.length} of ${u.max_books}</dd></div>
      <div><dt>Overdue</dt><dd>${late}</dd></div>
      <div><dt>Fines due</dt><dd>${rupees(d.fines_due)}</dd></div>
      <div><dt>Joined</dt><dd>${shortDate(u.joined_on)} ${u.joined_on.slice(0, 4)}</dd></div>
    </dl>
    <div class="actions-row">
      <button type="button" class="btn" data-prefill="${esc(u.card_no)}"><i class="ph ph-arrow-circle-up-right"></i>Issue a book</button>
      <label class="switch"><input type="checkbox" id="member-active"${u.active ? " checked" : ""} /><span class="switch__ui" aria-hidden="true"></span>${u.active ? "Active" : "Suspended"}</label>
    </div>
    <h3 class="sheet__sub">On loan</h3>
    <div class="list">${out.map((l) => loanRow(l, false)).join("") || empty("Nothing on loan.")}</div>
    ${unpaid.length ? `<h3 class="sheet__sub">Unpaid fines</h3><div class="list">${unpaid.map(fineRow).join("")}</div>` : ""}
    ${open.length ? `<h3 class="sheet__sub">Reservations</h3><div class="list">${open.map(reservationRow).join("")}</div>` : ""}
    <details class="fold">
      <summary>Recent activity on this card <i class="ph ph-caret-down"></i></summary>
      <div class="list">${d.notices.map((n) => `<div class="feed__item" data-kind="${esc(n.kind)}"><span>${esc(n.message)}</span>
        <time datetime="${n.created_at}">${timeAgo(n.created_at)}</time></div>`).join("") || empty("Nothing yet.")}</div>
    </details>`, `member:${u.card_no}`);

  $("#member-active").addEventListener("change", (e) =>
    attempt(async () => {
      await api(`/api/admin/members/${u.id}`, { method: "PATCH", body: { active: e.target.checked } });
      toast(`${u.name} ${e.target.checked ? "reinstated" : "suspended"}.`);
      refreshAll();
    })
  );
}

function addBook() {
  showSheet(`
    <p class="eyebrow">Catalogue</p>
    <h2 class="sheet__h" id="sheet-title">Add a <em>title</em></h2>
    <p class="muted">Look the ISBN up on Open Library, or fill the details in yourself.</p>
    <form class="form-grid form--spaced" id="book-form">
      <div class="field wide"><label for="new-isbn">ISBN</label>
        <span class="input-row"><input class="input" id="new-isbn" name="isbn" required pattern="\\d{9}[\\dXx]|\\d{13}" placeholder="9780132350884" />
        <button type="button" class="btn btn--light" id="lookup">Look up</button></span>
      </div>
      <label class="field wide">Title<input class="input" name="title" required maxlength="300" /></label>
      <label class="field">Author<input class="input" name="author" required maxlength="200" /></label>
      <label class="field">Subject<input class="input" name="subject" list="subject-list" required maxlength="60" /></label>
      <label class="field">Publisher<input class="input" name="publisher" maxlength="200" /></label>
      <label class="field">Year<input class="input" name="year" type="number" placeholder="e.g. 2008" /></label>
      <label class="field">Copies<input class="input" name="copies" type="number" min="1" max="20" value="1" required /></label>
      <label class="field">Rack<input class="input input--code" name="rack" required maxlength="20" placeholder="PRG-05A" /></label>
      <label class="field wide">Summary<textarea class="input" name="description" rows="3" maxlength="4000"></textarea></label>
      <input type="hidden" name="pages" /><input type="hidden" name="cover" />
      <div class="wide"><button class="btn btn--lg">Add to catalogue</button></div>
    </form>`);
  const f = $("#book-form");
  $("#lookup").addEventListener("click", (e) =>
    attempt(async () => {
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
      f.cover.value = data.cover?.medium?.replace(/^http:/, "https:") || "";
      f.subject.value ||= subjects.find((s) => data.subjects?.some((x) => x.name.toLowerCase().includes(s.toLowerCase()))) || "";
      toast(`Found “${f.title.value}”.`);
    }, e.currentTarget)
  );
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    body.isbn = body.isbn.toUpperCase();
    for (const k of ["year", "pages", "copies"]) body[k] = body[k] ? Number(body[k]) : null;
    body.cover ||= null;
    attempt(async () => {
      const book = await api("/api/admin/books", { method: "POST", body });
      toast(`Catalogued “${book.title}” with ${book.copies} ${book.copies === 1 ? "copy" : "copies"}.`);
      openBook(book.id);
      if (current() === "catalogue") loadCatalogue(false, false);
    }, $(".btn--lg", f));
  });
}

function addMember() {
  showSheet(`
    <p class="eyebrow">Members</p>
    <h2 class="sheet__h" id="sheet-title">Register a <em>member</em></h2>
    <form class="form form--spaced" id="member-form">
      <div class="choice" role="radiogroup" aria-label="Membership">
        <label><input type="radio" name="kind" value="student" checked /><b>Student</b><span>5 books · 10 days · ₹5 a day late</span></label>
        <label><input type="radio" name="kind" value="faculty" /><b>Faculty</b><span>10 books · 30 days · ₹2 a day late</span></label>
      </div>
      <label class="field">Full name<input class="input" name="name" required minlength="2" maxlength="120" /></label>
      <label class="field">Email<input class="input" name="email" type="email" required maxlength="160" /></label>
      <label class="field">Starting password<input class="input" name="password" required minlength="8" maxlength="128" value="welcome-${Math.random().toString(36).slice(2, 7)}" /></label>
      <button class="btn btn--lg">Issue library card</button>
    </form>`);
  $("#member-form").addEventListener("submit", (e) => {
    e.preventDefault();
    attempt(async () => {
      const m = await api("/api/admin/members", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
      toast(`Registered ${m.name}. Their card is ${m.card_no}.`);
      openMember(m.card_no);
      if (current() === "members") loadMembers(false);
    }, $("button", e.target));
  });
}

/* ---------- clicks ---------- */
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-book], [data-member], [data-prefill], [data-preset], [data-act], [data-signout], [data-return], [data-collect], [data-lost], [data-found]");
  if (!el) return;
  const d = el.dataset;
  if (d.book) openBook(d.book);
  else if (d.member) openMember(d.member);
  else if (d.prefill) prefill(d.prefill, d.copy);
  else if (d.preset) setFilter(...d.preset.split(":")); // the link itself then switches the view
  else if (d.act === "add-book") addBook();
  else if (d.act === "add-member") addMember();
  else if ("signout" in d) signOut();
  else if (d.return) {
    attempt(async () => {
      announceReturn(await api("/api/admin/return", { method: "POST", body: { barcode: d.return } }));
      refreshAll();
    }, el);
  } else if (d.collect) {
    attempt(async () => {
      const fine = await api(`/api/admin/fines/${d.collect}/pay`, { method: "POST" });
      toast(`Collected ${rupees(fine.amount)} from ${fine.member.name}.`);
      refreshAll();
    }, el);
  } else if (d.lost || d.found) {
    attempt(async () => {
      const barcode = d.lost || d.found;
      const c = await api(`/api/admin/items/${barcode}`, { method: "PATCH", body: { lost: Boolean(d.lost) } });
      toast(d.lost ? `${barcode} marked missing.` : `${barcode} is back ${c.status === "on_hold" ? "and held for the next reader" : "on the shelf"}.`);
      refreshAll();
    }, el);
  }
});

/* ---------- staff sign-in ---------- */
function renderWho() {
  $("#who").innerHTML = me
    ? `<span class="user">${avatar(me.name)}<span>${esc(firstName(me.name))}</span></span>
       <button type="button" class="icon-btn" data-signout aria-label="Sign out" title="Sign out"><i class="ph ph-sign-out"></i></button>`
    : "";
}

function showLogin() {
  me = null;
  renderWho();
  closeSheet($("#sheet"));
  $("#main").hidden = true;
  $("#tabs").hidden = true;
  $("#login").hidden = false;
  document.title = "Sign in · Shelfmark Admin";
}

function showApp() {
  renderWho();
  $("#login").hidden = true;
  $("#main").hidden = false;
  $("#tabs").hidden = false;
  route();
}

addEventListener("signedout", () => morph(showLogin));

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const button = $("button", f);
  $(".form-error", f).textContent = "";
  button.disabled = true;
  try {
    me = await api("/api/admin/login", { method: "POST", body: Object.fromEntries(new FormData(f)) });
    f.reset();
    await start();
  } catch (err) {
    $(".form-error", f).textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

async function signOut() {
  await api("/api/admin/logout", { method: "POST" }).catch(() => null);
  await morph(showLogin);
  $("#login-form").login.focus();
}

async function start() {
  const hour = new Date().getHours();
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  $("#today").textContent = `Good ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}, ${firstName(me.name)} · ${today}`;
  if (!subjects.length) {
    subjects = (await api("/api/stats")).subjects.map((s) => s.name);
    const options = subjects.map((s) => `<option>${esc(s)}</option>`).join("");
    $("#catalogue-subject").insertAdjacentHTML("beforeend", options);
    $("#subject-list").innerHTML = options;
  }
  await morph(showApp);
  if (current() === "counter" && matchMedia("(pointer: fine)").matches) issueForm.card_no.focus();
}

(async function boot() {
  me = await api("/api/admin/me").catch(() => null);
  if (!me) {
    showLogin();
    return $("#login-form").login.focus();
  }
  await start();
})();
