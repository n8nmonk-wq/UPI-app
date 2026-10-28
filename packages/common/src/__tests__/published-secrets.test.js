import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSecret } from '../secrets.js';

test('resolveSecret ignores a publicly known example value from .env', () => {
  const saved = process.env.ANDROID_ENROLLMENT_SECRET;
  process.env.ANDROID_ENROLLMENT_SECRET = 'android_pairing_enrollment_secret_key_32_chars';
  try {
    const value = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');
    assert.notEqual(value, 'android_pairing_enrollment_secret_key_32_chars');
    assert.match(value, /^[0-9a-f]{64}$/);
  } finally {
    if (saved === undefined) delete process.env.ANDROID_ENROLLMENT_SECRET;
    else process.env.ANDROID_ENROLLMENT_SECRET = saved;
  }
});

test('resolveSecret still honours an operator-chosen value', () => {
  process.env.TEST_CUSTOM_SECRET_FOR_SPEC = 'operator-chosen-value-123';
  try {
    assert.equal(resolveSecret('unused_name_for_spec', 'TEST_CUSTOM_SECRET_FOR_SPEC'), 'operator-chosen-value-123');
  } finally {
    delete process.env.TEST_CUSTOM_SECRET_FOR_SPEC;
  }
});
