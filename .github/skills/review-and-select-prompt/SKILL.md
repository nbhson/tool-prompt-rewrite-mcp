---
name: Review And Select Prompt
description: Use the `review_and_select_prompt` MCP gate tool: rewrites the prompt, shows original/rewritten to the user via elicitation, and returns only the user-approved prompt. Use whenever a prompt must be confirmed by the user before it is forwarded to the model.
---

# Review And Select Prompt (the gate)

This skill drives the **`review_and_select_prompt`** tool of the
`universal-prompt-gate-mcp` MCP server. It is the **gate**: it rewrites the
prompt, shows the user both the original and the rewritten version, lets the
user pick (original / rewritten / cancel), and returns **only** the
user-approved prompt.

## When to use

- Any time a prompt **must be explicitly approved by the user** before it is
  sent to the model.
- High-stakes prompts (code changes, external actions, expensive calls)
  where drift or a bad rewrite would be costly.
- The default choice for the "universal prompt gate" workflow.

If you only want to see a candidate rewrite with **no** user confirmation,
use the `rewrite-prompt` skill instead.

## Inputs

| Field              | Required | Notes                                                                                                                                                                                                                                                     |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`           | yes      | The user's **latest message only**, not the whole session.                                                                                                                                                                                                |
| `context`          | yes*     | 1–3 sentences summarizing the session so far (what was asked, which files or topics are in play, what was decided). Pass it on every call; omit only for a brand-new session with no history.                                                             |
| `language`         | no       | **Omit by default.** The server auto-detects the prompt's language and preserves it. Only pass this when the user explicitly asks for a different output language. Do NOT pass `"english"` to "improve clarity" — that is a language switch, and a drift. |
| `rewrite_level`    | no       | `light` / `balanced` (default) / `detailed`.                                                                                                                                                                                                              |
| `selection`        | no       | **Second call only** (after `pending_user_selection`): the user's choice — `"original"` / `"rewritten"` / `"cancel"`. Never auto-select; pass it only after the user has answered.                                                                        |
| `rewritten_prompt` | no       | **Second call only:** the exact rewritten text the user saw, so the user approves exactly what they read.                                                                                                                                                 |

## How it behaves

1. The tool rewrites the prompt (context enrichment only — no new intent).
2. It shows the user **both** the original and the rewritten version:
   - If the client supports elicitation: an interactive picker (3 options).
   - If the client does NOT: a `pending_user_selection` result with both
     versions in plain text and the three numbered choices.
3. The user chooses one of three:
   - **`original`** → the original prompt is the approved result.
   - **`rewritten`** → the rewritten prompt is the approved result.
   - **`cancel`** → nothing is approved.
4. The tool returns the approved prompt — or a distinct cancellation outcome.
   When the text fallback was used, step 4 happens on a **second call**
   where you pass `selection` (plus `rewritten_prompt` if that is what was
   chosen). The second call does not re-run the LLM.

## Expected results

**Approved (user picked original or rewritten):**

```json
{
  "status": "approved",
  "selected_option": "rewritten",
  "selected_prompt": "...",
  "original_prompt": "...",
  "rewritten_prompt": "..."
}
```

**Cancelled (user picked cancel):**

```json
{
  "status": "cancelled",
  "selected_option": "cancel",
  "selected_prompt": null
}
```

**Pending user selection (client has no elicitation — text fallback):**

When the client does not support MCP elicitation, the first call returns a
distinct outcome that shows both versions in plain text with the three
numbered choices, and instructs you to re-call this tool with the user's
choice:

```json
{
  "status": "pending_user_selection",
  "original_prompt": "...",
  "rewritten_prompt": "...",
  "available_selections": ["original", "rewritten", "cancel"]
}
```

On the second call, pass `selection` (and `rewritten_prompt` if the user
chose the rewritten version) — the second call does NOT re-run the LLM:

```json
{
  "prompt": "...(same)",
  "context": "...(same)",
  "selection": "rewritten",
  "rewritten_prompt": "...(the text the user saw)"
}
```

**Error (LLM failure, strict mode, ...):** a distinct error
outcome; never a silent fallback to the original.

## Hard rules (do not violate)

- **Cancel is a distinct outcome.** When the user cancels, `selected_prompt`
  is `null` and **no** approved prompt is exposed. Do not forward anything.
- **No silent fallback.** If the rewrite fails (timeout, HTTP error, empty
  completion), the tool returns an error — it never auto-selects the original.
- **No auto-select on timeout.** The user must choose; nothing is selected for
  them.
- **Elicitation must be supported.** If the client does not support MCP
  elicitation, the call returns a clear compatibility error. Check with
  `get_client_capabilities` first if in doubt.

## Before calling: check capabilities

Optionally (recommended when the client is unknown), call
`get_client_capabilities` and confirm `elicitation_supported: true` before
calling the gate. If it is `false`, the gate tool will fail with a
compatibility error — prefer `rewrite_prompt` or surface the limitation to the
user.

## Related

- Capability check: `get_client_capabilities` tool.
- Ungated preview only: `rewrite-prompt` skill.
