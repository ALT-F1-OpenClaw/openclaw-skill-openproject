import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

const resources = [
  ['agenda-item', 'meeting_agenda_items', ['--meeting-id', '6', '--title', 'Planning'], { title: 'Planning', _links: { meeting: { href: '/api/v3/meetings/6' } } }],
  ['section', 'meeting_sections', ['--meeting-id', '6', '--title', 'Planning'], { title: 'Planning', _links: { meeting: { href: '/api/v3/meetings/6' } } }],
  ['outcome', 'meeting_outcomes', ['--agenda-item-id', '8', '--notes', 'Agreed'], { kind: 'information', notes: { format: 'markdown', raw: 'Agreed' }, _links: { agendaItem: { href: '/api/v3/meeting_agenda_items/8' } } }],
];

for (const [kind, resource, args, json] of resources) {
  test(`meeting ${kind} creation links its container`, () => {
    const r = runCli([`meeting-${kind}-create`, ...args], [{ path: `/${resource}`, method: 'POST', json, response: { id: 8 } }]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /: 8/);
  });
  test(`meeting ${kind} read returns the API record`, () => {
    const response = { id: 8, ...json };
    const r = runCli([`meeting-${kind}-read`, '--id', '8'], [{ path: `/${resource}/8`, response }]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), response);
  });
  test(`meeting ${kind} deletion requires confirmation`, () => {
    assert.match(runCli([`meeting-${kind}-delete`, '--id', '8']).stderr, /requires --confirm/);
    const r = runCli([`meeting-${kind}-delete`, '--id', '8', '--confirm'], [{ path: `/${resource}/8`, method: 'DELETE', status: 204 }]);
    assert.equal(r.status, 0, r.stderr);
  });
}

test('agenda work package items send their type, presenter, section and duration', () => {
  const r = runCli(['meeting-agenda-item-create', '--meeting-id', '6', '--wp-id', '2', '--presenter-id', '5', '--section-id', '7', '--duration-minutes', '15'], [{
    path: '/meeting_agenda_items', method: 'POST', json: { durationInMinutes: 15, itemType: 'work_package', _links: { meeting: { href: '/api/v3/meetings/6' }, workPackage: { href: '/api/v3/work_packages/2' }, presenter: { href: '/api/v3/users/5' }, section: { href: '/api/v3/meeting_sections/7' } } }, response: { id: 8 },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('agenda updates include locking metadata and can clear duration/presenter', () => {
  const r = runCli(['meeting-agenda-item-update', '--id', '8', '--duration-minutes', 'none', '--presenter-id', 'none', '--notes', ''], [
    { path: '/meeting_agenda_items/8', response: { id: 8, lockVersion: 4 } },
    { path: '/meeting_agenda_items/8', method: 'PATCH', json: { lockVersion: 4, durationInMinutes: null, notes: { format: 'markdown', raw: '' }, _links: { presenter: { href: null } } }, response: {} },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('outcome work package creation sets the correct kind', () => {
  const r = runCli(['meeting-outcome-create', '--agenda-item-id', '8', '--wp-id', '2'], [{
    path: '/meeting_outcomes', method: 'POST', json: { kind: 'work_package', _links: { agendaItem: { href: '/api/v3/meeting_agenda_items/8' }, workPackage: { href: '/api/v3/work_packages/2' } } }, response: { id: 10 },
  }]);
  assert.equal(r.status, 0, r.stderr);
});

test('outcome and section patches do not invent a lockVersion requirement', () => {
  for (const [command, resource, args, json] of [
    ['meeting-outcome-update', 'meeting_outcomes', ['--notes', 'Changed'], { notes: { format: 'markdown', raw: 'Changed' } }],
    ['meeting-section-update', 'meeting_sections', ['--title', 'Renamed'], { title: 'Renamed' }],
  ]) {
    const r = runCli([command, '--id', '8', ...args], [{ path: `/${resource}/8`, method: 'PATCH', json, response: { id: 8 } }]);
    assert.equal(r.status, 0, r.stderr);
  }
});

test('meeting content lists use the documented nested routes', () => {
  for (const [command, args, path] of [
    ['meeting-agenda-item-list', ['--meeting-id', '6'], '/meetings/6/agenda_items'],
    ['meeting-section-list', ['--meeting-id', '6'], '/meetings/6/sections'],
    ['meeting-outcome-list', ['--meeting-id', '6', '--agenda-item-id', '8'], '/meetings/6/agenda_items/8/outcomes'],
  ]) {
    const response = { _embedded: { elements: [{ id: 8 }] } };
    const r = runCli([command, ...args], [{ path, response }]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), response);
  }
});

test('meeting content rejects missing content, invalid durations and empty patches', () => {
  for (const args of [
    ['meeting-agenda-item-create', '--meeting-id', '6'],
    ['meeting-agenda-item-create', '--meeting-id', '6', '--title', 'Task', '--duration-minutes', '-1'],
    ['meeting-outcome-create', '--agenda-item-id', '8'],
    ['meeting-outcome-create', '--agenda-item-id', '8', '--wp-id', '2', '--kind', 'information'],
    ['meeting-section-update', '--id', '8'],
  ]) {
    const r = runCli(args);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /Unexpected request/);
  }
});
