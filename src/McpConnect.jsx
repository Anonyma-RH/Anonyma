import React from "react";
import { Icon, CopyButton, Notice } from "./ui.jsx";
import "./mcp.css";

const claudeCodeCommand = (origin) =>
  `claude mcp add --transport http anonyma ${origin}/mcp --header "Authorization: Bearer YOUR_API_KEY"`;
const desktopConfig = (origin) =>
  JSON.stringify(
    {
      mcpServers: {
        anonyma: {
          url: `${origin}/mcp`,
          headers: { Authorization: "Bearer YOUR_API_KEY" },
        },
      },
    },
    null,
    2,
  );
// Copyable snippets that point an MCP client (Claude Code, Claude Desktop,
// Cursor, ...) at this account's remote MCP server. The key is always a
// placeholder; nothing here can leak a real secret.
export default function McpConnect({ config }) {
  const origin =
    config?.origin ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const cli = claudeCodeCommand(origin);
  const json = desktopConfig(origin);
  return (
    <div className="mcp-connect">
      <div className="mcp-connect-head">
        <Icon name="command" size={20} />
        <div>
          <h3>Connect an AI tool</h3>
          <p>
            Any key above works as a Bearer token. Requests from an AI tool
            spend from the same balance and appear on the same ledger as the
            web workspace.
          </p>
        </div>
      </div>
      <div className="code-example">
        <div>
          <span>CLAUDE CODE</span>
          <CopyButton text={cli} />
        </div>
        <pre>
          <code>{cli}</code>
        </pre>
      </div>
      <div className="code-example">
        <div>
          <span>CLAUDE DESKTOP / CURSOR</span>
          <CopyButton text={json} />
        </div>
        <pre>
          <code>{json}</code>
        </pre>
      </div>
      <Notice>
        Replace YOUR_API_KEY with a real key from above. Keep it private;
        anyone holding it can spend from this balance.
      </Notice>
    </div>
  );
}
