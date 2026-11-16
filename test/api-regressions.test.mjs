import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const mock = fileURLToPath(new URL('./fixtures/mock-fetch.cjs', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/openproject.mjs', import.meta.url));

function runCli(args, requests, env = {}) {
  const result = spawnSync(process.execPath, ['--require', mock, cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      OP_HOST: 'https://openproject.example.invalid',
      OP_API_TOKEN: 'test-token',
      OP_DEFAULT_PROJECT: '',
      OP_MAX_RESULTS: '50',
      OP_TEST_REQUESTS: JSON.stringify(requests),
      ...env,
    },
  });
  assert.ifError(result.error);
  return result;
}

const globalCapabilities = {
  path: '/capabilities',
  query: { pageSize: '50', filters: [{ context: { operator: '=', values: ['g'] } }] },
  response: { _embedded: { elements: [{ id: 'users/create/g-1', _links: { action: { title: 'Create users' } } }] }, total: 1 },
};

test('capability-global lists capabilities from the filtered collection', () => {
  const result = runCli(['capability-global'], [globalCapabilities]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Create users/);
  assert.match(result.stdout, /1 global capability/);
});

test('capability-global handles an empty collection', () => {
  const result = runCli(['capability-global'], [{
    ...globalCapabilities, response: { _embedded: { elements: [] }, total: 0 },
  }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No global capabilities/);
});

test('capability-list accepts the documented global alias', () => {
  const result = runCli(['capability-list', '--context', 'global'], [globalCapabilities]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Create users/);
});

test('capability-list maps a numeric workspace ID to its API context', () => {
  const result = runCli(['capability-list', '--context', '9'], [{
    ...globalCapabilities,
    query: { pageSize: '50', filters: [{ context: { operator: '=', values: ['w9'] } }] },
  }]);
  assert.equal(result.status, 0, result.stderr);
});

test('capability-list preserves a legacy project API context', () => {
  const result = runCli(['capability-list', '--context', 'p9'], [{
    ...globalCapabilities,
    query: { pageSize: '50', filters: [{ context: { operator: '=', values: ['p9'] } }] },
  }]);
  assert.equal(result.status, 0, result.stderr);
});

const projectMemberships = {
  path: '/memberships',
  query: { pageSize: '50', filters: [{ project: { operator: '=', values: ['9'] } }] },
  response: {
    _embedded: { elements: [{
      _links: { principal: { title: 'Ada Lovelace' } },
      _embedded: { roles: [{ name: 'Member' }] },
    }] },
    total: 1,
  },
};

test('member-list resolves a project slug and filters memberships by numeric ID', () => {
  const result = runCli(['member-list', '--project', 'my-project'], [
    { path: '/projects/my-project', response: { id: 9 } }, projectMemberships,
  ], { OP_DEFAULT_PROJECT: 'another-project' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Ada Lovelace/);
  assert.match(result.stdout, /Member/);
});

test('member-list accepts a numeric project ID and an empty result', () => {
  const result = runCli(['member-list', '--project', '9'], [
    { path: '/projects/9', response: { id: 9 } },
    { ...projectMemberships, response: { _embedded: { elements: [] }, total: 0 } },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No members found/);
});

test('member-list uses the configured default project', () => {
  const result = runCli(['member-list'], [
    { path: '/projects/default-project', response: { id: 9 } }, projectMemberships,
  ], { OP_DEFAULT_PROJECT: 'default-project' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Ada Lovelace/);
});

test('member-list reports project lookup failures', () => {
  const result = runCli(['member-list', '--project', 'missing'], [{
    path: '/projects/missing', status: 404, response: { message: 'Project not found' },
  }]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR \(404\): Project not found/);
});

for (const [command, path, input, html] of [
  ['render-markdown', '/render/markdown', '**Hello**', '<p><strong>Hello</strong></p>'],
  ['render-plain', '/render/plain', '**Hello**', '<p>**Hello**</p>'],
]) {
  test(`${command} requests and prints HTML with a plain text request body`, () => {
    const result = runCli([command, '--text', input], [{
      path, method: 'POST', body: input,
      headers: { 'Content-Type': 'text/plain', Accept: 'text/html' },
      contentType: 'text/html; charset=utf-8', text: html,
    }]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), html);
  });
}

test('render commands still surface plain text HTTP errors', () => {
  const result = runCli(['render-markdown', '--text', 'Hello'], [{
    path: '/render/markdown', method: 'POST', status: 403,
    contentType: 'text/plain', text: 'Rendering denied',
  }]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /ERROR \(403\): Rendering denied/);
});
