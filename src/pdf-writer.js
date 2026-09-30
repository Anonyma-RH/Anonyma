// PDF Redact: the file writer. It writes an image-only PDF from scratch:
// one page per picture, a catalog, a page tree and nothing else. It never
// reads or copies anything from the original PDF, so the original's text,
// fonts, metadata, annotations, form fields, attachments and scripts have
// nowhere to survive. The trailer names only /Size and /Root, and there is
// no /Info, no XMP stream and no /ID.
//
// Pages are added one at a time and the parts are kept as they are written,
// so a large file is never assembled in one string. No DOM here: it runs
// the same in the browser and in Node (tests/pdf-redact.test.mjs).

export class PdfWriteError extends Error {}

const encoder = new TextEncoder();
const ascii = (s) => encoder.encode(s);
// Numbers in the file: up to two decimals, never exponent notation.
export const fmt = (n) => {
  const v = Math.round(Number(n) * 100) / 100;
  if (!Number.isFinite(v)) throw new PdfWriteError("A page size isn't a number.");
  return String(v);
};

// ---- JPEG ---------------------------------------------------------------

// The markers a decoder needs; everything else (JFIF and EXIF headers, ICC
// profiles, comments, any application data) is dropped. DCTDecode wants
// only the frame, the tables and the scan.
const KEEP = (marker) =>
  marker === 0xdb || // DQT
  marker === 0xc4 || // DHT
  marker === 0xcc || // DAC
  marker === 0xdd || // DRI
  (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8) || // SOFn (DHT and DAC are above)
  marker === 0xda; // SOS

// The picture's size and colour components from its frame header, or null
// when these bytes aren't a JPEG this writer can place.
export function jpegInfo(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 10 > bytes.length) return null;
      return {
        precision: bytes[i + 4],
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        components: bytes[i + 9],
        progressive: marker === 0xc2,
      };
    }
    if (marker === 0xda) return null;
    i += 2 + length;
  }
  return null;
}

// The JPEG with only its structural segments kept, scan by scan, ending at
// its own end-of-image marker (bytes appended after it go). Returns a new
// array.
export function stripJpeg(bytes) {
  if (!jpegInfo(bytes)) throw new PdfWriteError("This picture isn't a JPEG that can be placed in a PDF.");
  const out = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 2 <= bytes.length) {
    if (bytes[i] !== 0xff) throw new PdfWriteError("This picture's data is damaged.");
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9) break;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const end = i + 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    if (end > bytes.length) throw new PdfWriteError("This picture's data is cut short.");
    if (KEEP(marker)) out.push(bytes.subarray(i, end));
    i = end;
    if (marker === 0xda) {
      // The entropy-coded data runs to the next marker that isn't a byte
      // stuffing (FF 00) or a restart (FF D0 to D7).
      const start = i;
      while (i + 1 < bytes.length) {
        if (bytes[i] === 0xff) {
          const m = bytes[i + 1];
          if (m === 0xff) {
            i++;
            continue;
          }
          if (m !== 0x00 && !(m >= 0xd0 && m <= 0xd7)) break;
        }
        i++;
      }
      out.push(bytes.subarray(start, i));
    }
  }
  out.push(Uint8Array.of(0xff, 0xd9));
  return concat(out);
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---- the file -----------------------------------------------------------

export class PdfWriter {
  constructor() {
    this.parts = [];
    this.length = 0;
    this.offsets = new Map();
    this.pageObjects = [];
    this.next = 3; // 1 is the catalog, 2 the page tree; both are written last.
    this.done = false;
    // %PDF-1.4, then the four high bytes a PDF puts in a comment so tools
    // treat the file as binary.
    this.push(ascii("%PDF-1.4\n"));
    this.push(Uint8Array.of(0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a));
  }
  push(bytes) {
    this.parts.push(bytes);
    this.length += bytes.length;
  }
  object(num, head, stream) {
    this.offsets.set(num, this.length);
    if (!stream) {
      this.push(ascii(`${num} 0 obj\n${head}\nendobj\n`));
      return;
    }
    this.push(ascii(`${num} 0 obj\n${head.replace("__LENGTH__", String(stream.length))}\nstream\n`));
    this.push(stream);
    this.push(ascii("\nendstream\nendobj\n"));
  }
  // One page: `width` and `height` in points, and the picture that fills
  // it: { kind: "jpeg", data } (a JPEG file's bytes) or { kind: "flate",
  // width, height, data } (8-bit RGB, zlib-compressed).
  addPage({ width, height, image }) {
    if (this.done) throw new PdfWriteError("The file is already finished.");
    const pageNum = this.next++,
      contentNum = this.next++,
      imageNum = this.next++;
    let dict, data;
    if (image?.kind === "jpeg") {
      const info = jpegInfo(image.data);
      if (!info || (info.components !== 1 && info.components !== 3) || info.precision !== 8)
        throw new PdfWriteError("This picture isn't a grey or colour JPEG that can be placed in a PDF.");
      data = stripJpeg(image.data);
      dict = `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${info.components === 1 ? "/DeviceGray" : "/DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode /Length __LENGTH__ >>`;
    } else if (image?.kind === "flate") {
      if (!(image.width > 0 && image.height > 0) || !image.data?.length)
        throw new PdfWriteError("This picture has no size.");
      data = image.data;
      dict = `<< /Type /XObject /Subtype /Image /Width ${image.width | 0} /Height ${image.height | 0} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length __LENGTH__ >>`;
    } else throw new PdfWriteError("This picture can't be placed in a PDF.");
    this.object(imageNum, dict, data);
    const content = ascii(`q ${fmt(width)} 0 0 ${fmt(height)} 0 0 cm /Im0 Do Q\n`);
    this.object(contentNum, "<< /Length __LENGTH__ >>", content);
    this.object(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(width)} ${fmt(height)}] /Resources << /XObject << /Im0 ${imageNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    this.pageObjects.push(pageNum);
    return this.pageObjects.length;
  }
  // Writes the page tree, the catalog, the cross-reference table and the
  // trailer. Returns the parts in order and the file's length.
  finish() {
    if (this.done) throw new PdfWriteError("The file is already finished.");
    if (!this.pageObjects.length) throw new PdfWriteError("A PDF needs at least one page.");
    this.done = true;
    this.object(2, `<< /Type /Pages /Kids [${this.pageObjects.map((n) => `${n} 0 R`).join(" ")}] /Count ${this.pageObjects.length} >>`);
    this.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const size = this.next;
    const xref = this.length;
    let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) table += String(this.offsets.get(n)).padStart(10, "0") + " 00000 n \n";
    table += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    this.push(ascii(table));
    return { parts: this.parts, length: this.length };
  }
  bytes() {
    const { parts } = this.finish();
    return concat(parts);
  }
}

export function buildImagePdf(pages) {
  const writer = new PdfWriter();
  for (const p of pages) writer.addPage(p);
  return writer.bytes();
}
