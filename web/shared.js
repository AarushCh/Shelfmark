// Helpers shared by the landing page, the catalog and Shelfmark Admin.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && data.detail;
    const message = Array.isArray(detail)
      ? detail.map((d) => `${d.loc.at(-1)}: ${d.msg}`).join(" · ")
      : detail || `Request failed (${res.status})`;
    throw Object.assign(new Error(message), { status: res.status });
  }
  return data;
}

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const coverUrl = (id, size = "M") => (id ? `https://covers.openlibrary.org/b/id/${id}-${size}.jpg` : "");

const shortDate = (iso) =>
  iso ? new Date(iso.length === 10 ? iso + "T00:00" : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—";

const rupees = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  if (s < 86400 * 30) return Math.floor(s / 86400) + "d";
  return shortDate(iso);
}

const firstName = (name) => name.replace(/^Dr\.?\s+/, "").split(/\s+/)[0];
const initials = (name) =>
  name.replace(/^Dr\.?\s+/, "").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

/* ---------- small pieces of markup ---------- */
const tag = (text, tone = "") => `<span class="tag${tone ? " tag--" + tone : ""}">${esc(text)}</span>`;
const avatar = (name, size = "") => `<span class="avatar${size ? " avatar--" + size : ""}" aria-hidden="true">${esc(initials(name))}</span>`;
const thumb = (book) =>
  `<span class="thumb" style="--hue:${hue(book.title)}${book.cover_id ? `;--cover:url('${coverUrl(book.cover_id, "S")}')` : ""}"></span>`;
const empty = (text) => `<p class="empty">${text}</p>`;
// Under every cover image sits a plain jacket in a colour picked from the title, so a cover that is slow or
// missing still looks like a book instead of a broken image.
const hue = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const coverImg = (book, size = "M") =>
  `<span class="book__blank" style="--hue:${hue(book.title)}"><b>${esc(book.title)}</b><small>${esc(book.author || "")}</small></span>` +
  (book.cover_id ? `<img src="${coverUrl(book.cover_id, size)}" alt="" loading="lazy" onerror="coverFailed(this)" />` : "");

// Open Library serves covers through archive.org, which now and then answers 502: try once more before giving up.
function coverFailed(img) {
  if (img.src.endsWith("?default=false")) return img.remove();
  img.src += "?default=false";
}

const row = ({ lead = "", title, sub = "", side = "" }) => `
  <div class="row">${lead}
    <div class="row__main"><div class="row__title">${title}</div>${sub ? `<div class="row__sub">${sub}</div>` : ""}</div>
    ${side ? `<div class="row__side">${side}</div>` : ""}
  </div>`;

const availability = (b) =>
  b.available ? tag(`${b.available} on the shelf`, "ok") : tag(b.queue ? `out · ${b.queue} waiting` : "all out", "warn");

const bookCard = (b, i = 0) => `
  <a class="book" href="/catalog?book=${b.id}" data-book="${b.id}" style="--i:${i % 12}">
    <span class="book__cover">${coverImg(b)}</span>
    <span class="book__title">${esc(b.title)}</span>
    <span class="book__by">${esc(b.author)}</span>
    ${availability(b)}
  </a>`;

/* ---------- feedback ---------- */
// Toasts live in a popover so they also show above an open modal dialog.
function toast(message, tone = "") {
  let box = $("#toasts");
  if (!box) {
    box = Object.assign(document.createElement("div"), { id: "toasts", className: "toasts" });
    box.setAttribute("popover", "manual");
    box.setAttribute("aria-live", "polite");
    document.body.append(box);
  }
  const el = Object.assign(document.createElement("div"), { className: `toast${tone ? " toast--" + tone : ""}`, textContent: message });
  box.append(el);
  if (box.showPopover) {
    if (box.matches(":popover-open")) box.hidePopover();
    box.showPopover();
  }
  setTimeout(() => {
    el.classList.add("is-leaving");
    setTimeout(() => {
      el.remove();
      if (!box.children.length && box.matches?.(":popover-open")) box.hidePopover();
    }, 300);
  }, 4200);
}

