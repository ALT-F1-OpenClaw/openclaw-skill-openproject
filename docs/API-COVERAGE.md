# OpenProject API v3 — Coverage & Limitations

Updated 2026-11-16 after implementing CI, project/work package enhancements, membership and version management, meeting content, user administration, and comment editing. The CLI has **147 commands**. This is partial API coverage.

## Scope and counts

| Specification | All paths / operations | Audited paths / operations | Called paths | Called operations |
|---|---:|---:|---:|---:|
| [Released 17.9.7](https://github.com/opf/openproject/tree/v17.9.7/docs/api/apiv3) | 234 / 320 | 229 / 315 | 99 | 148 |
| [Development snapshot `a6da65c1`](https://github.com/opf/openproject/tree/a6da65c1fecf085cb1ee48d36e7052d1879e6f72/docs/api/apiv3) | 263 / 350 | 258 / 345 | 97 | 146 |

An operation is one HTTP method on one path. Counts measure matching calls, not complete workflows or authenticated integration success. They include direct upload calls, variable URLs, conditional create/update paths, and shared resource handlers. Project-scoped calls are counted under `projects`; for example, `version-list` uses a project-scoped version collection rather than `GET /versions`.

The audited scope excludes five framework/documentation paths in each snapshot: root, specification-serving endpoints, value schemas, and documentation examples where present. The development snapshot has 63 resource groups. Stable and development figures differ because their specifications contain different operations; the development branch is not the compatibility baseline for every deployment.

## Implemented management workflows

| Area | Available behavior |
|---|---|
| Work packages | Existing CRUD and filters; create/update assignee, date ranges, milestone `date`, and ISO 8601 estimates. |
| Projects | List, read, create, update, delete, and assign/remove parents. Visibility/archive changes and deletion require `--confirm`. |
| Memberships | Project-scoped listing, read, create, update and delete; user/group/placeholder principals and complete role replacement. |
| Versions | Project-scoped listing, read, create, update and delete; status, sharing, descriptions and nullable dates. |
| Meetings | List, read, create, update and delete; attachment listing/upload. Updates use optimistic locking. |
| Agenda items | List, read, create, update and delete; notes, duration, presenters, sections and linked work packages. Updates use optimistic locking. |
| Outcomes and sections | List, read, create, update and delete; informational/work package outcomes and section titles. |
| Users | Existing list/read/me; invite/create, update, delete, lock/unlock and self password changes using environment variables. |
| Comments | Existing list/add; direct activity read and comment editing, including explicit internal/public flags. |
| Other established areas | Groups, news, watchers, relations, time entries, documents, reminders, portfolios/programs, placeholder users, calendars, preferences, rendering, configuration and reference data retain their existing support. See the table below for method coverage. |

Create/update commands expose selected documented fields. Custom-field writes, form/schema discovery, and every optional mutation field are not implied by CRUD support. Global membership creation is not exposed by the project membership commands.

## Development specification: per-resource coverage

A called path has at least one implemented method. Partial method counts identify remaining operations on otherwise supported resources. URI links in request bodies are not counted as HTTP calls.

| Resource | Called paths / spec paths | Called operations / spec operations |
|---|---:|---:|
| `actions` | 2 / 2 | 2 / 2 |
| `activities` | 1 / 4 | 2 / 7 |
| `ai_text_actions` | 0 / 1 | 0 / 1 |
| `ai_text_transform_runs` | 0 / 3 | 0 / 3 |
| `attachments` | 1 / 4 | 1 / 5 |
| `budgets` | 1 / 1 | 1 / 1 |
| `capabilities` | 1 / 3 | 1 / 3 |
| `categories` | 0 / 1 | 0 / 1 |
| `configuration` | 1 / 1 | 1 / 1 |
| `custom_actions` | 2 / 2 | 2 / 2 |
| `custom_field_items` | 2 / 2 | 2 / 2 |
| `custom_fields` | 1 / 2 | 1 / 2 |
| `custom_options` | 1 / 1 | 1 / 1 |
| `days` | 6 / 6 | 6 / 6 |
| `documents` | 2 / 3 | 3 / 4 |
| `file_links` | 0 / 3 | 0 / 4 |
| `grids` | 0 / 4 | 0 / 6 |
| `groups` | 2 / 2 | 5 / 5 |
| `help_texts` | 2 / 2 | 2 / 2 |
| `labels` | 0 / 2 | 0 / 3 |
| `meeting_agenda_items` | 2 / 5 | 4 / 7 |
| `meeting_outcomes` | 2 / 2 | 4 / 4 |
| `meeting_sections` | 2 / 2 | 4 / 4 |
| `meetings` | 6 / 15 | 10 / 19 |
| `memberships` | 2 / 6 | 5 / 9 |
| `my_preferences` | 1 / 1 | 2 / 2 |
| `news` | 2 / 2 | 5 / 5 |
| `notifications` | 6 / 8 | 6 / 8 |
| `oauth_applications` | 1 / 1 | 1 / 1 |
| `oauth_client_credentials` | 1 / 1 | 1 / 1 |
| `placeholder_users` | 2 / 2 | 5 / 5 |
| `portfolios` | 2 / 3 | 4 / 5 |
| `posts` | 2 / 3 | 2 / 4 |
| `principals` | 0 / 3 | 0 / 6 |
| `priorities` | 1 / 2 | 1 / 2 |
| `programs` | 2 / 3 | 4 / 5 |
| `project_phase_definitions` | 2 / 2 | 2 / 2 |
| `project_phases` | 1 / 1 | 1 / 1 |
| `project_statuses` | 1 / 1 | 1 / 1 |
| `project_storages` | 0 / 3 | 0 / 3 |
| `projects` | 8 / 22 | 11 / 27 |
| `queries` | 0 / 15 | 0 / 18 |
| `recurring_meetings` | 0 / 10 | 0 / 13 |
| `relations` | 2 / 2 | 4 / 4 |
| `reminders` | 2 / 2 | 3 / 3 |
| `repository_branches` | 0 / 1 | 0 / 1 |
| `repository_commits` | 0 / 1 | 0 / 1 |
| `repository_issues` | 0 / 1 | 0 / 1 |
| `repository_merge_requests` | 0 / 2 | 0 / 2 |
| `repository_pipelines` | 0 / 1 | 0 / 1 |
| `revisions` | 1 / 1 | 1 / 1 |
| `roles` | 0 / 2 | 0 / 2 |
| `sprints` | 0 / 2 | 0 / 2 |
| `statuses` | 1 / 2 | 1 / 2 |
| `storages` | 0 / 8 | 0 / 11 |
| `time_entries` | 2 / 7 | 4 / 10 |
| `types` | 1 / 2 | 1 / 2 |
| `users` | 3 / 9 | 7 / 19 |
| `versions` | 2 / 8 | 4 / 11 |
| `views` | 0 / 2 | 0 / 3 |
| `wiki_pages` | 2 / 3 | 3 / 4 |
| `work_packages` | 10 / 26 | 15 / 34 |
| `workspaces` | 0 / 14 | 0 / 18 |

Render endpoints are absent from this development specification but remain mounted in upstream server source and are implemented by the CLI. The released capability-context spelling is stale; global capability listing now uses the documented capability collection with context filter `g`.

## Remaining gaps and exclusions

- **Projects and workspaces:** project copy/favorites/available parents/assignees, direct workspace commands, and migration from deprecated project-scoped routes.
- **Meetings:** recurring meetings and occurrences; additional nested read alternatives, forms/schemas, and development-only agenda voting/move operations.
- **Users:** working hours, non-working times, and user forms/schemas.
- **Memberships and versions:** forms/schemas, available-project discovery, global memberships, global version listings and version workspace/project listings.
- **Activities and attachments:** emoji reactions, activity attachments, direct attachment reads, containerless uploads, and the optional direct-to-storage upload flow.
- **Reference data and helpers:** several individual-resource reads, principal/role listing, and work package form/schema/discovery operations.
- **Development-only additions:** AI actions/runs, labels, repository resources, principal hourly rates, notification summary, work package PDF export and document collaboration tokens. Verify availability on the target version.
- **Deliberate exclusions:** saved queries, grids, views, storages/project storages and external file links. These remain unimplemented and are included in the coverage denominators.
- **Framework/documentation paths:** omitted from the audited denominators as described above.

Feature availability and permissions depend on the deployed version and instance configuration. Resource presence does not establish that every feature is available under every license.

## Verification

`npm test` runs **74 mocked CLI regression checks**. CI runs syntax checks and the test suite on Node 18, 20, 22 and 24 for pushes and pull requests. The workflow has been validated locally; hosted jobs will run when the commits reach GitHub.

Authenticated live-instance checks have not been performed. The original audit and subsequent fix/feature commits are recorded in [Development Status & API Drift](./DEVELOPMENT-STATUS-2026-11-16.md).
