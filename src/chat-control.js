// Pure reading/receipt rules. No timers, storage, network calls or paid retries.
export const nearLatest = (bottom, viewport, composer = 0, threshold = 96) =>
  bottom <= viewport - composer + threshold;
const amount = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const display = (n) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 4 });
export function chargePresentation(state) {
  if (!state) return null;
  const payer = state.payer === "team" ? "Team balance" : "Your balance";
  const common = { payer, pending: false, canCheck: !!state.requestId };
  if (state.status === "settled" && amount(state.receipt?.credits_charged)) {
    const n = state.receipt.credits_charged;
    return {
      ...common,
      title: n === 0 ? "No credits charged" : `${display(n)} credits charged`,
      detail: `${payer} · settled receipt.${amount(state.receipt.released) && state.receipt.released > 0 ? ` ${display(state.receipt.released)} unused reserved credits released.` : ""}`,
    };
  }
  if (state.status === "released" && amount(state.reserved))
    return {
      ...common,
      title: "No credits charged",
      detail: `${payer} · ${display(state.reserved)} reserved credits released. This is a released hold, not a refund.`,
    };
  if (state.status === "not_charged")
    return {
      ...common,
      title: "No credits charged",
      detail: "The server refused this request before reserving credits.",
    };
  if (state.status === "held" && amount(state.reserved))
    return {
      ...common,
      pending: true,
      title: `${display(state.reserved)} credits reserved`,
      detail: `${payer} · ${state.checkError ? "last confirmed hold; current status unavailable." : "a hold, not a final charge."} Check status before sending another paid request.`,
    };
  return {
    ...common,
    pending: true,
    title:
      state.status === "sending"
        ? "Charge status pending"
        : "Charge status unknown",
    detail:
      "No final charge is confirmed here. Check status before sending another paid request; checking never resends it.",
  };
}
export function mergeCharge(previous, incoming) {
  if (
    !incoming ||
    (previous?.requestId && incoming.requestId !== previous.requestId)
  )
    return previous;
  // A recovery GET can resolve after a newer terminal stream event.
  if (
    ["settled", "released"].includes(previous?.status) &&
    ["held", "sending"].includes(incoming.status)
  )
    return previous;
  // A failed recovery read must not erase a confirmed terminal receipt.
  if (
    incoming.status === "unknown" &&
    ["settled", "released", "not_charged", "held"].includes(previous?.status)
  )
    return { ...previous, checkError: true };
  return { ...incoming, checkError: false };
}

export function chatFailureMessage(error) {
  const provider = {
    provider_interrupted:
      "The provider connection ended before the reply finished. Any partial reply stays here. Check the charge state below.",
    provider_timeout:
      "The provider took too long to finish. Check the charge state below before sending again.",
    provider_unreadable:
      "The provider sent a reply that could not be read. Check the charge state below before sending again.",
    provider_rejected:
      "The provider could not complete this reply. Check the charge state below.",
  };
  if (provider[error?.code]) return provider[error.code];
  if (error?.name === "AbortError")
    return "Stopped waiting for the reply. Check charge status before sending another paid request.";
  if (error?.name === "TypeError" || error?.status === 0)
    return "The connection was lost. Any partial reply stays here. Check charge status before sending again.";
  return (
    error?.message ||
    "The reply could not finish. Check charge status before sending again."
  );
}
