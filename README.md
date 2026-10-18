# Universal Prompt Gate MCP Server

> Một MCP server độc lập, hoạt động với nhiều coding agent, giúp người dùng xem xét và chọn prompt **trước khi** prompt được gửi đến LLM. Hỗ trợ viết lại prompt bằng LLM local, hiển thị 3 lựa chọn (gốc / đã sửa / hủy) và đảm bảo an toàn, linh hoạt cho agent.

## Ví dụ hoạt động (core use case)

Bạn nhập một prompt ngắn trong agent:

```
"thông tin việt nam"
```

MCP server rewrite (enrich) bằng LLM local (llama.cpp) thành:

> "Tóm tắt những tin tức mới nhất về Việt Nam hôm nay, phân loại theo kinh tế, chính trị, xã hội và công nghệ. Ưu tiên nguồn tin đáng tin cậy."

Trước khi prompt được forward tới LLM lớn, user được hiển thị 3 lựa chọn:

```
[1] Dùng prompt gốc        ("thông tin việt nam")
[2] Dùng prompt đã viết lại (bản enrich phía trên)
[3] Hủy                    (không gọi LLM)
```

User chọn → prompt được chọn (hoặc trạng thái "cancelled") mới được gửi tới LLM lớn. Đây là **flow core** của server.

## Tính năng chính

- **Prompt review & rewrite trước khi gửi**: mọi prompt đi qua "cổng kiểm duyệt", không tự động forward
- **3 lựa chọn cho người dùng**: (1) dùng prompt gốc, (2) dùng prompt đã viết lại, (3) hủy
- **Viết lại = Enrich ngữ cảnh** (context enrichment): bổ sung context, cấu trúc output, tiêu chí chất lượng thiếu — **không thêm ý mới**, tránh drift
- **Viết lại bằng LLM local** (llama.cpp, OpenAI-compatible) — không gửi prompt ra cloud
- **Hỗ trợ nhiều coding agent**: Claude Code, Cursor, Cline, Continue, OpenCode, …
- **2 chế độ tích hợp**:
  - **Standard MCP mode** — agent gọi tool, MCP server xử lý elicitation UI
  - **Mandatory Gating** (khi agent hỗ trợ hooks) — prompt **không được** forward cho đến khi user xác nhận
- **Đa nhà cung cấp LLM**: llama.cpp local, OpenAI (cloud), custom endpoint
- **An toàn**: không log prompt đầy đủ, không thực thi shell từ prompt, redact secrets trong log, timeout & cancellation, không placeholder credentials

## Các tool MCP

| Tool                       | Input chính                                                                                   | Output chính                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rewrite_prompt`           | `prompt` (bắt buộc), `language`?, `context`?, `rewrite_level` (`light`/`balanced`/`detailed`) | `original_prompt`, `rewritten_prompt`, `changes_summary`, `warnings`?                                                                                                                                            |
| `review_and_select_prompt` | `prompt` (bắt buộc), `language`?, `context`?, `rewrite_level`?                                | Approved: `status=approved`, `selected_option` (`original`/`rewritten`), `selected_prompt`, `original_prompt`, `rewritten_prompt` · Cancel: `status=cancelled`, `selected_option=cancel`, `selected_prompt=null` |
| `get_client_capabilities`  | —                                                                                             | `elicitation_supported`, `structured_elicitation_supported`, `transport`, `integration_mode`, `mandatory_gating_enforceable`                                                                                     |

> **Nguyên tắc quan trọng:**
>
> - `rewrite_prompt` **không được** tự động claim rewritten prompt đã được approve — tool chỉ sinh bản rewrite.
> - `review_and_select_prompt` mới là tool "gate" — chỉ return approved prompt sau khi user **chọn rõ**.
> - **Cancel ≠ approved**: khi user chọn cancel, response là distinct protocol outcome (`status=cancelled`), **không** expose approved prompt.
> - **Không silent fallback**: sau LLM error, **không** auto-chọn original. Trả về lỗi rõ ràng.
> - **Không auto-select sau timeout**: user phải chọn thủ công, không được auto chọn mặc định.

Chi tiết schema & behavior: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Cài đặt

Yêu cầu: **Node.js 20+**.

```bash
# 1. Clone & install
cd tool-prompt-rewrite-mcp
npm install

# 2. Build
npm run build

