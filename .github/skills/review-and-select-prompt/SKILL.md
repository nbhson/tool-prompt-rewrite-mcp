---
name: Review And Select Prompt
description: Use the `review_and_select_prompt` MCP gate tool: rewrites the prompt, has the user pick the level and then original/rewritten/update/cancel (update loops with feedback), and returns only the user-approved prompt. Use whenever a prompt must be confirmed by the user before it is forwarded to the model.
---

# Review And Select Prompt (the gate)

This skill drives the **`review_and_select_prompt`** tool of the
`universal-prompt-gate-mcp` MCP server. It is the **gate**: it rewrites the
prompt, shows the user both the original and the rewritten version, lets the
user pick (original / rewritten / update / cancel), and returns **only** the
user-approved prompt. Choosing **update** lets the user request changes: they
describe what to adjust and the prompt is rewritten again — the menu loops
until they pick original, rewritten, or cancel.

## When to use

- Any time a prompt **must be explicitly approved by the user** before it is
  sent to the model.
- High-stakes prompts (code changes, external actions, expensive calls)
  where drift or a bad rewrite would be costly.
- The default choice for the "universal prompt gate" workflow.

If you only want to see a candidate rewrite with **no** user confirmation,
use the `rewrite-prompt` skill instead.

## Inputs

