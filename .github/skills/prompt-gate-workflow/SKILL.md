---
name: Prompt Gate Workflow
description: Choose and drive the right universal-prompt-gate-mcp tool for a prompt: check client capabilities, then gate via review_and_select_prompt (user-approved) or preview via rewrite_prompt (no gate). Use when deciding which prompt-gate tool to call and how to chain them safely.
---

# Prompt Gate Workflow (capabilities → choose → gate)

This skill orchestrates the three tools of the
`universal-prompt-gate-mcp` MCP server. It tells you **which tool to call and
in what order**, so prompts are enriched and approved safely.

The three tools:

| Tool                       | Role                                                        | Asks the user? |
| -------------------------- | ----------------------------------------------------------- | -------------- |
| `get_client_capabilities`  | Reports what the connected client can do (elicitation, ...) | No             |
| `review_and_select_prompt` | **Gate**: rewrite + user picks original/rewritten/cancel    | **Yes**        |
| `rewrite_prompt`           | Rewrite only (candidate, no approval)                       | No             |

## Decision flow

```text
1. Is the prompt going to be forwarded to the model on the user's behalf
   (code change, external action, anything where drift is costly)?
   │
   ├─ YES → call review_and_select_prompt (the gate)
   │        │
   │        ├─ status = "approved"        → forward selected_prompt.
   │        ├─ status = "cancelled"        → stop; selected_prompt is null.
   │        ├─ status = "pending_user_selection"
   │        │        (client has no elicitation; text fallback is on)
   │        │        → show the two versions + the 3 numbered choices to
   │        │          the user. When the user answers, re-call
   │        │          review_and_select_prompt with `selection` set to
   │        │          "original"/"rewritten"/"cancel" (and
   │        │          `rewritten_prompt` if that was chosen). The second
   │        │          call does not re-run the LLM.
   │        └─ status = "error"
   │                 → do NOT fall back to the original; report the error.
   │
   └─ NO (just a preview / enrichment, no forwarding)
            → call rewrite_prompt
```

> **Note on elicitation:** the gate tool works with or without client
> elicitation support. When the client has no elicitation, the server's
> **text fallback** (`PROMPT_GATE_ECHO_FALLBACK=true`, the default) returns
> `pending_user_selection` and the gate completes on a second call with the
> user's `selection`. Only when the fallback is disabled
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
`pending_user_selection` and you complete it with a second call carrying
`selection`. Only when `PROMPT_GATE_ECHO_FALLBACK=false` does a
non-eliciting client get a hard compatibility error — never pretend a normal
tool response is an interactive confirmation.

## Step 2 — call the right tool

### Gate (user must approve before forwarding)

Use `review_and_select_prompt` (see `review-and-select-prompt` skill).
Pass:

- `prompt` — the user's latest message.
- `context` — 1–3 sentence session summary (strongly recommended every call).
- `rewrite_level` — `light` / `balanced` (default) / `detailed`.
- `language` — only when the output language differs.

Then branch on the result:

- `status: "approved"` → forward `selected_prompt`.
- `status: "cancelled"` → stop; `selected_prompt` is `null`; forward nothing.
- error outcome → do not fall back to the original; report the error.

### Preview (no gate)

Use `rewrite_prompt` (see `rewrite-prompt` skill). The result is a candidate
only — never forward it as if it were approved when a gate is actually
required.

## Hard rules (apply to the whole workflow)

- **Context is always passed.** Every rewrite or gate call includes a short
  session summary in `context` so the result is grounded.
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
