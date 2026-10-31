/**
 * Unit tests for elicitChoice — the elicitation wrapper.
 *
 * The wrapper is exercised against a stub `McpServer` whose
 * `server.elicitInput` is replaced, covering: valid accept (with and
 * without feedback), decline/cancel mapping, protocol errors, and
 * server-side validation of the returned content.
 */

import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { elicitChoice, type ElicitCall } from '../src/elicitation.js';
import { GateError } from '../src/types.js';

type ElicitInputArgs = Parameters<McpServer['server']['elicitInput']>[0];

function fakeServer(
  impl: (args: ElicitInputArgs) => Promise<unknown> | unknown
): McpServer {
  return {
    server: {
      elicitInput: (args: ElicitInputArgs) => impl(args),
    },
  } as unknown as McpServer;
}

/** Narrow the captured elicitInput args to the form-mode shape. */
function formArgs(args: unknown): {
  mode: string;
  requestedSchema: {
    type: string;
    required?: string[];
    properties: Record<string, unknown>;
  };
} {
  return args as {
    mode: string;
    requestedSchema: { type: string; required?: string[]; properties: Record<string, unknown> };
  };
}

const baseCall: ElicitCall = {
  step: 'selection',
  message: 'Choose one:',
  options: [
    { value: 'original', title: 'Original' },
    { value: 'rewritten', title: 'Rewritten' },
    { value: 'update', title: 'Update' },
  ],
  requestId: 'req-1',
};

describe('elicitChoice', () => {
  it('sends a form schema with the option enum and required "selected"', async () => {
    let captured: unknown;
    const server = fakeServer((args) => {
      captured = args;
      return { action: 'accept', content: { selected: 'original' } };
    });
    await elicitChoice(server, baseCall);
    const args = formArgs(captured);
    expect(args.mode).toBe('form');
    expect(args.requestedSchema.type).toBe('object');
    expect(args.requestedSchema.required).toEqual(['selected']);
    expect((args.requestedSchema.properties.selected as { enum?: string[] }).enum).toEqual([
      'original',
      'rewritten',
      'update',
    ]);
  });

  it('adds the optional feedback field when the call declares one', async () => {
    let captured: unknown;
    const server = fakeServer((args) => {
      captured = args;
      return { action: 'accept', content: { selected: 'update', feedback: '  shorter please  ' } };
    });
    const res = await elicitChoice(server, { ...baseCall, feedback: { title: 'Changes', description: 'd' } });
    expect((formArgs(captured).requestedSchema.properties.feedback as { type: string }).type).toBe('string');
    expect(res).toEqual({ action: 'accept', chosen: 'update', feedback: 'shorter please' });
  });

  it('trims feedback but omits it when blank', async () => {
    const server = fakeServer(() => ({ action: 'accept', content: { selected: 'update', feedback: '   ' } }));
    const res = await elicitChoice(server, { ...baseCall, feedback: { title: 'C', description: 'd' } });
    expect(res).toEqual({ action: 'accept', chosen: 'update' });
  });

  it('decline maps to a cancel outcome', async () => {
    const server = fakeServer(() => ({ action: 'decline' }));
    expect(await elicitChoice(server, baseCall)).toEqual({ action: 'cancel' });
  });

  it("client 'cancelled' action maps to a cancel outcome", async () => {
    const server = fakeServer(() => ({ action: 'cancel' }));
    expect(await elicitChoice(server, baseCall)).toEqual({ action: 'cancel' });
  });

  it('throws elicitation_unsupported when the SDK call fails', async () => {
    const server = fakeServer(() => {
      throw new Error('client does not support elicitation');
    });
    await expect(elicitChoice(server, baseCall)).rejects.toMatchObject({
      name: 'GateError',
      kind: 'elicitation_unsupported',
    });
  });

  it('throws invalid_input when "selected" is missing or out of enum', async () => {
    const missing = fakeServer(() => ({ action: 'accept', content: {} }));
    await expect(elicitChoice(missing, baseCall)).rejects.toMatchObject({
      kind: 'invalid_input',
    });
    const outOfEnum = fakeServer(() => ({ action: 'accept', content: { selected: 'hacked' } }));
    await expect(elicitChoice(outOfEnum, baseCall)).rejects.toBeInstanceOf(GateError);
    await expect(elicitChoice(outOfEnum, baseCall)).rejects.toMatchObject({
      kind: 'invalid_input',
    });
  });

  it('non-Error throws from the SDK still become typed GateErrors', async () => {
    const server = fakeServer(() => {
      throw 'boom';
    });
    await expect(elicitChoice(server, baseCall)).rejects.toMatchObject({
      kind: 'elicitation_unsupported',
    });
  });
});
