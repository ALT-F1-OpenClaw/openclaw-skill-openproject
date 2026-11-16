import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

test('work package creation sends assignee, dates and ISO estimate', () => {
  const r = runCli(['wp-create', '--project', 'demo', '--subject', 'Task', '--assignee', '3', '--start-date', '2026-11-16', '--due-date', '2026-11-20', '--estimate', 'PT2H30M'], [{
    path: '/projects/demo/work_packages', method: 'POST',
    json: { subject: 'Task', startDate: '2026-11-16', dueDate: '2026-11-20', estimatedTime: 'PT2H30M', _links: { assignee: { href: '/api/v3/users/3' } } },
    response: { id: 1, subject: 'Task' },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('milestone creation sends date instead of a date range', () => {
  const r = runCli(['wp-create', '--project', 'demo', '--subject', 'Release', '--date', '2026-11-20'], [{
    path: '/projects/demo/work_packages', method: 'POST',
    json: { subject: 'Release', date: '2026-11-20' }, response: { id: 1, subject: 'Release' },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('work package updates preserve locking and can clear the assignee', () => {
  const r = runCli(['wp-update', '--id', '1', '--assignee', 'none', '--date', '2026-11-20', '--estimate', 'PT1H'], [
    { path: '/work_packages/1', response: { id: 1, lockVersion: 7 } },
    { path: '/work_packages/1', method: 'PATCH', json: { lockVersion: 7, date: '2026-11-20', estimatedTime: 'PT1H', _links: { assignee: { href: null } } }, response: {} },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

for (const [flags, message] of [
  [['--start-date', '2026-02-30'], /valid date/],
  [['--assignee', '../users'], /numeric ID/],
  [['--estimate', 'two hours'], /ISO 8601 duration/],
  [['--date', '2026-11-20', '--due-date', '2026-11-20'], /Use --date for milestones/],
  [['--start-date', '2026-11-20', '--due-date', '2026-11-16'], /on or after/],
]) {
  test(`work package rejects invalid scheduling input: ${flags.join(' ')}`, () => {
    const r = runCli(['wp-create', '--project', 'demo', '--subject', 'Task', ...flags]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, message);
  });
}

test('project updates send only requested fields without a lockVersion lookup', () => {
  const r = runCli(['project-update', '--id', 'demo', '--name', 'Renamed', '--description', ''], [{
    path: '/projects/demo', method: 'PATCH', json: { name: 'Renamed', description: { format: 'markdown', raw: '' } }, response: {},
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('project creation resolves a parent slug and preserves false', () => {
  const r = runCli(['project-create', '--name', 'Child', '--parent', 'parent', '--public', 'false'], [
    { path: '/projects/parent', response: { id: 9 } },
    { path: '/projects', method: 'POST', json: { name: 'Child', public: false, _links: { parent: { href: '/api/v3/projects/9' } } }, response: { id: 10, name: 'Child', identifier: 'child' } },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('project parent removal uses an explicit null href', () => {
  const r = runCli(['project-update', '--id', 'demo', '--parent', 'none'], [{
    path: '/projects/demo', method: 'PATCH', json: { _links: { parent: { href: null } } }, response: {},
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('project identifiers may start with digits without becoming numeric IDs', () => {
  const r = runCli(['project-update', '--id', '2026-roadmap', '--name', 'Roadmap'], [{
    path: '/projects/2026-roadmap', method: 'PATCH', json: { name: 'Roadmap' }, response: {},
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('project visibility and archive updates require confirmation', () => {
  for (const field of ['--public', '--active']) {
    const r = runCli(['project-update', '--id', 'demo', field, 'false']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires --confirm/);
  }
});

test('confirmed project updates preserve boolean false', () => {
  const r = runCli(['project-update', '--id', 'demo', '--active', 'false', '--public', 'false', '--confirm'], [{
    path: '/projects/demo', method: 'PATCH', json: { active: false, public: false }, response: {},
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('project updates reject malformed booleans, unsafe IDs and empty updates', () => {
  for (const [args, message] of [
    [['--id', 'demo', '--active', 'True'], /Expected true or false/],
    [['--id', '../other', '--name', 'Bad'], /identifier slug/],
    [['--id', 'demo'], /at least one field/],
  ]) {
    const r = runCli(['project-update', ...args]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, message);
  }
});

test('project deletion is guarded and uses DELETE', () => {
  const denied = runCli(['project-delete', '--id', '9']);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /requires --confirm/);
  const r = runCli(['project-delete', '--id', '9', '--confirm'], [{ path: '/projects/9', method: 'DELETE', status: 204 }]);
  assert.equal(r.status, 0, r.stderr);
});
