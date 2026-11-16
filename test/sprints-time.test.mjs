import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

test('global sprint listing uses the requested page and retains total', () => {
  const response = { total: 51, _embedded: { elements: [{ id: 3, name: 'Sprint 3' }] } };
  const r = runCli(['sprint-list', '--page', '2'], [{ path: '/sprints', query: { pageSize: '50', offset: '2' }, response }], { OP_DEFAULT_PROJECT: 'does-not-limit-global-sprints' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), response);
});

test('project sprint listing uses the scoped endpoint including shared sprints', () => {
  const response = { _embedded: { elements: [{ id: 3, _links: { definingWorkspace: { href: '/api/v3/projects/10' } } }] } };
  const r = runCli(['sprint-list', '--project', 'demo'], [
    { path: '/projects/demo', response: { id: 9 } },
    { path: '/projects/9/sprints', query: { pageSize: '50', offset: '1' }, response },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), response);
});

test('sprints can be filtered by their defining project', () => {
  const r = runCli(['sprint-list', '--defined-in', 'demo'], [
    { path: '/projects/demo', response: { id: 9 } },
    { path: '/sprints', query: { pageSize: '50', offset: '1', filters: [{ definingWorkspace: { operator: '=', values: ['9'] } }] }, response: { _embedded: { elements: [] } } },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('sprint and time-entry readers return complete API records', () => {
  for (const [command, path, response] of [
    ['sprint-read', '/sprints/3', { id: 3, name: 'Sprint 3' }],
    ['time-read', '/time_entries/3', { id: 3, hours: 'PT2H', comment: { raw: 'Review' } }],
    ['time-activity-read', '/time_entries/activities/3', { id: 3, name: 'Development' }],
  ]) {
    const r = runCli([command, '--id', '3'], [{ path, response }]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), response);
  }
});

test('time tracking discovery returns the projects the caller can use', () => {
  const response = { _embedded: { elements: [{ id: 9, name: 'Project' }] } };
  const r = runCli(['time-projects'], [{ path: '/time_entries/available_projects', response }]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), response);
});

test('sprint and time lookup inputs reject unsafe IDs and invalid pages', () => {
  for (const args of [['sprint-list', '--page', '0'], ['sprint-list', '--project', '../demo'], ['time-read', '--id', '../3']]) {
    const r = runCli(args);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /Unexpected request/);
  }
});
