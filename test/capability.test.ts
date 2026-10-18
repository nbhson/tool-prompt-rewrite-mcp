import { describe, it, expect } from 'vitest';
import { detectCapabilities } from '../src/capability/capability.js';

describe('detectCapabilities', () => {
  it('returns the conservative default for no client caps', () => {
    const c = detectCapabilities({});
    expect(c.elicitationSupported).toBe(false);
    expect(c.structuredElicitationSupported).toBe(false);
    expect(c.mandatoryGatingEnforceable).toBe(false);
    expect(c.transport).toBe('stdio');
  });

  it('reports elicitation support when the client declares it', () => {
    const c = detectCapabilities({ elicitation: {} });
    expect(c.elicitationSupported).toBe(true);
    expect(c.structuredElicitationSupported).toBe(false);
  });

  it('reports structured elicitation when the form sub-capability is present', () => {
    const c = detectCapabilities({ elicitation: { form: {} } });
    expect(c.elicitationSupported).toBe(true);
    expect(c.structuredElicitationSupported).toBe(true);
  });

  it('never infers capabilities from the agent name', () => {
    // Even if the client is "claude-code" with no caps, we must not guess.
    const c = detectCapabilities({});
    expect(c.mandatoryGatingEnforceable).toBe(false);
  });
});
