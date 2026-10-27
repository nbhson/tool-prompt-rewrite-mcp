# Plan — tool-prompt-rewrite-mcp

MCP server rewrite prompt (universal-prompt-gate), TypeScript, vitest.

## Baseline audit (00:44, 28-10-2026)
- Tests: ✅ **66 pass** (10 files)
- Build: ✅
- Lint: ❌ **109 errors** — nguyên nhân chính: eslint script chạy `eslint . --ext .ts` và quét cả thư mục `build/` (artifacts) + `scripts/rewrite-smoke.ts` ngoài tsconfig.project; ngoài ra `no-undef` cho `process`/`console`/`fetch` trên file build

## Roadmap
### P0 (chặn)
- [x] eslint config: ignore `build/`, `scripts/` (không thuộc tsconfig project)
- [x] `npm run lint` = 0 error
- [x] npm audit: body-parser@2.3.0 (high DoS) + fast-uri (moderate) từ @modelcontextprotocol/sdk/express@5 — SDK đã ở latest; không fix được ở cấp này (ghi nhận)
- [x] vitest upgrade: 4.1.12 + vite@6 (fix tinypool critical + @vitest/mocker moderate)

### P1 (chất lượng)
- [ ] Audit logic rewrite/review/cancellation (đã có test tốt — rà soát edge case)
- [ ] Coverage check

### P2 (hardening)
- [ ] CI workflow
- [ ] Docs sync với tính năng hiện tại

## Self-review log
- _0:44_ Audit lần 1: 66/66 pass, lint fail (109 lỗi từ build/ + scripts/).
- _1:00_ Commit 1 (P0): eslint ignores, lint=0; vitest→4.1.12+vite@6; audit 2 remaining (body-parser DoS low-risk for local MCP; express@5 latest). Gate: test 66 ✅, lint ✅, typecheck ✅, build ✅, audit ⚠️ documented.
