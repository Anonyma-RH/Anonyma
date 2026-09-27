// Slides: how a slide looks, in the three house themes. One set of rules,
// used by the page (Slides.jsx puts it in a <style>) and written into the
// exported HTML file, so the editor, Present, the PDF and the file match.
// Everything is sized in cqw (a hundredth of the slide's width), so one
// slide reads the same as a thumbnail, full screen or a 1280 × 720 page.
// Only the site's colours (brand.css) and fonts (GFS Didot for headings,
// GFS Neohellenic for text, from fonts.css), and no images.
export const SLIDE_CSS = `
.slide-frame{container-type:inline-size;width:100%;--bg:#0135df;--fg:#fff;--muted:#d9e5ff;--accent:#ffb21c;--rule:rgba(255,255,255,.28)}
.slide-frame.theme-white{--bg:#fff;--fg:#18233f;--muted:#606a80;--accent:#0135df;--rule:#e2e6ee}
.slide-frame.theme-dark{--bg:#18233f;--fg:#fff;--muted:#d9e5ff;--accent:#ffb21c;--rule:rgba(255,255,255,.2)}
.slide{position:relative;box-sizing:border-box;display:flex;flex-direction:column;width:100%;aspect-ratio:16/9;overflow:hidden;margin:0;padding:6.2cqw 7cqw 6cqw;background:var(--bg);color:var(--fg);font-family:var(--font);font-weight:500;font-size:2.2cqw;line-height:1.35;letter-spacing:-.01em;text-align:left;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.slide-frame.theme-white .slide{box-shadow:inset 0 0 0 1px var(--rule)}
.slide *{box-sizing:border-box}
.slide h1,.slide h2,.slide h3,.slide p,.slide blockquote,.slide ul,.slide li,.slide div,.slide span{margin:0;padding:0;border:0;background:none;color:inherit;text-transform:none;text-shadow:none;box-shadow:none;max-width:none}
.slide .s-title{margin:0;font-family:var(--serif);font-weight:400;font-size:4.3cqw;line-height:1.08;letter-spacing:-.02em;overflow-wrap:anywhere}
.slide .s-subtitle{margin:2cqw 0 0;font-size:2.4cqw;line-height:1.35;color:var(--muted);overflow-wrap:anywhere}
.slide .s-bullets{list-style:none;margin:3.4cqw 0 0;padding:0;display:grid;gap:1.6cqw;align-content:start}
.slide .s-bullet{position:relative;padding-left:2.8cqw;font-size:2.45cqw;line-height:1.3;overflow-wrap:anywhere}
.slide .s-bullet::before{content:"";position:absolute;left:0;top:.5em;width:.95cqw;height:.95cqw;background:var(--accent)}
.slide.dense .s-bullets{gap:1.05cqw;margin-top:2.6cqw}
.slide.dense .s-bullet{font-size:2cqw}
.slide.l-title{justify-content:flex-end;padding-bottom:8.5cqw}
.slide.l-title .s-title{font-size:7.2cqw;line-height:1.02;letter-spacing:-.03em;max-width:84%}
.slide.l-title .s-subtitle{margin-top:2.4cqw;font-size:2.6cqw;max-width:74%}
.slide .s-steps{position:absolute;top:0;right:7cqw;display:flex;align-items:flex-start}
.slide .s-steps i{display:block;width:2.4cqw;background:var(--accent)}
.slide .s-steps i+i{margin-left:-.06cqw;width:2.46cqw}
.slide .s-steps i:nth-child(1){height:2.4cqw}
.slide .s-steps i:nth-child(2){height:4.8cqw}
.slide .s-steps i:nth-child(3){height:3.6cqw}
.slide .s-steps i:nth-child(4){height:7.2cqw}
.slide .s-steps i:nth-child(5){height:9.6cqw}
.slide.l-section{justify-content:center;padding-left:10cqw}
.slide.l-section::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2.4cqw;background:var(--accent)}
.slide .s-kicker{display:block;margin-bottom:1.8cqw;font-size:1.7cqw;font-weight:700;letter-spacing:.1em;color:var(--accent);font-variant-numeric:tabular-nums}
.slide.l-section .s-title{font-size:6cqw;max-width:88%}
.slide.l-section .s-subtitle{max-width:76%}
.slide .s-cols{display:grid;grid-template-columns:1fr 1fr;margin-top:3.6cqw;flex:1;min-height:0}
.slide .s-col{min-width:0;padding-right:4cqw}
.slide .s-col+.s-col{padding:0 0 0 4cqw;border-left:1px solid var(--rule)}
.slide .s-heading{margin:0;font-family:var(--font);font-size:2.3cqw;font-weight:700;line-height:1.25;color:var(--accent);overflow-wrap:anywhere}
.slide .s-col .s-bullets{margin-top:2cqw;gap:1.3cqw}
.slide .s-col .s-bullet{font-size:2.2cqw}
.slide.dense .s-col .s-bullet{font-size:1.85cqw}
.slide.l-quote{justify-content:center;padding-left:14cqw;padding-right:12cqw}
.slide .s-quote-mark{position:absolute;left:6cqw;top:4.2cqw;font-family:var(--serif);font-size:17cqw;line-height:1;color:var(--accent)}
.slide .s-quote{margin:0;font-family:var(--serif);font-weight:400;font-size:4.1cqw;line-height:1.18;letter-spacing:-.015em;overflow-wrap:anywhere}
.slide .s-attribution{margin:2.8cqw 0 0;font-size:2cqw;color:var(--muted)}
.slide .s-attribution::before{content:"— "}
.slide .s-figure{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0}
.slide .s-number{font-family:var(--serif);font-weight:400;font-size:15.5cqw;line-height:.95;letter-spacing:-.035em;color:var(--accent);overflow-wrap:anywhere}
.slide .s-label{margin:1.8cqw 0 0;font-size:2.7cqw;line-height:1.3;max-width:72%;overflow-wrap:anywhere}
.slide .s-foot{position:absolute;left:7cqw;right:7cqw;bottom:2.5cqw;display:flex;justify-content:space-between;gap:3cqw;font-size:1.15cqw;font-weight:500;letter-spacing:.02em;color:var(--muted)}
.slide .s-foot-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slide .s-foot-num{font-variant-numeric:tabular-nums}
.slide.l-section .s-foot{left:10cqw}
`;

// The exported file's fonts: the same families and adjustments as
// src/fonts.css, as data: URLs, plus the CJK fallbacks the site uses.
export function exportFontCSS({ didot, neo400, neo700 }) {
  const face = (family, weight, url, adjust = "") =>
    url
      ? `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;${adjust}src:url(${url}) format("woff2")}`
      : "";
  return [
    face("GFS Didot", 400, didot),
    face("GFS Neohellenic", 400, neo400, "size-adjust:118%;"),
    face("GFS Neohellenic", 700, neo700, "size-adjust:118%;"),
    ':root{--font:"GFS Neohellenic","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Source Han Sans SC",sans-serif;--serif:"GFS Didot","Songti SC","Noto Serif SC","Source Han Serif SC",STSong,SimSun,serif}',
  ].join("\n");
}
