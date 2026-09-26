// PDF text extraction in the browser, for Documents (a PDF the user attaches)
// and Link Reader (a PDF the server fetched from a link). pdfjs-dist is only
// fetched once a PDF actually needs reading, so it never lands in the main
// bundle. The worker URL is resolved the Vite way: a `?url` import hands back
// the hashed asset path to assign as workerSrc.
async function loadPdfjs() {
  const [pdfjs, workerUrl] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
  return pdfjs;
}
// { text, pages, hidden, hiddenText } from a PDF's bytes (an ArrayBuffer or
// typed array). `withDetails` also lists the document properties Clean
// Uploads reports. `hiddenOf(items, view, page)`, when given (Injection
// Shield's pdfHiddenText), lists text too small to see or off the page.
export async function pdfText(data, withDetails = false, hiddenOf = null) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data }).promise;
  // Clean Uploads: only the text below is sent, so the PDF's author,
  // software and dates never leave; the chip says which were there.
  let hidden = null;
  if (withDetails) {
    try {
      const { pdfDetails } = await import("./clean-uploads.js");
      hidden = pdfDetails(await doc.getMetadata());
    } catch {
      hidden = null;
    }
  }
  const pages = [],
    hiddenText = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    if (hiddenOf) hiddenText.push(...hiddenOf(content.items, page.view, i));
    pages.push(
      content.items
        .map((item) => item.str || "")
        .join(" ")
        .trim(),
    );
  }
  return { text: pages.join("\n\n").trim(), pages: doc.numPages, hidden, hiddenText };
}
