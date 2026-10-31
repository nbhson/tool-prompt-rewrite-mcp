/**
 * Test fixture: an INVALID custom provider module (missing the required
 * `createCustomLLMProvider` export). Used to assert the factory's error.
 */

export function somethingElse() {
  return {};
}
