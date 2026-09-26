// Math & Diagrams: KaTeX, loaded only when a reply on screen has math in it
// (src/RichMarkdown.jsx). Its stylesheet and fonts are bundled with the app
// and served from this site (the CSP allows font-src 'self').
import "katex/dist/katex.min.css";
export { default as katex } from "katex";
export { default as rehypeKatex } from "rehype-katex";
