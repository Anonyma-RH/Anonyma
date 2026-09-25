// Clean Uploads' light half: the words a chip shows and the composer's
// limits. The byte-level cleaning lives in clean-uploads.js, which the app
// loads only once someone attaches a file (like pdf.js).
export const IMAGE_LIMIT = 1.5 * 1024 * 1024;
export const HEIC_LIMIT = 20 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const HEIC_TYPES = ["image/heic", "image/heif"];
export const isHeicFile = (file) =>
  HEIC_TYPES.includes(file?.type) || /\.(heic|heif)$/i.test(file?.name || "");

// What a chip can say was removed, in the order it says it.
export const DETAILS = {
  location: "location",
  camera: "camera details",
  author: "author",
  company: "company",
  dates: "dates",
  software: "software",
  history: "edit history",
  comments: "comments",
  titles: "titles and tags",
  custom: "custom properties",
  paths: "file paths",
  pictures: "cover art",
  thumbnail: "thumbnail",
  other: "other details",
};
const ORDER = Object.keys(DETAILS);
export const detailList = (found) => ORDER.filter((k) => found.has(k));
export const detailText = (keys) => keys.map((k) => DETAILS[k]).join(", ");

// The one small line a file's chip shows. `notSent` is for files whose text
// alone is sent: their details were never going to leave, not removed.
export function cleanNote(result, { keep = false, notSent = false } = {}) {
  if (!result) return null;
  if (keep) return { tone: "kept", text: "Original kept with its hidden details" };
  if (result.status === "failed")
    return { tone: "warn", text: "Metadata couldn't be removed from this file." };
  if (result.status !== "cleaned" && result.status !== "clean") return null;
  if (!result.details?.length) return { tone: "ok", text: "No hidden details found" };
  return {
    tone: "ok",
    text: (notSent ? "Not sent: " : "Removed: ") + detailText(result.details),
  };
}

// Keep original on a composer image: Send uses the original, or the cleaned
// copy again (null while an image that couldn't be cleaned waits).
export const withKeep = (item, keep) => ({ ...item, keep, url: keep ? item.originalUrl : item.cleanUrl });
