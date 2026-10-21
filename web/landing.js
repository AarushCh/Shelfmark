// Landing page: glass-bubble parallax, live catalogue figures, GSAP-driven stacks and featured cards.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const arrow =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" /></svg>';

/* ---------- glass bubbles follow the pointer at three depths ---------- */
(function bubbles() {
  if (reduceMotion) {
    document.querySelector(".liquid-scene").pauseAnimations();
    return;
  }
  const layers = [["#mainParallax", 1], ["#secondaryParallax", 1.55], ["#dropParallax", 2.15]].map(([sel, depth]) => [
    document.querySelector(sel),
    depth,
  ]);
  const INTENSITY = 0.5;
  const SMOOTHNESS = 0.025;
  let targetX = 0, targetY = 0, x = 0, y = 0;
  addEventListener("pointermove", (e) => {
    targetX = (e.clientX / innerWidth - 0.5) * 180 * INTENSITY;
    targetY = (e.clientY / innerHeight - 0.5) * 130 * INTENSITY;
  });
  document.documentElement.addEventListener("mouseleave", () => (targetX = targetY = 0));
  (function frame() {
    x += (targetX - x) * SMOOTHNESS;
    y += (targetY - y) * SMOOTHNESS;
    for (const [el, depth] of layers) el.style.transform = `translate(${x * depth}px, ${y * depth}px)`;
    requestAnimationFrame(frame);
  })();
})();

/* ---------- live data ---------- */
async function load() {
  const [stats, me] = await Promise.all([api("/api/stats"), api("/api/auth/me").catch(() => null)]);

  if (me) {
    const link = document.getElementById("account-link");
    const desk = me.role === "librarian";
    link.href = desk ? "/desk" : "/catalog#account";
    link.classList.add("is-signed-in");
    link.lastElementChild.textContent = (desk ? "DESK · " : "") + me.name.replace(/^Dr\.?\s+/, "").split(" ")[0];
  }

  const subjects = stats.subjects.length;
  document.getElementById("intro").textContent =
    `Search ${stats.titles} titles across ${subjects} subjects, see the exact rack a copy sits on, ` +
    `reserve what's out and hear the moment it's back.`;
  document.getElementById("meta-available").textContent = `${stats.available} COPIES FREE`;
  document.getElementById("featured-kicker").textContent = `${stats.titles} TITLES · ${subjects} SUBJECTS · ONE CARD`;

  const busiest = [...stats.subjects].sort((a, b) => b.loans - a.loans).slice(0, 3);
  document.querySelectorAll(".pill").forEach((pill, i) => {
    const s = busiest[i];
    if (!s) return pill.remove();
    pill.querySelector(".label-tile").innerHTML =
      `<span class="lbl">${s.name.split(" ").map(esc).join("<br />")}</span><span class="sub">${s.titles} titles</span>`;
    pill.querySelector(".tools-tile").innerHTML = s.top
      .map((b) => `<a class="t" href="/catalog?book=${b.id}" title="${esc(b.title)}"><span>${esc(b.title)}</span></a>`)
      .join("");
  });

  document.getElementById("featured-grid").innerHTML = stats.popular
    .map(
      (b) => `
      <a class="f-card" href="/catalog?book=${b.id}">
        <div class="f-card-top">
          <div class="f-mini" style="background-image:url('${coverUrl(b.cover_id, "S")}')">${b.cover_id ? "" : esc(b.title[0])}</div>
          <span class="f-tag">${esc(b.subject)} · ${b.year ?? "—"}</span>
        </div>
        <h3>${esc(b.title)}</h3>
        <p class="by">${esc(b.author)}</p>
        <p>${esc(b.description || "")}</p>
        <div class="url">${b.available} of ${b.copies} on the shelf ${arrow}</div>
      </a>`
    )
    .join("");

  document.querySelectorAll(".cta-stat .num[data-key]").forEach((el) => (el.dataset.count = stats[el.dataset.key]));
}

/* ---------- motion (3D data cards choreography) ---------- */
function countUp(instant) {
  document.querySelectorAll(".cta-stat .num").forEach((el) => {
    const target = Number(el.dataset.count || 0);
    const span = el.querySelector("span");
    if (instant || !window.gsap) return (span.textContent = target.toLocaleString());
    gsap.to({ v: 0 }, {
      v: target,
      duration: 1.8,
      ease: "power2.out",
      onUpdate() {
        span.textContent = Math.floor(this.targets()[0].v).toLocaleString();
      },
    });
  });
}

