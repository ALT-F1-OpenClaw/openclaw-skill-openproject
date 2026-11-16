import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

test('version creation sends the documented definingProject link and dates', () => {
  const r = runCli(['version-create', '--project', 'demo', '--name', 'v1', '--start-date', '2026-11-16', '--end-date', '2026-11-20', '--status', 'open', '--sharing', 'descendants'], [
    { path: '/projects/demo', response: { id: 9 } },
    { path: '/versions', method: 'POST', json: { name: 'v1', startDate: '2026-11-16', endDate: '2026-11-20', status: 'open', sharing: 'descendants', _links: { definingProject: { href: '/api/v3/projects/9' } } }, response: { id: 4 } },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('version update clears nullable dates without changing the defining project', () => {
  const r = runCli(['version-update', '--id', '4', '--start-date', 'none', '--end-date', 'none', '--description', '', '--status', 'closed'], [{
    path: '/versions/4', method: 'PATCH', json: { status: 'closed', startDate: null, endDate: null, description: { format: 'markdown', raw: '' } }, response: { id: 4 },
  }], { OP_DEFAULT_PROJECT: 'should-not-be-used' });
  assert.equal(r.status, 0, r.stderr);
});

test('version read returns the API record', () => {
  const response = { id: 4, name: 'v1', sharing: 'none' };
  const r = runCli(['version-read', '--id', '4'], [{ path: '/versions/4', response }]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), response);
});

test('version deletion requires confirmation and handles no-content responses', () => {
  assert.match(runCli(['version-delete', '--id', '4']).stderr, /requires --confirm/);
  const r = runCli(['version-delete', '--id', '4', '--confirm'], [{ path: '/versions/4', method: 'DELETE', status: 204 }]);
  assert.equal(r.status, 0, r.stderr);
});

test('versions reject invalid states, ranges, IDs and empty updates', () => {
  for (const args of [
    ['--id', '4', '--status', 'finished'], ['--id', '4', '--sharing', 'everyone'], ['--id', '../bad', '--name', 'v1'],
    ['--id', '4', '--start-date', '2026-11-20', '--end-date', '2026-11-16'], ['--id', '4'],
  ]) {
    const r = runCli(['version-update', ...args]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /Unexpected request/);
  }
});
