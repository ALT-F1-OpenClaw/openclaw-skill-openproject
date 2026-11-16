import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

const LIST_QUERY = { pageSize: '50', sortBy: '[["updatedAt","desc"]]' };
const EMPTY_LIST = { _embedded: { elements: [] }, total: 0 };

test('work package listing rejects --open combined with --closed before any request', () => {
  const r = runCli(['wp-list', '--open', '--closed'], []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--open and --closed are mutually exclusive/);
});

for (const flag of ['--open', '--closed']) {
  test(`work package listing rejects --status combined with ${flag} before any request`, () => {
    const r = runCli(['wp-list', flag, '--status', 'New'], []);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`--status cannot be combined with \\${flag}`));
  });
}

test('work package listing keeps --open on the native meta-filter', () => {
  const r = runCli(['wp-list', '--open'], [
    { path: '/work_packages', query: { ...LIST_QUERY, filters: [{ status: { operator: 'o', values: [] } }] }, response: EMPTY_LIST },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('work package listing accepts --status open as an alias when no status carries that name', () => {
  const r = runCli(['wp-list', '--status', 'open'], [
    { path: '/statuses', response: { _embedded: { elements: [{ id: 1, name: 'New' }, { id: 12, name: 'Closed' }] } } },
    { path: '/work_packages', query: { ...LIST_QUERY, filters: [{ status: { operator: 'o', values: [] } }] }, response: EMPTY_LIST },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('work package listing prefers a real status over the open/closed alias', () => {
  const r = runCli(['wp-list', '--status', 'closed'], [
    { path: '/statuses', response: { _embedded: { elements: [{ id: 1, name: 'New' }, { id: 12, name: 'Closed' }] } } },
    { path: '/work_packages', query: { ...LIST_QUERY, filters: [{ status: { operator: '=', values: ['12'] } }] }, response: EMPTY_LIST },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('work package listing still resolves an exact status name', () => {
  const r = runCli(['wp-list', '--status', 'In progress'], [
    { path: '/statuses', response: { _embedded: { elements: [{ id: 7, name: 'In progress' }] } } },
    { path: '/work_packages', query: { ...LIST_QUERY, filters: [{ status: { operator: '=', values: ['7'] } }] }, response: EMPTY_LIST },
  ]);
  assert.equal(r.status, 0, r.stderr);
});

test('work package listing rejects an unknown status without listing anything', () => {
  const r = runCli(['wp-list', '--status', 'Bogus'], [
    { path: '/statuses', response: { _embedded: { elements: [{ id: 1, name: 'New' }] } } },
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No status named "Bogus"/);
});
