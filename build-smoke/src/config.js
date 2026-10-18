/**
 * Configuration loading for the Universal Prompt Gate MCP Server.
 *
 * Reads PROMPT_GATE_* env vars, validates them, and exposes typed config.
 * No secret values are ever logged.
 */
const DEFAULTS = {
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'qwen3.5-9b',
    apiKey: 'local-dev-key',
    // Default 60s is too short for thinking models running on CPU/Apple
    // Silicon (qwen3.5-9b + 1024 completion tokens can take 60–90s).
    // 180s leaves headroom; raise via PROMPT_GATE_TIMEOUT_MS if slower.
    timeoutMs: 180_000,
    retryMax: 3,
    httpPort: 3000,
    logLevel: 'info',
    // Thinking models need room for reasoning before the final answer; 1024
    // is too tight. 2048 is enough for a short, structured rewrite.
    maxTokens: 2048,
    temperature: 0.2,
};
function parsePositiveInt(raw, fallback, max) {
    if (raw === undefined || raw.trim() === '')
        return fallback;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || n <= 0)
        return fallback;
    if (max !== undefined && n > max)
        return max;
    return n;
}
function parseLevel(raw) {
    const r = raw?.toLowerCase();
    if (r === 'debug' || r === 'info' || r === 'warn' || r === 'error')
        return r;
    return DEFAULTS.logLevel;
}
function pickLlmUrl(env) {
    // External LLM overrides local when set.
    if (env.PROMPT_GATE_EXTERNAL_LLM && env.PROMPT_GATE_EXTERNAL_LLM.trim() !== '') {
        return env.PROMPT_GATE_EXTERNAL_LLM.trim();
    }
    return env.PROMPT_GATE_LLM_BASE_URL?.trim() || DEFAULTS.baseUrl;
}
export function loadConfig(env = process.env) {
    const logLevel = parseLevel(env.PROMPT_GATE_LOG_LEVEL);
    const baseUrl = pickLlmUrl(env);
    const model = env.PROMPT_GATE_LLM_MODEL?.trim() || DEFAULTS.model;
    const apiKey = env.PROMPT_GATE_LLM_API_KEY?.trim() || DEFAULTS.apiKey;
    const timeoutMs = parsePositiveInt(env.PROMPT_GATE_TIMEOUT_MS, DEFAULTS.timeoutMs, 10 * 60_000);
    const retryMax = parsePositiveInt(env.PROMPT_GATE_LLM_RETRY_MAX, DEFAULTS.retryMax, 10);
    const maxTokens = parsePositiveInt(env.PROMPT_GATE_LLM_MAX_TOKENS, DEFAULTS.maxTokens, 32_768);
    const transportRaw = env.PROMPT_GATE_TRANSPORT?.toLowerCase();
    const transport = transportRaw === 'http' ? 'http' : 'stdio';
    const httpPort = parsePositiveInt(env.PROMPT_GATE_HTTP_PORT, DEFAULTS.httpPort, 65535);
    const policyFile = env.PROMPT_GATE_REWRITE_POLICY_FILE?.trim() || undefined;
    // Optional passthrough body fields for OpenAI-compatible endpoints.
    // Most useful: `PROMPT_GATE_LLM_ENABLE_THINKING=false` to skip the
    // reasoning phase on qwen3 / qwen3.5 thinking models via llama.cpp.
    //
    // NOTE: llama.cpp (v12+ with thinking support) honors `thinking: false`
    // at the top level, not `enable_thinking`. We send both; llama.cpp
    // uses `thinking`, OpenAI/other providers use `enable_thinking`.
    //
    // Any PROMPT_GATE_LLM_EXTRA_JSON (a JSON object) is merged in last.
    const extraBody = {};
    const thinking = env.PROMPT_GATE_LLM_ENABLE_THINKING?.trim();
    if (thinking !== undefined && thinking !== '') {
        const bool = thinking === 'true' ? true : thinking === 'false' ? false : thinking;
        extraBody.thinking = bool; // llama.cpp parameter
        extraBody.enable_thinking = bool; // OpenAI / custom providers
    }
    const extraJson = env.PROMPT_GATE_LLM_EXTRA_JSON?.trim();
    if (extraJson !== undefined && extraJson !== '') {
        try {
            const parsed = JSON.parse(extraJson);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                Object.assign(extraBody, parsed);
            }
        }
        catch {
            // Malformed JSON: ignore rather than crash; warn via a top-level field.
            extraBody.__invalidExtraJson = true;
        }
    }
    return {
        llm: {
            baseUrl,
            model,
            apiKey,
            timeoutMs,
            retryMax,
            maxTokens,
            temperature: DEFAULTS.temperature,
            ...(Object.keys(extraBody).length > 0 ? { extraBody } : {}),
        },
        externalLlm: env.PROMPT_GATE_EXTERNAL_LLM?.trim() || undefined,
        transport,
        httpPort,
        policyFile,
        logLevel,
    };
}
