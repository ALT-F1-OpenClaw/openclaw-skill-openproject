import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

test('user creation defaults to an email invitation', () => {
  const r = runCli(['user-create', '--email', 'ada@alt-f1.be'], [{
    path: '/users', method: 'POST', json: { email: 'ada@alt-f1.be', status: 'invited', admin: false, language: 'en' }, response: { id: 5 },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('active user creation reads a password from the selected variable without printing it', () => {
  const r = runCli(['user-create', '--email', 'ada@alt-f1.be', '--status', 'active', '--login', 'ada', '--first-name', 'Ada', '--last-name', 'Lovelace', '--password-env', 'OP_TEST_PASSWORD'], [{
    path: '/users', method: 'POST', json: { email: 'ada@alt-f1.be', status: 'active', admin: false, language: 'en', login: 'ada', firstName: 'Ada', lastName: 'Lovelace', password: 'dummy-test-password' }, response: { id: 5 },
  }], { OP_TEST_PASSWORD: 'dummy-test-password' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /dummy-test-password/);
});

test('user update preserves admin false without applying creation defaults', () => {
  const r = runCli(['user-update', '--id', '5', '--admin', 'false', '--first-name', 'Ada'], [{
    path: '/users/5', method: 'PATCH', json: { admin: false, firstName: 'Ada' }, response: { id: 5 },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('self password update sends currentPassword and never prints either secret', () => {
  const r = runCli(['user-update', '--id', 'me', '--password-env', 'OP_TEST_NEW', '--current-password-env', 'OP_TEST_OLD'], [{
    path: '/users/me', method: 'PATCH', json: { password: 'dummy-new-secret', currentPassword: 'dummy-old-secret' }, response: { id: 5 },
  }], { OP_TEST_NEW: 'dummy-new-secret', OP_TEST_OLD: 'dummy-old-secret' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /dummy-(new|old)-secret/);
});

test('user lock and unlock use their documented HTTP methods', () => {
  for (const [command, method] of [['user-lock', 'POST'], ['user-unlock', 'DELETE']]) {
    const r = runCli([command, '--id', '5'], [{ path: '/users/5/lock', method, status: 204 }]);
    assert.equal(r.status, 0, r.stderr);
  }
});

test('user delete requires confirmation', () => {
  assert.match(runCli(['user-delete', '--id', '5']).stderr, /requires --confirm/);
  const r = runCli(['user-delete', '--id', '5', '--confirm'], [{ path: '/users/5', method: 'DELETE', status: 204 }]);
  assert.equal(r.status, 0, r.stderr);
});

test('user validation rejects unsafe input, missing passwords and creation-only update status', () => {
  for (const args of [
    ['user-create', '--email', 'ada@alt-f1.be', '--status', 'active'],
    ['user-create', '--email', 'ada@alt-f1.be', '--status', 'active', '--login', 'ada', '--first-name', 'Ada', '--last-name', 'Lovelace', '--password-env', 'OP_MISSING_TEST_PASSWORD'],
    ['user-update', '--id', '5', '--admin', 'True'],
    ['user-update', '--id', '../5', '--login', 'ada'],
    ['user-update', '--id', '5', '--status', 'active'],
    ['user-update', '--id', '5'],
    ['user-update', '--id', '5', '--password-env', 'OP_TEST_PASSWORD'],
  ]) {
    const r = runCli(args, [], { OP_MISSING_TEST_PASSWORD: '' });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /Unexpected request/);
  }
});
