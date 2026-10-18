#!/usr/bin/env node
/**
 * E2E test of the MCP server over stdio (the real JSON-RPC protocol).
 *
 * Spawns `node build/index.js`, sends initialize + tools/list +
 * tools/call rewrite_prompt, and prints the result. Optionally answers an
 * elicitation request for review_and_select_prompt.
 *
 * Usage:
 *   node scripts/mcp-e2e.mjs [rewrite|gate]
 *
 *   rewrite - just test rewrite_prompt (no user interaction needed)
 *   gate    - test review_and_select_prompt; auto-answers elicitation
 *             with "rewritten" so the flow runs unattended
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Modes:
//  - caps        : declare NO elicitation -> get_client_capabilities must say false
//  - caps-decl   : declare elicitation.form -> get_client_capabilities must say true
//  - rewrite     : test rewrite_prompt
//  - gate        : test review_and_select_prompt (auto-answers elicitation)
const mode = process.argv[2] || 'rewrite';
const declareElicitation = mode !== 'caps';

const child = spawn('node', [join(__dirname, '..', 'build', 'index.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: join(__dirname, '..'),
});

let buffer = '';
let nextId = 0;
const pending = new Map();

function send(method, params) {
  const id = ++nextId;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  child.stdin.write(msg + '\n');
  return id;
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    // Server->client request (elicitation). Auto-accept "rewritten".
    if (msg.id !== undefined && msg.method) {
      console.error(`[server->client] ${msg.method}`);
      const content = {};
      if (msg.params?.requestedSchema?.properties?.selected) {
        const enumVals = msg.params.requestedSchema.properties.selected.enum ?? [];
        // Prefer rewritten if present, else the first option.
        content.selected = enumVals.includes('rewritten') ? 'rewritten' : enumVals[0];
      }
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { action: 'accept', content } }) + '\n');
      return;
    }

    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

function rpc(method, params) {
  const id = send(method, params);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const T0 = Date.now();
const secs = () => ((Date.now() - T0) / 1000).toFixed(1);

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: declareElicitation ? { elicitation: { form: {} } } : {},
    clientInfo: { name: 'e2e-test', version: '1.0.0' },
  });
  console.log(`[${secs()}s] initialized: ${init.serverInfo?.name} v${init.serverInfo?.version} (declared elicitation: ${declareElicitation})`);
  notify('notifications/initialized', {});

  const tools = await rpc('tools/list', {});
  console.log(`[${secs()}s] tools: ${tools.tools.map((t) => t.name).join(', ')}`);

  if (mode === 'caps' || mode === 'caps-decl') {
    const r = await rpc('tools/call', { name: 'get_client_capabilities', arguments: {} });
    console.log(`\n=== [${secs()}s] get_client_capabilities ===`);
    console.log(JSON.stringify(r.structuredContent, null, 2));
    const supported = r.structuredContent?.elicitation_supported;
    const expect = mode === 'caps-decl' ? true : false;
    if (supported !== expect) {
      console.error(`FAIL: expected elicitation_supported=${expect}, got ${supported}`);
      child.kill();
      process.exit(1);
    }
    console.log(`\n=== E2E ${mode} PASS in ${secs()}s ===`);
    child.kill();
    process.exit(0);
  }

  if (mode === 'rewrite') {
    const r = await rpc('tools/call', {
      name: 'rewrite_prompt',
      arguments: { prompt: 'thông tin việt nam', rewrite_level: 'light', context: 'tin tức hôm nay' },
    });
    console.log(`\n=== [${secs()}s] rewrite_prompt ===`);
    if (r.isError) {
      console.error('ERROR:', r.structuredContent?.message ?? r.content?.[0]?.text);
      child.kill();
      process.exit(1);
    }
    console.log('ORIGINAL:', r.structuredContent?.original_prompt);
    console.log('REWRITTEN:', r.structuredContent?.rewritten_prompt);
    console.log('CHANGES:', r.structuredContent?.changes_summary);
    console.log('WARNINGS:', r.structuredContent?.warnings ?? '(none)');
  } else {
    const r = await rpc('tools/call', {
      name: 'review_and_select_prompt',
      arguments: { prompt: 'thông tin việt nam', rewrite_level: 'light' },
    });
    console.log(`\n=== [${secs()}s] review_and_select_prompt (auto-chose: rewritten) ===`);
    if (r.isError) {
      console.error('ERROR:', r.structuredContent?.message ?? r.content?.[0]?.text);
      child.kill();
      process.exit(1);
    }
    console.log('STATUS:', r.structuredContent?.status);
    console.log('SELECTED:', r.structuredContent?.selected_option);
    console.log('PROMPT:', r.structuredContent?.selected_prompt);
  }

  console.log(`\n=== E2E ${mode} PASS in ${secs()}s ===`);
  child.kill();
  process.exit(0);
} catch (err) {
  console.error(`\nE2E ${mode} FAILED after ${secs()}s:`, err.message);
  child.kill();
  process.exit(1);
}
