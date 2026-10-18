# Agent Skills — universal-prompt-gate-mcp

Three skills that teach an agent how to drive the `universal-prompt-gate-mcp`
MCP server. Each skill is a directory with a `SKILL.md` (YAML frontmatter:
`name`, `description`) following the Agent Skills convention, so it is
discoverable by OpenCode, Claude Code, and VS Code Copilot agents alike.

| Skill ID                 | File                                      | What it does                                   |
| ------------------------ | ----------------------------------------- | ---------------------------------------------- |
| `rewrite-prompt`         | `rewrite-prompt/SKILL.md`                 | Drive the un-gated `rewrite_prompt` tool       |
| `review-and-select-prompt` | `review-and-select-prompt/SKILL.md`     | Drive the gated `review_and_select_prompt` tool |
| `prompt-gate-workflow`   | `prompt-gate-workflow/SKILL.md`           | Decide which tool to call, and in what order   |

## How they map to the MCP tools

- `rewrite-prompt` → the `rewrite_prompt` tool (candidate rewrite, no approval).
- `review-and-select-prompt` → the `review_and_select_prompt` tool (the gate).
- `prompt-gate-workflow` → orchestrates `get_client_capabilities` + the choice
  between the two above.

## Note on tool descriptions

The skills reference tool input/behavior that is also embedded in the MCP
server's own tool descriptions (`src/tools/*.ts`). Keep the two in sync: when
you change a tool's schema or description, update the matching skill here.
