import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  createTimeline,
  onScroll,
  utils,
  stagger,
  createAnimatable,
} from "animejs";
import { Icon } from "./ui.jsx";
import AsciiField from "./AsciiField.jsx";
import "./flow.css";
const positions = ["tr", "tl", "bl", "br"];
const sides = ["top", "left", "bottom", "right"];
export default function ReferenceFlow({ steps }) {
  const root = useRef(),
    canvas = useRef(),
    center = useRef(),
    [fallback, setFallback] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(
    () => matchMedia("(width < 58.75rem)").matches,
  );
  useEffect(() => {
    const m = matchMedia("(width < 58.75rem)");
    const update = () => setMobileLayout(m.matches);
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    setFallback(false);
    const section = root.current,
      query = (s) => Array.from(section.querySelectorAll(s));
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) {
      setFallback(true);
      return;
    }
    let cleanup = () => {},
      disposed = false;
    const setup = async () => {
      const { createFlowScene } = await import("./FlowScene.js");
      if (disposed) return;
      const progress = { value: 0 };
      let scene;
      try {
        scene = createFlowScene(canvas.current, center.current, progress);
      } catch {
        setFallback(true);
        return;
      }
      const mobile = matchMedia("(width < 58.75rem)").matches;
      const labels = query(".label-container"),
        labelsBorder = query(".labels-border")[0],
        edges = query(".edges line"),
        rectangle = center.current;
      const parallax = createAnimatable([labelsBorder, ...labels], {
        x: 800,
        y: 800,
        ease: "outExpo",
      });
      let currentTime = 0,
        frame = 0,
        visible = false,
        snapTimer,
        snapping = false;
      const timeline = createTimeline({
        autoplay: onScroll({
          target: section,
          enter: "top+=30% top",
          leave: "bottom bottom",
          sync: 0.75,
        }),
        onUpdate: ({ currentTime: t }) => {
          currentTime = t;
          section.dataset.phase =
            t < 250 ? "intro" : t < 650 ? "stages" : "outro";
          query(".intro-text")[0].style.visibility =
            t < 250 ? "visible" : "hidden";
          query(".outro-text")[0].style.visibility =
            t >= 650 ? "visible" : "hidden";
          canvas.current.style.visibility =
            t >= 200 && t < 650 ? "visible" : "hidden";
          if (t < 650) {
            parallax.x(0);
            parallax.y(0);
          }
        },
      });
      timeline
        .add(rectangle, { opacity: [0, 1], duration: 100 }, 0)
        .add(rectangle, { scale: [0.85, 1], rotate: [25, 0], duration: 200 }, 0)
        .add(
          query(".intro-text,.label"),
          { rotate: [-25, 0], duration: 200 },
          0,
        )
        .add(
          query(".word-cover"),
          { scaleY: 0, delay: stagger(25), duration: 50 },
          0,
        )
        .add(
          query(".rectangle>.line.top,.rectangle>.line.bottom"),
          { scaleX: [0, 1], duration: 200 },
          0,
        )
        .add(
          query(".rectangle>.line.left,.rectangle>.line.right"),
          { scaleY: [0, 1], duration: 200 },
          0,
        )
        .set(query(".rectangle>.line"), { opacity: 0 }, 200)
        .set(query(".label-container>.line"), { opacity: 1 }, 200)
        .add(
          query(".intro-text"),
          { opacity: 0, scale: 0.85, duration: 50 },
          200,
        )
        .add(labels, { "--offset": 0.15, duration: 200 }, 200);
      [1.15, 0.85, 0.55, 0.25].forEach((scale, i) =>
        timeline.add(
          query(`.label-container.${positions[i]}`),
          { "--scale": scale, duration: 200 },
          200,
        ),
      );
      timeline.add(
        progress,
        { value: [0, 1], duration: 500, ease: "linear" },
        200,
      );
      const phases = [
        {
          start: 300,
          active: "tr",
          lines: ["tr.top", "tr.left", "tr.bottom", "tl.right", "tl.top"],
          scales: { tr: 1.45, tl: 1.15, bl: 0.85, br: 0.55 },
        },
        {
          start: 400,
          active: "tl",
          lines: ["tl.left", "tl.bottom", "bl.right", "bl.top", "bl.left"],
          scales: { tl: 1.45, bl: 1.15, br: 0.85 },
        },
        {
          start: 500,
          active: "bl",
          lines: ["bl.bottom", "br.right", "br.top", "br.left", "br.bottom"],
          scales: { bl: 1.45, br: 1.15 },
        },
        { start: 600, active: "br", lines: [], scales: { br: 1.45 } },
      ];
      phases.forEach(({ start, active, lines, scales }) => {
        timeline.add(
          query(`.label-container.${active} .label`),
          { opacity: 0, duration: 20, ease: "linear" },
          start,
        );
        lines.forEach((entry, i) => {
          let [pos, side] = entry.split(".");
          timeline.add(
            query(`.label-container.${pos}>.line.${side}`),
            {
              "--mask": 1,
              [["top", "bottom"].includes(side) ? "scaleX" : "scaleY"]: 0,
              duration: 20,
              ease: "linear",
            },
            start + i * 20,
          );
        });
        Object.entries(scales).forEach(([pos, scale]) =>
          timeline.add(
            query(`.label-container.${pos}`),
            { "--scale": scale, duration: 100, ease: "linear" },
            start,
          ),
        );
      });
      if (mobile)
        timeline
          .add(
            query(".info"),
            { x: "calc(-100% - 100vw)", duration: 500, ease: "linear" },
            200,
          )
          .add(
            query(".info>.section"),
            { opacity: 0, duration: 100, delay: stagger(100), ease: "linear" },
            300,
          );
      timeline
        .set(query(".content"), { "--bg-opacity": "100%" }, 650)
        .set(labels, { "--offset": 0, "--scale": 1 }, 650)
        .set(rectangle, { scale: 0.85 }, 650)
        .add(rectangle, { scale: 1, duration: 200 }, 650)
        .add(
          query(".rectangle>.line,.labels-border,.label,.outro-text"),
          { opacity: 1, duration: 200 },
          650,
        );
      const mouse = (e) => {
        if (currentTime < 650 || !matchMedia("(hover:hover)").matches) return;
        const r = section.querySelector(".sticky").getBoundingClientRect();
        parallax.x(-((e.clientX - r.left) / r.width - 0.5) * 150);
        parallax.y(-((e.clientY - r.top) / r.height - 0.5) * 150);
      };
      const leave = () => {
        parallax.x(0);
        parallax.y(0);
      };
      const tick = () => {
        if (!visible || disposed) return;
        scene.render();
        const x = Number(utils.get(labelsBorder, "x", false)) || 0,
          y = Number(utils.get(labelsBorder, "y", false)) || 0,
          w = rectangle.offsetWidth,
          h = rectangle.offsetHeight;
        [
          [w, 0, w - x - 0.5, -y + 0.5],
          [0, 0, -x + 0.5, -y + 0.5],
          [0, h, -x + 0.5, h - y - 0.5],
          [w, h, w - x - 0.5, h - y - 0.5],
        ].forEach((v, i) =>
          ["x1", "y1", "x2", "y2"].forEach((a, j) =>
            edges[i].setAttribute(a, v[j]),
          ),
        );
        query(".labels-border>.line").forEach(
          (l, i) => (l.style.opacity = [y < 0, x < 0, y > 0, x > 0][i] ? 1 : 0),
        );
        frame = requestAnimationFrame(tick);
      };
      const io = new IntersectionObserver(([e]) => {
        visible = e.isIntersecting;
        cancelAnimationFrame(frame);
        if (visible) tick();
        else scene.pause();
      });
      io.observe(section);
      const scroll = () => {
        clearTimeout(snapTimer);
        if (mobile || snapping) return;
        snapTimer = setTimeout(() => {
          if (currentTime < 250 || currentTime > 650) return;
          const stage =
            progress.value < 0.3
              ? 0
              : progress.value < 0.5
                ? 1
                : progress.value < 0.7
                  ? 2
                  : 3;
          const y =
            section.getBoundingClientRect().top +
            scrollY +
            innerHeight * (2.7 + stage);
          if (Math.abs(scrollY - y) < 5) return;
          snapping = true;
          window.scrollTo({ top: y, behavior: "smooth" });
          snapTimer = setTimeout(() => {
            snapping = false;
          }, 1000);
        }, 220);
      };
      section.addEventListener("pointermove", mouse);
      section.addEventListener("pointerleave", leave);
      window.addEventListener("scroll", scroll, { passive: true });
      cleanup = () => {
        timeline.revert();
        timeline.scrollTrigger?.revert();
        parallax.revert();
        io.disconnect();
        scene.dispose();
        cancelAnimationFrame(frame);
        clearTimeout(snapTimer);
        section.removeEventListener("pointermove", mouse);
        section.removeEventListener("pointerleave", leave);
        window.removeEventListener("scroll", scroll);
      };
    };
    setup().catch(() => setFallback(true));
    return () => {
      disposed = true;
      cleanup();
    };
  }, [mobileLayout]);
  return (
    <section
      ref={root}
      id="how-it-works"
      className={"a-flow" + (fallback ? " is-static" : "")}
    >
      <div className="sticky">
        <AsciiField sectionRef={root} />
        <div className="rectangle" ref={center}>
          <div className="content">
            <h2 className="intro-text">
              {["How", "it", "works"].map((w) => (
                <React.Fragment key={w}>
                  <span className="flow-word">
                    {w}
                    <i className="word-cover" />
                  </span>{" "}
                </React.Fragment>
              ))}
            </h2>
            <div className="outro-text">
              <h2>
                The ANONYMA
                <br />
                Platform
              </h2>
              <Link className="n-cta" to="/workspace/chat?demo=1">
                Explore More <Icon name="arrow" />
              </Link>
            </div>
          </div>
          {sides.map((s) => (
            <i className={"line " + s} key={s} />
          ))}
          <div className="labels-border">
            {sides.map((s) => (
              <i className={"line " + s} key={s} />
            ))}
            <svg className="edges">
              {sides.map((s) => (
                <line key={s} stroke="currentColor" />
              ))}
            </svg>
          </div>
          {positions.map((p, i) => (
            <div className={"label-container " + p} key={p}>
              {sides.map((s) => (
                <i className={"line " + s} key={s} />
              ))}
              <div className="label">
                <span className="text">{steps[i].title}</span>
                <i className="square" />
              </div>
            </div>
          ))}
        </div>
        <div className="canvas" aria-hidden="true">
          <canvas ref={canvas} />
        </div>
      </div>
      <div className="info">
        {steps.map((s, i) => (
          <div className="section" key={s.title}>
            <article className="card">
              <div className="top">
                <h3>{s.title}</h3>
                <span className="index">0{i + 1}</span>
              </div>
              <p>{s.description}</p>
              <ul>
                {s.items.map((t) => (
                  <li key={t}>
                    <span>
                      <svg
                        className="bullet"
                        viewBox="0 0 10 10"
                        aria-hidden="true"
                      >
                        <path d="M0 0h5v5h5v5H0Z" fill="currentColor" />
                      </svg>
                      {t}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          </div>
        ))}
      </div>
    </section>
  );
}
