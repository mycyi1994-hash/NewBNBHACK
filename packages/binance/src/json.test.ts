import { describe, expect, it } from 'vitest';
import { parseJsonLossless, stringifyJsonLossless } from './json.js';
import { maskSensitive, redactValues } from './telemetry.js';

describe('lossless JSON', () => {
  it('round-trips integers beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const text = '{"a":12345678901234567890,"b":1.5,"c":42,"d":[9007199254740993],"e":1e21}';
    const value = parseJsonLossless(text);
    expect(value).toEqual({
      a: 12345678901234567890n,
      b: 1.5,
      c: 42,
      d: [9007199254740993n],
      e: 1e21,
    });
    expect(stringifyJsonLossless(value)).toBe(
      '{"a":12345678901234567890,"b":1.5,"c":42,"d":[9007199254740993],"e":1e+21}',
    );
  });
});

describe('masking', () => {
  it('redacts listed values, matching hex case-insensitively', () => {
    const wallet = '0xAbCdEf0000000000000000000000000000000001';
    expect(redactValues(`to ${wallet.toLowerCase()} key sk-1234`, [wallet, 'sk-1234'])).toBe(
      'to [redacted] key [redacted]',
    );
  });

  it('shortens every address in free text', () => {
    expect(maskSensitive('from 0x55d398326f99059fF775485246999027B3197955 ok')).toBe(
      'from 0x55d3…7955 ok',
    );
  });

  it('leaves 32-byte hashes intact (transaction hashes are public)', () => {
    const hash = `0x${'a'.repeat(64)}`;
    expect(maskSensitive(hash)).toBe(hash);
  });
});
