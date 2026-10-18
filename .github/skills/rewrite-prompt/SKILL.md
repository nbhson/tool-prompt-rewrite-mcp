---
name: Rewrite Prompt
description: Use the `rewrite_prompt` MCP tool to produce a context-enriched version of the user's latest prompt without any approval gate. Use when the user asks to improve/enrich/expand a prompt but does NOT need to confirm the result before it is used.
---

# Rewrite Prompt (no gate)

This skill drives the **`rewrite_prompt`** tool of the
`universal-prompt-gate-mcp` MCP server. It produces a **candidate** rewrite
only — it does **NOT** approve the result, and it does **NOT** ask the user to
choose. If the user needs a confirmed, user-approved prompt before it is
forwarded, use the `review-and-select-prompt` skill instead.

## When to use

- The user asks to "improve / enrich / expand / clarify" a prompt and just
  wants to see the result.
- A quick preview of what a richer version of the prompt would look like.
- Generating prompt variants for experimentation, without gating.

Do **NOT** use it when the prompt must be explicitly approved before it is
sent to the model — that is the job of `review_and_select_prompt`.

## Inputs

| Field           | Required | Notes                                                                                                                                                                                                                                                                                 |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`        | yes      | The user's **latest message only**, not the whole session.                                                                                                                                                                                                                            |
| `context`       | yes*     | 1–3 sentences summarizing the session so far (what was asked, which files or topics are in play, what was decided). Pass it on every call; omit only for a brand-new session with no history.                                                                                         |
| `language`      | no       | **Omit by default.** The server auto-detects the prompt's language and preserves it. Only pass this when the user explicitly asks for a different output language (e.g. "rewrite in English"). Do NOT pass `"english"` to "improve clarity" — that is a language switch, and a drift. |
| `rewrite_level` | no       | `light` (minimal), `balanced` (default), `detailed` (full spec).                                                                                                                                                                                                                      |

## Choosing `rewrite_level`

- **`light`** — quick one-shot answers; keep the rewrite close to the original.
- **`balanced`** — most coding / research / analysis work (default).
- **`detailed`** — when the user explicitly wants a fully-specified spec with
  acceptance criteria.

## Language rule (do not drift)

The server **auto-detects the prompt's language** and preserves it by default.

- **Do not pass `language`** unless the user _explicitly_ asks for a different
  output language (e.g. "viết lại bằng tiếng Anh" / "rewrite this in English").
- A Vietnamese prompt stays Vietnamese; a Japanese prompt stays Japanese.
- Passing `language: "english"` because "English is clearer" is a **drift**,
  not an improvement. It overrides the user's language and breaks the
  "preserve the user's language" rule.

## How to call

The MCP server exposes the tool as `rewrite_prompt`. A correct call looks like:

```json
{
  "tool": "rewrite_prompt",
  "input": {
    "prompt": "fix the login bug",
    "context": "User reported the login page throws 500 after entering valid credentials. Working on src/auth/login.ts. Decided to move token validation into a middleware.",
    "rewrite_level": "balanced"
  }
}
```

## Expected result

The tool returns:

- `original_prompt` — the input prompt, unchanged.
- `rewritten_prompt` — the enriched version (the candidate; **not approved**).
- `changes_summary` — what was enriched (level, context applied, language, custom policy).
- `warnings` — optional notes (e.g., when a thinking model degraded output).

## Hard rules (do not violate)

- The result is a **candidate only**. Never treat `rewritten_prompt` as
  approved and never forward it to the model on the strength of this tool
  alone when a gate is required.
- Do not add new requirements or change intent — the tool is designed for
  **context enrichment only**.
- On an LLM error (timeout, HTTP error, empty completion), the tool returns a
  distinct error outcome; do **not** silently fall back to the original.
  Report the error to the user instead.

## Related

- Gate (user-approved) flow: `review-and-select-prompt` skill.
- Capability check before gating: `get_client_capabilities` tool.
