---
name: Prompt Gate Workflow
description: Choose and drive the right universal-prompt-gate-mcp tool for a prompt: check client capabilities, then gate via review_and_select_prompt (user-approved) or preview via rewrite_prompt (no gate). Use when deciding which prompt-gate tool to call and how to chain them safely.
---

# Prompt Gate Workflow (capabilities → choose → gate)

This skill orchestrates the three tools of the
`universal-prompt-gate-mcp` MCP server. It tells you **which tool to call and
in what order**, so prompts are enriched and approved safely.

The three tools:

| Tool                       | Role                                                           | Asks the user? |
| -------------------------- | -------------------------------------------------------------- | -------------- |
| `get_client_capabilities`  | Reports what the connected client can do (elicitation, ...)    | No             |
| `review_and_select_prompt` | **Gate**: user picks the level, then original/rewritten/cancel | **Yes**        |
| `rewrite_prompt`           | Rewrite only (candidate, no approval)                          | No             |

## Decision flow

```text
1. Is the prompt going to be forwarded to the model on the user's behalf
   (code change, external action, anything where drift is costly)?
   │
   ├─ YES → call review_and_select_prompt (the gate)
   │        │
   │        ├─ status = "approved"        → forward selected_prompt.
   │        ├─ status = "cancelled"        → stop; selected_prompt is null.
   │        ├─ status = "pending_level_selection"
   │        │        (client has no elicitation; text fallback is on)
   │        │        → ask the user which level to use (light/balanced/
   │        │          detailed), then re-call with `rewrite_level` set to
   │        │          their choice. The prompt has NOT been rewritten yet.
   │        ├─ status = "pending_user_selection"
   │        │        (client has no elicitation; text fallback is on)
   │        │        → show the two versions + the 3 numbered choices to
   │        │          the user. When the user answers, re-call
   │        │          review_and_select_prompt with `selection` set to
   │        │          "original"/"rewritten"/"cancel" (and
   │        │          `rewritten_prompt` if that was chosen). That call
   │        │          does not re-run the LLM.
   │        └─ status = "error"
   │                 → do NOT fall back to the original; report the error.
   │
   └─ NO (just a preview / enrichment, no forwarding)
            → call rewrite_prompt
```

> **Note on elicitation:** the gate tool works with or without client
> elicitation support. With elicitation, the user picks the rewrite level
> (light/balanced/detailed) in a first picker, then original/rewritten/cancel
> in a second one — all inside a single tool call. When the client has no
> elicitation, the server's **text fallback** (`PROMPT_GATE_ECHO_FALLBACK=true`,
> the default) returns `pending_level_selection` first (ask the user, re-call
> with `rewrite_level`) and then `pending_user_selection` (ask the user,
> re-call with `selection`). Only when the fallback is disabled
> (`PROMPT_GATE_ECHO_FALLBACK=false`) does a non-eliciting client get a hard
> compatibility error — in that case, prefer `rewrite_prompt` or surface the
> limitation to the user.

## Step 1 — check capabilities (optional)

Call `get_client_capabilities` (no input). Read:

- `elicitation_supported` — can the client show an interactive picker?
- `structured_elicitation_supported` — structured variant.
- `transport` — `stdio` / `http`.
- `integration_mode` — how the client integrates the server.
- `mandatory_gating_enforceable` — whether a hard gate is enforceable.

If `elicitation_supported` is `false` and the text fallback is enabled
(the default), the gate still works: the tool returns
`pending_level_selection` (level menu) and later `pending_user_selection`
(original/rewritten/cancel menu), and you complete it with follow-up calls
carrying `rewrite_level` / `selection`. Only when
`PROMPT_GATE_ECHO_FALLBACK=false` does a non-eliciting client get a hard
compatibility error — never pretend a normal tool response is an interactive
confirmation.

## Step 2 — call the right tool

### Gate (user must approve before forwarding)

Use `review_and_select_prompt` (see `review-and-select-prompt` skill).
Pass:

- `prompt` — the user's latest message.
- `context` — 1–3 sentence session summary (strongly recommended every call).
- `language` — always pass the language the user wrote their prompt in;
  deviate only when the user explicitly asks for a different output language.
- `rewrite_level` — do NOT pass it: the USER chooses the level via the
  picker. Only relay it after a `pending_level_selection` result (text
  fallback).

Then branch on the result:

- `status: "approved"` → forward `selected_prompt`.
- `status: "cancelled"` → stop; `selected_prompt` is `null`; forward nothing.
- `status: "pending_level_selection"` → ask the user for the level; re-call
  with `rewrite_level` set to their choice (same prompt/context/language).
- `status: "pending_user_selection"` → ask the user which version to use;
  re-call with `selection` (+ `rewritten_prompt` if chosen).
- error outcome → do not fall back to the original; report the error.

### Preview (no gate)

Use `rewrite_prompt` (see `rewrite-prompt` skill). The result is a candidate
only — never forward it as if it were approved when a gate is actually
required.

## Hard rules (apply to the whole workflow)

- **Context is always passed.** Every rewrite or gate call includes a short
  session summary in `context` so the result is grounded.
- **The user chooses the level.** Never pick `rewrite_level` for the user in
  the gate flow; relay their explicit choice.
- **Enrichment only, no new intent.** Neither tool adds requirements the
  user did not ask for.
- **Cancel ≠ approved.** A cancelled gate exposes no prompt.
- **No silent fallback, no auto-select.** LLM errors and timeouts are
  reported, never resolved by defaulting to the original.
- **Respect capabilities.** Never claim a gate succeeded on a client that
  cannot do elicitation.

## Related skills

- `rewrite-prompt` — un-gated rewrite (candidate only).
- `review-and-select-prompt` — the gate (user-approved prompt).
