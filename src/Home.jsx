import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Icon, Mark } from "./ui.jsx";
import AsciiField from "./AsciiField.jsx";
import { Reveal, useHeroMotion } from "./ReferenceMotion.jsx";
import ReferenceFlow from "./ReferenceFlow.jsx";
import { reducedMotion, setMotion, useReducedMotion } from "./motion.js";

const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
function useScene(ref) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      if (ref.current)
        setProgress(
          reducedMotion.matches
            ? 0
            : Math.max(
                0,
                -ref.current.getBoundingClientRect().top / innerHeight,
              ),
        );
    };
    const scroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    addEventListener("scroll", scroll, { passive: true });
    addEventListener("resize", scroll);
    reducedMotion.addEventListener("change", scroll);
    return () => {
      removeEventListener("scroll", scroll);
      removeEventListener("resize", scroll);
      reducedMotion.removeEventListener("change", scroll);
      cancelAnimationFrame(frame);
    };
  }, []);
  return progress;
}
function ArrowLink({ to, children, className = "" }) {
  return (
    <Link className={"n-cta " + className} to={to}>
      {children}
      <Icon name="arrow" size={15} />
    </Link>
  );
}
function Heading({ label, children, body }) {
  return (
    <div className="n-heading">
      <p className="n-label">{label}</p>
      <Reveal>
        <h2>{children}</h2>
      </Reveal>
      {body && <p className="n-description">{body}</p>}
    </div>
  );
}
const labels = [
  ["Chat & reasoning", "sage", "chat"],
  ["Code generation", "mint", "code"],
  ["Model selection", "yellow", "models"],
  ["Image creation", "pink", "image"],
  ["Video generation", "mint-light", "video"],
  ["Developer API", "lavender", "key"],
];
function Hero() {
  const ref = useRef(),
    video = useRef(),
    backgroundVideo = useRef();
  const p = useScene(ref);
  useHeroMotion(ref);
  // The motion button pauses every animation on the site, not just these films.
  const paused = useReducedMotion();
  useEffect(() => {
    const films = [video.current, backgroundVideo.current];
    if (paused) {
      films.forEach((f) => f.pause());
      return;
    }
    const o = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) e.target.play().catch(() => {});
          else e.target.pause();
        }
      },
      { threshold: 0.05 },
    );
    films.forEach((f) => o.observe(f));
    return () => o.disconnect();
  }, [paused]);
  return (
    <section className="n-hero" ref={ref}>
      <div className="brand-hero-film" aria-hidden="true">
        <video
          ref={backgroundVideo}
          src="/media/anonyma-landscape-upscaled.mp4"
          poster="/media/anonyma-landscape-upscaled-poster.jpg"
          autoPlay={!paused}
          muted
          loop
          playsInline
          preload="auto"
        />
      </div>
      <div
        className="n-pills"
        aria-hidden="true"

      >
        <div className="n-blurs">
          {[1, 2, 3, 4, 5].map((i) => (
            <i key={i} />
          ))}
        </div>
        {labels.map(([t, c, ic], i) => (
          <div key={t} className={`n-pill n-pill-${i} ${c}`}>
            <span>
              <img src={`/reference/pill-${i + 1}.svg`} alt="" />
            </span>
            <b>{t}</b>
          </div>
        ))}
      </div>
      <div
        className="n-hero-content"

      >
        <div className="n-hero-copy">
          <Reveal><h1>Bring your ideas to life with AI models.</h1></Reveal>
          <p>
            ANONYMA brings chat, code, images and video into one workspace — so
            you can spend less time switching tools and more time bringing your
            ideas to life.
          </p>
          <ArrowLink to="/workspace?demo=1" className="n-primary">
            Get started
          </ArrowLink>
          <button
            className="hero-motion-toggle"
            onClick={() => setMotion(paused)}
            aria-label={paused ? "Play hero motion" : "Pause hero motion"}
          >
            <Icon name={paused ? "play" : "pause"} size={11} />
            {paused ? "Play motion" : "Pause motion"}
          </button>
        </div>
      </div>
      <div className="n-hero-media">
        <video
          ref={video}
          src="/media/anonyma-dashboard-4k.mp4"
          poster="/media/anonyma-dashboard-poster.jpg"
          autoPlay={!paused}
          muted
          loop
          playsInline
          preload="auto"
          aria-label="ANONYMA workspace hero animation: sample tasks complete across chat, code, images and video"
        />
        <button
          className="n-video-toggle"
          onClick={() => setMotion(paused)}
          aria-label={paused ? "Play hero animation" : "Pause hero animation"}
        >
          <Icon name={paused ? "play" : "pause"} size={12} />
          {paused ? "Play" : "Pause"}
        </button>
      </div>
      <div className="n-hero-wipe" aria-hidden="true">
        {[0.2, 0.12, 0.3, 0.22, 0.48, 0.34, 0.66].map((h, i) => (
          <i
            key={i}
            style={{ height: `${clamp((p - 0.35) * 1.05) * h * 100}%` }}
          />
        ))}
      </div>
    </section>
  );
}
const families = [
  "OpenAI",
  "Anthropic",
  "Google",
  "DeepSeek",
  "Models",
  "One API",
];
function Providers() {
  return (
    <section className="n-marquee">
      <h2>
        One workspace.
        <br />
        Many model families.
      </h2>
      <div className="n-marquee-window">
        <div className="n-marquee-track">
          {[...families, ...families].map((t, i) => (
            <span key={i} aria-hidden={i > 5}>
              {t}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
const capabilities = [
  {
    title: "Chat & code",
    description: "Everything you need to think, write and build.",
    items: [
      "Multi-model conversations",
      "Code generation",
      "Project file exports",
      "Conversation history",
    ],
    to: "/workspace/chat?demo=1",
  },
  {
    title: "Images & video",
    description: "Visual creation in one workspace.",
    items: ["Image generation", "Reference images", "Asynchronous video"],
    to: "/workspace/image?demo=1",
  },
  {
    title: "Credits & API",
    description: "One balance across every AI workflow.",
    items: ["Prepaid credits", "Developer API keys", "Usage & receipts"],
    to: "/developers",
  },
];
function Capabilities() {
  const [slide, setSlide] = useState(0);
  return (
    <section className="n-capabilities" id="platform">
      <Heading
        label="What We Do"
        body="Different models. One connected workspace for your ideas."
      >
        Introducing your
        <br />
        all-in-one AI workspace
      </Heading>
      <div className="n-capability-frame">
        <div className="n-capability-grid" style={{ "--slide": slide }}>
          {capabilities.map((c, i) => (
            <Link to={c.to} className="n-capability" key={c.title}>
              <img src={`/reference/capability-${i + 1}.svg`} alt="" />
              <div>
                <h3>{c.title}</h3>
                <p>{c.description}</p>
                <ul>
                  {c.items.map((t) => (
                    <li key={t}>
                      <span className="n-bullet" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            </Link>
          ))}
        </div>
      </div>
      <div className="n-card-pagination">
        <button
          disabled={slide === 0}
          onClick={() => setSlide(slide - 1)}
          aria-label="Previous capability"
        >
          ←
        </button>
        <button
          disabled={slide === 2}
          onClick={() => setSlide(slide + 1)}
          aria-label="Next capability"
        >
          →
        </button>
      </div>
    </section>
  );
}
const creditSlides = [
  {
    stat: "1,000",
    label: "Credits per US dollar",
    quote:
      "A conversation here. A creation there. One prepaid balance connects the work you do across models and tools.",
    name: "One shared balance",
    sub: "Chat, code, images, video and API",
  },
  {
    stat: "4",
    label: "Ways to bring an idea to life",
    quote:
      "Think it through, build something, make it visual. Move between chat, code, images and video in the same workspace.",
    name: "A connected workflow",
    sub: "Choose the model that fits your task",
  },
  {
    stat: "1",
    label: "Account for your AI workflows",
    quote:
      "Return to your conversations, revisit your creations, and see a receipt for each completed request.",
    name: "Your work, together",
    sub: "Private history, media and usage receipts",
  },
];
function Outcomes() {
  const [index, setIndex] = useState(0);
  const ref = useRef();
  const reduced = useReducedMotion();
  useEffect(() => {
    let timer;
    const o = new IntersectionObserver(
      ([e]) => {
        clearInterval(timer);
        if (e.isIntersecting && !reduced)
          timer = setInterval(() => setIndex((i) => (i + 1) % 3), 7000);
      },
      { threshold: 0.3 },
    );
    o.observe(ref.current);
    return () => {
      o.disconnect();
      clearInterval(timer);
    };
  }, [reduced]);
  const c = creditSlides[index];
  return (
    <section className="n-outcomes" ref={ref}>
      <Heading label="Your Workspace">
        Connected.
        <br />
        Flexible. Always yours.
      </Heading>
      <div className="n-outcome-panel">
        <i className="n-outcome-notch" />
        <div className="n-stat">
          <div key={index} className="n-stat-copy">
            <b>{c.stat}</b>
            <p>{c.label}</p>
          </div>
          <div className="n-stat-progress">
            {creditSlides.map((_, i) => (
              <button
                key={i}
                aria-label={`Show workspace benefit ${i + 1}`}
                aria-current={index === i}
                onClick={() => setIndex(i)}
              >
                <i key={index} className={index === i ? "active" : ""} />
              </button>
            ))}
          </div>
        </div>
        <div className="n-outcome-divider" />
        <div className="n-quote">
          <svg className="n-quote-mark" viewBox="0 0 40 40" aria-hidden="true">
            <path
              fill="currentColor"
              d="M0 20 17 0v12L8 23h9v17H0zm23 0L40 0v12L31 23h9v17H23z"
            />
          </svg>
          <div key={index} className="n-quote-copy">
            <h3>{c.quote}</h3>
            <p>{c.name}</p>
            <span>{c.sub}</span>
          </div>
          <div className="n-quote-controls">
            <button
              onClick={() => setIndex((index + 2) % 3)}
              aria-label="Previous workspace benefit"
            >
              ←
            </button>
            <button
              onClick={() => setIndex((index + 1) % 3)}
              aria-label="Next workspace benefit"
            >
              →
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
const steps = [
  {
    title: "Models",
    color: "#0135df",
    description:
      "Choose the intelligence that fits your task. Explore the catalog from the same place you create.",
    items: [
      "Chat and reasoning models",
      "Image and video capabilities",
      "Availability before you begin",
    ],
  },
  {
    title: "Shared credits",
    color: "#aebfff",
    description:
      "One prepaid balance connects your workspace and developer tools, with estimates before work begins.",
    items: [
      "1 USD = 1,000 credits",
      "Available and held credits",
      "Itemized usage receipts",
    ],
  },
  {
    title: "AI workflows",
    color: "#9bb5ed",
    description:
      "Go from a prompt to a conversation, code, an image or a video. Keep your ideas moving in one place.",
    items: [
      "Stream conversations",
      "Build and export code",
      "Compare image results",
      "Track video generation",
    ],
  },
  {
    title: "Your workspace",
    color: "#cedcf6",
    description:
      "Return to your conversations and creations. Your history, media and account stay connected.",
    items: [
      "Saved conversation history",
      "A private media library",
      "Developer keys and controls",
    ],
  },
];
function Panel({ x, y, w = 150, h = 105, title, children }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={w} height={h} fill="#151414" stroke="#414441" rx="2" />
      <text x="10" y="19" fill="#bbb" fontSize="9">
        {title}
      </text>
      {children}
    </g>
  );
}
function FlowDiagram({ stage }) {
  const c = steps[stage].color;
  return (
    <svg
      viewBox="0 0 580 430"
      aria-hidden="true"
      className="n-flow-art"
      key={stage}
    >
      <g fill="none" stroke="#343734">
        <path d="M64 195V65h280v286H94V195h370V94H172v295h352V35H28v355h487" />
        <rect x="50" y="48" width="474" height="336" />
        <rect x="70" y="68" width="434" height="296" />
        <rect x="90" y="88" width="394" height="256" />
      </g>
      {stage === 0 ? (
        <>
          <Panel x={175} y={80} w={170} h={120} title="Model catalog">
            {["Chat & reasoning", "Image creation", "Video generation"].map(
              (t, i) => (
                <g key={t}>
                  <rect
                    x="12"
                    y={37 + i * 25}
                    width={[112, 70, 90][i]}
                    height="9"
                    fill={c}
                    opacity={1 - i * 0.25}
                  />
                  <text x="12" y={53 + i * 25} fontSize="7" fill="#999">
                    {t}
                  </text>
                </g>
              ),
            )}
          </Panel>
          <Panel x={72} y={255} title="Providers">
            <text x="16" y="51" fill="#eee" fontSize="14">
              OpenAI　Google
            </text>
            <text x="16" y="80" fill="#eee" fontSize="13">
              Anthropic　DeepSeek
            </text>
          </Panel>
          <Panel x={332} y={247} w={178} h={104} title="One connection">
            {[0, 1, 2].map((i) => (
              <rect
                key={i}
                x={12 + i * 52}
                y="40"
                width="39"
                height="45"
                fill={c}
                fillOpacity={i / 2}
                stroke={c}
              />
            ))}
          </Panel>
        </>
      ) : stage === 1 ? (
        <>
          <Panel x={72} y={105} w={195} h={140} title="Shared balance">
            <text x="16" y="62" fill={c} fontSize="29">
              1,000 credits
            </text>
            <path d="M16 83h160M16 102h115M16 118h142" stroke="#60617c" />
          </Panel>
          <Panel
            x={306}
            y={190}
            w={200}
            h={135}
            title="A receipt for every request"
          >
            <text x="16" y="52" fill="#ddd" fontSize="12">
              Estimated → Reserved
            </text>
            <text x="16" y="83" fill={c} fontSize="12">
              Settled → Available
            </text>
            <path d="M16 108h164" stroke={c} />
          </Panel>
        </>
      ) : stage === 2 ? (
        <>
          <Panel x={105} y={97} w={161} h={103} title="Conversation">
            <rect x="12" y="39" width="100" height="16" rx="8" fill={c} />
            <path d="M12 73h119M12 85h85" stroke="#999" />
          </Panel>
          <Panel x={307} y={125} w={164} h={108} title="Code workspace">
            <text x="14" y="52" fill={c} fontSize="15">
              {"<Your next idea />"}
            </text>
            <path d="M14 76h132M14 88h84" stroke="#7d5b62" />
          </Panel>
          <Panel x={90} y={245} w={160} h={111} title="Images">
            <path d="M14 89 54 47 83 76 112 54 148 92Z" fill={c} />
          </Panel>
          <Panel x={320} y={273} w={160} h={93} title="Video">
            <path d="m60 36 33 19-33 19Z" fill={c} />
            <path d="M14 81h130" stroke="#999" />
          </Panel>
        </>
      ) : (
        <>
          <Panel x={110} y={86} w={175} h={104} title="Saved conversations">
            <rect x="12" y="37" width="122" height="13" rx="6" fill={c} />
            <path d="M12 69h140M12 83h100" stroke="#7d795b" />
          </Panel>
          <Panel x={311} y={148} w={181} h={145} title="Your library">
            {[0, 1, 2, 3].map((i) => (
              <g key={i}>
                <rect x="12" y={37 + i * 24} width="13" height="13" fill={c} />
                <path d={`M35 ${43 + i * 24}h125`} stroke="#aaa" />
              </g>
            ))}
          </Panel>
          <Panel x={139} y={261} w={157} h={96} title="Account controls">
            <path d="M12 40h120M12 63h90M12 80h110" stroke={c} />
          </Panel>
        </>
      )}
    </svg>
  );
}
function Workflow() {
  const ref = useRef();
  const p = useScene(ref);
  const stage = Math.min(3, Math.max(0, Math.floor(p - 2.7)));
  const inScene = p > 2.3 && p < 6.8;
  const outro = p > 6.8;
  const introOpacity = 1 - clamp((p - 1.5) * 2.5);
  const scale = outro ? 1 + clamp(p - 7.2) * 0.22 : 0.85 + clamp(p / 2) * 0.15;
  const rotate = (1 - clamp(p)) * 25;
  return (
    <section className="n-flow" id="how-it-works" ref={ref}>
      <div className="n-flow-sticky">
        <AsciiField sectionRef={ref} />
        <div
          className="n-flow-frame"
          style={{
            transform: `rotate(${rotate}deg) scale(${scale})`,
            opacity: clamp(p * 2 + 0.15),
          }}
        >
          <div className="n-flow-rings" style={{ opacity: inScene ? 0.7 : 0 }}>
            <i />
            <i />
            <i />
          </div>
          {[
            ["tl", 1],
            ["tr", 0],
            ["bl", 2],
            ["br", 3],
          ].map(([pos, i]) => (
            <div className={`n-flow-label ${pos}`} key={pos}>
              <span>{steps[i].title}</span>
              <i style={{ background: steps[i].color }} />
            </div>
          ))}
          <h2
            className="n-flow-intro"
            style={{
              opacity: introOpacity,
              transform: `rotate(${-rotate}deg)`,
            }}
          >
            How it works
          </h2>
          <div className={"n-flow-scene " + (inScene ? "visible" : "")}>
            {steps.map((_, i) => {
              const t = p - 2.3 - i;
              const entering = t < 1;
              const alive = t > 0 && t < 1.47;
              const zoom = entering
                ? clamp(t)
                : (2 - t) / Math.max(0.06, 3 - 2 * t);
              return (
                <div
                  className="n-flow-depth"
                  key={i}
                  style={{
                    opacity: alive ? clamp((t - 0.2) / 0.2) : 0,
                    transform: `scale(${zoom})`,
                    visibility: alive ? "visible" : "hidden",
                  }}
                >
                  <FlowDiagram stage={i} />
                </div>
              );
            })}
          </div>
          <div className={"n-flow-outro " + (outro ? "visible" : "")}>
            <h2>
              The ANONYMA
              <br />
              Platform
            </h2>
            <ArrowLink to="/workspace?demo=1">Explore More</ArrowLink>
          </div>
        </div>
        <article
          className={"n-flow-card " + (inScene ? "visible" : "")}
          style={{ "--scene-color": steps[stage].color }}
        >
          <div>
            <h3>{steps[stage].title}</h3>
            <span>0{stage + 1}</span>
          </div>
          <p>{steps[stage].description}</p>
          <ul>
            {steps[stage].items.map((t) => (
              <li key={t}>
                <i className="n-bullet" />
                {t}
              </li>
            ))}
          </ul>
        </article>
      </div>
      <div className="n-flow-accessible">
        {steps.map((s, i) => (
          <article key={s.title}>
            <h3>
              0{i + 1} — {s.title}
            </h3>
            <p>{s.description}</p>
            <ul>
              {s.items.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
function ModelGrid() {
  return (
    <section className="n-models">
      <Heading
        label="Our Models"
        body="The ANONYMA workspace connects different model families in one place. Explore their capabilities and choose what fits your next idea."
      >
        Model choice by design
      </Heading>
      <div className="n-model-grid">
        {[
          "OpenAI",
          "Anthropic",
          "Google",
          "DeepSeek",
          "Image & Video",
          null,
        ].map((t, i) => (
          <Link key={i} to={t && i < 4 ? "/models?provider=" + t : "/models"}>
            {t ? (
              <strong className={"n-provider-name provider-" + i}>{t}</strong>
            ) : (
              <p>
                Find the right model.
                <br />
                Explore the complete catalog.
              </p>
            )}
            <span>
              Explore <Icon name="arrow" size={15} />
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
function ArticleArt({ index }) {
  return (
    <div className={"n-article-art art-" + index} aria-hidden="true">
      <img className="n-knowledge-background" src={`/media/knowledge-painterly-${["models", "credits", "api"][index]}.png`} alt="" loading="lazy" />
      <div className="n-pixel-bg">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <i key={i} />
        ))}
      </div>
      {index === 0 ? (
        <>
          <span className="n-art-cell cell-1">
            <Icon name="models" size={43} />
          </span>
          <span className="n-art-cell cell-2">
            <Mark />
          </span>
          <span className="n-art-cell cell-3">
            <svg viewBox="0 0 50 50">
              <path
                fill="currentColor"
                d="M4 32h10v15H4zm15-13h10v28H19zM34 4h12v43H34z"
              />
            </svg>
          </span>
        </>
      ) : (
        <span className="n-art-cell large">
          <Icon name={index === 1 ? "credits" : "key"} size={66} />
        </span>
      )}
    </div>
  );
}
function Resources() {
  return (
    <>
      <div className="n-stair-transition" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <i key={i} />
        ))}
      </div>
      <section className="n-resources">
        <div className="n-resource-inner">
          <p className="n-label">Our Knowledge Base</p>
          <Reveal>
            <h2>Ideas for your next AI workflow</h2>
          </Reveal>
          <div className="n-resource-grid">
            {[
              [
                "MODEL GUIDE",
                "The right model for the way you work.",
                "choose-a-model",
              ],
              [
                "CREDITS & USAGE",
                "Understand your credits, estimates and receipts.",
                "understanding-credits",
              ],
              [
                "DEVELOPER NOTES",
                "One connection to your AI workspace.",
                "one-api",
              ],
            ].map(([tag, title, slug], i) => (
              <Link key={slug} to={"/guides/" + slug}>
                <ArticleArt index={i} />
                <p className="n-article-tag">
                  ANONYMA Guide <span /> {tag}
                </p>
                <h3>{title}</h3>
              </Link>
            ))}
          </div>
        </div>
        <ArrowLink to="/docs" className="n-resource-more">
          Read More
        </ArrowLink>
      </section>
    </>
  );
}
export default function Home() {
  return (
    <main id="main" className="n-home">
      <Hero />
      <Providers />
      <Capabilities />
      <Outcomes />
      <ReferenceFlow steps={steps} />
      <ModelGrid />
      <Resources />
    </main>
  );
}
