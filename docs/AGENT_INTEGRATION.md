# Agent Integration Examples

Concrete, copy-paste-ready configurations for connecting the Universal Prompt
Gate MCP server to popular coding agents. Each example uses the **standard
MCP mode** (explicit tool invocation). Mandatory gating (hooks) is noted
where an agent supports it.

> **Important:** "Standard MCP mode" means the agent _can call_ the gate
> tools. It does NOT mean every user prompt is automatically intercepted.
> To enforce a mandatory gate, the agent must support a hook / integration
> that routes the submitted prompt through the gate tool before sending it
> to the LLM. See [`ARCHITECTURE.md`](ARCHITECTURE.md#22-mandatory-gating-khi-agent-hỗ-trợ-hooks).

## 1. Claude Code

Add the MCP server to your Claude Code configuration. Create or edit
`~/.claude/settings.json` (or the project-level `.claude/settings.json`):

```json
{
  "mcpServers": {
    "prompt-gate": {
      "command": "node",
      "args": ["/absolute/path/to/tool-prompt-rewrite-mcp/build/index.js"]
    }
  }
}
```

Restart Claude Code. The server's tools (`rewrite_prompt`,
`review_and_select_prompt`, `get_client_capabilities`) become available.

**Mandatory gating:** Claude Code supports hooks (the `PreToolUse` /
`UserPromptSubmit` hooks). Investigate whether `UserPromptSubmit` can block
or modify the submitted prompt before it reaches the model. If it can only
add context (not block/modify), mandatory gating is **partially enforced** —
the hook can remind the model to call the gate, but it cannot hard-block.
Document the actual semantics in the compatibility matrix before claiming
support.

## 2. Cursor

Create or edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "prompt-gate": {
      "command": "node",
      "args": ["/absolute/path/to/tool-prompt-rewrite-mcp/build/index.js"]
    }
  }
}
```

Restart Cursor. Use the tools manually, or have the agent call
`review_and_select_prompt` at the start of a task.

**Mandatory gating:** Cursor does not expose a public "pre-LLM" hook API as
of writing. Treat mandatory gating as **unavailable** unless you add a
custom extension that intercepts prompt submission.

## 3. Cline

Cline supports MCP servers via its settings. In the Cline UI:
Settings → MCP Servers → Add, then enter:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/tool-prompt-rewrite-mcp/build/index.js"]
}
```

Or edit `~/.config/cline/mcp_settings.json` / the project `.cline/mcp.json`
depending on your Cline version.

**Mandatory gating:** Cline's extension model may allow prompt interception,
but this requires a custom extension. Default: unavailable.

## 4. Continue

Continue is an open-source coding agent that supports MCP. Add to
`~/.continue/config.yaml` or the project-level config:

```yaml
mcpServers:
  prompt-gate:
    command: node
    args:
      - /absolute/path/to/tool-prompt-rewrite-mcp/build/index.js
```

**Mandatory gating:** Continue supports a rule / custom action system that
could invoke the gate tool before sending the prompt. This is
extension-dependent — verify the exact API before claiming support.

## 5. OpenCode

OpenCode supports MCP servers. Add to your OpenCode config (typically
`.opencode/config.json` or the user-level equivalent):

```json
{
  "mcp": {
    "prompt-gate": {
      "command": "node",
      "args": ["/absolute/path/to/tool-prompt-rewrite-mcp/build/index.js"]
    }
  }
}
```

**Mandatory gating:** OpenCode's extension mechanism is the path to a hard
gate. Until a tested E2E implementation exists, mark it as unverified.

## 6. Other MCP-compatible agents

Any agent that speaks MCP (stdio or Streamable HTTP) can connect to this
server. The only difference is _where_ you register the server and _whether_
the agent has a hook to force the gate on every prompt.

**Rule of thumb:**

- If the agent lets the user/LLM explicitly call tools → use
  `review_and_select_prompt` manually (standard mode).
- If the agent has a prompt-submission hook → wire the hook to call the gate
  tool (mandatory gating, when available).
- Otherwise → the gate is a _suggestion_, not enforcement.

## Testing your integration

1. Start a local llama.cpp server:
   ```bash
   ./llama-server -m qwen3.5-9b -c 8192 --port 8080 --api-key local-dev-key
   ```
2. Start the MCP server with MCP Inspector:
   ```bash
   npm run inspector
   ```
3. In the Inspector, call `get_client_capabilities` first. Confirm
   `elicitation_supported: true` for the client you are using.
4. Call `review_and_select_prompt` with a short prompt and walk through the
   elicitation UI (original / rewritten / update / cancel; "update" lets you
   type requested changes and the prompt is rewritten again — the loop ends
   at original / rewritten / cancel).
5. Verify that a cancel produces `status: "cancelled"` and no
   `selected_prompt` is returned.

## Compatibility matrix (default state — no E2E verified)

Until a tested end-to-end implementation exists for each agent, the
compatibility matrix in [`ARCHITECTURE.md`](ARCHITECTURE.md#3-ma-trận-tương-thích-agent)
marks Mandatory Gating as **TBD** and E2E Verified as **No**. This is the
"no unverified claims" principle: a ✓ is only earned by a passing E2E test,
not by the agent's name.
