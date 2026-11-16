import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

test('comment read fetches an activity by its own ID', () => {
  const response = { id: 21, comment: { raw: 'Old text' } };
  const r = runCli(['comment-read', '--id', '21'], [{ path: '/activities/21', response }]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), response);
});

test('comment editing uses PATCH with the documented raw comment shape', () => {
  const r = runCli(['comment-update', '--id', '21', '--body', 'New **text**'], [{
    path: '/activities/21', method: 'PATCH', json: { comment: { raw: 'New **text**' } }, response: { id: 21 },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('comment editing preserves explicit internal false', () => {
  const r = runCli(['comment-update', '--id', '21', '--body', 'Public text', '--internal', 'false'], [{
    path: '/activities/21', method: 'PATCH', json: { comment: { raw: 'Public text' }, internal: false }, response: { id: 21 },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('comment editing reports permission errors', () => {
  const r = runCli(['comment-update', '--id', '21', '--body', 'New text'], [{
    path: '/activities/21', method: 'PATCH', status: 403, response: { message: 'Comment editing is not permitted' },
  }]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ERROR \(403\): Comment editing is not permitted/);
});

test('comment editing rejects missing text, invalid booleans and unsafe IDs', () => {
  for (const args of [['--id', '21'], ['--id', '../21', '--body', 'Text'], ['--id', '21', '--body', 'Text', '--internal', 'yes']]) {
    const r = runCli(['comment-update', ...args]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /Unexpected request/);
  }
});
