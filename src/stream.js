// POST-based SSE reader; network chunks need not align with UTF-8 or events.
export async function* readChatEvents(response) {
  if (!response.body) throw Error("The service returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
          .trim();
        if (!data) continue;
        if (data === "[DONE]") return;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw Error(
            "The response stream could not be decoded. Check account activity before retrying.",
          );
        }
        yield event;
      }
      if (done)
        throw Error(
          "The connection ended before completion was confirmed. Check history and account activity before retrying.",
        );
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
