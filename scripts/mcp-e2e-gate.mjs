#!/usr/bin/env node
/**
 * E2E test: verify that the gate tool shows the 3-option picker
 * when the client declares the elicitation capability.
 *
 * Usage:
 *   node scripts/mcp-e2e-gate.mjs
 *
 * This script:
 *   1. Spawns the built MCP server (build/index.js) via stdio.
 *   2. Initializes it as an MCP client that DECLARES `elicitation: { form: {} }`
 *      — exactly what VS Code does in mcpServerRequestHandler.ts.
 *   3. Calls `get_client_capabilities` and prints the result.
 *   4. Calls `review_and_select_prompt` with a tiny prompt + context.
 *   5. When the server sends an `elicitation/create` request, auto-accepts
 *      with `selected: "rewritten"` and prints the final result.
 *
 * If your llama.cpp is not running, the LLM step will fail — that's fine,
 * the point of this script is to prove the elicitation round-trip works.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(here, '..', 'build', 'index.js');

const child = spawn(process.execPath, [serverScript], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const rl = createInterface({ input: child.stdout });
let msgId = 1;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    const msg = { jsonrpc: '2.0', id, method, params };
    child.stdin.write(JSON.stringify(msg) + '\n');
  });
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  // Server → client request (elicitation/create, etc.)
  if (msg.method === 'elicitation/create') {
    console.log('\n[elicitation request from server]');
    console.log(JSON.stringify(msg.params, null, 2));
    // Auto-accept with "rewritten" to prove the round-trip.
    const resp = {
      jsonrpc: '2.0',
      id: msg.id,
      result: { action: 'accept', content: { selected: 'rewritten' } },
    };
    child.stdin.write(JSON.stringify(resp) + '\n');
    return;
  }
  if (msg.method === 'sampling/createMessage') {
    // Not expected in this flow, but respond gracefully.
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } }) + '\n'
    );
    return;
  }
});

async function main() {
  // 1. initialize — declare elicitation capability (what VS Code does).
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {
      elicitation: { form: {} },
    },
    clientInfo: { name: 'e2e-gate-test', version: '1.0' },
  });
  console.log('[initialize] OK, server:', init?.serverInfo?.name, init?.serverInfo?.version);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 2. capabilities
  const caps = await send('tools/call', {
    name: 'get_client_capabilities',
    arguments: {},
  });
  const capJson = caps?.structuredContent ?? JSON.parse(caps?.content?.[0]?.text ?? '{}');
  console.log('\n[get_client_capabilities]', JSON.stringify(capJson, null, 2));
  if (!capJson.elicitation_supported) {
    console.error('\nFAIL: server did NOT see the elicitation capability.');
    child.kill();
    process.exit(1);
  }
  console.log('PASS: server sees elicitation as supported.');

  // 3. gate tool (this is where the picker would appear in VS Code)
  const t0 = Date.now();
  const result = await send('tools/call', {
    name: 'review_and_select_prompt',
    arguments: {
      prompt: 'thông tin việt nam',
      context: 'e2e gate test session',
      rewrite_level: 'light',
    },
  });
  console.log(`\n[review_and_select_prompt] in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(result?.structuredContent ?? result, null, 2));

  child.kill();
}

main().catch((e) => {
  console.error('E2E gate test failed:', e.message ?? e);
  child.kill();
  process.exit(1);
});
