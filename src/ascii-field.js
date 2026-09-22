// Vanilla JavaScript player: no animation library; only visible frames are drawn.
export function attachAsciiField(canvas, section) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const images = new Map();
  let dead = false,
    visible = false,
    raf = 0,
    last = 0,
    elapsed = 0,
    frame = -1;
  const count = 48;
  function load(index) {
    if (images.has(index)) return;
    const image = new Image();
    images.set(index, image);
    image.src = `/media/ascii/frame-${String(index).padStart(3, "0")}.webp`;
  }
  function draw(now) {
    raf = 0;
    if (dead || !visible) return;
    const delta = last ? Math.min(100, now - last) : 0;
    last = now;
    elapsed += delta;
    const bounds = section.getBoundingClientRect();
    const progress = Math.max(
      0,
      Math.min(1, -bounds.top / Math.max(1, bounds.height - innerHeight)),
    );
    const target = reduced.matches
      ? 0
      : Math.floor((elapsed / 1000) * 12 + progress * count) % count;
    load(target);
    load((target + 1) % count);
    load((target + 2) % count);
    const image = images.get(target);
    if (image?.complete && image.naturalWidth && frame !== target) {
      canvas
        .getContext("2d", { alpha: false })
        .drawImage(image, 0, 0, 854, 480);
      frame = target;
      canvas.dataset.frame = String(frame);
    }
    // All 48 frames (about 2 MB) stay cached once loaded, so a long-open page never re-requests them.
    if (!reduced.matches || frame < 0) raf = requestAnimationFrame(draw);
  }
  const start = () => {
    if (!raf && visible) {
      last = 0;
      raf = requestAnimationFrame(draw);
    }
  };
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) start();
    else {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    }
  });
  observer.observe(canvas);
  reduced.addEventListener("change", start);
  return () => {
    dead = true;
    cancelAnimationFrame(raf);
    observer.disconnect();
    reduced.removeEventListener("change", start);
    images.clear();
  };
}
