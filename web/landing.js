// Landing page: bubble parallax, live figures, the most borrowed titles and the subject shelves.
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ICONS = {
  "Fantasy": "ph-castle-turret", "Science Fiction": "ph-rocket-launch", "Mystery": "ph-detective", "Romance": "ph-heart-half",
  "Horror": "ph-skull", "Historical Fiction": "ph-scroll", "Poetry": "ph-feather", "Biography": "ph-identification-card",
  "History": "ph-hourglass-medium", "Science": "ph-atom", "Philosophy": "ph-brain", "Programming": "ph-terminal-window",
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

function countUp(el, target) {
  if (still) return (el.textContent = target.toLocaleString("en-IN"));
  const start = performance.now();
  (function tick(now) {
    const p = Math.min(1, (now - start) / 1400);
    el.textContent = Math.round(target * (1 - (1 - p) ** 3)).toLocaleString("en-IN");
    if (p < 1) requestAnimationFrame(tick);
  })(start);
}

/* ---------- live data ---------- */
async function load() {
  const [stats, me] = await Promise.all([api("/api/stats"), api("/api/auth/me").catch(() => null)]);
  if (me) {
    const href = me.role === "librarian" ? "/desk" : "/catalog#shelf";
    $("#who").innerHTML = `<a class="user" href="${href}">${avatar(me.name)}<span>${esc(firstName(me.name))}</span></a>`;
  }
  $("#intro").textContent =
    `Search ${stats.titles} titles across ${stats.subjects.length} subjects, see the exact rack a copy sits on, ` +
    `reserve what's out and hear the moment it's back.`;
  $$("[data-stat]").forEach((el) => countUp(el, stats[el.dataset.stat]));
  $("#popular-books").innerHTML = stats.popular.map(bookCard).join("");
  $("#subjects-kicker").textContent = `${stats.subjects.length} subjects`;
  $("#shelves").innerHTML = stats.subjects
    .map((s, i) => `
      <a class="tile shelf-tile reveal" style="--i:${i}" href="/catalog?subject=${encodeURIComponent(s.name)}">
        <i class="ph ${ICONS[s.name] || "ph-books"}" aria-hidden="true"></i>
        <span><span class="shelf-tile__name">${esc(s.name)}</span><span class="shelf-tile__count">${s.titles} titles</span></span>
      </a>`)
    .join("");
}

load()
  .catch(() => ($("#popular-books").innerHTML = empty("The catalogue is waking up. Refresh in a few seconds.")))
  .finally(reveal);
