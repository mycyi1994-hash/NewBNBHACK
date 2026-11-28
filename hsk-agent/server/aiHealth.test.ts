import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAIL_KEEP_MS, failureKind, openAiHealth } from './aiHealth.ts';

const NOW = 1_800_000_000_000;
/** An error shaped like the model API's: an HTTP status and the API's own error type. */
const apiError = (status: number, type: string) => Object.assign(new Error(`${status} {"type":"error","error":{"type":"${type}","message":"sk-ant-secret must not leak"}}`), { status, error: { error: { type } } });

test('the kind of a failed call: status and the API error type, never the message', () => {
  assert.equal(failureKind(apiError(400, 'invalid_request_error')), '400 invalid_request_error');
  assert.equal(failureKind(apiError(529, 'overloaded_error')), '529 overloaded_error');
  assert.equal(failureKind(Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })), 'no-status APIConnectionError');
  assert.equal(failureKind(new Error('Request was aborted.')), 'timeout');
  assert.equal(failureKind(Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' })), 'timeout');
  assert.equal(failureKind('boom'), 'no-status error');
  assert.doesNotMatch(failureKind(apiError(401, 'authentication_error')), /sk-ant|secret/);
});

test('health: not failing until a call fails; an answer of the same kind clears it; each kind is kept apart', () => {
  const h = openAiHealth();
  assert.equal(h.failing(NOW), false, 'nothing known yet');
  assert.equal(h.fail('chat', apiError(400, 'invalid_request_error'), NOW), '400 invalid_request_error');
  assert.deepEqual(h.last('chat'), { ok: false, kind: '400 invalid_request_error', at: NOW });
  assert.equal(h.failing(NOW + 1), true);
  h.ok('pilot', NOW + 2);
  assert.equal(h.failing(NOW + 3), true, 'Moa AI answering does not make the chat healthy');
  h.ok('chat', NOW + 4);
  assert.equal(h.failing(NOW + 5), false);
  h.fail('pilot', new Error('timed out'), NOW + 6);
  assert.equal(h.last('pilot')?.kind, 'timeout');
  assert.equal(h.failing(NOW + 7), true);
  assert.equal(h.failing(NOW + 6 + FAIL_KEEP_MS.pilot), false, 'an old failure nobody has retried is no longer news');
  const c = openAiHealth();
  c.fail('chat', new Error('busy'), NOW);
  assert.equal(c.failing(NOW + FAIL_KEEP_MS.chat - 1), true);
  assert.equal(c.failing(NOW + FAIL_KEEP_MS.chat), false, 'one failed chat answer is forgotten sooner than a failed decision');
  assert.ok(FAIL_KEEP_MS.chat < FAIL_KEEP_MS.pilot);
});
