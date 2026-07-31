import { fail } from "./core.js";
import { videoPresets } from "../data/video-presets.js";

// Accept only options with a published price, before creating a financial hold.
export function videoOptions(model, body) {
  const presets = videoPresets(model);
  if (!presets.length)
    fail(
      400,
      "This video model has no valid published price.",
      "unpriced_model",
    );
  const quality = body.quality ?? presets[0].quality;
  const qualityDefault = presets.find((p) => p.quality === quality);
  const ratio = body.ratio ?? qualityDefault?.ratio;
  const duration = String(body.duration ?? qualityDefault?.duration ?? "");
  const option = presets.find(
    (p) =>
      p.quality === quality && p.ratio === ratio && p.duration === duration,
  );
  if (!option)
    fail(
      400,
      "This model does not support the chosen quality, ratio and duration.",
    );
  const image = body.image_url;
  const capabilities = model.capabilities || {};
  if (
    (capabilities.requires_image_url || model.category === "image-to-video") &&
    !image
  )
    fail(400, "This video model requires a public HTTPS reference image.");
  if (image) {
    if (capabilities.accepts_image_url === false)
      fail(400, "This video model does not accept a reference image.");
    let url;
    try {
      url = new URL(image);
    } catch {
      fail(400, "Reference image must be a public HTTPS URL.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      fail(
        400,
        "Reference image must be a public HTTPS URL without credentials.",
      );
  }
  return {
    ratio: ratio || undefined,
    duration: duration || undefined,
    quality: quality || undefined,
    price: option.price,
  };
}