| Field              | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`           | yes      | The user's **latest message only**, not the whole session.                                                                                                                                                                                                                                                                                                                                                                    |
| `context`          | yes*     | 1–3 sentences summarizing the session so far (what was asked, which files or topics are in play, what was decided). Pass it on every call; omit only for a brand-new session with no history.                                                                                                                                                                                                                                 |
| `language`         | yes*     | **Always pass the language the user wrote their prompt in** (e.g. `"vietnamese"`, `"japanese"`), so the rewrite stays in that language. Only deviate when the user explicitly asks for a different output language — then pass that language instead. Do NOT pass `"english"` to "improve clarity" — that is a language switch, and a drift. Omit only if the language cannot be determined; the server then auto-detects it. |
| `rewrite_level`    | no       | **Chosen by the USER, not you.** Do NOT pass it on the first call — the tool shows the user a picker with `light` / `balanced` / `detailed` (or, for clients without elicitation, returns `pending_level_selection` with a text menu). Only pass it to relay the user's explicit choice after `pending_level_selection`.                                                                                                      |
| `selection`        | no       | **After `pending_user_selection` only:** the user's choice — `"original"` / `"rewritten"` / `"update"` / `"cancel"`. Never auto-select; pass it only after the user has answered.                                                                                                                                                                                                                                             |
| `rewritten_prompt` | no       | **Along with `selection`:** the exact rewritten text the user saw, so the user approves exactly what they read; also used with `selection="update"` as the version to revise.                                                                                                                                                                                                                                                 |
| `feedback`         | no       | **Required with `selection="update"`:** the changes the user asked for, in their own words (e.g. "make it shorter", "add acceptance criteria for X"). The tool rewrites again and returns a NEW `pending_user_selection`. Never invent feedback for the user.                                                                                                                                                                 |

## How it behaves

1. The tool first asks **the user** to choose the rewrite level
   (`light` / `balanced` / `detailed`):
   - If the client supports elicitation: an interactive picker. The agent
     must not choose the level.
   - If the client does NOT: a `pending_level_selection` result with the
     three numbered levels in plain text. Ask the user, then re-call with
     the same inputs plus `rewrite_level` set to their choice. Never pick
     for them.
2. The tool rewrites the prompt at that level (context enrichment only —
   no new intent).
3. It shows the user **both** the original and the rewritten version:
   - If the client supports elicitation: an interactive picker (4 options +
     an optional text field for requested changes).
   - If the client does NOT: a `pending_user_selection` result with both
     versions in plain text and the numbered choices.
4. The user chooses one of four:
   - **`original`** → the original prompt is the approved result.
   - **`rewritten`** → the rewritten prompt is the approved result.
   - **`update`** → the user wants changes. They describe them (feedback);
     the tool rewrites the prompt again at the same level and shows the new
     version — back to step 3. This loops until the user picks one of the
     other three options.
   - **`cancel`** → nothing is approved.
5. The tool returns the approved prompt — or a distinct cancellation outcome.
   When the text fallback was used, step 5 happens on a **later call**
   where you pass `selection` (plus `rewritten_prompt` if that is what was
   chosen). That call does not re-run the LLM. For `selection="update"` the
   call DOES run the LLM once (revision round) and returns a NEW
   `pending_user_selection` for another review.

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

**Pending level selection (client has no elicitation — text fallback, first step):**

When the client does not support MCP elicitation, the first call returns a
distinct outcome asking the user to choose the rewrite level. **No rewrite
has happened yet** (the LLM is not called):

```json
{
  "status": "pending_level_selection",
  "available_levels": ["light", "balanced", "detailed"]
}
```

Ask the user which level to use, then re-call with the same inputs plus
`rewrite_level` set to their choice:

```json
{
  "prompt": "...(same)",
  "context": "...(same)",
  "language": "...(same)",
  "rewrite_level": "balanced"
}
```

**Pending user selection (client has no elicitation — text fallback, second step):**

After the rewrite, the tool returns a distinct outcome that shows both
versions in plain text with the numbered choices, and instructs you to
re-call this tool with the user's choice:

```json
{
  "status": "pending_user_selection",
  "original_prompt": "...",
  "rewritten_prompt": "...",
  "available_selections": ["original", "rewritten", "update", "cancel"],
  "revision_count": 0
}
```

On the next call, pass `selection` (and `rewritten_prompt` if the user
chose the rewritten version) — that call does NOT re-run the LLM:

```json
{
  "prompt": "...(same)",
  "context": "...(same)",
  "language": "...(same)",
  "selection": "rewritten",
  "rewritten_prompt": "...(the text the user saw)"
}
```

If the user chooses **update**, pass `selection: "update"` **plus**
`feedback` with their requested changes and `rewritten_prompt` of the version
they reviewed. That call DOES run the LLM and returns a NEW
`pending_user_selection` (with `revision_count` bumped) to review — repeat
until the user picks original, rewritten, or cancel:

```json
{
  "prompt": "...(same)",
  "context": "...(same)",
  "language": "...(same)",
  "rewrite_level": "balanced",
  "selection": "update",
  "rewritten_prompt": "...(the version the user reviewed)",
  "feedback": "Make it shorter and add acceptance criteria for X"
}
```

**Error (LLM failure, strict mode, ...):** a distinct error
outcome; never a silent fallback to the original.

## Hard rules (do not violate)

- **The user chooses the level.** Never pass `rewrite_level` on the first
  call and never pick a level "on the user's behalf". With elicitation the
  picker enforces this; with the text fallback you must relay the user's
  explicit answer.
- **"Update" is user-driven only.** Only pass `selection="update"` after the
  user actually asked for changes, with their own words in `feedback`. Never
  invent feedback, and never use "update" to nudge the rewrite yourself.
  Keep looping (rewrite → review) until the user picks original, rewritten,
  or cancel.
- **Cancel is a distinct outcome.** When the user cancels, `selected_prompt`
  is `null` and **no** approved prompt is exposed. Do not forward anything.
- **No silent fallback.** If the rewrite fails (timeout, HTTP error, empty
  completion), the tool returns an error — it never auto-selects the original.
- **No auto-select on timeout.** The user must choose; nothing is selected for
  them.
- **Elicitation is optional (text fallback exists).** If the client does not
  support MCP elicitation, the tool returns `pending_level_selection` /
  `pending_user_selection` text menus by default. In strict mode
  (`PROMPT_GATE_ECHO_FALLBACK=false`) it returns a compatibility error
  instead. Check with `get_client_capabilities` if in doubt.

## Before calling: check capabilities

Optionally (recommended when the client is unknown), call
`get_client_capabilities` and check `elicitation_supported`. If it is
`false`, the gate still works in text-fallback mode by default — expect
`pending_level_selection` / `pending_user_selection` text menus and relay
the user's answers. In strict mode the gate fails with a compatibility
error — prefer `rewrite_prompt` or surface the limitation to the user.

## Related

- Capability check: `get_client_capabilities` tool.
- Ungated preview only: `rewrite-prompt` skill.