// Runs an action, disabling its button meanwhile and reporting failures. A 401 tells the page to ask for a sign-in.
async function attempt(work, button) {
  if (button) button.disabled = true;
  try {
    return await work();
  } catch (err) {
    toast(err.message, "error");
    if (err.status === 401) dispatchEvent(new Event("signedout"));
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

// Puts html into an element and numbers the rows of every list in it so they cascade in;
// `animate = false` swaps them quietly (used for background refreshes).
function fill(el, html, animate = true) {
  el.innerHTML = html;
  for (const list of [el, ...el.querySelectorAll(".list")]) {
    list.classList.toggle("still", !animate);
    [...list.children].forEach((child, i) => child.style.setProperty("--i", Math.min(i, 14)));
  }
}

// Counts a number up (or down) to its new value.
function countTo(el, to, format = (n) => n.toLocaleString("en-IN")) {
  const from = Number(el.dataset.value || 0);
  el.dataset.value = to;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === to) return (el.textContent = format(to));
  const start = performance.now();
  (function tick(now) {
    const p = Math.min(1, (now - start) / 900);
    el.textContent = format(Math.round(from + (to - from) * (1 - (1 - p) ** 3)));
    if (p < 1) requestAnimationFrame(tick);
  })(start);
}

// Same-page changes (signing in or out) cross-fade where the browser can.
async function morph(update) {
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return update();
  const transition = document.startViewTransition(update);
  transition.ready.catch(() => null); // skipped (say, in a background tab): the update still happens, just without the fade
  await transition.updateCallbackDone;
}

// The same goes for the cross-fade between pages, which the browser drops on a reload.
addEventListener("pagereveal", (e) => e.viewTransition?.ready.catch(() => null));

/* ---------- page chrome ---------- */
// The top bar picks up a backdrop once the page scrolls under it.
const topbar = $(".topbar");
const stick = () => topbar.classList.toggle("is-stuck", scrollY > 4);
addEventListener("scroll", stick, { passive: true });
stick();

// Slides a .tabs highlight under its current item.
function slide(tabs) {
  const on = tabs.querySelector("[aria-current], [aria-pressed=\"true\"]");
  tabs.style.setProperty("--x", `${on ? on.offsetLeft : 0}px`);
  tabs.style.setProperty("--w", `${on ? on.offsetWidth : 0}px`);
  requestAnimationFrame(() => tabs.classList.add("is-ready"));
}
const slideAll = () => $$(".tabs").forEach(slide);
addEventListener("resize", debounce(slideAll, 100));
document.fonts?.ready.then(slideAll);

// Sheets fade out instead of vanishing: close buttons, backdrop clicks and Escape all come through here.
function closeSheet(dialog) {
  if (!dialog?.open || dialog.classList.contains("is-closing")) return;
  dialog.classList.add("is-closing");
  const done = (e) => {
    if (e.target !== dialog) return;
    dialog.removeEventListener("animationend", done);
    if (!dialog.classList.contains("is-closing")) return; // reopened while fading out
    dialog.classList.remove("is-closing");
    dialog.close();
  };
  dialog.addEventListener("animationend", done);
}

function openSheet(dialog) {
  dialog.classList.remove("is-closing");
  if (!dialog.open) dialog.showModal();
}

document.addEventListener("click", (e) => {
  if (e.target.matches("dialog[open]:not([data-locked])")) closeSheet(e.target);
  else if (e.target.closest("[data-close]")) closeSheet(e.target.closest("dialog"));
  for (const menu of $$("details.menu[open]")) if (!menu.contains(e.target)) menu.open = false;
});

document.addEventListener("cancel", (e) => {
  if (!e.target.matches("dialog")) return;
  e.preventDefault();
  if (!e.target.hasAttribute("data-locked")) closeSheet(e.target);
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") for (const menu of $$("details.menu[open]")) menu.open = false;
});
