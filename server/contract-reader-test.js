import { CONTRACT_SYSTEM, POWER_GROUPS, functionIndex, parseContractRequest } from "../src/contract-reader.js";

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for the
// model behind a Contract Reader explanation, so the whole flow can be driven
// without a provider. It reads the facts and files back out of the request
// and never invents anything: each power is a function whose declaration
// line carries an only… modifier, cited at that line; an unpublished
// contract's powers are its bytecode's matched functions. Markers in a
// source file pick other shapes real models give: [[contract:length]] comes
// back cut short, [[contract:prose]] in prose, [[contract:refuse]] as a
// refusal, [[contract:fenced]] in a code fence with prose around it and
// [[contract:shapes]] with other field names, a list for the summary and
// "file:line" locations. Never used live.
export function contractTestReply(messages) {
  const system = String(messages?.[0]?.content || "");
  if (!system.startsWith(CONTRACT_SYSTEM)) return null;
  const read = parseContractRequest(String(messages.find((m) => m.role === "user")?.content || ""));
  if (!read) return { text: '{"error": "No facts were sent."}', finish: "stop" };
  const { facts, files } = read;
  const all = files.map((f) => f.lines.map((l) => l.text).join("\n")).join("\n");
  const marker = /\[\[contract:(\w+)\]\]/.exec(all)?.[1];
  if (marker === "length") return { text: '{"summary": "A reading that was cut', finish: "length" };
  if (marker === "prose") return { text: "This contract looks like a token with an owner. Here is what I found, in prose.", finish: "stop" };
  if (marker === "refuse") return { text: '{"error": "There is no code here to read."}', finish: "stop" };
  const powers = [];
  for (const f of files) {
    const index = functionIndex(f.lines);
    for (const fn of index) {
      const line = f.lines.find((l) => l.n === fn.start)?.text || "";
      if (!/\bfunction\b/.test(line)) continue;
      const who = /\b(onlyRole\([^)]*\)|only[A-Z]\w*)/.exec(line)?.[1];
      if (who && powers.length < 8)
        powers.push({ title: `Call ${fn.name}`, detail: `Only ${who} can call ${fn.name}.`, who, function: fn.name, file: f.path, line: fn.start });
    }
  }
  if (!files.length)
    for (const f of facts.bytecode?.functions || [])
      if (powers.length < 8)
        powers.push({ title: POWER_GROUPS[f.group] || f.signature, detail: `Its bytecode has ${f.signature}; who can call it isn't known.`, function: f.signature.split("(")[0] });
  const name = facts.name || facts.token?.symbol || "This contract";
  const reading = {
    summary: `Local test provider: a fixture, not a model. ${name} on ${facts.chain.name}${files.length ? `, read from ${files.length} verified ${files.length === 1 ? "file" : "files"}` : ", whose code isn't published"}.`,
    powers,
    checks: powers.length ? [{ title: "Owner-only functions", detail: "Some functions can be called by one role only.", function: powers[0].function, file: powers[0].file, line: powers[0].line }] : [],
    limits: ["Configure a gateway key for a real reading."],
  };
  if (marker === "fenced") return { text: "Sure! Here's the reading:\n```json\n" + JSON.stringify(reading, null, 2) + "\n```\nHope it helps.", finish: "stop" };
  if (marker === "shapes")
    return {
      text: JSON.stringify({
        reading: {
          summary: ["Local test provider.", { text: "Other shapes." }],
          what_they_can_do: powers.map((p) => ({ power: p.title, description: p.detail, role: p.who, method: p.function + "()", location: `${p.file}:${p.line}` })),
          things_to_check: "An owner can mint\nFees can change",
          cant_tell: "Off-chain agreements.",
        },
      }),
      finish: "stop",
    };
  return { text: JSON.stringify(reading), finish: "stop" };
}
