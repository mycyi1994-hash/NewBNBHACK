import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameCheck, frameVerdict } from './nanoFrame.ts';

const MOA = 'https://grabitmoa.onrender.com';

test('the headers nanotradingclub sends today refuse every other site', () => {
  // read from https://nanotradingclub.xyz/fire on 27 Nov 2026
  assert.equal(frameVerdict('SAMEORIGIN', null, MOA), false);
  assert.equal(frameVerdict('DENY', null, MOA), false);
});

test('after the /fire rule: Moa is allowed, other sites and a local copy are not', () => {
  const csp = "frame-ancestors 'self' https://grabitmoa.onrender.com";
  assert.equal(frameVerdict(null, csp, MOA), true);
  assert.equal(frameVerdict(null, csp, MOA + '/'), true);
  assert.equal(frameVerdict(null, csp, 'https://evil.example'), false);
  assert.equal(frameVerdict(null, csp, 'http://localhost:4199'), false);
  // frame-ancestors decides even if an X-Frame-Options is still sent, as browsers do
  assert.equal(frameVerdict('SAMEORIGIN', csp, MOA), true);
  // among other directives, in any case
  assert.equal(frameVerdict(null, "default-src 'self'; Frame-Ancestors https://GrabitMoa.onrender.com", MOA), true);
  assert.equal(frameVerdict(null, "default-src 'self'", MOA), true, 'no frame rule at all allows it');
  assert.equal(frameVerdict(null, 'frame-ancestors *', MOA), true);
});

test('the check is kept ten minutes per address, and a site that does not answer is a no', async () => {
  let calls = 0;
  const ok = (async () => { calls++; return new Response('x', { headers: { 'content-security-policy': "frame-ancestors 'self' https://a.example" } }); }) as typeof fetch;
  assert.deepEqual((await frameCheck('https://a.example', ok)).allowed, true);
  await frameCheck('https://a.example', ok);
  assert.equal(calls, 1);
  const down = (async () => { throw new Error('offline'); }) as typeof fetch;
  const v = await frameCheck('https://b.example', down);
  assert.equal(v.allowed, false);
  assert.equal(v.why, 'unreachable');
  const refused = (async () => new Response('x', { headers: { 'x-frame-options': 'SAMEORIGIN' } })) as typeof fetch;
  assert.equal((await frameCheck('https://c.example', refused)).why, 'refused');
});
