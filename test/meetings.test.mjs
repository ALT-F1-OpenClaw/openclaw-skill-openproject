import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

test('meeting creation resolves its project and preserves notification false', () => {
  const r = runCli(['meeting-create', '--project', 'demo', '--title', 'Planning', '--start-time', '2026-11-20T10:00:00Z', '--duration', 'PT1H', '--notify', 'false'], [
    { path: '/projects/demo', response: { id: 9 } },
    { path: '/meetings', method: 'POST', json: { title: 'Planning', startTime: '2026-11-20T10:00:00Z', duration: 'PT1H', notify: false, _links: { project: { href: '/api/v3/projects/9' } } }, response: { id: 6 } },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('meeting list preserves collection pagination metadata', () => {
  const response = { total: 51, _embedded: { elements: [{ id: 6, title: 'Planning' }] } };
  const r = runCli(['meeting-list', '--page', '2'], [{ path: '/meetings', query: { pageSize: '50', offset: '2' }, response }]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), response);
});

test('meeting read supports the complete JSON record', () => {
  const response = { id: 6, title: 'Planning', lockVersion: 2 };
  const r = runCli(['meeting-read', '--id', '6', '--json'], [{ path: '/meetings/6', response }]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), response);
});

test('meeting updates include the fetched lockVersion', () => {
  const r = runCli(['meeting-update', '--id', '6', '--state', 'closed', '--location', ''], [
    { path: '/meetings/6', response: { id: 6, lockVersion: 3 } },
    { path: '/meetings/6', method: 'PATCH', json: { state: 'closed', location: '', lockVersion: 3 }, response: {} },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('meeting conflicts are reported without replaying the update', () => {
  const r = runCli(['meeting-update', '--id', '6', '--title', 'Renamed'], [
    { path: '/meetings/6', response: { lockVersion: 3 } },
    { path: '/meetings/6', method: 'PATCH', status: 409, response: { message: 'Stale lock version' } },
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ERROR \(409\): Stale lock version/);
});

test('meeting update cancels if locking metadata is missing', () => {
  const r = runCli(['meeting-update', '--id', '6', '--title', 'Renamed'], [{ path: '/meetings/6', response: { id: 6 } }]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing lockVersion/);
});

test('meeting delete requires confirmation', () => {
  assert.match(runCli(['meeting-delete', '--id', '6']).stderr, /requires --confirm/);
  const r = runCli(['meeting-delete', '--id', '6', '--confirm'], [{ path: '/meetings/6', method: 'DELETE', status: 204 }]);
  assert.equal(r.status, 0, r.stderr);
});

test('meeting validation rejects timezone-free timestamps and invalid states', () => {
  for (const args of [
    ['--id', '6', '--start-time', '2026-11-20T10:00:00'], ['--id', '6', '--state', 'done'], ['--id', '6'],
  ]) {
    const r = runCli(['meeting-update', ...args]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /Unexpected request/);
  }
});