# 3. Chạy với MCP Inspector (thử tool)
npm run inspector
```

## Cấu hình (biến môi trường)

Tạo file `.env` (xem `.env.example`) hoặc export trực tiếp:

| Biến                              | Default                                                | Mô tả                                                                                        |
| --------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `PROMPT_GATE_LLM_BASE_URL`        | `http://127.0.0.1:8080/v1`                             | Endpoint LLM (OpenAI-compatible)                                                             |
| `PROMPT_GATE_LLM_MODEL`           | `qwen3.5-9b` _(ví dụ — verify theo llama.cpp version)_ | Tên model                                                                                    |
| `PROMPT_GATE_LLM_API_KEY`         | `local-dev-key`                                        | API key (local, không cần thật)                                                              |
| `PROMPT_GATE_TIMEOUT_MS`          | `180000`                                               | Timeout (ms) cho LLM (thinking models chạy CPU cần thời gian dài hơn) |
| `PROMPT_GATE_LLM_RETRY_MAX`       | `3`                                                    | Số lần retry cho lỗi network (idempotent)                                              |
| `PROMPT_GATE_LLM_MAX_TOKENS`      | `2048`                                                 | Số token completion tối đa (thinking models cần budget lớn)                           |
| `PROMPT_GATE_LLM_ENABLE_THINKING` | _(unset)_                                              | `true`/`false` — bật/tắt reasoning (qwen3/llama.cpp thinking models)                   |
| `PROMPT_GATE_LLM_EXTRA_JSON`      | _(unset)_                                              | JSON object gộp vào request body LLM (vd: `{"chat_format":"chatml"}`)                  |
| `PROMPT_GATE_TRANSPORT`           | `stdio`                                                | `stdio` hoặc `http`                                                                     |
| `PROMPT_GATE_EXTERNAL_LLM`        | _(unset)_                                              | Optional: endpoint LLM cloud                                                                 |
| `PROMPT_GATE_REWRITE_POLICY_FILE` | _(unset)_                                              | File meta-prompt tùy chỉnh (preset: `news`/`code`/`research`, …) — override default strategy |

> **Tách rạch ròi 2 trục:**
>
> - **Per-call** (nhập vào tool): `rewrite_level` — `light` / `balanced` / `detailed`
> - **Global default** (env): `PROMPT_GATE_REWRITE_POLICY_FILE` — meta-prompt preset
>
> Khi gọi tool, `rewrite_level` quyết định mức enrich cụ thể; `PROMPT_GATE_REWRITE_POLICY_FILE` chỉ định meta-prompt dùng làm hệ thống. `qwen3.5-9b` là **ví dụ** — cần verify model name đúng theo version llama.cpp đang chạy.

## Chạy LLM local (llama.cpp)

```bash
# Tải model (một lần)
./llama-server -m qwen3.5-9b -c 8192 --port 8080 --api-key local-dev-key

# Xác nhận
curl http://127.0.0.1:8080/v1/models
```

MCP server sẽ gọi endpoint này để rewrite prompt. Không cần internet.

## Chạy MCP server

```bash
# Default (stdio) — dành cho desktop agents
node build/index.js

# Hoặc qua package.json
npm start
```

## Tích hợp với agent

> **Standard MCP mode** là chế độ mặc định, hoạt động trên mọi agent hỗ trợ MCP. Phần Mandatory Gating (hook) là **extension** — không bắt buộc, và chỉ khả thi khi agent có hỗ trợ hook API.

### Ví dụ cấu hình MCP server

Thêm MCP server vào config của agent (JSON dạng phổ biến):

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

Hoặc nếu đã publish lên npm:

```json
{
  "mcpServers": {
    "prompt-gate": {
      "command": "npx",
      "args": ["-y", "universal-prompt-gate-mcp"]
    }
  }
}
```

