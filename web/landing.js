// Landing page: bubble parallax, live figures, the most borrowed titles, subject shelves and the how-it-works cards.
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ICONS = {
  "Fantasy": "ph-castle-turret", "Science Fiction": "ph-rocket-launch", "Mystery": "ph-detective", "Romance": "ph-heart-half",
  "Horror": "ph-skull", "Historical Fiction": "ph-scroll", "Poetry": "ph-feather", "Biography": "ph-identification-card",
  "History": "ph-hourglass-medium", "Science": "ph-atom", "Philosophy": "ph-yin-yang", "Programming": "ph-terminal-window",
  "Indian Fiction": "ph-flower-lotus", "Young Adult": "ph-backpack", "Graphic Novels": "ph-chat-teardrop-text",
  "Psychology": "ph-brain", "Business": "ph-chart-line-up", "Self-Help": "ph-plant",
};

/* ---------- the glass bubbles drift with the pointer at three depths ---------- */
(function bubbles() {
  if (still) return $(".liquid-scene").pauseAnimations();
  const layers = [["#mainParallax", 1], ["#secondaryParallax", 1.55], ["#dropParallax", 2.15]].map(([sel, depth]) => [$(sel), depth]);
  let targetX = 0, targetY = 0, x = 0, y = 0;
  addEventListener("pointermove", (e) => {
    targetX = (e.clientX / innerWidth - 0.5) * 90;
    targetY = (e.clientY / innerHeight - 0.5) * 65;
  });
  document.documentElement.addEventListener("mouseleave", () => (targetX = targetY = 0));
  (function frame() {
    x += (targetX - x) * 0.025;
    y += (targetY - y) * 0.025;
    for (const [el, depth] of layers) el.style.transform = `translate(${x * depth}px, ${y * depth}px)`;
    requestAnimationFrame(frame);
  })();
})();

/* ---------- the top bar follows the section you're reading ---------- */
const spy = $("#spy");
const sections = ["popular", "subjects", "how"].map((id) => document.getElementById(id));
let spying = false;
function follow() {
  spying = false;
  const current = sections.filter((s) => s.getBoundingClientRect().top < innerHeight * 0.45).pop();
  for (const tab of $$(".tab", spy)) {
    if (current && tab.hash === `#${current.id}`) tab.setAttribute("aria-current", "location");
    else tab.removeAttribute("aria-current");
  }
  slide(spy);
}
addEventListener("scroll", () => spying || (spying = requestAnimationFrame(follow)), { passive: true });
follow();

/* ---------- sections fade up as they scroll in ---------- */
const revealer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-in");
      revealer.unobserve(entry.target);
    }
  },
  { rootMargin: "0px 0px -8% 0px" }
);
const reveal = () => $$(".reveal:not(.is-in)").forEach((el) => revealer.observe(el));

/* ---------- shelf tiles lean toward the pointer ---------- */
$("#shelves").addEventListener("pointermove", (e) => {
  const tile = e.target.closest(".shelf-tile");
  if (!tile || still || e.pointerType !== "mouse") return;
  const r = tile.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  tile.style.setProperty("--ry", `${(px - 0.5) * 14}deg`);
  tile.style.setProperty("--rx", `${(0.5 - py) * 14}deg`);
  tile.style.setProperty("--mx", `${px * 100}%`);
  tile.style.setProperty("--my", `${py * 100}%`);
});
$("#shelves").addEventListener("pointerout", (e) => {
  const tile = e.target.closest(".shelf-tile");
  if (tile && !tile.contains(e.relatedTarget)) ["--rx", "--ry"].forEach((p) => tile.style.removeProperty(p));
});

/* ---------- how-it-works cards turn over on tap (hover does it with a mouse) ---------- */
for (const step of $$(".step")) {
  step.addEventListener("click", () => step.setAttribute("aria-pressed", step.getAttribute("aria-pressed") !== "true"));
}

/* ---------- live data ---------- */
async function load() {
  const [stats, me] = await Promise.all([api("/api/stats"), api("/api/auth/me").catch(() => null)]);
  if (me) $("#who").innerHTML = `<a class="user" href="/catalog#shelf">${avatar(me.name)}<span>${esc(firstName(me.name))}</span></a>`;
  $("#intro").textContent =
    `Search ${stats.titles} titles across ${stats.subjects.length} subjects, see the exact rack a copy sits on, ` +
    `reserve what's out and hear the moment it's back.`;
  $$("[data-stat]").forEach((el) => countTo(el, el.dataset.stat === "subjects" ? stats.subjects.length : stats[el.dataset.stat]));

  $("#popular-books").innerHTML = stats.popular.map(bookCard).join("");
  $$("#popular-books .book").forEach((card, i) => {
    card.classList.add("reveal");
    card.style.setProperty("--i", i);
  });

  $("#subjects-kicker").textContent = `${stats.subjects.length} subjects`;
  $("#shelves").innerHTML = stats.subjects
    .map((s, i) => `
      <a class="shelf-tile reveal" style="--i:${i}" href="/catalog?subject=${encodeURIComponent(s.name)}">
        <span class="shelf-tile__fan" aria-hidden="true">${s.covers
          .map((src) => `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()" />`)
          .join("")}</span>
        <span class="tile shelf-tile__face">
          <i class="ph ${ICONS[s.name] || "ph-books"} shelf-tile__icon" aria-hidden="true"></i>
          <span class="shelf-tile__name">${esc(s.name)}</span>
          <span class="shelf-tile__count">${s.titles} titles <i class="ph ph-arrow-up-right" aria-hidden="true"></i></span>
        </span>
      </a>`)
    .join("");
}

load()
  .catch(() => ($("#popular-books").innerHTML = empty("The catalogue is waking up. Refresh in a few seconds.")))
  .finally(reveal);
