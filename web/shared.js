// Helpers shared by the landing page, the catalog and the desk.
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
const thumb = (book) => `<span class="thumb"${book.cover_id ? ` style="background-image:url('${coverUrl(book.cover_id, "S")}')"` : ""}></span>`;
const empty = (text) => `<p class="empty">${text}</p>`;
// The title sits under the cover image, so a cover that fails to load leaves a plain jacket rather than a broken icon.
const coverImg = (book, size = "M") =>
  `<span class="book__blank">${esc(book.title)}</span>` +
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

/* ---------- page chrome ---------- */
// The top bar picks up a backdrop once the page scrolls under it.
const topbar = $(".topbar");
const stick = () => topbar.classList.toggle("is-stuck", scrollY > 4);
addEventListener("scroll", stick, { passive: true });
stick();

// Close buttons and backdrop clicks dismiss a dialog, unless it's locked (the desk's sign-in).
document.addEventListener("click", (e) => {
  if (e.target.matches("dialog[open]:not([data-locked])")) e.target.close();
  else if (e.target.closest("[data-close]")) e.target.closest("dialog")?.close();
});