function animate() {
  if (!window.gsap || reduceMotion) return countUp(true);
  gsap.registerPlugin(ScrollTrigger);

  document.querySelectorAll(".arc").forEach((arc) => {
    const c = 2 * Math.PI * arc.r.baseVal.value;
    arc.style.strokeDasharray = c;
    arc.style.strokeDashoffset = c;
  });
  gsap.set(".top-divider .line", { scaleX: 0, transformOrigin: "center" });
  gsap.set(".top-divider .dot", { scale: 0 });
  gsap.set(".pill", { y: 80, opacity: 0, scale: 0.96 });
  gsap.set(".tools-tile .t, .label-tile > *", { y: 16, opacity: 0 });
  gsap.set("#reinvent", { opacity: 0, y: 10 });

  gsap
    .timeline({ defaults: { ease: "power3.out" }, scrollTrigger: { trigger: ".poster", start: "top 70%" } })
    .to(".top-divider .line", { scaleX: 1, duration: 0.9, ease: "power3.inOut" }, 0.1)
    .to(".top-divider .dot", { scale: 1, duration: 0.6, ease: "back.out(1.8)" }, 0.6)
    .to(".arc", { strokeDashoffset: (i, el) => Math.PI * el.r.baseVal.value, duration: 2.4, stagger: 0.12, ease: "power2.inOut" }, 0.4)
    .to(".pill", { y: 0, opacity: 1, scale: 1, duration: 1.1, stagger: 0.15, ease: "back.out(1.3)" }, 0.6)
    .to(".label-tile > *", { y: 0, opacity: 1, duration: 0.7, stagger: 0.15 }, 1.0)
    .to(".tools-tile .t", { y: 0, opacity: 1, duration: 0.55, stagger: 0.04 }, 1.15)
    .to("#reinvent", { opacity: 1, y: 0, duration: 0.8 }, 1.9);

  gsap.to(".arc", { opacity: 0.4, duration: 3, stagger: 0.3, delay: 2.5, ease: "sine.inOut", yoyo: true, repeat: -1 });

  // pills: 3D tilt + lift under the pointer
  document.querySelectorAll(".pill").forEach((pill) => {
    pill.addEventListener("mousemove", (e) => {
      const r = pill.getBoundingClientRect();
      gsap.to(pill, {
        rotateX: -((e.clientY - r.top) / r.height - 0.5) * 6,
        rotateY: ((e.clientX - r.left) / r.width - 0.5) * 6,
        y: -6,
        duration: 0.5,
        ease: "power2.out",
        transformPerspective: 1200,
        overwrite: "auto",
      });
    });
    pill.addEventListener("mouseleave", () =>
      gsap.to(pill, { rotateX: 0, rotateY: 0, y: 0, duration: 0.8, ease: "elastic.out(1, 0.6)", overwrite: "auto" })
    );
  });

  // arcs drift with the pointer
  const poster = document.querySelector(".poster");
  const arcs = document.getElementById("arcs");
  let mx = 0, my = 0, ax = 0, ay = 0;
  poster.addEventListener("mousemove", (e) => {
    const r = poster.getBoundingClientRect();
    mx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    my = ((e.clientY - r.top) / r.height - 0.5) * 2;
  });
  poster.addEventListener("mouseleave", () => (mx = my = 0));
  (function drift() {
    ax += (mx - ax) * 0.05;
    ay += (my - ay) * 0.05;
    arcs.style.translate = `${ax * 18}px ${ay * 10}px`;
    requestAnimationFrame(drift);
  })();

  // scrolling through the stacks fans the pills apart
  const pills = gsap.utils.toArray(".pill");
  ScrollTrigger.create({
    trigger: ".poster",
    start: "center center",
    end: "bottom top",
    scrub: 0.8,
    onUpdate: ({ progress: p }) => {
      if (pills[0]) gsap.set(pills[0], { x: -180 * p, rotation: -2 * p });
      if (pills[1]) gsap.set(pills[1], { scale: 1 - 0.04 * p });
      if (pills[2]) gsap.set(pills[2], { x: 180 * p, rotation: 2 * p });
      gsap.set("#arcs", { scale: 1 + 0.15 * p });
    },
  });

  gsap.from(".kicker, .featured-head h2, .featured-head p", {
    opacity: 0, y: 30, duration: 0.6, stagger: 0.1, ease: "power3.out",
    scrollTrigger: { trigger: ".featured-head", start: "top 85%" },
  });
  gsap.from(".f-card", {
    opacity: 0, y: 70, scale: 0.94, duration: 1, stagger: 0.1, ease: "back.out(1.3)", clearProps: "transform,opacity",
    scrollTrigger: { trigger: ".featured-grid", start: "top 85%" },
  });
  document.querySelectorAll(".f-card").forEach((card) => {
    const mini = card.querySelector(".f-mini");
    card.addEventListener("mouseenter", () => gsap.to(mini, { rotate: -8, y: -4, scale: 1.08, duration: 0.5, ease: "back.out(1.6)" }));
    card.addEventListener("mouseleave", () => gsap.to(mini, { rotate: 0, y: 0, scale: 1, duration: 0.6, ease: "elastic.out(1, 0.6)" }));
  });

  gsap.from(".cta-inner", { y: 80, scale: 0.95, opacity: 0, duration: 1.2, ease: "power3.out", scrollTrigger: { trigger: ".cta-section", start: "top 80%" } });
  ScrollTrigger.create({ trigger: ".cta-section", start: "top 75%", once: true, onEnter: () => countUp(false) });
  addEventListener("load", () => ScrollTrigger.refresh());
}

load()
  .catch(() => {
    document.getElementById("featured-grid").innerHTML =
      '<p class="f-card">The catalogue is waking up. Refresh in a few seconds.</p>';
  })
  .finally(animate);
