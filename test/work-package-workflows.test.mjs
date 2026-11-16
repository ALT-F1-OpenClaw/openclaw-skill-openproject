import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

test('work package creation links parent, responsible, category and target version', () => {
  const r = runCli(['wp-create', '--project', 'demo', '--subject', 'Task', '--parent', '10', '--responsible', '3', '--category', '4', '--target-version', '5', '--status', '2', '--remaining', 'PT1H'], [{
    path: '/projects/demo/work_packages', method: 'POST', json: {
      subject: 'Task', remainingTime: 'PT1H', _links: {
        parent: { href: '/api/v3/work_packages/10' }, responsible: { href: '/api/v3/users/3' }, category: { href: '/api/v3/categories/4' },
        targetVersions: [{ href: '/api/v3/versions/5' }], status: { href: '/api/v3/statuses/2' },
      },
    }, response: { id: 1, subject: 'Task' },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('work package updates clear relationships, scheduling and descriptions explicitly', () => {
  const r = runCli(['wp-update', '--id', '1', '--parent', 'none', '--responsible', 'none', '--category', 'none', '--target-version', 'none', '--start-date', 'none', '--due-date', 'none', '--estimate', 'none', '--remaining', 'none', '--description', '', '--percent-done', '0', '--schedule-manually', 'false'], [
    { path: '/work_packages/1', response: { lockVersion: 3 } },
    { path: '/work_packages/1', method: 'PATCH', json: {
      lockVersion: 3, startDate: null, dueDate: null, estimatedTime: null, remainingTime: null, percentageDone: 0, scheduleManually: false,
      description: { format: 'markdown', raw: '' }, _links: { parent: { href: null }, responsible: { href: null }, category: { href: null }, targetVersions: [] },
    }, response: {} },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('moving a work package resolves its destination before resolving the destination type', () => {
  const r = runCli(['wp-update', '--id', '1', '--project', 'destination', '--type', 'Task'], [
    { path: '/work_packages/1', response: { lockVersion: 3, _links: { project: { href: '/api/v3/projects/9' } } } },
    { path: '/projects/destination', response: { id: 11 } },
    { path: '/projects/11/types', response: { _embedded: { elements: [{ id: 2, name: 'Task' }] } } },
    { path: '/work_packages/1', method: 'PATCH', json: { lockVersion: 3, _links: { project: { href: '/api/v3/projects/11' }, type: { href: '/api/v3/types/2' } } }, response: {} },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('work package listing resolves a type name and accepts a status ID', () => {
  const r = runCli(['wp-list', '--type', 'Task', '--status', '2'], [
    { path: '/types', response: { _embedded: { elements: [{ id: 3, name: 'Task' }] } } },
    { path: '/work_packages', query: { pageSize: '50', sortBy: '[["updatedAt","desc"]]', filters: [{ status: { operator: '=', values: ['2'] } }, { type: { operator: '=', values: ['3'] } }] }, response: { _embedded: { elements: [] }, total: 0 } },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

for (const [field, path] of [['type', '/projects/demo/types'], ['priority', '/priorities'], ['status', '/statuses']]) {
  test(`work package creation rejects an unknown ${field} without creating anything`, () => {
    const r = runCli(['wp-create', '--project', 'demo', '--subject', 'Task', `--${field}`, 'Unknown'], [{ path, response: { _embedded: { elements: [] } } }]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`No ${field} named`));
  });
}

test('work package rejects empty updates and updates without locking metadata', () => {
  const empty = runCli(['wp-update', '--id', '1'], [{ path: '/work_packages/1', response: { lockVersion: 3 } }]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /at least one field/);
  const missingLock = runCli(['wp-update', '--id', '1', '--subject', 'Changed'], [{ path: '/work_packages/1', response: { id: 1 } }]);
  assert.equal(missingLock.status, 1);
  assert.match(missingLock.stderr, /missing lockVersion/);
});

test('percentage validation rejects fractions and out-of-range values before requests', () => {
  for (const value of ['-1', '101', '2.5', '25percent']) {
    const r = runCli(['wp-update', '--id', '1', '--percent-done', value]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /whole percentage/);
  }
});

test('JSON work package records retain links, milestone dates and work estimates', () => {
  const r = runCli(['wp-read', '--id', '1', '--json'], [{ path: '/work_packages/1', response: {
    id: 1, subject: 'Milestone', date: '2026-11-20', estimatedTime: 'PT2H', remainingTime: 'PT1H',
    _links: { parent: { href: '/api/v3/work_packages/10' }, responsible: { href: '/api/v3/users/3', title: 'Ada' }, targetVersions: [{ href: '/api/v3/versions/5' }] },
  } }]);
  assert.equal(r.status, 0, r.stderr);
  const task = JSON.parse(r.stdout);
  assert.equal(task.parentId, '10');
  assert.equal(task.responsibleId, '3');
  assert.deepEqual(task.versionIds, ['5']);
  assert.equal(task.date, '2026-11-20');
  assert.equal(task.estimatedTime, 'PT2H');
  assert.equal(task.remainingTime, 'PT1H');
});
