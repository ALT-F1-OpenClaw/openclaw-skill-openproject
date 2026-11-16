# Changelog

## Unreleased

- Add CI for syntax checks and mocked CLI regressions on Node 18, 20, 22 and 24.
- Add project updates/deletion and parent assignment/removal, with strict booleans and confirmation for visibility/archive changes.
- Add work package assignee, date range, milestone date and ISO estimate options on create/update; retain milestone dates in JSON output.
- Add membership and version read/create/update/delete commands, role replacement, and nullable version dates.
- Add meeting CRUD and agenda item, outcome and section management, including optimistic locking for meeting/agenda updates.
- Add user invitations, active creation, updates, deletion, lock/unlock and self password changes via environment variables.
- Add direct activity reads and comment editing.
- Fix global capability listing, membership listing routes and HTML rendering responses.
- Add 74 mocked regression checks and refresh the API coverage/status documentation.
- Align package lockfile metadata and README counts; replace former example host references with ALT-F1 examples.

The package and CLI remain at version 2.0.0 until a release is prepared. The API remains partially implemented; see [API coverage](docs/API-COVERAGE.md).
