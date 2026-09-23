/**
 * Lossless JSON. The official connector parses responses with `json-with-bigint` because some
 * integer fields are typed `number | bigint`; we do the same with the standard source-text
 * access (`context.source`, `JSON.rawJSON`, Node >= 21) instead of an extra dependency.
 */

interface ReviverContext {
  source?: string;
}

const INTEGER_TEXT = /^-?\d+$/;

export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: ReviverContext) => {
    if (
      typeof value === 'number' &&
      !Number.isSafeInteger(value) &&
      context?.source !== undefined &&
      INTEGER_TEXT.test(context.source)
    ) {
      return BigInt(context.source);
    }
    return value;
  });
}

const rawJSON = (text: string): unknown =>
  (JSON as unknown as { rawJSON(this: void, text: string): unknown }).rawJSON(text);

/** Inverse of parseJsonLossless: bigint values are written back as bare JSON integers. */
export function stringifyJsonLossless(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => (typeof v === 'bigint' ? rawJSON(v.toString()) : v),
    space,
  );
}
