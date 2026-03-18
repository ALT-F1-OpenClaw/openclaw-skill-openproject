# OpenProject API v3 — Coverage & Limitations

This document lists all 55 API v3 resources, what this skill covers, and what's excluded with reasons.

## ✅ Covered (30 resources)

| Resource | Commands | Notes |
|----------|----------|-------|
| `work_packages` | wp-list, wp-create, wp-read, wp-update, wp-delete | Full CRUD with filters |
| `projects` | project-list, project-read, project-create | List, read, create |
| `activities` | comment-list, comment-add | Comments on work packages |
| `attachments` | attachment-list, attachment-add, attachment-delete | Upload/delete on work packages |
| `time_entries` | time-list, time-create, time-update, time-delete | Full CRUD |
| `users` | user-list, user-read, user-me | List/search users, view details, current user |
| `notifications` | notification-list, notification-read, notification-mark-read, notification-mark-unread | List/read/mark with reason/project/WP filters |
| `meetings` | meeting-read, meeting-attachment-list, meeting-attachment-add | Read meetings, attachments (Enterprise) |
| `days` | day-read, days-list, non-working-days-list, non-working-day-read, week-days-list, week-day-read | Working/non-working days and week schedule |
| `configuration` | config-read, project-config-read | Instance and project configuration |
| `oauth_applications` | oauth-app-read | Read OAuth application details |
| `oauth_client_credentials` | oauth-credentials-read | Read OAuth client credentials |
| `help_texts` | help-text-list, help-text-read | List and read attribute help texts |
| `custom_fields` | custom-field-items | List hierarchical custom field items |
| `custom_field_items` | custom-field-item-read, custom-field-item-branch | Read items and browse branches |
| `custom_options` | custom-option-read | Read custom option values |
| `custom_actions` | custom-action-read, custom-action-execute | Read and execute workflow actions on WPs |
| `groups` | group-list, group-read, group-create, group-update, group-delete | Full CRUD with member management |
| `news` | news-list, news-read, news-create, news-update, news-delete | Full CRUD for project announcements |
| `watchers` | watcher-list, watcher-add, watcher-remove, watcher-available | List, add, remove watchers on WPs |
| `relations` | relation-list, relation-read, relation-create, relation-update, relation-delete | Full CRUD with type/WP filters |
| `wiki_pages` | wiki-read, wiki-attachment-list, wiki-attachment-add | Read page, list & upload attachments |
| `statuses` | status-list | List all statuses; transitions via wp-update --status |
| `types` | type-list | List work package types |
| `priorities` | priority-list | List priorities |
| `memberships` | member-list | List project members |
| `versions` | version-list | List versions/milestones |
| `categories` | category-list | List work package categories |
| `principals` | (used internally) | User/group resolution |
| `roles` | (used internally) | Role resolution in member-list |

## ❌ Not Covered — With Reasons

### Queries (`/api/v3/queries`)
- **Reason:** Saved work package filters/views. Internal to OpenProject UI. CLI users can use `wp-list` filters directly instead.

### Budgets (`/api/v3/budgets`)
- **Reason:** Enterprise-only feature. Financial/cost tracking tied to Enterprise edition.

### Documents (`/api/v3/documents`)
- **Reason:** Minimal API exposure. Document management is better handled via OpenProject UI or Nextcloud/SharePoint integrations.

### Revisions (`/api/v3/revisions`)
- **Reason:** Read-only. SCM/repository changesets linked to work packages. Requires server-side SCM integration (Git/SVN).

### File Links (`/api/v3/file_links`)
- **Reason:** External storage integration (Nextcloud, OneDrive, SharePoint). Requires storage integration to be configured server-side.

### Storages & Project Storages (`/api/v3/storages`, `/api/v3/project_storages`)
- **Reason:** External file storage configuration. Admin-level setup. Not a day-to-day project management action.

### Grids (`/api/v3/grids`)
- **Reason:** Dashboard/widget layout configuration. Internal to OpenProject UI rendering. No CLI use case.

### Views (`/api/v3/views`)
- **Reason:** Saved work package views (Gantt, board, etc.). Internal to OpenProject UI. No CLI equivalent.

### Placeholder Users (`/api/v3/placeholder_users`)
- **Reason:** Enterprise-only. Virtual users for resource planning before real users are assigned.

### Capabilities & Actions (`/api/v3/capabilities`, `/api/v3/actions`)
- **Reason:** Permission introspection. Internal framework resource. Used by OpenProject UI for dynamic permission checks.

### My Preferences (`/api/v3/my_preferences`)
- **Reason:** Personal UI preferences. Not relevant for project management automation.

### Render (`/api/v3/render`)
- **Reason:** Textile/Markdown rendering utility endpoint. Used internally by OpenProject editor.

### Posts (`/api/v3/posts`)
- **Reason:** Forum posts. Limited API, legacy feature in OpenProject.

### Reminders (`/api/v3/reminders`)
- **Reason:** User-specific notification reminders. Personal notification settings.

### Portfolios & Programs (`/api/v3/portfolios`, `/api/v3/programs`)
- **Reason:** Enterprise-only. Portfolio/program management for multi-project oversight.

### Project Phases & Definitions (`/api/v3/project_phases`, `/api/v3/project_phase_definitions`)
- **Reason:** Enterprise-only. Project lifecycle phase tracking.

### Project Statuses (`/api/v3/project_statuses`)
- **Reason:** Project-level health statuses (on track, at risk, off track). Read-only reference data, low CLI value.

### Workspace & Workspaces (`/api/v3/workspace`, `/api/v3/workspaces`)
- **Reason:** Instance/workspace info. Read-only metadata.

### Values (`/api/v3/values`)
- **Reason:** Internal value resolution endpoint. Framework utility, not a user-facing resource.

### Example & Examples (`/api/v3/example`, `/api/v3/examples`)
- **Reason:** API documentation examples. Not real resources.

## 🔮 Candidates for Future Versions

| Resource | Priority | Why |
|----------|----------|-----|
| Documents | Low | List and read documents (no create via API) |

## Enterprise-Only Features (Not Available on Community Edition)

These require an OpenProject Enterprise license:
- Meetings
- Budgets
- Placeholder Users
- Portfolios & Programs
- Project Phases

---

*Based on OpenProject API v3 specification (55 resources, 193 endpoints)*
*Last updated: 2026-03-18 (v1.5.0)*
