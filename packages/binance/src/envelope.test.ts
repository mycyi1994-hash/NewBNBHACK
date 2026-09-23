import { describe, expect, it } from 'vitest';
import { parseEnvelope } from './envelope.js';

// Bodies below are the examples printed in llms-full.txt (line numbers of the 2026-09-23 snapshot).
const DOC_SUCCESS = '{"code":0,"msg":"success","data":{},"timestamp":1713500000000,"success":true}'; // L98
const DOC_GATEWAY_401 =
  '{"code":40102,"msg":"Invalid signature","data":null,"timestamp":1715420937000}'; // L422
const DOC_DEFI_REVERT =
  '{"code":40484,"msg":"The amount is below the minimum required by the protocol. Please enter a larger amount.","data":null,"success":false}'; // L3914

describe('OCResult envelope', () => {
  it('accepts code 0 with HTTP 200', () => {
    const result = parseEnvelope(200, DOC_SUCCESS, 'oc');
    expect(result).toMatchObject({ ok: true, code: 0, data: {}, serverTime: 1713500000000 });
  });

  it('treats an HTTP 200 body with a non-zero code as an error (Trading/Market/Wallet/Tx style)', () => {
    const result = parseEnvelope(200, DOC_DEFI_REVERT, 'oc');
    expect(result).toMatchObject({ ok: false, kind: 'api', code: 40484 });
    expect(result.ok || result.msg).toContain('below the minimum');
  });

  it('treats success:false as an error even with code 0', () => {
    const result = parseEnvelope(200, '{"code":0,"msg":"x","data":null,"success":false}', 'oc');
    expect(result.ok).toBe(false);
  });

  it('reads a gateway 401 body that has no success field', () => {
    const result = parseEnvelope(401, DOC_GATEWAY_401, 'oc');
    expect(result).toMatchObject({ ok: false, kind: 'api', code: 40102, msg: 'Invalid signature' });
  });

  it('does not call a 2xx body without an envelope code a success', () => {
    const result = parseEnvelope(200, '{"data":[1,2,3]}', 'oc');
    expect(result).toMatchObject({ ok: false, kind: 'transport', code: null });
  });

  it('reports the AWS WAF challenge (HTTP 202, empty body) as a transport error', () => {
    const headers = new Headers({ 'x-amzn-waf-action': 'challenge' });
    const result = parseEnvelope(202, '', 'oc', headers);
    expect(result).toMatchObject({ ok: false, kind: 'transport' });
    expect(result.ok || result.msg).toBe('empty body, x-amzn-waf-action: challenge');
  });

  it('reports HTML error pages as http errors', () => {
    const result = parseEnvelope(502, '<html><body>Bad Gateway</body></html>', 'oc');
    expect(result).toMatchObject({ ok: false, kind: 'http', code: null });
  });

  it('keeps integers beyond 2^53 exact', () => {
    const result = parseEnvelope(
      200,
      '{"code":0,"msg":"success","data":{"raw":123456789012345678901234},"timestamp":1,"success":true}',
      'oc',
    );
    expect(result.ok && result.data).toEqual({ raw: 123456789012345678901234n });
  });
});

// Field names from the connector's b402 response types; only code/errorData/data matter here.
describe('B402 envelope', () => {
  it('accepts the 9-zero success code', () => {
    const body =
      '{"status":null,"type":null,"code":"000000000","errorData":null,"data":{"kinds":[]},"subData":null}';
    expect(parseEnvelope(200, body, 'b402')).toMatchObject({
      ok: true,
      code: '000000000',
      data: { kinds: [] },
    });
  });

  it('keeps b402 envelope error codes as strings', () => {
    const body =
      '{"status":null,"type":null,"code":"1160401","errorData":"Merchant not found","data":null}';
    expect(parseEnvelope(200, body, 'b402')).toMatchObject({
      ok: false,
      kind: 'api',
      code: '1160401',
      msg: 'Merchant not found',
    });
  });

  it('reads gateway errors on b402 paths with the OC rules', () => {
    const body = '{"code":40104,"msg":"Permission denied","data":null,"timestamp":1}';
    expect(parseEnvelope(403, body, 'b402')).toMatchObject({ ok: false, kind: 'api', code: 40104 });
  });
});
