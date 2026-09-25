import { fail, wantsWebSearch } from "./core.js";
// Structured requests still use chat's existing auth, accounting and saved-history path.
export function validateTaskRequest(body) {
  if (body.taskTool === undefined) return;
  if (!["research", "writing"].includes(body.taskTool))
    fail(400, "Choose a supported task tool.", "invalid_task");
  if (body.conversationId || body.mode !== "chat")
    fail(
      400,
      "Task tools create a separate chat for every result.",
      "invalid_task",
    );
  const m = body.messages;
  if (
    !Array.isArray(m) ||
    m.length !== 2 ||
    m[0]?.role !== "system" ||
    m[1]?.role !== "user" ||
    m.some((v) => typeof v.content !== "string") ||
    !m[1].content.trim() ||
    m[0].content.length > 1000 ||
    m[1].content.length > 10000
  )
    fail(
      400,
      "Task tools need a brief of 1–10,000 characters.",
      "invalid_task",
    );
  if (body.taskTool === "research" && !wantsWebSearch(body))
    fail(400, "Research requires Web search.", "invalid_task");
}
