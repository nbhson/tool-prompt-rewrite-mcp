#!/usr/bin/env node
/**
 * E2E test of the MCP server over stdio (the real JSON-RPC protocol).
 *
 * Spawns `node build/index.js`, sends initialize + tools/list +
 * tools/call rewrite_prompt, and prints the result. Optionally answers an
 * elicitation request for review_and_select_prompt.
 *
 * Usage:
 *   node scripts/mcp-e2e.mjs [rewrite|gate|caps|caps-decl|echo]
 *
 *   rewrite - just test rewrite_prompt (no user interaction needed)
 *   gate    - test review_and_select_prompt; auto-answers the level picker
 *             with "balanced", requests a revision ("update" + feedback) on
 *             the first selection round, then answers "rewritten" on the
 *             second round (exercises the update loop end-to-end)
 *   caps    - declare NO elicitation; get_client_capabilities must say false
 *   caps-decl - declare elicitation; get_client_capabilities must say true
 *   echo    - client declares NO elicitation; the gate tool returns
 *             pending_level_selection first (text fallback), a re-call with
 *             rewrite_level="light" returns pending_user_selection, a
 *             selection="update" + feedback re-call returns a NEW
 *             pending_user_selection, and a final selection="rewritten"
 *             completes the gate without another LLM call
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
const declareElicitation = mode !== 'caps' && mode !== 'echo';

const child = spawn('node', [join(__dirname, '..', 'build', 'index.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: join(__dirname, '..'),
});

let buffer = '';
let nextId = 0;
let selectionRounds = 0;
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

    // Server->client request (elicitation). Auto-answer: the level picker
    // gets "balanced"; on the selection picker the first round requests a
    // revision ("update" + feedback) and later rounds accept "rewritten".
    if (msg.id !== undefined && msg.method) {
      console.error(`[server->client] ${msg.method}`);
      const content = {};
      if (msg.params?.requestedSchema?.properties?.selected) {
        const enumVals = msg.params.requestedSchema.properties.selected.enum ?? [];
        if (enumVals.includes('rewritten')) {
          // Selection picker.
          selectionRounds += 1;
          if (selectionRounds === 1) {
            content.selected = 'update';
            content.feedback = 'Keep it short and add acceptance criteria.';
          } else {
            content.selected = 'rewritten';
          }
        } else if (enumVals.includes('balanced')) {
          content.selected = 'balanced';
        } else {
          content.selected = enumVals[0];
        }
        console.error(`[server->client] auto-answer: ${content.selected}`);
      }
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { action: 'accept', content } }) + '\n'
      );
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
  console.log(
    `[${secs()}s] initialized: ${init.serverInfo?.name} v${init.serverInfo?.version} (declared elicitation: ${declareElicitation})`
  );
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
  } else if (mode === 'echo') {
    // Client declares NO elicitation -> the gate tool must return
    // pending_level_selection first (the text fallback), NOT an error, and
    // WITHOUT calling the LLM yet. The USER must choose the level.
    const r = await rpc('tools/call', {
      name: 'review_and_select_prompt',
      arguments: { prompt: 'thông tin việt nam', context: 'e2e echo test' },
    });
    console.log(`\n=== [${secs()}s] call 1: no elicitation, no level -> level menu expected ===`);
    if (r.isError) {
      console.error('ERROR:', r.structuredContent?.message ?? r.content?.[0]?.text);
      child.kill();
      process.exit(1);
    }
    const sc = r.structuredContent;
    console.log('STATUS:', sc?.status);
    if (sc?.status !== 'pending_level_selection') {
      console.error(`FAIL: expected pending_level_selection, got ${sc?.status}`);
      child.kill();
      process.exit(1);
    }
    console.log('LEVELS:', sc?.available_levels?.join(', '));
    console.log('\n--- text menu shown to the agent ---');
    console.log(r.content?.[0]?.text);

    // Simulate the user picking "light": the agent re-calls with the SAME
    // inputs plus the relayed level. Now the rewrite runs and the selection
    // menu is returned.
    const r2 = await rpc('tools/call', {
      name: 'review_and_select_prompt',
      arguments: {
        prompt: 'thông tin việt nam',
        rewrite_level: 'light',
        context: 'e2e echo test',
      },
    });
    console.log(`\n=== [${secs()}s] call 2: rewrite_level=light -> selection menu expected ===`);
    if (r2.isError) {
      console.error('ERROR:', r2.structuredContent?.message ?? r2.content?.[0]?.text);
      child.kill();
      process.exit(1);
    }
    const sc2 = r2.structuredContent;
    console.log('STATUS:', sc2?.status);
    if (sc2?.status !== 'pending_user_selection') {
      console.error(`FAIL: expected pending_user_selection, got ${sc2?.status}`);
      child.kill();
      process.exit(1);
    }
    console.log('ORIGINAL:', sc2?.original_prompt);
    console.log('REWRITTEN:', sc2?.rewritten_prompt);
    console.log('MENU:', sc2?.available_selections?.join(', '));
    if (!sc2?.available_selections?.includes('update')) {
      console.error('FAIL: selection menu must offer "update"');
      child.kill();
      process.exit(1);
    }

    // Simulate the user picking "update" and describing changes: the agent
    // re-calls with the user's selection + feedback. This must rewrite
    // again (new LLM call) and return a NEW pending_user_selection.
    const r2b = await rpc('tools/call', {
      name: 'review_and_select_prompt',
      arguments: {
        prompt: 'thông tin việt nam',
        rewrite_level: 'light',
        context: 'e2e echo test',
        selection: 'update',
        feedback: 'Keep it shorter and add acceptance criteria.',
        rewritten_prompt: sc2?.rewritten_prompt,
      },
    });
    console.log(`\n=== [${secs()}s] call 3: re-call with selection=update + feedback ===`);
    if (r2b.isError) {
      console.error('ERROR:', r2b.structuredContent?.message ?? r2b.content?.[0]?.text);
      child.kill();
      process.exit(1);
    }
    const sc2b = r2b.structuredContent;
    console.log('STATUS:', sc2b?.status);
    console.log('REVISION:', sc2b?.revision_count);
    console.log('REWRITTEN:', sc2b?.rewritten_prompt);
    if (sc2b?.status !== 'pending_user_selection' || sc2b?.revision_count !== 1) {
      console.error(`FAIL: expected a new pending_user_selection with revision_count=1, got ${sc2b?.status}`);
      child.kill();
      process.exit(1);
    }

    // Simulate the user picking "rewritten" on the revised version: the
    // agent re-calls with the user's selection. This must NOT call the LLM
    // again.
    const r3 = await rpc('tools/call', {
      name: 'review_and_select_prompt',
      arguments: {
        prompt: 'thông tin việt nam',
        rewrite_level: 'light',
        context: 'e2e echo test',
        selection: 'rewritten',
        rewritten_prompt: sc2b?.rewritten_prompt,
      },
    });
    console.log(`\n=== [${secs()}s] call 4: re-call with selection=rewritten ===`);
    if (r3.isError) {
      console.error('ERROR:', r3.structuredContent?.message ?? r3.content?.[0]?.text);
      child.kill();
      process.exit(1);
    }
    console.log('STATUS:', r3.structuredContent?.status);
    console.log('SELECTED:', r3.structuredContent?.selected_option);
    console.log('PROMPT:', r3.structuredContent?.selected_prompt);
    if (
      r3.structuredContent?.status !== 'approved' ||
      r3.structuredContent?.selected_option !== 'rewritten'
    ) {
      console.error('FAIL: expected approved/rewritten on the final call');
      child.kill();
      process.exit(1);
    }
  } else {
    const r = await rpc('tools/call', {
      name: 'review_and_select_prompt',
      arguments: { prompt: 'thông tin việt nam', context: 'e2e gate test' },
    });
    console.log(
      `\n=== [${secs()}s] review_and_select_prompt (auto-answered: level=balanced, round 1=update+feedback, round 2=rewritten) ===`
    );
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
