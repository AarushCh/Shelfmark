// Tiny helpers shared by the three pages.
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

const initials = (name) =>
  name.replace(/^Dr\.?\s+/, "").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

const store = {
  get(key, fallback = null) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};
