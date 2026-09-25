// The offline page's language follows the site's English / 中文 switch
// (src/i18n.js stores it as localStorage "anonyma.lang").
try {
  if (localStorage.getItem("anonyma.lang") === "zh") {
    document.documentElement.classList.add("zh");
    document.documentElement.lang = "zh-CN";
    document.title = "你已离线 — ANONYMA";
  }
} catch {
  // Storage can be blocked; the page then stays in English.
}