Mỗi agent có cơ chế cấu hình khác nhau — xem [ma trận tương thích](docs/ARCHITECTURE.md#3-ma-trận-tương-thích-agent).

### Truyền cấu hình (env) cho server — 3 cách

Server đọc config theo thứ tự ưu tiên (cao hơn thắng):

```
1. env thật (client truyền qua `env`/`environment` trong JSON MCP)
2. file `.env` (auto-load: PROMPT_GATE_ENV_FILE → CWD → cạnh build/index.js)
3. defaults built-in
```

#### Cách A — `env` trong JSON (khuyến nghị khi publish)

Claude Code / Cursor / VS Code Copilot dùng key `mcpServers` (hoặc `servers`) + trường `env`:

```json
{
  "mcpServers": {
    "prompt-gate": {
      "command": "node",
      "args": ["/absolute/path/to/build/index.js"],
      "env": {
        "PROMPT_GATE_LLM_BASE_URL": "http://127.0.0.1:8080/v1",
        "PROMPT_GATE_LLM_MODEL": "qwen3.5-9b",
        "PROMPT_GATE_LLM_MAX_TOKENS": "4096",
        "PROMPT_GATE_TIMEOUT_MS": "300000",
        "PROMPT_GATE_LLM_ENABLE_THINKING": "false"
      }
    }
  }
}
```

> OpenCode V2 dùng `mcp.servers` + trường `environment`, và `command` là mảng:
>
> ```jsonc
> {
>   "mcp": {
>     "servers": {
>       "prompt-gate": {
>         "type": "local",
>         "command": ["node", "/absolute/path/to/build/index.js"],
>         "environment": { "PROMPT_GATE_LLM_MODEL": "qwen3.5-9b" }
>       }
>     }
>   }
> }
> ```

#### Cách B — file `.env` (local dev)

Copy `.env.example` → `.env` ở root repo. Server **tự load** khi khởi động (không cần `env` trong JSON). Khi client spawn server từ CWD khác, server sẽ tìm `.env` cạnh `build/index.js` (repo). Set `PROMPT_GATE_ENV_FILE=/duong/dan/.env` để chỉ đúng file.

#### Cách C — Custom provider (ship riêng, dùng khi publish)

```json
"env": {
  "PROMPT_GATE_PROVIDER": "custom",
  "PROMPT_GATE_CUSTOM_PROVIDER_MODULE": "/absolute/path/to/my-provider.js"
}
```

`my-provider.js` phải export:

```js
export function createCustomLLMProvider(cfg) {
  // cfg: LLMConfig (baseUrl, model, apiKey, timeoutMs, retryMax, maxTokens, …)
  return {
    isConfigured: () => true,
    chat: async (messages, options) => {
      // gọi endpoint/model/API của bạn, trả về STRING (completion).
      // Ném Error khi lỗi — server sẽ map thành GateError.
      return await callYourApi(messages, options);
    },
  };
}
```

→ Bạn ship provider này như 1 package riêng (vd `@me/my-llm-provider`), trỏ `PROMPT_GATE_CUSTOM_PROVIDER_MODULE` tới file đã cài (`require.resolve` / path tuyệt đối). Không cần sửa nguồn package prompt-gate.

### Các biến env liên quan tới provider

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PROMPT_GATE_PROVIDER` | `openai-compatible` | `openai-compatible` / `openai` / `custom` |
| `PROMPT_GATE_CUSTOM_PROVIDER_MODULE` | _(unset)_ | Path module custom (chỉ dùng khi provider=custom) |
| `PROMPT_GATE_LLM_BASE_URL` | `http://127.0.0.1:8080/v1` | Endpoint OpenAI-compatible |
| `PROMPT_GATE_EXTERNAL_LLM` | _(unset)_ | Override baseUrl (cloud endpoint) |
| `PROMPT_GATE_LLM_MODEL` | `qwen3.5-9b` | Tên model |
| `PROMPT_GATE_LLM_MAX_TOKENS` | `2048` | Completion tokens tối đa |
| `PROMPT_GATE_TIMEOUT_MS` | `180000` | Timeout (ms) |
| `PROMPT_GATE_LLM_ENABLE_THINKING` | _(unset)_ | `true`/`false` — tắt reasoning (qwen3/llama.cpp) |
| `PROMPT_GATE_LLM_EXTRA_JSON` | _(unset)_ | JSON gộp vào request body LLM |
| `PROMPT_GATE_ENV_FILE` | _(unset)_ | Path file `.env` explicit |


### Khi nào nên dùng tool nào

- **`rewrite_prompt`** — khi chỉ muốn xem bản enrich, chưa cần user gate (vd preview).
- **`review_and_select_prompt`** — khi cần "gate" thực sự: user phải chọn trước khi prompt được dùng. Đây là tool chính của "Universal Prompt Gate".
- **`get_client_capabilities`** — để kiểm tra client đang connect có hỗ trợ elicitation không, trước khi gọi gate tool.

## Luồng hoạt động

### Sơ đồ workflow (Mermaid)

```mermaid
flowchart TD
  U(["👤 User<br/>gõ prompt<br/>VD: &quot;thông tin việt nam&quot;"])

  subgraph AGENT["🤖 Coding Agent (client MCP)"]
    A1["Gọi tool<br/><b>review_and_select_prompt</b>"]
    A3["Nhận kết quả JSON"]
    A4{"Dùng kết quả"}
    AOK["Gửi <b>selected_prompt</b><br/>tới LLM lớn"]
    ASTOP["Dừng / báo hủy"]
  end

  subgraph MCP["🛡️ Universal Prompt Gate MCP Server"]
    T["Tool: <b>review_and_select_prompt</b>"]
    V["Validate input (Zod)"]
    R["Gọi LLM để rewrite"]
    RM{"LLM ok?"}
    RE["Trả về error<br/>(<b>không</b> silent fallback)"]
    E["Hiển thị ORIGINAL &amp; REWRITTEN<br/>qua elicitation"]
    CHOICE{"User chọn 1 trong 3"}
    O1["Use original"]
    O2["Use rewritten"]
    O3["Cancel"]
  end

  subgraph LLM["🧠 LLM local (llama.cpp)"]
    L1["/v1/chat/completions"]
  end

  U -->|"1. submit prompt"| A1
  A1 -->|"2. MCP tool call"| T
  T --> V
  V -->|"hợp lệ"| R
  R -->|3. fetch| L1
  L1 -->|4. completion| R
  R --> RM
  RM -->|thất bại| RE
  RM -->|thành công| E
  E -->|5. elicitation| CHOICE
  CHOICE -->|6a| O1
  CHOICE -->|6b| O2
  CHOICE -->|6c| O3
  O1 -->|7a. approved| A3
  O2 -->|7b. approved| A3
  O3 -->|7c. cancelled| A3
  RE -->|error| A3
  A3 --> A4
  A4 -->|"approved"| AOK
  A4 -->|"cancelled / error"| ASTOP
```

> File nguồn của sơ đồ: [`docs/WORKFLOW.md`](docs/WORKFLOW.md).

### Standard MCP Mode

```
1. Agent submit prompt ("thông tin việt nam")
2. Agent gọi MCP tool → LLM (llama.cpp) viết lại prompt
3. MCP server trả về bản gốc & bản đã sửa (qua elicitation UI)
4. MCP server hiển thị 3 lựa chọn (1/2/3)
5. User chọn (1/2/3)
6. MCP server trả về prompt đã chọn (hoặc trạng thái "cancelled")
7. Agent gửi prompt đó (hoặc dừng nếu hủy)
```

### Mandatory Gating (khi agent hỗ trợ hooks)

Agent hook bắt prompt → gọi `review_and_select_prompt` → bên trong MCP server:

```
Write prompt (llama.cpp)
    → Hiển thị lựa chọn (elicitation)
    → Người dùng lựa chọn & xác nhận
    → Trả về kết quả (hoặc hủy)
```

Prompt **không được** forward khi user chọn "Hủy".

### Cancellation Flow

```
User chọn Cancel → MCP Server xác nhận hủy → Không forward prompt tới agent/LLM
Response: { status: "cancelled", selected_option: "cancel", selected_prompt: null }
```

> Cancel là **distinct protocol outcome** — response **không** expose `selected_prompt`. Không silent fallback sang original khi LLM lỗi.

## An toàn & bảo mật

- Giới hạn độ dài input, validate output (Zod)
- Timeout & cancellation (explicit, không auto-select)
- Phát hiện injection; treat prompt as untrusted data
- Quản lý session (pending requests), isolation per session/request ID, cleanup abandoned
- **Không silent fallback**: sau LLM error, KHÔNG auto-chọn original — trả về lỗi rõ ràng
- **Không auto-select sau timeout**: user phải chọn thủ công
- **Cancel = distinct outcome**: response `status=cancelled`, **không** expose approved prompt
- Không log prompt đầy đủ; redact secrets trong log; không placeholder credentials
- Không tự động forward khi hủy; không thực thi shell từ prompt

## Testing

```bash
# Chạy unit + integration tests (mock LLM, không cần llama.cpp)
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

Test suite phủ:

- Rewrite (success, timeout, malformed, language/context pass-through)
- Review/select: original, rewritten, cancel, cancellation via action, LLM error (no fallback), elicitation unsupported, invalid selection
- Capability detection (conservative default, no name-based inference)
- Concurrent sessions (isolation)
- Logger (redaction, stderr-only)
- Config (env defaults, overrides, clamping)

## Phát triển & build

```bash
npm run typecheck   # tsc --noEmit
npm run lint         # eslint
npm run format       # prettier
npm run build        # tsc
npm run dev          # tsx (không build)
```

## Cấu trúc thư mục

```
tool-prompt-rewrite-mcp/
├── package.json
├── tsconfig.json
├── tsconfig.test.json
├── eslint.config.js
├── .prettierrc
├── .env.example
├── .gitignore
├── README.md
├── docs/
│   ├── ARCHITECTURE.md
│   ├── AGENT_INTEGRATION.md
│   ├── WORKFLOW.md
│   └── Universal Prompt Gate MCP Architecture.png
├── src/
│   ├── index.ts                  # entry (stdio)
│   ├── config.ts                 # load env → typed config
│   ├── logger.ts                 # safe logger (stderr, redaction)
│   ├── types.ts                  # shared domain types
│   ├── elicitation.ts            # MCP elicitation wrapper
│   ├── capability/
│   │   └── capability.ts         # client capability detection
│   ├── session/
│   │   └── session.ts            # pending-request management
│   ├── llm/
│   │   ├── index.ts              # provider factory
│   │   └── provider.ts           # OpenAI-compatible provider + retry
│   ├── rewrite/
│   │   └── rewrite.ts            # meta-prompts + RewriteService
│   └── tools/
│       ├── index.ts              # tool registration
│       ├── rewritePrompt.ts      # rewrite_prompt tool
│       ├── reviewAndSelect.ts    # review_and_select_prompt tool (the gate)
│       └── getClientCapabilities.ts
└── test/
    ├── rewrite.test.ts
    ├── review.test.ts
    ├── cancellation.test.ts
    ├── concurrent.test.ts
    ├── capability.test.ts
    ├── config.test.ts
    ├── logger.test.ts
    └── fixtures/
        └── llm-mocks.ts
```

## Tài liệu liên quan

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Kiến trúc tổng thể, ma trận tương thích, env variables, security
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) — test & debug server
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — chạy OpenAI-compatible API local
- [Troubleshooting](#troubleshooting)

## Troubleshooting

| Triệu chứng                          | Nguyên nhân                                                | Cách xử lý                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `LLM request timed out`              | llama.cpp quá chậm, model quá lớn, thinking model chạy CPU | Tăng `PROMPT_GATE_TIMEOUT_MS` (vd 300000), tăng `PROMPT_GATE_LLM_MAX_TOKENS` (vd 4096)                                   |
| `LLM HTTP 401`                       | Sai API key                                                | Kiểm tra `PROMPT_GATE_LLM_API_KEY` khớp với key llama.cpp                                                                  |
| `LLM returned an empty completion`   | Model không sinh ra text (temperature cao, max_tokens nhỏ) | Giảm `temperature`, tăng `PROMPT_GATE_LLM_MAX_TOKENS` (default 2048, tăng nếu cần)                                         |
| `LLM returned empty content but produced reasoning_content` | Model thinking (qwen3/3.5) không tôn trọng `thinking:false` | Dùng model **không** thinking (vd `qwen2.5-7b`), hoặc update llama.cpp về build hỗ trợ `thinking:false`, hoặc set `PROMPT_GATE_LLM_MAX_TOKENS=4096`+ để model có đủ budget |
| Client báo `elicitation_unsupported` | Agent không support elicitation                            | Dùng tool `get_client_capabilities` trước; chỉ dùng gate tool khi `elicitation_supported: true`                            |
| Prompt không qua gate khi dùng agent | Agent không có hook (Standard mode)                        | Đây là giới hạn của standard MCP — xem [Mandatory Gating](docs/ARCHITECTURE.md#22-mandatory-gating-khi-agent-hỗ-trợ-hooks) |
| `node build/index.js` không chạy     | Chưa build                                                 | `npm run build` trước                                                                                                      |

## License

[Apache-2.0](LICENSE)
