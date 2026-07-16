// Shared interpretation of PPQ's published price choices; never invent a tier.
export function videoPresets(model) {
  const variants = model?.pricing?.variants || [];
  const presets = [];
  for (const variant of variants) {
    for (const option of variant.options || []) {
      if (
        typeof option.price !== "number" ||
        !Number.isFinite(option.price) ||
        option.price <= 0
      )
        continue;
      const pair = /^(16:9|9:16|1:1)_([1-9]\d{0,2})$/.exec(option.size);
      const seconds = /^[1-9]\d{0,2}$/.test(option.size);
      if (pair || seconds || option.size === "default")
        presets.push({
          quality: variant.quality || "",
          ratio: pair?.[1] || "",
          duration: pair?.[2] || (seconds ? option.size : ""),
          price: option.price,
        });
    }
  }
  const price = model?.pricing?.base_price ?? model?.pricing?.per_generation;
  if (
    !variants.length &&
    typeof price === "number" &&
    Number.isFinite(price) &&
    price > 0
  )
    presets.push({ quality: "", ratio: "", duration: "", price });
  return presets;
}
