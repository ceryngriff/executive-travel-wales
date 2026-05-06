// Executive Travel Wales - Site JS

// Footer year
const y = document.getElementById("y");
if (y) y.textContent = new Date().getFullYear();

// ===== Header scroll effect =====
const siteHeader = document.querySelector(".site-header");
if (siteHeader) {
  window.addEventListener("scroll", () => {
    siteHeader.classList.toggle("scrolled", window.scrollY > 30);
  }, { passive: true });
}

// ===== Hero carousel =====
(function initHeroCarousel() {
  const hero = document.querySelector(".hero-carousel");
  if (!hero) return;

  const slides = Array.from(hero.querySelectorAll(".slide"));
  const prevBtn = hero.querySelector(".prev");
  const nextBtn = hero.querySelector(".next");
  const dotsWrap = hero.querySelector(".dots");

  if (!slides.length || !prevBtn || !nextBtn || !dotsWrap) return;

  slides.forEach((s, i) => s.classList.toggle("is-active", i === 0));
  let index = 0;

  dotsWrap.innerHTML = "";
  const dots = slides.map((_, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", `Go to slide ${i + 1}`);
    b.addEventListener("click", () => show(i, true));
    dotsWrap.appendChild(b);
    return b;
  });

  function render() {
    slides.forEach((s, i) => s.classList.toggle("is-active", i === index));
    dots.forEach((d, i) => d.setAttribute("aria-current", i === index ? "true" : "false"));
  }

  function show(i, user = false) {
    index = (i + slides.length) % slides.length;
    render();
    if (user) restart();
  }

  function next() { show(index + 1, true); }
  function prev() { show(index - 1, true); }

  prevBtn.addEventListener("click", prev);
  nextBtn.addEventListener("click", next);

  // Touch/swipe support
  let touchStartX = 0;
  let touchEndX = 0;
  hero.addEventListener("touchstart", (e) => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });
  hero.addEventListener("touchend", (e) => {
    touchEndX = e.changedTouches[0].screenX;
    const diff = touchStartX - touchEndX;
    if (Math.abs(diff) > 50) {
      diff > 0 ? next() : prev();
    }
  }, { passive: true });

  let timer = null;
  function start() { stop(); timer = setInterval(() => show(index + 1), 6000); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function restart() { stop(); start(); }

  hero.addEventListener("mouseenter", stop);
  hero.addEventListener("mouseleave", start);
  hero.addEventListener("focusin", stop);
  hero.addEventListener("focusout", start);

  render();
  start();
})();

// ===== Scroll reveal (IntersectionObserver) =====
(function initReveal() {
  const reveals = document.querySelectorAll(".reveal");
  if (!reveals.length) return;

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.12,
      rootMargin: "0px 0px -50px 0px"
    });

    reveals.forEach((el) => observer.observe(el));
  } else {
    // Fallback: show all immediately
    reveals.forEach((el) => el.classList.add("is-visible"));
  }
})();

// ===== Back to top button =====
(function initBackToTop() {
  const btn = document.querySelector(".back-to-top");
  if (!btn) return;

  window.addEventListener("scroll", () => {
    btn.classList.toggle("visible", window.scrollY > 500);
  }, { passive: true });

  btn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
})();

// ===== Form submissions via Web3Forms =====
function handleWeb3Form(form, successId) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";

    try {
      const res = await fetch("https://api.web3forms.com/submit", {
        method: "POST",
        body: new FormData(form),
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById(successId)?.classList.remove("hidden");
        form.reset();
      } else {
        alert("Something went wrong. Please try calling us instead.");
      }
    } catch {
      alert("Network error. Please try calling us instead.");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

const quoteForm = document.getElementById("quoteForm");
if (quoteForm) handleWeb3Form(quoteForm, "quote-success");

const contactForm = document.getElementById("contactForm");
if (contactForm) handleWeb3Form(contactForm, "contact-success");

// ===== Fleet lightbox gallery =====
(function initFleetLightbox() {
  const cards = document.querySelectorAll(".fleet-card");
  const lightbox = document.getElementById("fleetLightbox");
  if (!cards.length || !lightbox) return;

  const titleEl = lightbox.querySelector(".lightbox-title");
  const imageEl = lightbox.querySelector(".lightbox-image");
  const counterEl = lightbox.querySelector(".lightbox-counter");
  const thumbsEl = lightbox.querySelector(".lightbox-thumbs");
  const prevBtn = lightbox.querySelector(".lightbox-prev");
  const nextBtn = lightbox.querySelector(".lightbox-next");
  const closeEls = lightbox.querySelectorAll("[data-lightbox-close]");

  let images = [];
  let index = 0;
  let lastFocus = null;

  function parseGallery(card) {
    const raw = card.getAttribute("data-gallery-images") || "";
    return raw.split(",").map((entry) => {
      const [src, alt] = entry.split("|").map((s) => (s || "").trim());
      return { src, alt: alt || "" };
    }).filter((item) => item.src);
  }

  function renderThumbs() {
    thumbsEl.innerHTML = "";
    images.forEach((img, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-label", `Show photo ${i + 1}`);
      btn.setAttribute("aria-selected", i === index ? "true" : "false");
      const t = document.createElement("img");
      t.src = img.src;
      t.alt = "";
      t.loading = "lazy";
      btn.appendChild(t);
      btn.addEventListener("click", () => show(i));
      thumbsEl.appendChild(btn);
    });
  }

  function update() {
    const current = images[index];
    if (!current) return;
    imageEl.src = current.src;
    imageEl.alt = current.alt;
    counterEl.textContent = `${index + 1} / ${images.length}`;
    Array.from(thumbsEl.children).forEach((b, i) => {
      b.setAttribute("aria-selected", i === index ? "true" : "false");
      if (i === index) b.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    });
    const single = images.length <= 1;
    prevBtn.disabled = single;
    nextBtn.disabled = single;
  }

  function show(i) {
    if (!images.length) return;
    index = (i + images.length) % images.length;
    update();
  }

  function open(card) {
    images = parseGallery(card);
    if (!images.length) return;
    titleEl.textContent = card.getAttribute("data-gallery-title") || "Gallery";
    index = 0;
    renderThumbs();
    update();
    lastFocus = document.activeElement;
    lightbox.hidden = false;
    document.body.classList.add("lightbox-open");
    setTimeout(() => closeEls[closeEls.length - 1]?.focus(), 0);
  }

  function close() {
    lightbox.hidden = true;
    document.body.classList.remove("lightbox-open");
    imageEl.src = "";
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  cards.forEach((card) => {
    card.addEventListener("click", () => open(card));
  });

  prevBtn.addEventListener("click", () => show(index - 1));
  nextBtn.addEventListener("click", () => show(index + 1));
  closeEls.forEach((el) => el.addEventListener("click", close));

  document.addEventListener("keydown", (e) => {
    if (lightbox.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") show(index - 1);
    else if (e.key === "ArrowRight") show(index + 1);
  });

  // Touch/swipe within stage
  const stage = lightbox.querySelector(".lightbox-stage");
  let sx = 0;
  stage.addEventListener("touchstart", (e) => { sx = e.changedTouches[0].screenX; }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    const dx = sx - e.changedTouches[0].screenX;
    if (Math.abs(dx) > 50) (dx > 0 ? show(index + 1) : show(index - 1));
  }, { passive: true });
})();
