import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mock = fileURLToPath(new URL('../fixtures/mock-fetch.cjs', import.meta.url));
const cli = fileURLToPath(new URL('../../scripts/openproject.mjs', import.meta.url));

export function runCli(args, requests = [], env = {}) {
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
