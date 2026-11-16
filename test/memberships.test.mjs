import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

test('membership creation resolves a project and sends principal and role links', () => {
  const r = runCli(['member-create', '--principal', '5', '--roles', '2, 3'], [
    { path: '/projects/demo', response: { id: 9 } },
    { path: '/memberships', method: 'POST', json: { _links: { project: { href: '/api/v3/projects/9' }, principal: { href: '/api/v3/users/5' }, roles: [{ href: '/api/v3/roles/2' }, { href: '/api/v3/roles/3' }] } }, response: { id: 7 } },
  ], { OP_DEFAULT_PROJECT: 'demo' });
  assert.equal(r.status, 0, r.stderr);
});

test('membership updates can target groups and replace the complete role set', () => {
  const r = runCli(['member-update', '--id', '7', '--principal', '5', '--principal-type', 'group', '--roles', '3'], [{
    path: '/memberships/7', method: 'PATCH', json: { _links: { principal: { href: '/api/v3/groups/5' }, roles: [{ href: '/api/v3/roles/3' }] } }, response: { id: 7 },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('membership read returns the complete API record', () => {
  const response = { id: 7, _type: 'Membership', _links: { roles: [{ title: 'Member' }] } };
  const r = runCli(['member-read', '--id', '7'], [{ path: '/memberships/7', response }]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), response);
});

test('membership deletion requires confirmation', () => {
  assert.match(runCli(['member-delete', '--id', '7']).stderr, /requires --confirm/);
  const r = runCli(['member-delete', '--id', '7', '--confirm'], [{ path: '/memberships/7', method: 'DELETE', status: 204 }]);
  assert.equal(r.status, 0, r.stderr);
});

test('membership update rejects empty updates and malformed roles', () => {
  for (const args of [['--id', '7'], ['--id', '7', '--roles', '2,'], ['--id', '7', '--principal-type', 'group']]) {
    const r = runCli(['member-update', ...args]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /Unexpected request/);
  }
});

test('membership listing displays titles from role links without embedded records', () => {
  const r = runCli(['member-list', '--project', 'demo'], [
    { path: '/projects/demo', response: { id: 9 } },
    { path: '/memberships', query: { pageSize: '50', filters: [{ project: { operator: '=', values: ['9'] } }] }, response: { _embedded: { elements: [{ _links: { principal: { title: 'Ada' }, roles: [{ title: 'Manager' }, { title: 'Member' }] } }] } } },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Manager, Member/);
});
