import React, { Suspense, lazy } from "react";
import { Icon } from "./ui.jsx";
import { isReleased } from "./lib.js";
import "./ocr.css";

// Local OCR ("Text only"): what the composer shows on an image chip. The
// panel (OcrPanel.jsx) and the text reader behind it (tesseract.js, in
// ocr-engine.js) load only when someone opens it.
const OcrPanel = lazy(() => import("./OcrPanel.jsx"));

// The text goes as a Documents attachment, so it needs Documents released too.
export const ocrReleased = (config) =>
  !!config && isReleased(config, "ocr") && isReleased(config, "documents");

// "Text only" on a composer image chip.
export function OcrChipTool({ item, onOpen, disabled = false }) {
  return (
    <button
      type="button"
      className="ocr-open"
      onClick={onOpen}
      disabled={disabled}
      aria-label={"Read the text in " + item.name}
      title="Read the text on this device and send it instead of the image"
    >
      <Icon name="scantext" size={13} />
      <span>Text only</span>
    </button>
  );
}

export function OcrDialog(props) {
  if (!props.item) return null;
  return (
    <Suspense fallback={null}>
      <OcrPanel {...props} />
    </Suspense>
  );
}
