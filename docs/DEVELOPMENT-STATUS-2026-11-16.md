# Development Status & API Drift — 2026-11-16

Verified review of the skill against both released and development OpenProject API v3 specifications. The CLI covers common workflows, but has integration bugs and substantial feature gaps. Differences below include existing implementation defects and unimplemented features; they should not all be interpreted as recent upstream changes.

- **Skill version:** 2.0.0 (`package.json`, CLI `--version`)
- **Project revision reviewed:** [`c4bea8550667f66778d1805e7156d03c9116b8e9`](https://github.com/ALT-F1-OpenClaw/openclaw-skill-openproject/commit/c4bea8550667f66778d1805e7156d03c9116b8e9)
- **Released specification:** [`opf/openproject` v17.9.7](https://github.com/opf/openproject/tree/v17.9.7/docs/api/apiv3), the latest release at the time of review, published 2026-11-09
- **Development specification:** [`opf/openproject` at `a6da65c1fecf085cb1ee48d36e7052d1879e6f72`](https://github.com/opf/openproject/tree/a6da65c1fecf085cb1ee48d36e7052d1879e6f72/docs/api/apiv3), `dev` snapshot; `openapi-spec.yml` last changed 2026-11-13

| Specification | All paths | All HTTP operations | Paths included in resource table scope | Operations in that scope |
|---|---:|---:|---:|---:|
| Released 17.9.7 | 234 | 320 | 229 | 315 |
| Development snapshot | 263 | 350 | 258 | 345 |

An operation is one HTTP method on one path. The previous development count of 348 missed the GET operations on `/queries/filter_instance_schemas/{id}` and `/work_packages/schemas/{identifier}`. The five excluded paths in each snapshot are described in section 6.

> The `dev` spec is ahead of released versions. Confirm endpoint availability on the version users actually run. Specifications can also lag server routing: the released global capability-context path is one confirmed example, described below.

## 1. Project status

| Item | State |
|---|---|
| Last maintainer code change | 2026-03-18 (v2.0.0, PR #19). The maintainer reviewed PR #20 on 2026-11-16. |
| Last merged changes | **2026-11-16**: [PR #22](https://github.com/ALT-F1-OpenClaw/openclaw-skill-openproject/pull/22) by Weiming-Hu adds `--json` on `wp-list`/`wp-read`; [PR #21](https://github.com/ALT-F1-OpenClaw/openclaw-skill-openproject/pull/21) adds open/closed filters and rejects unknown status names. August 1 was PR #22's opening date, not its merge date. |
| Open PRs | [#20 "Add User Management Features"](https://github.com/ALT-F1-OpenClaw/openclaw-skill-openproject/pull/20) by Nolaan, opened 2026-04-08; **changes requested on 2026-11-16**, still mergeable at review time. Adds `--assignee`, `--start-date`, `--due-date`, `--estimate` to `wp-create`, `--parent` to `project-create`, and a new `project-update`; it does not add user management. |
| Tests / CI / changelog | None committed. Single 2,904-line script `scripts/openproject.mjs`. This audit ran 14 temporary mocked checks, described in section 6; they are not a repository test suite. |
| Commands registered in code | 111 |
| Commands claimed in README | 120 — **stale** |
| Package metadata | `package.json` and CLI report 2.0.0; `package-lock.json` still declares **1.1.0** at the top level and for the root package. |
| `docs/API-COVERAGE.md` | Says 55 resources / 193 endpoints, last updated 2026-03-18 — **stale**. It also incorrectly describes workspaces as read-only metadata and claims internal principal/role resolution that the script does not perform. |

## 2. Confirmed integration bugs

### `capability-global`: wrong route and response shape

The command calls `/capabilities/context/global` (`scripts/openproject.mjs:854`). The server route is `/capabilities/contexts/global` (plural). Anonymous GET checks on the public community instance returned 404 for the singular route and 200 for the plural route. The [17.9.7 server source](https://github.com/opf/openproject/blob/v17.9.7/lib/api/v3/capabilities/capabilities_api.rb) mounts the plural route, although the [released specification](https://github.com/opf/openproject/blob/v17.9.7/docs/api/apiv3/paths/capabilities_context_global.yml) still lists the singular spelling.

Changing the URL alone is insufficient: the endpoint returns one context object, not a collection. The command reads `resp._embedded.elements` at line 855 and crashes when given the documented response. If the command is intended to list global capabilities, it should query `/capabilities` with its context filter instead of iterating context metadata.

### `member-list`: unsupported project-scoped route

The command calls `/projects/{project}/memberships` (`scripts/openproject.mjs:722`). This route is absent from both specifications and the released project's nested routes. On the public instance, a request for an existing public project's memberships returned 404, while `/memberships` with a project filter returned a collection.

Use the documented [`GET /memberships` project filter](https://github.com/opf/openproject/blob/v17.9.7/docs/api/apiv3/paths/memberships.yml), resolving a project identifier to its numeric ID first. The command's existence does not establish working membership coverage.

### `render-markdown` / `render-plain`: HTML response discarded

The [render API returns `text/html`](https://github.com/opf/openproject/blob/v17.9.7/docs/api/apiv3/paths/render_markdown.yml). The shared HTTP client attempts JSON parsing and returns `null` when parsing fails (`scripts/openproject.mjs:119–121,134`). Both render commands therefore print `null` for a successful HTML response. This was reproduced with mocked responses. Preserve text responses in the HTTP client and request a suitable response media type.

## 3. Headline gaps by upstream version

### Present in the released 17.9.7 specification

- **Meetings:** list/create/update/delete, agenda items, outcomes, sections, recurring meetings and occurrences. The skill only reads meetings and lists/uploads attachments.
- **Users:** create, update, delete, lock/unlock, working hours and non-working times.
- **Projects:** update, delete, copy, favorite, available parents/assignees and project sprints. PR #20 adds project update, but is not merged.
- **Memberships and versions:** CRUD, forms and schemas. The skill attempts membership listing through the broken route above and lists versions through a project-scoped endpoint.
- **Sprints and workspaces:** sprint listings/read; workspace listings, favorites, work package list/create, categories, types and versions. Workspaces already provide useful operations in the released API; excluding them as read-only metadata is inaccurate.
- **Activities:** direct activity read/comment editing (`PATCH /activities/{id}`), emoji reactions and activity attachments. Work package comment list/add is already implemented through `/work_packages/{id}/activities`.
- **Notification details:** `/notifications/{notification_id}/details/{id}`. Bulk read/unread is already implemented.
- **Direct attachment upload:** prepare, transfer to storage, then complete. This is an optional alternative to the skill's existing regular uploads, not the only upload path for external storage. The [released upload documentation](https://github.com/opf/openproject/blob/v17.9.7/docs/api/apiv3/paths/attachments_prepare.yml) explicitly supports regular uploads and describes the three-step direct-upload flow.

### Present in the development snapshot but absent from the released specification

- **AI text actions and transform runs**, including project/work package action listings.
- **Labels**, including workspace labels.
- **Repository resources:** branches, commits, issues, merge requests, pipelines and work package integration listings.
- **Principal hourly rates.**
- **Workspace instance read/update/delete** and additional query schemas.
- **Notification summary, work package PDF export and document collaboration token.**
- Additional meeting agenda-item operations, including voting and moving an item to the next meeting.

These are specification differences, not proof that every deployment lacks the feature. Verify availability on the target version before implementing them. Some project-scoped operations used by the skill, including type/category/version listings and work package creation, are marked deprecated in the development spec in favor of workspace routes.

Deliberate exclusions that still hold: queries, grids, views, storages, project storages, file links.

## 4. Per-resource table (spec vs. CLI calls)

This table uses the **pinned development snapshot**, not the released specification. It includes 63 resource groups, 258 paths and 345 operations after the exclusions in section 6. The CLI has static matches for 81 paths and 109 operations.

"Called by CLI" counts paths for which the script calls at least one documented method, including variable URLs and direct `fetch` uploads. "Not called operations" includes missing methods on partially covered paths. Counts describe call presence, not successful behavior or complete user workflows. For example, global work package creation is uncalled, but project-scoped creation is implemented.

The corrected days count is **6/6**, and notifications **6/8**. The earlier extraction missed the variable days URL and the bulk notification URLs with an appended filter parameter. Render routes are absent from this development spec but remain mounted in upstream server source; specification absence alone does not establish endpoint removal.

| Resource | Spec paths | Called by CLI | Not called operations |
|---|---|---|---|
| `actions` | 2 | 2 | — |
| `activities` | 4 | 0 | /activities/{id} (GET,PATCH)<br>/activities/{id}/attachments (GET,POST)<br>/activities/{id}/attachments/prepare (POST)<br>/activities/{id}/emoji_reactions (GET,PATCH) |
| `ai_text_actions` | 1 | 0 | /ai_text_actions (GET) |
| `ai_text_transform_runs` | 3 | 0 | /ai_text_transform_runs (POST)<br>/ai_text_transform_runs/{id} (GET)<br>/ai_text_transform_runs/{id}/cancel (POST) |
| `attachments` | 4 | 1 | /attachments (POST)<br>/attachments/prepare (POST)<br>/attachments/{id} (GET)<br>/attachments/{id}/uploaded (GET) |
| `budgets` | 1 | 1 | — |
| `capabilities` | 3 | 1 | /capabilities/contexts/global (GET)<br>/capabilities/{id} (GET) |
| `categories` | 1 | 0 | /categories/{id} (GET) |
| `configuration` | 1 | 1 | — |
| `custom_actions` | 2 | 2 | — |
| `custom_field_items` | 2 | 2 | — |
| `custom_fields` | 2 | 1 | /custom_fields/{id} (GET) |
| `custom_options` | 1 | 1 | — |
| `days` | 6 | 6 | — |
| `documents` | 3 | 2 | /documents/{id}/collaboration_token (POST) |
| `file_links` | 3 | 0 | /file_links/{id} (GET,DELETE)<br>/file_links/{id}/open (GET)<br>/file_links/{id}/download (GET) |
| `grids` | 4 | 0 | /grids (GET,POST)<br>/grids/form (POST)<br>/grids/{id} (GET,PATCH)<br>/grids/{id}/form (POST) |
| `groups` | 2 | 2 | — |
| `help_texts` | 2 | 2 | — |
| `labels` | 2 | 0 | /labels (GET,POST)<br>/labels/{id} (GET) |
| `meeting_agenda_items` | 5 | 0 | /meeting_agenda_items (POST)<br>/meeting_agenda_items/{id} (GET,PATCH,DELETE)<br>/meeting_agenda_items/{id}/move_to_next_meeting (POST)<br>/meeting_agenda_items/{id}/upvote (POST)<br>/meeting_agenda_items/{id}/downvote (POST) |
| `meeting_outcomes` | 2 | 0 | /meeting_outcomes (POST)<br>/meeting_outcomes/{id} (GET,PATCH,DELETE) |
| `meeting_sections` | 2 | 0 | /meeting_sections (POST)<br>/meeting_sections/{id} (GET,PATCH,DELETE) |
| `meetings` | 15 | 2 | /meetings (GET,POST)<br>/meetings/{id} (PATCH,DELETE)<br>/meetings/{id}/agenda_items (GET)<br>/meetings/{meeting_id}/agenda_items/{id} (GET)<br>/meetings/{meeting_id}/agenda_items/{id}/upvote (POST)<br>/meetings/{meeting_id}/agenda_items/{id}/downvote (POST)<br>/meetings/{meeting_id}/agenda_items/{agenda_item_id}/outcomes (GET)<br>/meetings/{meeting_id}/agenda_items/{agenda_item_id}/outcomes/{id} (GET)<br>/meetings/{id}/attachments/prepare (POST)<br>/meetings/{id}/form (POST)<br>/meetings/{id}/sections (GET)<br>/meetings/{meeting_id}/sections/{id} (GET)<br>/meetings/form (POST)<br>/meetings/schema (GET) |
| `memberships` | 6 | 0 | /memberships (GET,POST)<br>/memberships/available_projects (GET)<br>/memberships/form (POST)<br>/memberships/schema (GET)<br>/memberships/{id} (DELETE,GET,PATCH)<br>/memberships/{id}/form (POST) |
| `my_preferences` | 1 | 1 | — |
| `news` | 2 | 2 | — |
| `notifications` | 8 | 6 | /notifications/summary (GET)<br>/notifications/{notification_id}/details/{id} (GET) |
| `oauth_applications` | 1 | 1 | — |
| `oauth_client_credentials` | 1 | 1 | — |
| `placeholder_users` | 2 | 2 | — |
| `portfolios` | 3 | 2 | /portfolios/{id}/form (POST) |
| `posts` | 3 | 2 | /posts/{id}/attachments (POST)<br>/posts/{id}/attachments/prepare (POST) |
| `principals` | 3 | 0 | /principals (GET)<br>/principals/{id}/hourly_rates (GET,POST)<br>/principals/{id}/hourly_rates/{rate_id} (GET,PATCH,DELETE) |
| `priorities` | 2 | 1 | /priorities/{id} (GET) |
| `programs` | 3 | 2 | /programs/{id}/form (POST) |
| `project_phase_definitions` | 2 | 2 | — |
| `project_phases` | 1 | 1 | — |
| `project_statuses` | 1 | 1 | — |
| `project_storages` | 3 | 0 | /project_storages (GET)<br>/project_storages/{id} (GET)<br>/project_storages/{id}/open (GET) |
| `projects` | 22 | 8 | /projects/form (POST)<br>/projects/schema (GET)<br>/projects/{id} (PATCH,DELETE)<br>/projects/{id}/form (POST)<br>/projects/{id}/copy (POST)<br>/projects/{id}/copy/form (POST)<br>/projects/available_parent_projects (GET)<br>/projects/{id}/queries/default (GET)<br>/projects/{id}/queries/filter_instance_schemas (GET)<br>/projects/{id}/queries/schema (GET)<br>/projects/{id}/work_packages (GET)<br>/projects/{id}/work_packages/form (POST)<br>/projects/{id}/available_assignees (GET)<br>/projects/{id}/sprints (GET)<br>/projects/{id}/favorite (DELETE,POST)<br>/projects/{id}/ai_text_actions (GET) |
| `queries` | 15 | 0 | /queries (GET,POST)<br>/queries/available_projects (GET)<br>/queries/columns/{id} (GET)<br>/queries/default (GET)<br>/queries/filter_instance_schemas (GET)<br>/queries/filter_instance_schemas/{id} (GET)<br>/queries/filters/{id} (GET)<br>/queries/form (POST)<br>/queries/operators/{id} (GET)<br>/queries/schema (GET)<br>/queries/sort_bys/{id} (GET)<br>/queries/{id} (DELETE,GET,PATCH)<br>/queries/{id}/form (POST)<br>/queries/{id}/star (PATCH)<br>/queries/{id}/unstar (PATCH) |
| `recurring_meetings` | 10 | 0 | /recurring_meetings (GET,POST)<br>/recurring_meetings/{id} (GET,PATCH,DELETE)<br>/recurring_meetings/{id}/end (POST)<br>/recurring_meetings/{id}/template_completed (POST)<br>/recurring_meetings/{id}/occurrences/upcoming (GET)<br>/recurring_meetings/{id}/occurrences/past (GET)<br>/recurring_meetings/{id}/occurrences/cancelled (GET)<br>/recurring_meetings/{id}/occurrences/open (GET)<br>/recurring_meetings/{id}/occurrences/{start_time} (DELETE)<br>/recurring_meetings/{id}/occurrences/{start_time}/init (POST) |
| `relations` | 2 | 2 | — |
| `reminders` | 2 | 2 | — |
| `repository_branches` | 1 | 0 | /repository_branches/{id} (GET) |
| `repository_commits` | 1 | 0 | /repository_commits/{id} (GET) |
| `repository_issues` | 1 | 0 | /repository_issues/{id} (GET) |
| `repository_merge_requests` | 2 | 0 | /repository_merge_requests/{id} (GET)<br>/repository_merge_requests/{id}/repository_pipelines (GET) |
| `repository_pipelines` | 1 | 0 | /repository_pipelines/{id} (GET) |
| `revisions` | 1 | 1 | — |
| `roles` | 2 | 0 | /roles (GET)<br>/roles/{id} (GET) |
| `sprints` | 2 | 0 | /sprints (GET)<br>/sprints/{id} (GET) |
| `statuses` | 2 | 1 | /statuses/{id} (GET) |
| `storages` | 8 | 0 | /storages (GET,POST)<br>/storages/{id} (GET,PATCH,DELETE)<br>/storages/{id}/files (GET)<br>/storages/{storage_id}/files/{file_id} (GET)<br>/storages/{id}/files/prepare_upload (POST)<br>/storages/{id}/folders (POST)<br>/storages/{id}/oauth_client_credentials (POST)<br>/storages/{id}/open (GET) |
| `time_entries` | 7 | 2 | /time_entries/{id} (GET)<br>/time_entries/{id}/form (POST)<br>/time_entries/activities/{id} (GET)<br>/time_entries/available_projects (GET)<br>/time_entries/form (POST)<br>/time_entries/schema (GET) |
| `types` | 2 | 1 | /types/{id} (GET) |
| `users` | 9 | 2 | /users (POST)<br>/users/schema (GET)<br>/users/{id} (PATCH,DELETE)<br>/users/{id}/form (POST)<br>/users/{id}/lock (DELETE,POST)<br>/users/{id}/non_working_times (GET,POST)<br>/users/{id}/non_working_times/{non_working_time_id} (GET,PATCH,DELETE)<br>/users/{id}/working_hours (GET,POST)<br>/users/{id}/working_hours/{working_hours_id} (GET,PATCH,DELETE) |
| `versions` | 8 | 0 | /versions (GET,POST)<br>/versions/available_projects (GET)<br>/versions/form (POST)<br>/versions/schema (GET)<br>/versions/{id} (GET,DELETE,PATCH)<br>/versions/{id}/form (POST)<br>/versions/{id}/projects (GET)<br>/versions/{id}/workspaces (GET) |
| `views` | 2 | 0 | /views (GET)<br>/views/{id} (GET,POST) |
| `wiki_pages` | 3 | 2 | /wiki_pages/{id}/attachments/prepare (POST) |
| `work_packages` | 26 | 10 | /work_packages (POST)<br>/work_packages/{id}/activities_emoji_reactions (GET)<br>/work_packages/{id}/ai_text_actions (GET)<br>/work_packages/{id}/attachments/prepare (POST)<br>/work_packages/{id}/available_assignees (GET)<br>/work_packages/{id}/available_projects (GET)<br>/work_packages/{id}/available_relation_candidates (GET)<br>/work_packages/{id}/file_links (POST,GET)<br>/work_packages/{id}/form (POST)<br>/work_packages/{id}/pdf (GET)<br>/work_packages/{id}/reminders (GET)<br>/work_packages/{id}/repository_branches (GET)<br>/work_packages/{id}/repository_commits (GET)<br>/work_packages/{id}/repository_issues (GET)<br>/work_packages/{id}/repository_merge_requests (GET)<br>/work_packages/form (POST)<br>/work_packages/schemas (GET)<br>/work_packages/schemas/{identifier} (GET) |
| `workspaces` | 14 | 0 | /workspaces (GET)<br>/workspaces/{id} (GET,PATCH,DELETE)<br>/workspaces/{id}/available_assignees (GET)<br>/workspaces/{id}/categories (GET)<br>/workspaces/{id}/favorite (DELETE,POST)<br>/workspaces/{id}/queries/default (GET)<br>/workspaces/{id}/queries/filter_instance_schemas (GET)<br>/workspaces/{id}/queries/schema (GET)<br>/workspaces/{id}/types (GET)<br>/workspaces/{id}/work_packages (GET,POST)<br>/workspaces/{id}/work_packages/form (POST)<br>/workspaces/{id}/versions (GET)<br>/workspaces/{id}/labels (GET)<br>/workspaces/schema (GET) |

## 5. Suggested next steps

1. Fix the three integration problems: global capability lookup/listing (route and response shape), membership listing through `/memberships`, and HTML response handling for rendering.
2. Add focused regression checks for those defects and retain checks for JSON pagination and open/closed filters. Establish CI and a CHANGELOG before the next release.
3. Reconcile README's command count (111), the 1.1.0 lockfile metadata, and `API-COVERAGE.md`. Distinguish resource presence, method coverage and verified behavior; document workspace replacements for deprecated project routes.
4. Resolve PR #20: address its review, validate flags/booleans/IDs, handle or document milestone dates and parent removal, restore the executable bit, update SKILL.md, retitle the PR, and rebase on main.
5. Prioritize gaps already documented in released 17.9.7: project update/delete, membership and version CRUD, meeting CRUD/agenda items, user create/update/lock, and comment editing. Keep development-spec additions in a separate backlog until target-version availability is confirmed.

## 6. Method, validation and limits

- Reviewed project revision `c4bea8550667f66778d1805e7156d03c9116b8e9`; checked Git history and public GitHub pull request/review metadata for development status.
- Compared the released tag and pinned development commit linked above. Resolved every path item's referenced YAML file and counted HTTP methods, including the schema GET operations previously omitted. Both raw path totals and totals after exclusions are reported; a path may have several operations.
- Extracted CLI paths and methods from `opFetch(...)`, followed the variable URL in `days-list`, handled the appended notification filter parameter, and included all three upload commands that call `fetch(...)` directly. Removed query strings and normalized path parameters for matching. `/users/me` is matched to the documented `/users/{id}` route.
- Excluded from the resource table: API root, `openapi.json`, `spec.json`, `spec.yml`, `values`, and documentation `example`/`examples` paths. These account for five paths and five operations in each snapshot. In the development snapshot, 81 of the remaining 258 paths and 109 of 345 operations match CLI calls. These figures measure static call presence, not correct payloads, response handling or runtime success.
- Inspected upstream server routing where specifications and implementation disagreed. In particular, the released global capability-context spelling is stale, and render routes remain mounted despite their absence from the development specification.
- `node --check`, CLI `--version` and help checks passed. Installed the two locked dependencies in a temporary copy outside the repository. Ran **14 mocked checks**: normal work package JSON dates; open/closed operators; unknown-status rejection; multi-page JSON aggregation; reproduction of the capability response-shape crash; reproduction of both render commands printing `null`; days listing; both bulk notification operations; and all three upload POSTs. Assertions of reproduced defects passed; this does not mean those commands are fixed.
- Made anonymous, read-only GET requests to the public community instance: singular capability-context route 404, plural route 200; project-scoped memberships 404 for an existing public project, filtered `/memberships` 200. The empty membership collection reflects anonymous access and does not validate authenticated member visibility.
- No authenticated integration checks were performed against the user's deployed instance, and no application code was changed. The temporary audit harness is not committed; automated tests, CI and the implementation fixes remain outstanding.
