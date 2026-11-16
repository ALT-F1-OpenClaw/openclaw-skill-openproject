# Plan: MCP server mimicking the OpenProject Enterprise MCP server

Status: proposal, 2026-11-16. Not started.

Reference: [OpenProject MCP Server docs](https://www.openproject.org/docs/system-admin-guide/integrations/mcp-server/) (Enterprise add-on, served by the instance at `/mcp`).

## Goal

Offer the same 24 tools and 10 resources as the official OpenProject MCP server, as a standalone process that talks to OpenProject API v3 with the user's personal API token. Community instances get MCP access; Enterprise users get a local alternative they can run from Claude Code or Claude Desktop.

## Scope

In scope for v1:

- Stdio transport. Covers the official "personal access with API tokens" use case: one user, one local client.
- All 24 official tools, with the same names, argument shapes, pagination limits, and compact/expanded behaviour.
- All 10 official resources.
- A config file replacing the Enterprise admin UI: enable/disable tools and resources, override titles and descriptions, choose the response format.
- The existing CLI keeps working unchanged.

Out of scope for v1 (see "Later"):

- Streamable HTTP transport and multi-user OAuth.
- Tools beyond the official 24.

## Architecture

```
scripts/openproject.mjs      CLI (commander)          thin front-end
scripts/openproject-mcp.mjs  MCP server (SDK, stdio)  thin front-end
lib/
  client.mjs      opFetch, authHeader, baseUrl, config loading, retry on 429
  resolve.mjs     project/status/type/priority/user name -> id, work package display id -> numeric id
  workPackages.mjs, timeEntries.mjs, comments.mjs, relations.mjs, users.mjs,
  projects.mjs, portfolios.mjs, programs.mjs, versions.mjs, customFields.mjs, lookups.mjs
  format.mjs      compact/expanded shaping, custom field name resolution
mcp/
  tools.mjs       24 tool registrations (zod input + output schemas)
  resources.mjs   10 resource registrations (URI templates)
  config.mjs      loads openproject-mcp.config.json, applies enable/rename/format
```

Rule for `lib/`: functions take plain arguments, return plain objects, throw `Error` with `statusCode`. No `console.log`, no `process.exit`. Today the script has 349 `console.log` and 104 `process.exit` calls inside the command functions, so this split is the bulk of the work.

Dependencies to add: `@modelcontextprotocol/sdk` (1.32.x at time of writing), `zod`.

## Phase 1. Extract the library

1. Move `getCfg`, `authHeader`, `baseUrl`, `opFetch`, `halLink` into `lib/client.mjs`. Keep behaviour identical.
2. Move `resolveProject` and the inline status/type/priority lookups (currently repeated inside `cmdWpList`, `cmdWpCreate`, `cmdWpUpdate`) into `lib/resolve.mjs`.
3. For each command the MCP needs (table below), split `cmdXxx(options)` into `lib` function returning data plus a CLI printer. Start with work packages, comments, relations, time entries, users, projects. Portfolios, programs, versions, custom fields follow.
4. Add `normalizeWp` style normalisers for time entries, users, projects, so CLI `--json` and MCP structured content share one shape.
5. Keep the other 100 or so CLI commands untouched in this phase. They can migrate later or stay inline.

Acceptance: CLI output is byte-identical for the migrated commands. Run the existing CI regression workflow before and after.

## Phase 2. MCP server with tools

Create `scripts/openproject-mcp.mjs` using `McpServer` + `StdioServerTransport`. Register the tools below. Every handler returns `{ content: [{type:'text', text}], structuredContent }` and declares an `outputSchema`, matching the official "Full" response format.

| Official tool | Backed by | Work needed |
|---|---|---|
| `current_user` | user-me | none |
| `search_users` | user-list | `page` param, limit 100 |
| `search_projects` | project-list | filters (name, identifier, active, parent), `page`, limit 100 |
| `search_portfolios` | portfolio-list | filters, `page`, limit 100 (Enterprise only on server side) |
| `search_programs` | program-list | filters, `page`, limit 100 (Enterprise only on server side) |
| `search_versions` | version-list | switch to global `GET /versions` with project filter, `page`, limit 100 |
| `list_statuses` | status-list | none |
| `list_types` | type-list | none |
| `search_work_packages` | wp-list | `page` param, limit 40, `expanded` flag, compact shape (id, subject, type, author, status, start, finish, assignee), display ID lookup, custom field name resolution |
| `create_work_package` | wp-create | accept custom field values |
| `update_work_package` | wp-update | lockVersion handling, display ID lookup |
| `list_work_package_comments` | comment-list | none |
| `create_work_package_comment` | comment-add | none |
| `list_work_package_relations` | relation-list | none |
| `create_work_package_relation` | relation-create | none |
| `update_work_package_relation` | relation-update | none |
| `delete_work_package_relation` | relation-delete | none |
| `search_time_entries` | time-list | filters (project, user, work package, date range), `page`, limit 40 |
| `create_time_entry` | time-create | none |
| `update_time_entry` | time-update | none |
| `delete_time_entry` | time-delete | none |
| `search_custom_fields` | none | new. API v3 has no custom field list endpoint; build from `GET /work_packages/schemas/{project}-{type}` and `GET /custom_fields/{id}`. Cache per session. |
| `search_custom_field_items` | custom-field-items | add text search and `page` |

Behaviours to replicate:

- **Pagination.** `page` is 1-based. Translate to `offset`/`pageSize`. Tool description states the limit, as the official one does.
- **Compact work package response.** Default. `expanded: true` returns description and all attributes.
- **Work package IDs.** Accept numeric ID or display ID. Resolve display IDs with a work package filter before calling `/work_packages/{id}`.
- **Custom field names.** Resolve `customFieldN` keys to the field's human name through the schema cache before returning results.
- **Errors.** Return `isError: true` with the OpenProject message. Never exit the process.

## Phase 3. Resources

Register with `ResourceTemplate` and URIs under an `openproject://` scheme.

| Resource | URI | Source |
|---|---|---|
| `current_user` | `openproject://current_user` | `GET /users/me` |
| `user` | `openproject://user/{id}` | `GET /users/{id}` |
| `project` | `openproject://project/{id}` | `GET /projects/{id}` (id or identifier) |
| `work_package` | `openproject://work_package/{id}` | `GET /work_packages/{id}` (numeric or display id) |
| `version` | `openproject://version/{id}` | `GET /versions/{id}` |
| `custom_field` | `openproject://custom_field/{id}` | `GET /custom_fields/{id}` |
| `status` | `openproject://status/{id}` | `GET /statuses/{id}` |
| `status_list` | `openproject://statuses` | `GET /statuses` |
| `type` | `openproject://type/{id}` | `GET /types/{id}` |
| `type_list` | `openproject://types` | `GET /types` |

Return `application/json` with the normalised object. Provide `list` callbacks for the two static lists so clients can discover them.

## Phase 4. Configuration file

`openproject-mcp.config.json`, optional, looked up in cwd then next to the script. Mirrors what the Enterprise admin UI exposes.

```json
{
  "serverTitle": "OpenProject",
  "serverDescription": "Access to the ALT-F1 OpenProject instance",
  "responseFormat": "full",
  "tools": {
    "search_work_packages": { "title": "Search work items", "description": "..." },
    "delete_time_entry": { "enabled": false }
  },
  "resources": {
    "custom_field": { "enabled": false }
  }
}
```

- `responseFormat`: `full` (text + structured), `structured`, `text`.
- Disabled tools and resources are not registered, so clients never see them.
- Titles and descriptions override the defaults at registration time.

## Phase 5. Packaging and docs

- Add `"openproject-mcp": "./scripts/openproject-mcp.mjs"` to `bin` in `package.json`.
- Document client setup. Claude Code: `claude mcp add openproject -e OP_HOST=... -e OP_API_TOKEN=... -- node /path/scripts/openproject-mcp.mjs`. Claude Desktop: the equivalent `mcpServers` JSON block.
- Add an MCP section to README and SKILL.md. Update `docs/API-COVERAGE.md` to mention which endpoints the MCP uses.
- Bump to 3.0.0 (new entry point, internal restructure).

## Testing

- Unit tests for `lib/` with mocked `fetch` (Node's built-in test runner, no new dev dependency).
- Contract test: start the server over stdio, call `tools/list` and `resources/list`, assert the 24 and 10 names match the official list.
- Smoke test against a demo or staging instance: `current_user`, `search_work_packages`, `create_work_package_comment`, `search_time_entries`.
- Run the MCP Inspector (`npx @modelcontextprotocol/inspector`) manually before release.

## Authentication

v1 uses the existing `OP_HOST` and `OP_API_TOKEN` env vars (Basic auth, `apikey:<token>`). This is exactly the official "personal access" mode and needs nothing from the OpenProject admin beyond "Enable API tokens".

The official "shared access via OAuth" mode cannot be copied as-is. The `mcp` OAuth scope only exists for OpenProject's built-in endpoint. A shared clone would have to:

1. Run Streamable HTTP instead of stdio.
2. Implement the MCP authorization spec on the server side (OAuth 2.1 resource server with protected-resource metadata).
3. Exchange each user's token against an OpenProject OAuth application with the `api_v3` scope and call the API on their behalf.

That is a separate project and is deferred.

## Later

- Streamable HTTP transport behind a reverse proxy at `/mcp`, plus the OAuth work above.
- Extra tools beyond the official set, drawn from the CLI: notifications, watchers, news, groups, wiki pages, attachments. Keep them off by default so the tool list stays close to the official one.
- Prompts (MCP prompt primitives) for common flows such as "daily standup summary" or "log time against this ticket".

## Known limits

- `search_portfolios` and `search_programs` return errors on Community instances. The server should surface the OpenProject message rather than hide the tools.
- Actions run with the permissions of the token's user, same as the official server.
- Custom field search is reconstructed from schemas and may miss fields on types the user cannot see.

## Open decisions

1. Keep one package with two bins, or publish the MCP as a separate npm package depending on a shared `@alt-f1/openproject-client`? One package is simpler for ClawHub; separate packages are cleaner for npm users who only want MCP.
2. Whether to ship the config file by default or only document it.
3. Whether `search_work_packages` compact output should include `project`. The official list omits it; adding it helps multi-project users but breaks parity.

## Effort

| Phase | Estimate |
|---|---|
| 1. Library extraction (14 commands) | 2 to 3 days |
| 2. Tools | 1 to 2 days |
| 3. Resources | half a day |
| 4. Config | half a day |
| 5. Packaging, docs, tests | 1 day |

About one working week for v1 with stdio and API token auth.
