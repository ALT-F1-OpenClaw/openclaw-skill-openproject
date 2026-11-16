import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

test('work package assignment and move discovery return full collections', () => {
  for (const [command, path] of [['wp-assignees', '/work_packages/1/available_assignees'], ['wp-projects', '/work_packages/1/available_projects']]) {
    const response = { total: 1, _embedded: { elements: [{ id: 9, name: 'Candidate' }] } };
    const r = runCli([command, '--id', '1'], [{ path, response }]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), response);
  }
});

test('relation candidate search encodes query text and forwards relation type', () => {
  const r = runCli(['wp-relation-candidates', '--id', '1', '--query', 'auth & review?', '--type', 'blocks'], [{
    path: '/work_packages/1/available_relation_candidates', query: { pageSize: '50', query: 'auth & review?', type: 'blocks' }, response: { _embedded: { elements: [] } },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('project assignee discovery resolves slugs and uses the workspace replacement', () => {
  const r = runCli(['project-assignees'], [
    { path: '/projects/demo', response: { id: 9 } },
    { path: '/workspaces/9/available_assignees', response: { _embedded: { elements: [{ id: 5 }] } } },
  ], { OP_DEFAULT_PROJECT: 'demo' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)._embedded.elements[0].id, 5);
});

test('parent candidates distinguish an existing project from a new one', () => {
  const existing = runCli(['project-parent-candidates', '--project', 'demo', '--query', 'Planning'], [{
    path: '/projects/available_parent_projects', query: { of: 'demo', filters: [{ name_and_identifier: { operator: '~', values: ['Planning'] } }] }, response: { _embedded: { elements: [] } },
  }]);
  assert.equal(existing.status, 0, existing.stderr);
  const create = runCli(['project-parent-candidates'], [{ path: '/projects/available_parent_projects', response: { _embedded: { elements: [] } } }], { OP_DEFAULT_PROJECT: 'ignored-for-new-projects' });
  assert.equal(create.status, 0, create.stderr);
});

test('reference and attachment readers use their documented individual-resource routes', () => {
  for (const [command, path] of [
    ['status-read', '/statuses/3'], ['type-read', '/types/3'], ['priority-read', '/priorities/3'], ['category-read', '/categories/3'],
    ['role-read', '/roles/3'], ['custom-field-read', '/custom_fields/3'], ['attachment-read', '/attachments/3'],
  ]) {
    const response = { id: 3, name: 'Reference', _links: { self: { href: `/api/v3${path}` } } };
    const r = runCli([command, '--id', '3'], [{ path, response }]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), response);
  }
});

test('role discovery preserves an explicit grantable false filter', () => {
  const r = runCli(['role-list', '--unit', 'project', '--grantable', 'false'], [{
    path: '/roles', query: { filters: [{ unit: { operator: '=', values: ['project'] } }, { grantable: { operator: '=', values: ['f'] } }] }, response: { _embedded: { elements: [{ id: 3, name: 'Member' }] } },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('principal search combines names, type, project membership and pagination', () => {
  const r = runCli(['principal-list', '--type', 'Group', '--name', 'Engineering', '--project', 'demo', '--page', '2'], [
    { path: '/projects/demo', response: { id: 9 } },
    { path: '/principals', query: { pageSize: '50', offset: '2', filters: [{ type: { operator: '=', values: ['Group'] } }, { any_name_attribute: { operator: '~', values: ['Engineering'] } }, { member: { operator: '=', values: ['9'] } }] }, response: { total: 51, _embedded: { elements: [{ id: 5, _type: 'Group' }] } } },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).total, 51);
});

test('type listing supports project-enabled types and still supports a global list', () => {
  const response = { _embedded: { elements: [{ id: 3, name: 'Task' }] } };
  const scoped = runCli(['type-list', '--project', 'demo', '--json'], [
    { path: '/projects/demo', response: { id: 9 } }, { path: '/workspaces/9/types', response },
  ]);
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.deepEqual(JSON.parse(scoped.stdout), response);
  const global = runCli(['type-list', '--json'], [{ path: '/types', response }], { OP_DEFAULT_PROJECT: 'should-not-limit-global-list' });
  assert.equal(global.status, 0, global.stderr);
});

test('discovery input validation prevents unsafe paths and malformed filters', () => {
  for (const args of [
    ['wp-assignees', '--id', '../1'], ['project-assignees', '--project', '../demo'],
    ['role-list', '--grantable', 'yes'], ['principal-list', '--page', '0'], ['status-read', '--id', '0'],
  ]) {
    const r = runCli(args);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /Unexpected request/);
  }
});
