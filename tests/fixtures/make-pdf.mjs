// A tiny PDF writer for tests/pdf-redact.test.mjs. Every PDF the tests use
// is made here, in the test run, from invented text: nothing is a
// third-party document. It can add everything a redacted copy must not
// keep: document details, an XMP packet, an attachment, JavaScript, a note
// and a form field, and text that's drawn invisibly (like a scan's hidden
// text layer).
//
// makePdf({ pages: [{ width, height, rotate, items: [{ text, x, y, size,
//   font: "F1" | "F2", invisible }], notes: [{ rect, contents }],
//   fields: [{ rect, name, value }] }], info, xmp, attachment, javascript })
// returns the file's bytes (a Uint8Array).
const esc = (s) => String(s).replace(/([\\()])/g, "\\$1");

export function makePdf({ pages, info = null, xmp = null, attachment = null, javascript = null } = {}) {
  const objects = []; // index i is object i + 1
  const add = (body) => objects.push(body) && objects.length;
  const reserve = () => objects.push(null) && objects.length;
  const set = (n, body) => (objects[n - 1] = body);
  const stream = (dict, data) => `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;

  const catalog = reserve(),
    tree = reserve();
  const helvetica = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const courier = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const kids = [];
  const fields = [];
  for (const p of pages) {
    const page = reserve();
    kids.push(page);
    const annots = [];
    for (const note of p.notes || []) {
      annots.push(add(`<< /Type /Annot /Subtype /Text /Rect [${note.rect.join(" ")}] /Contents (${esc(note.contents)}) /Name /Comment >>`));
    }
    for (const f of p.fields || []) {
      const w = add(
        `<< /Type /Annot /Subtype /Widget /FT /Tx /T (${esc(f.name)}) /V (${esc(f.value)}) /DA (/Helv 12 Tf 0 g) /Rect [${f.rect.join(" ")}] /F 4 /P ${page} 0 R >>`,
      );
      annots.push(w);
      fields.push(w);
    }
    let content = "";
    for (const it of p.items || []) {
      const font = it.font === "F2" ? "F2" : "F1";
      // The rendering mode stays set after ET, so every item names its own.
      content += `BT ${it.invisible ? 3 : 0} Tr /${font} ${it.size || 12} Tf ${it.x} ${it.y} Td (${esc(it.text)}) Tj ET\n`;
    }
    const contents = add(stream("", content));
    set(
      page,
      `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${p.width || 612} ${p.height || 792}]${p.rotate ? ` /Rotate ${p.rotate}` : ""} /Resources << /Font << /F1 ${helvetica} 0 R /F2 ${courier} 0 R >> >> /Contents ${contents} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(" ")}]` : ""} >>`,
    );
  }
  set(tree, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);

  let root = `/Type /Catalog /Pages ${tree} 0 R`;
  if (fields.length) root += ` /AcroForm << /Fields [${fields.map((f) => `${f} 0 R`).join(" ")}] /NeedAppearances true /DA (/Helv 12 Tf 0 g) >>`;
  if (xmp) root += ` /Metadata ${add(stream("/Type /Metadata /Subtype /XML", xmp))} 0 R`;
  if (javascript) root += ` /OpenAction << /S /JavaScript /JS (${esc(javascript)}) >>`;
  if (attachment) {
    const file = add(stream("/Type /EmbeddedFile", attachment.data));
    const spec = add(`<< /Type /Filespec /F (${esc(attachment.name)}) /EF << /F ${file} 0 R >> >>`);
    root += ` /Names << /EmbeddedFiles << /Names [(${esc(attachment.name)}) ${spec} 0 R] >> >>`;
  }
  set(catalog, `<< ${root} >>`);

  let trailer = `/Size ${objects.length + 1} /Root ${catalog} 0 R`;
  if (info) {
    const dict = add(`<< ${Object.entries(info).map(([k, v]) => `/${k} (${esc(v)})`).join(" ")} >>`);
    trailer = `/Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${dict} 0 R`;
  }
  let pdf = "%PDF-1.7\n";
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  pdf += `trailer\n<< ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  const out = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) out[i] = pdf.charCodeAt(i) & 0xff;
  return out;
}
