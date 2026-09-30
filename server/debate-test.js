import { JUDGE_PROMPT } from "../src/debate.js";

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for the
// models in a debate, so the page can be driven end to end without a
// provider. Never used live.
//
// A debater's turn is a short, generic argument for its side that quotes the
// question; the judge's reply is JSON in the shape it was asked for. Markers
// in the question drive the failure paths the tests and the demo rig need:
// DEBATE-TEST-FAIL (Side B's first rebuttal is a provider error),
// DEBATE-TEST-EMPTY (Side B's opening comes back empty), DEBATE-TEST-LENGTH
// (Side B's opening is cut off with nothing), DEBATE-TEST-CUT (Side A's
// opening is cut off after a usable start), DEBATE-TEST-JUDGE-BAD (the judge
// answers in prose), DEBATE-TEST-JUDGE-FENCE (the judge's JSON is wrapped in
// a code fence) and DEBATE-TEST-TIE (the judge says it is too close).
const NOTE = "**Local test provider.** ";
const short = (s, n = 90) => (s.length > n ? s.slice(0, n).replace(/\s\S*$/, "") + "…" : s);
const OPENING = {
  A: (q, stance) =>
    `${stance ? `Arguing that ${short(stance)}: the` : "The"} case for this rests on two points. First, the benefits are concrete and show up in the lives of the people affected, not only in principle. Second, the alternative carries costs that are easy to overlook because they are spread thinly and paid quietly.`,
  B: (q, stance) =>
    `${stance ? `Arguing that ${short(stance)}: the` : "The"} case against rests on two points. First, the gains claimed are real but smaller and slower than promised, and the people who pay for them are rarely the people who are asked. Second, there are cheaper ways to reach most of the same goal.`,
};
const REBUTTAL = {
  A: "The other side calls the gains smaller than promised, but it doesn't say how it measured them, and the cheaper alternatives it names have already been tried where this was debated before. Even granting a slower path, the direction is right.",
  B: "The other side treats the benefits as settled, but its own examples come from places that differ from most. It concedes that costs fall on some people more than others, and that is the point: those costs decide whether this works at all.",
};
const CLOSING = {
  A: "Where the two sides agree, the goal is shared. Where they differ, my side gave reasons and named the trade-offs it accepts. That is why this side made the better case.",
  B: "Both sides want the same thing. The difference is who carries the risk and how sure we can be. My side answered the strongest points against it and kept its claims to what the evidence supports.",
};
function judge(question) {
  const tie = question.includes("DEBATE-TEST-TIE");
  const verdict = tie ? "too_close" : question.length % 2 ? "a" : "b";
  return {
    summary: `The two sides disagreed about how large the benefits are and who pays for them. Side A led with concrete gains; Side B pressed on cost and on cheaper alternatives, and each answered the other's main point.`,
    strongest: {
      a: "Side A tied the benefits to the people affected, and named the cost of doing nothing.",
      b: "Side B separated who gains from who pays, and pointed to a cheaper route to most of the goal.",
    },
    weakest: {
      a: "Side A never showed how the benefits were measured, and left the cheaper alternatives mostly unanswered.",
      b: "Side B's cheaper alternatives were named but not costed, and it leaned on examples from unlike places.",
    },
    verdict,
    why: tie
      ? "Each side answered the other's best point and neither left a gap the other could exploit."
      : `Side ${verdict.toUpperCase()} engaged more directly with the other side's strongest point and kept its claims closer to what it showed.`,
    settle: "Measured results from a place that tried this, with the costs counted for the people who paid them.",
  };
}
export function debateTestReply(messages) {
  const system = messages?.[0];
  if (system?.role !== "system" || typeof system.content !== "string") return null;
  const user = messages.find((m) => m.role === "user")?.content;
  if (typeof user !== "string") return null;
  const question = /Question or claim:\n([\s\S]*?)\n\n(?:Side A|Debate|The debate)/.exec(user)?.[1] ?? "";
  if (system.content === JUDGE_PROMPT) {
    if (question.includes("DEBATE-TEST-JUDGE-BAD")) return { text: "Both sides made fair points, and it's hard to say who won." };
    const json = JSON.stringify(judge(question), null, 2);
    return { text: question.includes("DEBATE-TEST-JUDGE-FENCE") ? "```json\n" + json + "\n```" : json };
  }
  const side = /^You are Side ([AB]) in a structured debate/.exec(system.content)?.[1];
  if (!side) return null;
  const role = system.content.includes("This is your opening statement") ? "opening" : system.content.includes("This is a rebuttal") ? "rebuttal" : "closing";
  if (side === "B" && role === "rebuttal" && question.includes("DEBATE-TEST-FAIL")) return { error: "Local test provider: this turn failed on purpose." };
  if (side === "B" && role === "opening" && question.includes("DEBATE-TEST-EMPTY")) return { text: "" };
  if (side === "B" && role === "opening" && question.includes("DEBATE-TEST-LENGTH")) return { text: "", finish: "length" };
  const stance = new RegExp(`Side ${side}'s position: (.*)`).exec(user)?.[1] || "";
  const body = role === "opening" ? OPENING[side](question, stance) : role === "rebuttal" ? REBUTTAL[side] : CLOSING[side];
  const text = NOTE + body;
  if (side === "A" && role === "opening" && question.includes("DEBATE-TEST-CUT")) return { text: text.slice(0, text.indexOf("First,") + 60), finish: "length" };
  return { text };
}
