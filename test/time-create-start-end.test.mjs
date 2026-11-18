import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

// --start/--end are parsed in the local zone, so the suite pins TZ to keep the
// derived startTime and spentOn deterministic on any runner.
const UTC = { TZ: 'UTC' };
const WP_LINK = { workPackage: { href: '/api/v3/work_packages/1' } };

test('time entry creation derives hours from the --start..--end span', () => {
  const r = runCli(['time-create', '--wp-id', '1', '--start', '2026-09-08T13:00', '--end', '2026-09-08T14:30'], [{
    path: '/time_entries', method: 'POST',
    json: { hours: 'PT1H30M', spentOn: '2026-09-08', startTime: '2026-09-08T13:00:00.000Z', _links: WP_LINK },
    response: { id: 7 },
  }], UTC);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\.5h on WP#1/);
  assert.match(r.stdout, /Start: 2026-09-08T13:00:00\.000Z/);
});

test('time entry creation keeps explicit --hours alongside --start', () => {
  const r = runCli(['time-create', '--wp-id', '1', '--start', '2026-09-08T13:00', '--hours', '2'], [{
    path: '/time_entries', method: 'POST',
    json: { hours: 'PT2H0M', spentOn: '2026-09-08', startTime: '2026-09-08T13:00:00.000Z', _links: WP_LINK },
    response: { id: 8 },
  }], UTC);
  assert.equal(r.status, 0, r.stderr);
});

test('an explicit --date overrides the date derived from --start', () => {
  const r = runCli(['time-create', '--wp-id', '1', '--start', '2026-09-08T23:30', '--hours', '1', '--date', '2026-09-09'], [{
    path: '/time_entries', method: 'POST',
    json: { hours: 'PT1H0M', spentOn: '2026-09-09', startTime: '2026-09-08T23:30:00.000Z', _links: WP_LINK },
    response: { id: 9 },
  }], UTC);
  assert.equal(r.status, 0, r.stderr);
});

test('time entry creation without --start sends no startTime', () => {
  const r = runCli(['time-create', '--wp-id', '1', '--hours', '2.5', '--date', '2026-09-08', '--comment', 'Review'], [{
    path: '/time_entries', method: 'POST',
    json: { hours: 'PT2H30M', comment: { format: 'plain', raw: 'Review' }, spentOn: '2026-09-08', _links: WP_LINK },
    response: { id: 10 },
  }], UTC);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Start:/);
});

for (const [name, args, expected] of [
  ['--end without --start', ['--end', '2026-09-08T14:30'], /--end requires --start/],
  ['--end together with --hours', ['--start', '2026-09-08T13:00', '--end', '2026-09-08T14:30', '--hours', '2'], /either --end or --hours, not both/],
  ['--start without a duration', ['--start', '2026-09-08T13:00'], /with --start, also pass --end or --hours/],
  ['no duration at all', [], /--hours is required/],
  ['an --end at or before --start', ['--start', '2026-09-08T14:30', '--end', '2026-09-08T13:00'], /--end must be after --start/],
  ['an unparseable --start', ['--start', 'not-a-date', '--hours', '1'], /invalid --start/],
]) {
  test(`time entry creation rejects ${name} before any request`, () => {
    const r = runCli(['time-create', '--wp-id', '1', ...args], [], UTC);
    assert.equal(r.status, 1);
    assert.match(r.stderr, expected);
  });
}
