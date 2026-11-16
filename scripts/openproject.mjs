#!/usr/bin/env node

/**
 * OpenClaw OpenProject Skill — CLI for OpenProject management via API v3.
 * Supports both cloud and self-hosted instances.
 *
 * @author Abdelkrim BOUJRAF <abdelkrim@alt-f1.be>
 * @license MIT
 * @see https://www.alt-f1.be
 */

// File I/O is used ONLY for reading user-specified attachments that the user
// explicitly passes via --file flag. No arbitrary file access.
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve, posix, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { config } from 'dotenv';
import { Command, InvalidArgumentError } from 'commander';

// ── Config ──────────────────────────────────────────────────────────────────

config(); // load .env from the current working directory (takes precedence)
// Fallback: also load the .env that ships next to this script, so the CLI works
// when invoked from any directory. dotenv never overrides already-set vars,
// so a cwd .env or real environment variables still win.
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

let _cfg;
function getCfg() {
  if (!_cfg) {
    // Only OpenProject-specific env vars are read — nothing else.
    const host     = process.env.OP_HOST;
    const apiToken = process.env.OP_API_TOKEN;

    const missing = [];
    if (!host)     missing.push('OP_HOST');
    if (!apiToken) missing.push('OP_API_TOKEN');

    if (missing.length) {
      console.error(`ERROR: Missing required env var(s): ${missing.join(', ')}. See .env.example`);
      process.exit(1);
    }

    _cfg = {
      host,
      apiToken,
      defaultProject: process.env.OP_DEFAULT_PROJECT || '',
      maxResults:     parseInt(process.env.OP_MAX_RESULTS || '50', 10),
      maxFileSize:    parseInt(process.env.OP_MAX_FILE_SIZE || '52428800', 10), // 50 MB
    };
  }
  return _cfg;
}
const CFG = new Proxy({}, { get: (_, prop) => getCfg()[prop] });

// ── Security helpers ────────────────────────────────────────────────────────

function safePath(p) {
  if (!p) return '';
  const normalized = posix.normalize(p).replace(/\\/g, '/');
  if (normalized.includes('..')) {
    console.error('ERROR: Path traversal detected — ".." is not allowed');
    process.exit(1);
  }
  return normalized.replace(/^\/+/, '');
}

function checkFileSize(filePath) {
  const stat = statSync(filePath);
  if (stat.size > CFG.maxFileSize) {
    console.error(`ERROR: File exceeds size limit (${(stat.size / 1048576).toFixed(1)} MB > ${(CFG.maxFileSize / 1048576).toFixed(1)} MB)`);
    process.exit(1);
  }
  return stat.size;
}

// ── HTTP client with rate-limit retry ───────────────────────────────────────

function authHeader() {
  // OpenProject uses Basic auth with 'apikey' as username
  const token = Buffer.from(`apikey:${CFG.apiToken}`).toString('base64');
  return `Basic ${token}`;
}

function baseUrl() {
  const host = CFG.host.replace(/\/+$/, '');
  const prefix = host.startsWith('http') ? host : `https://${host}`;
  return `${prefix}/api/v3`;
}

async function opFetch(path, options = {}, retries = 3) {
  const url = path.startsWith('http') ? path : `${baseUrl()}${path}`;
  const headers = {
    'Authorization': authHeader(),
    'Accept': 'application/json',
    ...options.headers,
  };

  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    const resp = await fetch(url, { ...options, headers });

    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('retry-after') || '5', 10);
      const backoff = retryAfter * 1000 * attempt;
      if (attempt < retries) {
        console.error(`⏳ Rate limited — retrying in ${(backoff / 1000).toFixed(0)}s (attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
    }

    if (resp.status === 204) return null;

    const body = await resp.text();
    let data;
    try { data = JSON.parse(body); } catch { data = body; }

    if (!resp.ok) {
      const msg = data?.message
        || data?.errorIdentifier
        || data?._embedded?.errors?.map(e => e.message).join(', ')
        || body
        || resp.statusText;
      const err = new Error(msg);
      err.statusCode = resp.status;
      throw err;
    }

    return data;
  }
}

// ── HAL helpers ─────────────────────────────────────────────────────────────

function halLink(obj, rel) {
  return obj?._links?.[rel]?.title || obj?._links?.[rel]?.href?.split('/').pop() || '?';
}

function halId(obj, rel) {
  const href = obj?._links?.[rel]?.href;
  if (!href) return null;
  const match = href.match(/\/(\d+)$/);
  return match ? match[1] : null;
}

// Normalize a work package into a flat JSON object with the fields the API
// already returns but the human-readable output omits (start/due dates, description).
function normalizeWp(wp) {
  const versions = wp._links?.targetVersions ?? (wp._links?.version?.href ? [wp._links.version] : []);
  return {
    id: wp.id,
    subject: wp.subject,
    type: halLink(wp, 'type'),
    status: halLink(wp, 'status'),
    priority: halLink(wp, 'priority'),
    assignee: wp?._links?.assignee?.title || null,
    assigneeId: halId(wp, 'assignee'),
    responsible: wp._links?.responsible?.title || null,
    responsibleId: halId(wp, 'responsible'),
    parentId: halId(wp, 'parent'),
    category: wp._links?.category?.title || null,
    categoryId: halId(wp, 'category'),
    versionIds: versions.map(link => link.href?.match(/\/(\d+)$/)?.[1]).filter(Boolean),
    estimatedTime: wp.estimatedTime ?? null,
    remainingTime: wp.remainingTime ?? null,
    project: halLink(wp, 'project'),
    projectId: halId(wp, 'project'),
    startDate: wp.startDate || null,
    dueDate: wp.dueDate || null,
    date: wp.date || null,
    percentageDone: wp.percentageDone ?? null,
    createdAt: wp.createdAt || null,
    updatedAt: wp.updatedAt || null,
    description: wp.description?.raw || '',
    url: `${CFG.host}/work_packages/${wp.id}`,
  };
}

// ── Work Package commands ───────────────────────────────────────────────────

function numericId(value, label = 'ID') {
  if (!/^[1-9]\d*$/.test(String(value))) throw new InvalidArgumentError(`${label} must be a positive numeric ID`);
  return String(value);
}

function projectRef(value) {
  if (/^\d+$/.test(value)) return numericId(value, 'Project');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new InvalidArgumentError('Project must be a numeric ID or identifier slug');
  return value;
}

function booleanValue(value) {
  if (value !== 'true' && value !== 'false') throw new InvalidArgumentError('Expected true or false');
  return value === 'true';
}

function choice(...values) {
  return value => {
    if (!values.includes(value)) throw new InvalidArgumentError(`Expected one of: ${values.join(', ')}`);
    return value;
  };
}

function idList(value) {
  return value.split(',').map(id => numericId(id.trim()));
}

function optionalId(value) { return value === 'none' ? value : numericId(value); }

function envName(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new InvalidArgumentError('Expected an environment variable name');
  return value;
}

function envSecret(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before changing a password`);
  return value;
}

function minutesValue(value) {
  if (value === 'none') return value;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Expected whole minutes, or none to clear');
  return Number(value);
}

function dateValue(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new InvalidArgumentError('Expected a valid date in YYYY-MM-DD format');
  }
  return value;
}

function nullableDate(value) { return value === 'none' ? value : dateValue(value); }
function nullableDuration(value) { return value === 'none' ? value : durationValue(value); }

function percentageValue(value) {
  if (!/^\d+$/.test(value) || Number(value) > 100) throw new InvalidArgumentError('Expected a whole percentage from 0 to 100');
  return Number(value);
}

function durationValue(value) {
  if (!/^P(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/.test(value)) {
    throw new InvalidArgumentError('Expected an ISO 8601 duration, e.g. PT2H30M');
  }
  return value;
}

function timestampValue(value) {
  dateValue(value.slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InvalidArgumentError('Expected an ISO 8601 timestamp with timezone, e.g. 2026-11-20T10:00:00Z');
  }
  return value;
}

function requireConfirm(options, action) {
  if (!options.confirm) throw new Error(`${action} requires --confirm`);
}

function requireChanges(payload) {
  const { lockVersion, ...changes } = payload;
  if (!Object.keys(changes).length) throw new Error('Provide at least one field to update');
}

async function resolveProject(value) {
  const ref = projectRef(value || CFG.defaultProject || '');
  const project = await opFetch(`/projects/${ref}`);
  return numericId(project.id, 'Resolved project');
}

async function cmdResourceRead(options, resource) {
  const result = await opFetch(`/${resource}/${options.id}`);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdCollectionRead(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const suffix = params.toString();
  const result = await opFetch(`${path}${suffix ? `?${suffix}` : ''}`);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdWpDiscovery(options, resource) {
  const query = resource === 'available_relation_candidates'
    ? { pageSize: CFG.maxResults, query: options.query, type: options.type } : {};
  await cmdCollectionRead(`/work_packages/${options.id}/${resource}`, query);
}

async function cmdProjectAssignees(options) {
  const id = await resolveProject(options.project);
  await cmdCollectionRead(`/workspaces/${id}/available_assignees`);
}

async function cmdProjectParentCandidates(options) {
  const filters = options.query ? [{ name_and_identifier: { operator: '~', values: [options.query] } }] : undefined;
  await cmdCollectionRead('/projects/available_parent_projects', { of: options.project, filters });
}

async function cmdRoleList(options) {
  const filters = [];
  if (options.unit) filters.push({ unit: { operator: '=', values: [options.unit] } });
  if (options.grantable !== undefined) filters.push({ grantable: { operator: '=', values: [options.grantable ? 't' : 'f'] } });
  await cmdCollectionRead('/roles', { filters: filters.length ? filters : undefined });
}

async function cmdPrincipalList(options) {
  const filters = [];
  if (options.type) filters.push({ type: { operator: '=', values: [options.type] } });
  if (options.name) filters.push({ any_name_attribute: { operator: '~', values: [options.name] } });
  if (options.project) filters.push({ member: { operator: '=', values: [await resolveProject(options.project)] } });
  await cmdCollectionRead('/principals', { pageSize: CFG.maxResults, offset: options.page || 1, filters: filters.length ? filters : undefined });
}

async function cmdSprintList(options) {
  const projectId = options.project ? await resolveProject(options.project) : undefined;
  const path = projectId ? `/projects/${projectId}/sprints` : '/sprints';
  const definingId = options.definedIn ? await resolveProject(options.definedIn) : undefined;
  const filters = definingId ? [{ definingWorkspace: { operator: '=', values: [definingId] } }] : undefined;
  await cmdCollectionRead(path, { pageSize: CFG.maxResults, offset: options.page || 1, filters });
}

async function cmdResourceDelete(options, resource) {
  requireConfirm(options, `Deleting ${resource}`);
  await opFetch(`/${resource}/${options.id}`, { method: 'DELETE' });
  console.log(`✅ Deleted ${resource}: ${options.id}`);
}

async function updateLocked(path, payload) {
  requireChanges(payload);
  const current = await opFetch(path);
  if (!Number.isInteger(current.lockVersion)) throw new Error('API response is missing lockVersion; update cancelled');
  await opFetch(path, { method: 'PATCH', body: JSON.stringify({ ...payload, lockVersion: current.lockVersion }) });
}

function wpSchedule(options) {
  if (options.date !== undefined && (options.startDate !== undefined || options.dueDate !== undefined)) {
    throw new Error('Use --date for milestones, or --start-date/--due-date for other work packages');
  }
  if (options.startDate && options.startDate !== 'none' && options.dueDate && options.dueDate !== 'none' && options.startDate > options.dueDate) {
    throw new Error('--due-date must be on or after --start-date');
  }
  const payload = {};
  for (const field of ['startDate', 'dueDate', 'date']) if (options[field] !== undefined) payload[field] = options[field] === 'none' ? null : options[field];
  for (const [option, field] of [['estimate', 'estimatedTime'], ['remaining', 'remainingTime']]) {
    if (options[option] !== undefined) payload[field] = options[option] === 'none' ? null : options[option];
  }
  if (options.scheduleManually !== undefined) payload.scheduleManually = options.scheduleManually;
  return payload;
}

function wpLinks(options) {
  const links = {};
  for (const [field, resource] of [['assignee', 'users'], ['responsible', 'users'], ['parent', 'work_packages'], ['category', 'categories']]) {
    if (options[field] !== undefined) links[field] = { href: options[field] === 'none' ? null : `/api/v3/${resource}/${options[field]}` };
  }
  if (options.targetVersion !== undefined) links.targetVersions = options.targetVersion === 'none' ? [] : [{ href: `/api/v3/versions/${options.targetVersion}` }];
  return links;
}

async function resolveNamedId(path, value, label) {
  if (/^\d+$/.test(value)) return numericId(value, label);
  const result = await opFetch(path);
  const elements = result._embedded?.elements || [];
  const match = elements.find(item => item.name.toLowerCase() === value.toLowerCase());
  if (!match) throw new Error(`No ${label} named "${value}". Available: ${elements.map(item => item.name).join(', ')}`);
  return String(match.id);
}

async function cmdWpList(options) {
  const project = options.project || CFG.defaultProject;
  const filters = [];

  if (project) {
    projectRef(project);
    const projResp = await opFetch(`/projects/${project}`);
    filters.push({ project: { operator: '=', values: [String(projResp.id)] } });
  }
  if (options.open || options.closed) {
    // OpenProject native meta-filter: 'o' = any open status, 'c' = any closed status
    filters.push({ status: { operator: options.closed ? 'c' : 'o', values: [] } });
  } else if (options.status) {
    const id = await resolveNamedId('/statuses', options.status, 'status');
    filters.push({ status: { operator: '=', values: [id] } });
  }
  if (options.assignee === 'me') {
    filters.push({ assignee: { operator: '=', values: ['me'] } });
  } else if (options.assignee) {
    filters.push({ assignee: { operator: '=', values: [options.assignee] } });
  }
  if (options.type) {
    const id = await resolveNamedId(project ? `/projects/${project}/types` : '/types', options.type, 'type');
    filters.push({ type: { operator: '=', values: [id] } });
  }

  const filterParam = filters.length ? `&filters=${encodeURIComponent(JSON.stringify(filters))}` : '';

  // --json: paginate through ALL matching work packages and emit normalized
  // JSON (incl. start/due dates + description) for programmatic consumers.
  if (options.json) {
    const all = [];
    let page = 1;
    while (true) {
      const resp = await opFetch(`/work_packages?offset=${page}&pageSize=100${filterParam}&sortBy=[["updatedAt","desc"]]`);
      const els = resp._embedded?.elements || [];
      for (const wp of els) all.push(normalizeWp(wp));
      const total = resp.total || 0;
      if (all.length >= total || els.length === 0) break;
      page++;
    }
    console.log(JSON.stringify({ total: all.length, tasks: all }, null, 2));
    return;
  }

  const resp = await opFetch(`/work_packages?pageSize=${CFG.maxResults}${filterParam}&sortBy=[["updatedAt","desc"]]`);

  if (!resp._embedded.elements.length) {
    console.log('No work packages found.');
    return;
  }

  for (const wp of resp._embedded.elements) {
    const status = halLink(wp, 'status');
    const priority = halLink(wp, 'priority');
    const assignee = halLink(wp, 'assignee');
    const type = halLink(wp, 'type');
    const updated = wp.updatedAt?.substring(0, 10) || '';
    console.log(`📋  #${String(wp.id).padEnd(6)}  ${type.padEnd(10)}  ${status.padEnd(14)}  ${priority.padEnd(8)}  ${(assignee || 'Unassigned').padEnd(20)}  ${updated}  ${wp.subject}`);
  }
  console.log(`\n${resp._embedded.elements.length} of ${resp.total} work packages`);
}

async function cmdWpCreate(options) {
  const project = options.project || CFG.defaultProject;
  if (!project) {
    console.error('ERROR: --project is required (or set OP_DEFAULT_PROJECT)');
    process.exit(1);
  }
  projectRef(project);
  if (!options.subject) {
    console.error('ERROR: --subject is required');
    process.exit(1);
  }

  const payload = {
    subject: options.subject,
    ...wpSchedule(options),
    _links: wpLinks(options),
  };

  if (options.description) {
    payload.description = { format: 'markdown', raw: options.description };
  }

  // Resolve type
  if (options.type) {
    const id = await resolveNamedId(`/projects/${project}/types`, options.type, 'type');
    payload._links.type = { href: `/api/v3/types/${id}` };
  }

  // Resolve priority
  if (options.priority) {
    const id = await resolveNamedId('/priorities', options.priority, 'priority');
    payload._links.priority = { href: `/api/v3/priorities/${id}` };
  }
  if (options.status) payload._links.status = { href: `/api/v3/statuses/${await resolveNamedId('/statuses', options.status, 'status')}` };

  if (Object.keys(payload._links).length === 0) delete payload._links;

  const result = await opFetch(`/projects/${project}/work_packages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Created: #${result.id} — ${result.subject}`);
  console.log(`   URL: ${CFG.host}/work_packages/${result.id}`);
}

async function cmdWpRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const wp = await opFetch(`/work_packages/${options.id}`);

  if (options.json) {
    console.log(JSON.stringify(normalizeWp(wp), null, 2));
    return;
  }

  console.log(`📋 #${wp.id}: ${wp.subject}`);
  console.log(`   Type:        ${halLink(wp, 'type')}`);
  console.log(`   Status:      ${halLink(wp, 'status')}`);
  console.log(`   Priority:    ${halLink(wp, 'priority')}`);
  console.log(`   Assignee:    ${halLink(wp, 'assignee')}`);
  console.log(`   Author:      ${halLink(wp, 'author')}`);
  console.log(`   Project:     ${halLink(wp, 'project')}`);
  console.log(`   Version:     ${halLink(wp, 'version')}`);
  console.log(`   Category:    ${halLink(wp, 'category')}`);
  console.log(`   Start:       ${wp.startDate || '?'}`);
  console.log(`   Due:         ${wp.dueDate || '?'}`);
  console.log(`   Created:     ${wp.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:     ${wp.updatedAt?.substring(0, 10) || '?'}`);
  console.log(`   % Done:      ${wp.percentageDone ?? '?'}%`);
  console.log(`   Estimated:   ${wp.estimatedTime || '?'}`);
  console.log(`   URL:         ${CFG.host}/work_packages/${wp.id}`);

  if (wp.description?.raw) {
    console.log(`\n📝 Description:\n${wp.description.raw}`);
  }
}

async function cmdWpUpdate(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const schedule = wpSchedule(options);
  // Get current work package for lockVersion
  const current = await opFetch(`/work_packages/${options.id}`);
  if (!Number.isInteger(current.lockVersion)) throw new Error('API response is missing lockVersion; update cancelled');
  const payload = { lockVersion: current.lockVersion, ...schedule, _links: wpLinks(options) };
  const projectId = options.project !== undefined ? await resolveProject(options.project) : halId(current, 'project');
  if (options.project !== undefined) payload._links.project = { href: `/api/v3/projects/${projectId}` };

  if (options.subject !== undefined) payload.subject = options.subject;
  if (options.description !== undefined) payload.description = { format: 'markdown', raw: options.description };
  if (options.percentDone !== undefined) payload.percentageDone = options.percentDone;

  if (options.status) {
    const id = await resolveNamedId('/statuses', options.status, 'status');
    payload._links.status = { href: `/api/v3/statuses/${id}` };
  }

  if (options.priority) {
    const id = await resolveNamedId('/priorities', options.priority, 'priority');
    payload._links.priority = { href: `/api/v3/priorities/${id}` };
  }

  if (options.type) {
    if (!projectId && !/^\d+$/.test(options.type)) throw new Error('Cannot resolve type name without the work package project');
    const id = await resolveNamedId(`/projects/${projectId}/types`, options.type, 'type');
    payload._links.type = { href: `/api/v3/types/${id}` };
  }

  if (Object.keys(payload._links).length === 0) delete payload._links;
  requireChanges(payload);

  await opFetch(`/work_packages/${options.id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Updated: #${options.id}`);
}

async function cmdWpDelete(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }
  if (!options.confirm) {
    console.error('ERROR: Delete requires --confirm flag for safety');
    console.error('Usage: openproject wp-delete --id 42 --confirm');
    process.exit(1);
  }

  await opFetch(`/work_packages/${options.id}`, { method: 'DELETE' });
  console.log(`✅ Deleted: #${options.id}`);
}

// ── Project commands ────────────────────────────────────────────────────────

async function cmdProjectList() {
  const resp = await opFetch(`/projects?pageSize=${CFG.maxResults}`);

  if (!resp._embedded.elements.length) {
    console.log('No projects found.');
    return;
  }

  for (const p of resp._embedded.elements) {
    const status = p.active ? '✅' : '⏸️';
    const updated = p.updatedAt?.substring(0, 10) || '';
    console.log(`${status}  ${p.identifier.padEnd(25)}  ${p.name.padEnd(30)}  ${updated}`);
  }
  console.log(`\n${resp._embedded.elements.length} project(s)`);
}

async function cmdProjectRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required (project identifier or numeric ID)');
    process.exit(1);
  }

  const p = await opFetch(`/projects/${options.id}`);

  console.log(`📂 ${p.name}`);
  console.log(`   Identifier:  ${p.identifier}`);
  console.log(`   ID:          ${p.id}`);
  console.log(`   Active:      ${p.active ? 'Yes' : 'No'}`);
  console.log(`   Public:      ${p.public ? 'Yes' : 'No'}`);
  console.log(`   Created:     ${p.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:     ${p.updatedAt?.substring(0, 10) || '?'}`);
  console.log(`   URL:         ${CFG.host}/projects/${p.identifier}`);

  if (p.description?.raw) {
    console.log(`\n📝 Description:\n${p.description.raw}`);
  }
}

async function cmdProjectCreate(options) {
  if (!options.name) {
    console.error('ERROR: --name is required');
    process.exit(1);
  }

  const payload = {
    name: options.name,
  };
  if (options.identifier) payload.identifier = options.identifier;
  if (options.description) payload.description = { format: 'markdown', raw: options.description };
  if (options.public !== undefined) payload.public = options.public;
  if (options.parent !== undefined) payload._links = { parent: { href: `/api/v3/projects/${await resolveProject(options.parent)}` } };

  const result = await opFetch('/projects', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Created project: ${result.name}`);
  console.log(`   Identifier: ${result.identifier}`);
  console.log(`   ID: ${result.id}`);
  console.log(`   URL: ${CFG.host}/projects/${result.identifier}`);
}

async function cmdProjectUpdate(options) {
  if (options.public !== undefined || options.active !== undefined) requireConfirm(options, 'Changing project visibility or active state');
  const payload = {};
  for (const field of ['name', 'public', 'active']) if (options[field] !== undefined) payload[field] = options[field];
  if (options.description !== undefined) payload.description = { format: 'markdown', raw: options.description };
  if (options.parent !== undefined) {
    payload._links = { parent: { href: options.parent === 'none' ? null : `/api/v3/projects/${await resolveProject(options.parent)}` } };
  }
  requireChanges(payload);
  await opFetch(`/projects/${options.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  console.log(`✅ Updated project: ${options.id}`);
}

async function cmdProjectDelete(options) {
  requireConfirm(options, 'Deleting a project');
  await opFetch(`/projects/${options.id}`, { method: 'DELETE' });
  console.log(`✅ Deleted project: ${options.id}`);
}

// ── Comment (Activity) commands ─────────────────────────────────────────────

async function cmdCommentUpdate(options) {
  const payload = { comment: { raw: options.body } };
  if (options.internal !== undefined) payload.internal = options.internal;
  await opFetch(`/activities/${options.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  console.log(`✅ Updated comment: ${options.id}`);
}

async function cmdCommentList(options) {
  if (!options.wpId) {
    console.error('ERROR: --wp-id is required');
    process.exit(1);
  }

  const resp = await opFetch(`/work_packages/${options.wpId}/activities`);

  const comments = resp._embedded.elements.filter(a => a.comment?.raw);
  if (!comments.length) {
    console.log('No comments.');
    return;
  }

  for (const a of comments) {
    const author = halLink(a, 'user');
    const created = a.createdAt?.substring(0, 16).replace('T', ' ') || '?';
    const body = a.comment.raw;
    console.log(`💬 #${a.id}  ${author}  ${created}`);
    console.log(`   ${body.substring(0, 200)}${body.length > 200 ? '...' : ''}`);
    console.log('');
  }
  console.log(`${comments.length} comment(s)`);
}

async function cmdCommentAdd(options) {
  if (!options.wpId || !options.body) {
    console.error('ERROR: --wp-id and --body are required');
    process.exit(1);
  }

  const result = await opFetch(`/work_packages/${options.wpId}/activities`, {
    method: 'POST',
    body: JSON.stringify({
      comment: { format: 'markdown', raw: options.body },
    }),
  });

  console.log(`✅ Comment added to #${options.wpId}`);
  console.log(`   ID: ${result.id}`);
}

// ── Attachment commands ─────────────────────────────────────────────────────

async function cmdAttachmentList(options) {
  if (!options.wpId) {
    console.error('ERROR: --wp-id is required');
    process.exit(1);
  }

  const resp = await opFetch(`/work_packages/${options.wpId}/attachments`);

  if (!resp._embedded.elements.length) {
    console.log('No attachments.');
    return;
  }

  for (const a of resp._embedded.elements) {
    const size = `${(a.fileSize / 1024).toFixed(1)} KB`;
    const created = a.createdAt?.substring(0, 10) || '';
    const author = halLink(a, 'author');
    console.log(`📎  #${String(a.id).padEnd(8)}  ${a.fileName.padEnd(30)}  ${size.padStart(12)}  ${created}  ${author}`);
  }
  console.log(`\n${resp._embedded.elements.length} attachment(s)`);
}

async function cmdAttachmentAdd(options) {
  if (!options.wpId || !options.file) {
    console.error('ERROR: --wp-id and --file are required');
    process.exit(1);
  }

  const filePath = resolve(safePath(options.file) || options.file);
  checkFileSize(filePath);

  const fileContent = readFileSync(filePath);
  const fileName = basename(filePath);

  const form = new FormData();
  form.append('file', new Blob([fileContent]), fileName);
  form.append('metadata', JSON.stringify({ fileName, description: { format: 'plain', raw: '' } }));

  const url = `${baseUrl()}/work_packages/${options.wpId}/attachments`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': authHeader() },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text();
    let json;
    try { json = JSON.parse(body); } catch { json = null; }
    const msg = json?.message || json?.errorIdentifier || body;
    console.error(`ERROR (${resp.status}): ${msg}`);
    process.exit(1);
  }

  const result = await resp.json();
  console.log(`✅ Attachment uploaded to #${options.wpId}`);
  console.log(`   File: ${result.fileName}`);
  console.log(`   Size: ${(result.fileSize / 1024).toFixed(1)} KB`);
  console.log(`   ID: ${result.id}`);
}

async function cmdAttachmentDelete(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }
  if (!options.confirm) {
    console.error('ERROR: Delete requires --confirm flag for safety');
    console.error('Usage: openproject attachment-delete --id 10 --confirm');
    process.exit(1);
  }

  await opFetch(`/attachments/${options.id}`, { method: 'DELETE' });
  console.log(`✅ Attachment #${options.id} deleted`);
}

// ── Time Entry commands ─────────────────────────────────────────────────────

async function cmdTimeList(options) {
  const filters = [];
  const project = options.project || CFG.defaultProject;

  if (project) {
    const projResp = await opFetch(`/projects/${project}`);
    filters.push({ project: { operator: '=', values: [String(projResp.id)] } });
  }
  if (options.wpId) {
    filters.push({ work_package: { operator: '=', values: [options.wpId] } });
  }

  const filterParam = filters.length ? `&filters=${encodeURIComponent(JSON.stringify(filters))}` : '';
  const resp = await opFetch(`/time_entries?pageSize=${CFG.maxResults}${filterParam}`);

  if (!resp._embedded.elements.length) {
    console.log('No time entries found.');
    return;
  }

  for (const t of resp._embedded.elements) {
    const user = halLink(t, 'user');
    const wpId = halId(t, 'workPackage') || '?';
    const hours = t.hours ? t.hours.replace('PT', '').replace('H', 'h ').replace('M', 'm').trim() : '?';
    const date = t.spentOn || '?';
    const comment = t.comment?.raw || '';
    console.log(`⏱️  #${String(t.id).padEnd(6)}  WP#${wpId.padEnd(6)}  ${hours.padEnd(8)}  ${date}  ${user.padEnd(20)}  ${comment.substring(0, 40)}`);
  }
  console.log(`\n${resp._embedded.elements.length} time entries`);
}

async function cmdTimeCreate(options) {
  if (!options.wpId || !options.hours) {
    console.error('ERROR: --wp-id and --hours are required');
    process.exit(1);
  }

  const hours = parseFloat(options.hours);
  const isoDuration = `PT${Math.floor(hours)}H${Math.round((hours % 1) * 60)}M`;

  const payload = {
    hours: isoDuration,
    comment: options.comment ? { format: 'plain', raw: options.comment } : undefined,
    spentOn: options.date || new Date().toISOString().substring(0, 10),
    _links: {
      workPackage: { href: `/api/v3/work_packages/${options.wpId}` },
    },
  };

  if (options.activityId) {
    payload._links.activity = { href: `/api/v3/time_entries/activities/${options.activityId}` };
  }

  const result = await opFetch('/time_entries', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Time logged: ${options.hours}h on WP#${options.wpId}`);
  console.log(`   ID: ${result.id}`);
}

async function cmdTimeUpdate(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const payload = {};
  if (options.hours) {
    const hours = parseFloat(options.hours);
    payload.hours = `PT${Math.floor(hours)}H${Math.round((hours % 1) * 60)}M`;
  }
  if (options.comment) payload.comment = { format: 'plain', raw: options.comment };
  if (options.date) payload.spentOn = options.date;

  await opFetch(`/time_entries/${options.id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Time entry #${options.id} updated`);
}

async function cmdTimeDelete(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }
  if (!options.confirm) {
    console.error('ERROR: Delete requires --confirm flag for safety');
    console.error('Usage: openproject time-delete --id 5 --confirm');
    process.exit(1);
  }

  await opFetch(`/time_entries/${options.id}`, { method: 'DELETE' });
  console.log(`✅ Time entry #${options.id} deleted`);
}

// ── Reference Data commands ─────────────────────────────────────────────────

async function cmdStatusList() {
  const resp = await opFetch('/statuses');
  console.log('Available statuses:\n');
  for (const s of resp._embedded.elements) {
    const closed = s.isClosed ? '🔒' : '🔓';
    console.log(`  ${closed}  ID: ${String(s.id).padEnd(4)}  ${s.name}`);
  }
}

async function cmdTypeList(options) {
  const path = options.project ? `/workspaces/${await resolveProject(options.project)}/types` : '/types';
  const resp = await opFetch(path);
  if (options.json) { console.log(JSON.stringify(resp, null, 2)); return; }
  console.log('Available types:\n');
  for (const t of resp._embedded.elements) {
    console.log(`  🏷️  ID: ${String(t.id).padEnd(4)}  ${t.name}`);
  }
}

async function cmdPriorityList() {
  const resp = await opFetch('/priorities');
  console.log('Available priorities:\n');
  for (const p of resp._embedded.elements) {
    const def = p.isDefault ? ' (default)' : '';
    console.log(`  ⚡  ID: ${String(p.id).padEnd(4)}  ${p.name}${def}`);
  }
}

async function cmdMemberList(options) {
  const project = options.project || CFG.defaultProject;
  if (!project) {
    console.error('ERROR: --project is required (or set OP_DEFAULT_PROJECT)');
    process.exit(1);
  }

  const proj = await opFetch(`/projects/${encodeURIComponent(project)}`);
  const filters = encodeURIComponent(JSON.stringify([{ project: { operator: '=', values: [String(proj.id)] } }]));
  const resp = await opFetch(`/memberships?pageSize=${CFG.maxResults}&filters=${filters}`);

  if (!resp._embedded.elements.length) {
    console.log('No members found.');
    return;
  }

  for (const m of resp._embedded.elements) {
    const user = halLink(m, 'principal');
    const roles = m._embedded?.roles?.map(r => r.name).filter(Boolean).join(', ')
      || m._links?.roles?.map(r => r.title || r.href?.split('/').pop()).join(', ') || '?';
    console.log(`  👤  ${user.padEnd(25)}  ${roles}`);
  }
  console.log(`\n${resp._embedded.elements.length} member(s)`);
}

async function cmdMemberWrite(options, create = false) {
  const links = {};
  if (options.project !== undefined || create) links.project = { href: `/api/v3/projects/${await resolveProject(options.project)}` };
  if (options.principal !== undefined) {
    const namespace = { user: 'users', group: 'groups', placeholder: 'placeholder_users' }[options.principalType || 'user'];
    links.principal = { href: `/api/v3/${namespace}/${options.principal}` };
  } else if (options.principalType !== undefined) {
    throw new Error('--principal-type requires --principal');
  }
  if (options.roles !== undefined) links.roles = options.roles.map(id => ({ href: `/api/v3/roles/${id}` }));
  const payload = Object.keys(links).length ? { _links: links } : {};
  requireChanges(payload);
  const result = await opFetch(create ? '/memberships' : `/memberships/${options.id}`, {
    method: create ? 'POST' : 'PATCH', body: JSON.stringify(payload),
  });
  console.log(`✅ ${create ? 'Created' : 'Updated'} membership: ${result?.id || options.id}`);
}

async function cmdVersionList(options) {
  const project = options.project || CFG.defaultProject;
  if (!project) {
    console.error('ERROR: --project is required (or set OP_DEFAULT_PROJECT)');
    process.exit(1);
  }

  const resp = await opFetch(`/projects/${project}/versions`);

  if (!resp._embedded.elements.length) {
    console.log('No versions found.');
    return;
  }

  for (const v of resp._embedded.elements) {
    const status = v.status || '?';
    const date = v.endDate || 'no date';
    console.log(`  🏁  ID: ${String(v.id).padEnd(4)}  ${v.name.padEnd(25)}  ${status.padEnd(10)}  ${date}`);
  }
  console.log(`\n${resp._embedded.elements.length} version(s)`);
}

async function cmdVersionWrite(options, create = false) {
  const payload = {};
  for (const field of ['name', 'status', 'sharing', 'startDate', 'endDate']) {
    if (options[field] !== undefined) payload[field] = ['startDate', 'endDate'].includes(field) && options[field] === 'none' ? null : options[field];
  }
  if (options.description !== undefined) payload.description = { format: 'markdown', raw: options.description };
  if (payload.startDate && payload.endDate && payload.startDate > payload.endDate) throw new Error('--end-date must be on or after --start-date');
  if (create || options.project !== undefined) payload._links = { definingProject: { href: `/api/v3/projects/${await resolveProject(options.project)}` } };
  requireChanges(payload);
  const result = await opFetch(create ? '/versions' : `/versions/${options.id}`, {
    method: create ? 'POST' : 'PATCH', body: JSON.stringify(payload),
  });
  console.log(`✅ ${create ? 'Created' : 'Updated'} version: ${result?.id || options.id}`);
}

async function cmdCategoryList(options) {
  const project = options.project || CFG.defaultProject;
  if (!project) {
    console.error('ERROR: --project is required (or set OP_DEFAULT_PROJECT)');
    process.exit(1);
  }

  const resp = await opFetch(`/projects/${project}/categories`);

  if (!resp._embedded.elements.length) {
    console.log('No categories found.');
    return;
  }

  for (const c of resp._embedded.elements) {
    console.log(`  📁  ID: ${String(c.id).padEnd(4)}  ${c.name}`);
  }
  console.log(`\n${resp._embedded.elements.length} category/categories`);
}

// ── Document commands ────────────────────────────────────────────────────────

async function cmdDocumentList() {
  const resp = await opFetch(`/documents?pageSize=${CFG.maxResults}`);
  if (!resp._embedded.elements.length) { console.log('No documents found.'); return; }
  for (const d of resp._embedded.elements) {
    const project = halLink(d, 'project');
    const created = d.createdAt?.substring(0, 10) || '?';
    console.log(`  📄  #${String(d.id).padEnd(6)}  ${(d.title || '?').padEnd(30)}  ${project}  ${created}`);
  }
  console.log(`\n${resp._embedded.elements.length} document(s)`);
}

async function cmdDocumentRead(options) {
  if (!options.id) { console.error('ERROR: --id is required'); process.exit(1); }
  const d = await opFetch(`/documents/${options.id}`);
  console.log(`📄 Document #${d.id}: ${d.title || '?'}`);
  console.log(`   Project:     ${halLink(d, 'project')}`);
  console.log(`   Created:     ${d.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:     ${d.updatedAt?.substring(0, 10) || '?'}`);
  if (d.description?.raw) console.log(`\n📝 Description:\n${d.description.raw}`);
}

async function cmdDocumentUpdate(options) {
  if (!options.id) { console.error('ERROR: --id is required'); process.exit(1); }
  const payload = {};
  if (options.title) payload.title = options.title;
  if (options.description) payload.description = { format: 'markdown', raw: options.description };
  await opFetch(`/documents/${options.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  console.log(`✅ Document #${options.id} updated`);
}

// ── Revision commands ────────────────────────────────────────────────────────

async function cmdRevisionRead(options) {
  if (!options.id) { console.error('ERROR: --id is required'); process.exit(1); }
  const r = await opFetch(`/revisions/${options.id}`);
  console.log(`🔀 Revision #${r.id}`);
  console.log(`   Identifier:  ${r.identifier || '?'}`);
  if (r.message?.raw) console.log(`   Message:     ${r.message.raw}`);
  console.log(`   Author:      ${halLink(r, 'author')}`);
  console.log(`   Created:     ${r.createdAt?.substring(0, 10) || '?'}`);
}

async function cmdRevisionListByWp(options) {
  if (!options.wpId) { console.error('ERROR: --wp-id is required'); process.exit(1); }
  const resp = await opFetch(`/work_packages/${options.wpId}/revisions`);
  if (!resp._embedded.elements.length) { console.log('No revisions found.'); return; }
  for (const r of resp._embedded.elements) {
    const msg = r.message?.raw?.substring(0, 60) || '';
    console.log(`  🔀  #${String(r.id).padEnd(6)}  ${(r.identifier || '?').padEnd(12)}  ${msg}`);
  }
  console.log(`\n${resp._embedded.elements.length} revision(s)`);
}

// ── Capability & Action commands ─────────────────────────────────────────────

async function cmdCapabilityList(options) {
  const filters = [];
  if (options.context) {
    const context = options.context === 'global' ? 'g'
      : /^\d+$/.test(options.context) ? `w${options.context}` : options.context;
    filters.push({ context: { operator: '=', values: [context] } });
  }
  if (options.action) filters.push({ action: { operator: '=', values: [options.action] } });
  if (options.principal) filters.push({ principal: { operator: '=', values: [options.principal] } });
  const filterParam = filters.length ? `&filters=${encodeURIComponent(JSON.stringify(filters))}` : '';
  const resp = await opFetch(`/capabilities?pageSize=${CFG.maxResults}${filterParam}`);
  if (!resp._embedded.elements.length) { console.log('No capabilities found.'); return; }
  for (const c of resp._embedded.elements) {
    const action = halLink(c, 'action') || '?';
    const context = halLink(c, 'context') || 'global';
    const principal = halLink(c, 'principal') || '?';
    console.log(`  🔑  ${String(c.id).padEnd(30)}  ${action.padEnd(25)}  ${context.padEnd(20)}  ${principal}`);
  }
  console.log(`\n${resp._embedded.elements.length} of ${resp.total} capability/capabilities`);
}

async function cmdCapabilityGlobal() {
  const filters = encodeURIComponent(JSON.stringify([{ context: { operator: '=', values: ['g'] } }]));
  const resp = await opFetch(`/capabilities?pageSize=${CFG.maxResults}&filters=${filters}`);
  if (!resp._embedded.elements.length) { console.log('No global capabilities.'); return; }
  for (const c of resp._embedded.elements) {
    const action = halLink(c, 'action') || '?';
    console.log(`  🔑  ${action}`);
  }
  console.log(`\n${resp._embedded.elements.length} global capability/capabilities`);
}

async function cmdActionList() {
  const resp = await opFetch('/actions');
  if (!resp._embedded.elements.length) { console.log('No actions found.'); return; }
  for (const a of resp._embedded.elements) {
    console.log(`  ⚡  ${a.id}`);
  }
  console.log(`\n${resp._embedded.elements.length} action(s)`);
}

async function cmdActionRead(options) {
  if (!options.id) { console.error('ERROR: --id is required'); process.exit(1); }
  const a = await opFetch(`/actions/${options.id}`);
  console.log(`⚡ Action: ${a.id}`);
}

// ── My Preferences commands ──────────────────────────────────────────────────

async function cmdMyPreferencesRead() {
  const p = await opFetch('/my_preferences');
  console.log('⚙️ My Preferences');
  const skip = ['_type', '_links'];
  for (const [key, val] of Object.entries(p)) {
    if (skip.includes(key)) continue;
    const display = typeof val === 'object' ? JSON.stringify(val) : val;
    console.log(`   ${key}: ${display}`);
  }
}

async function cmdMyPreferencesUpdate(options) {
  const payload = {};
  if (options.timeZone) payload.timeZone = options.timeZone;
  if (options.autoHidePopups !== undefined) payload.autoHidePopups = options.autoHidePopups === 'true';
  if (options.commentOrder) payload.commentSortDescending = options.commentOrder === 'desc';
  if (options.warnOnLeavingUnsaved !== undefined) payload.warnOnLeavingUnsaved = options.warnOnLeavingUnsaved === 'true';
  await opFetch('/my_preferences', { method: 'PATCH', body: JSON.stringify(payload) });
  console.log('✅ Preferences updated');
}

// ── Render commands ──────────────────────────────────────────────────────────

async function cmdRenderMarkdown(options) {
  if (!options.text) { console.error('ERROR: --text is required'); process.exit(1); }
  const result = await opFetch('/render/markdown', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Accept': 'text/html' },
    body: options.text,
  });
  console.log(typeof result === 'string' ? result : result?.html || JSON.stringify(result));
}

async function cmdRenderPlain(options) {
  if (!options.text) { console.error('ERROR: --text is required'); process.exit(1); }
  const result = await opFetch('/render/plain', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Accept': 'text/html' },
    body: options.text,
  });
  console.log(typeof result === 'string' ? result : result?.html || JSON.stringify(result));
}

// ── Post commands ────────────────────────────────────────────────────────────

async function cmdPostRead(options) {
  if (!options.id) { console.error('ERROR: --id is required'); process.exit(1); }
  const p = await opFetch(`/posts/${options.id}`);
  console.log(`📝 Post #${p.id}: ${p.subject || '?'}`);
  console.log(`   Author:      ${halLink(p, 'author')}`);
  console.log(`   Project:     ${halLink(p, 'project')}`);
  console.log(`   Created:     ${p.createdAt?.substring(0, 10) || '?'}`);
  if (p.description?.raw) console.log(`\n${p.description.raw}`);
}

async function cmdPostAttachmentList(options) {
  if (!options.id) { console.error('ERROR: --id is required'); process.exit(1); }
  const resp = await opFetch(`/posts/${options.id}/attachments`);
  if (!resp._embedded.elements.length) { console.log('No attachments.'); return; }
  for (const a of resp._embedded.elements) {
    const size = `${(a.fileSize / 1024).toFixed(1)} KB`;
    console.log(`📎  #${String(a.id).padEnd(8)}  ${a.fileName.padEnd(30)}  ${size.padStart(12)}`);
  }
  console.log(`\n${resp._embedded.elements.length} attachment(s)`);
}

// ── Reminder commands ────────────────────────────────────────────────────────

async function cmdReminderList() {
  const resp = await opFetch(`/reminders?pageSize=${CFG.maxResults}`);
  if (!resp._embedded.elements.length) { console.log('No reminders found.'); return; }
  for (const r of resp._embedded.elements) {
    const wp = halLink(r, 'workPackage') || '?';
    const note = r.note || '';
    console.log(`  ⏰  #${String(r.id).padEnd(6)}  WP: ${wp.padEnd(20)}  ${r.remindAt || '?'}  ${note.substring(0, 40)}`);
  }
  console.log(`\n${resp._embedded.elements.length} reminder(s)`);
}

async function cmdReminderCreate(options) {
  if (!options.wpId || !options.remindAt) {
    console.error('ERROR: --wp-id and --remind-at are required');
    process.exit(1);
  }
  const payload = {
    remindAt: options.remindAt,
    note: options.note || null,
  };
  const result = await opFetch(`/work_packages/${options.wpId}/reminders`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  console.log(`✅ Reminder created for WP#${options.wpId}`);
  console.log(`   ID: ${result.id}`);
  console.log(`   Remind at: ${result.remindAt}`);
}

async function cmdReminderUpdate(options) {
  if (!options.id) { console.error('ERROR: --id is required'); process.exit(1); }
  const payload = {};
  if (options.remindAt) payload.remindAt = options.remindAt;
  if (options.note !== undefined) payload.note = options.note || null;
  await opFetch(`/reminders/${options.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  console.log(`✅ Reminder #${options.id} updated`);
}

async function cmdReminderDelete(options) {
  if (!options.id) { console.error('ERROR: --id is required'); process.exit(1); }
  if (!options.confirm) { console.error('ERROR: Delete requires --confirm flag'); process.exit(1); }
  await opFetch(`/reminders/${options.id}`, { method: 'DELETE' });
  console.log(`✅ Reminder #${options.id} deleted`);
}

// ── Project Status commands ──────────────────────────────────────────────────

async function cmdProjectStatusRead(options) {
  if (!options.id) { console.error('ERROR: --id is required'); process.exit(1); }
  const s = await opFetch(`/project_statuses/${options.id}`);
  console.log(`🚦 Project Status: ${s.name || s.id}`);
  if (s.color) console.log(`   Color: ${s.color}`);
}

// ── Project Phase commands (Enterprise) ──────────────────────────────────────

async function cmdProjectPhaseDefinitionList() {
  const resp = await opFetch('/project_phase_definitions');

  if (!resp._embedded.elements.length) {
    console.log('No project phase definitions found.');
    return;
  }

  for (const d of resp._embedded.elements) {
    const color = d.color || '';
    console.log(`  🔄  ID: ${String(d.id).padEnd(6)}  ${(d.name || '?').padEnd(25)}  ${color}`);
  }
  console.log(`\n${resp._embedded.elements.length} phase definition(s)`);
}

async function cmdProjectPhaseDefinitionRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const d = await opFetch(`/project_phase_definitions/${options.id}`);

  console.log(`🔄 Phase Definition #${d.id}: ${d.name || '?'}`);
  if (d.color) console.log(`   Color:       ${d.color}`);
  if (d.position !== undefined) console.log(`   Position:    ${d.position}`);
}

async function cmdProjectPhaseRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const p = await opFetch(`/project_phases/${options.id}`);

  console.log(`🔄 Project Phase #${p.id}`);
  console.log(`   Definition:  ${halLink(p, 'phaseDefinition') || '?'}`);
  console.log(`   Project:     ${halLink(p, 'project') || '?'}`);
  if (p.startDate) console.log(`   Start:       ${p.startDate}`);
  if (p.endDate) console.log(`   End:         ${p.endDate}`);
  console.log(`   Created:     ${p.createdAt?.substring(0, 10) || '?'}`);
}

// ── Portfolio commands (Enterprise) ──────────────────────────────────────────

async function cmdPortfolioList() {
  const resp = await opFetch(`/portfolios?pageSize=${CFG.maxResults}`);

  if (!resp._embedded.elements.length) {
    console.log('No portfolios found.');
    return;
  }

  for (const p of resp._embedded.elements) {
    console.log(`  📊  #${String(p.id).padEnd(6)}  ${p.name || p.title || '?'}`);
  }
  console.log(`\n${resp._embedded.elements.length} portfolio(s)`);
}

async function cmdPortfolioRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const p = await opFetch(`/portfolios/${options.id}`);

  console.log(`📊 Portfolio #${p.id}: ${p.name || p.title || '?'}`);
  if (p.description?.raw) console.log(`   Description: ${p.description.raw}`);
  console.log(`   Created:     ${p.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:     ${p.updatedAt?.substring(0, 10) || '?'}`);
}

async function cmdPortfolioUpdate(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const payload = {};
  if (options.name) payload.name = options.name;
  if (options.description) payload.description = { format: 'markdown', raw: options.description };

  await opFetch(`/portfolios/${options.id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Portfolio #${options.id} updated`);
}

async function cmdPortfolioDelete(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }
  if (!options.confirm) {
    console.error('ERROR: Delete requires --confirm flag for safety');
    process.exit(1);
  }

  await opFetch(`/portfolios/${options.id}`, { method: 'DELETE' });
  console.log(`✅ Portfolio #${options.id} deleted`);
}

// ── Program commands (Enterprise) ───────────────────────────────────────────

async function cmdProgramList() {
  const resp = await opFetch(`/programs?pageSize=${CFG.maxResults}`);

  if (!resp._embedded.elements.length) {
    console.log('No programs found.');
    return;
  }

  for (const p of resp._embedded.elements) {
    console.log(`  🏗️  #${String(p.id).padEnd(6)}  ${p.name || p.title || '?'}`);
  }
  console.log(`\n${resp._embedded.elements.length} program(s)`);
}

async function cmdProgramRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const p = await opFetch(`/programs/${options.id}`);

  console.log(`🏗️ Program #${p.id}: ${p.name || p.title || '?'}`);
  if (p.description?.raw) console.log(`   Description: ${p.description.raw}`);
  console.log(`   Created:     ${p.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:     ${p.updatedAt?.substring(0, 10) || '?'}`);
}

async function cmdProgramUpdate(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const payload = {};
  if (options.name) payload.name = options.name;
  if (options.description) payload.description = { format: 'markdown', raw: options.description };

  await opFetch(`/programs/${options.id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Program #${options.id} updated`);
}

async function cmdProgramDelete(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }
  if (!options.confirm) {
    console.error('ERROR: Delete requires --confirm flag for safety');
    process.exit(1);
  }

  await opFetch(`/programs/${options.id}`, { method: 'DELETE' });
  console.log(`✅ Program #${options.id} deleted`);
}

// ── Placeholder User commands (Enterprise) ──────────────────────────────────

async function cmdPlaceholderUserList() {
  const resp = await opFetch(`/placeholder_users?pageSize=${CFG.maxResults}`);

  if (!resp._embedded.elements.length) {
    console.log('No placeholder users found.');
    return;
  }

  for (const u of resp._embedded.elements) {
    const status = u.status || '?';
    console.log(`  👻  ID: ${String(u.id).padEnd(6)}  ${u.name.padEnd(25)}  [${status}]`);
  }
  console.log(`\n${resp._embedded.elements.length} placeholder user(s)`);
}

async function cmdPlaceholderUserRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const u = await opFetch(`/placeholder_users/${options.id}`);

  console.log(`👻 Placeholder User #${u.id}: ${u.name}`);
  console.log(`   Status:      ${u.status || '?'}`);
  console.log(`   Created:     ${u.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:     ${u.updatedAt?.substring(0, 10) || '?'}`);
}

async function cmdPlaceholderUserCreate(options) {
  if (!options.name) {
    console.error('ERROR: --name is required');
    process.exit(1);
  }

  const result = await opFetch('/placeholder_users', {
    method: 'POST',
    body: JSON.stringify({ name: options.name }),
  });

  console.log(`✅ Placeholder user created: ${result.name}`);
  console.log(`   ID: ${result.id}`);
}

async function cmdPlaceholderUserUpdate(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const payload = {};
  if (options.name) payload.name = options.name;

  await opFetch(`/placeholder_users/${options.id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Placeholder user #${options.id} updated`);
}

async function cmdPlaceholderUserDelete(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }
  if (!options.confirm) {
    console.error('ERROR: Delete requires --confirm flag for safety');
    process.exit(1);
  }

  await opFetch(`/placeholder_users/${options.id}`, { method: 'DELETE' });
  console.log(`✅ Placeholder user #${options.id} deleted`);
}

// ── Budget commands (Enterprise) ─────────────────────────────────────────────

async function cmdBudgetRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const b = await opFetch(`/budgets/${options.id}`);

  console.log(`💰 Budget #${b.id}: ${b.subject || '?'}`);
  console.log(`   Project:     ${halLink(b, 'project')}`);
  if (b.spent !== undefined) console.log(`   Spent:       ${b.spent}`);
  if (b.laborBudget !== undefined) console.log(`   Labor:       ${b.laborBudget}`);
  if (b.materialBudget !== undefined) console.log(`   Material:    ${b.materialBudget}`);
  if (b.overallCosts !== undefined) console.log(`   Overall:     ${b.overallCosts}`);
  console.log(`   Created:     ${b.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:     ${b.updatedAt?.substring(0, 10) || '?'}`);

  if (b.description?.raw) {
    console.log(`\n📝 Description:\n${b.description.raw}`);
  }
}

async function cmdBudgetList(options) {
  const project = options.project || CFG.defaultProject;
  if (!project) {
    console.error('ERROR: --project is required (or set OP_DEFAULT_PROJECT)');
    process.exit(1);
  }

  const resp = await opFetch(`/projects/${project}/budgets`);

  if (!resp._embedded.elements.length) {
    console.log('No budgets found.');
    return;
  }

  for (const b of resp._embedded.elements) {
    const spent = b.spent !== undefined ? `spent: ${b.spent}` : '';
    console.log(`  💰  #${String(b.id).padEnd(6)}  ${(b.subject || '?').padEnd(30)}  ${spent}`);
  }
  console.log(`\n${resp._embedded.elements.length} budget(s)`);
}

// ── Meeting commands (Enterprise) ────────────────────────────────────────────

async function cmdMeetingList(options) {
  const result = await opFetch(`/meetings?pageSize=${CFG.maxResults}&offset=${options.page || 1}`);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdMeetingWrite(options, create = false) {
  const payload = {};
  for (const field of ['title', 'location', 'startTime', 'duration', 'state', 'template', 'sharing', 'notify']) {
    if (options[field] !== undefined) payload[field] = options[field];
  }
  if (create) {
    payload._links = { project: { href: `/api/v3/projects/${await resolveProject(options.project)}` } };
    const meeting = await opFetch('/meetings', { method: 'POST', body: JSON.stringify(payload) });
    console.log(`✅ Created meeting: ${meeting.id}`);
  } else {
    await updateLocked(`/meetings/${options.id}`, payload);
    console.log(`✅ Updated meeting: ${options.id}`);
  }
}

const MEETING_CONTENT = {
  'agenda-item': 'meeting_agenda_items', outcome: 'meeting_outcomes', section: 'meeting_sections',
};

async function cmdMeetingContentList(options, kind) {
  const path = kind === 'outcome'
    ? `/meetings/${options.meetingId}/agenda_items/${options.agendaItemId}/outcomes`
    : `/meetings/${options.meetingId}/${kind === 'section' ? 'sections' : 'agenda_items'}`;
  console.log(JSON.stringify(await opFetch(path), null, 2));
}

async function cmdMeetingContentWrite(options, kind, create = false) {
  const payload = {};
  const links = {};
  if (options.title !== undefined) payload.title = options.title;
  if (options.notes !== undefined) payload.notes = { format: 'markdown', raw: options.notes };
  if (create) {
    if (kind === 'outcome') links.agendaItem = { href: `/api/v3/meeting_agenda_items/${options.agendaItemId}` };
    else links.meeting = { href: `/api/v3/meetings/${options.meetingId}` };
  }
  if (kind === 'agenda-item') {
    if (create && !options.title && (!options.wpId || options.wpId === 'none')) throw new Error('Provide --title or --wp-id for an agenda item');
    if (options.durationMinutes !== undefined) payload.durationInMinutes = options.durationMinutes === 'none' ? null : options.durationMinutes;
    for (const field of ['presenter', 'section']) {
      const value = options[`${field}Id`];
      if (value !== undefined) links[field] = { href: value === 'none' ? null : `/api/v3/${field === 'presenter' ? 'users' : 'meeting_sections'}/${value}` };
    }
  }
  if (kind === 'outcome') {
    if (create && options.notes === undefined && (!options.wpId || options.wpId === 'none')) throw new Error('Provide --notes or --wp-id for an outcome');
    if (options.kind !== undefined) payload.kind = options.kind;
    else if (create) payload.kind = 'information';
    if (options.kind === 'information' && options.wpId && options.wpId !== 'none') throw new Error('A work package outcome must use --kind work_package');
  }
  if (options.wpId !== undefined) {
    links.workPackage = { href: options.wpId === 'none' ? null : `/api/v3/work_packages/${options.wpId}` };
    payload[kind === 'outcome' ? 'kind' : 'itemType'] = options.wpId === 'none' ? (kind === 'outcome' ? 'information' : 'simple') : 'work_package';
  }
  if (Object.keys(links).length) payload._links = links;
  requireChanges(payload);
  const resource = MEETING_CONTENT[kind];
  let result;
  if (!create && kind === 'agenda-item') await updateLocked(`/${resource}/${options.id}`, payload);
  else result = await opFetch(create ? `/${resource}` : `/${resource}/${options.id}`, { method: create ? 'POST' : 'PATCH', body: JSON.stringify(payload) });
  console.log(`✅ ${create ? 'Created' : 'Updated'} meeting ${kind}: ${result?.id || options.id}`);
}

async function cmdMeetingRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const m = await opFetch(`/meetings/${options.id}`);
  if (options.json) { console.log(JSON.stringify(m, null, 2)); return; }

  console.log(`📅 Meeting #${m.id}: ${m.title || '?'}`);
  console.log(`   Type:        ${m._type || '?'}`);
  console.log(`   Project:     ${halLink(m, 'project')}`);
  console.log(`   Author:      ${halLink(m, 'author')}`);
  if (m.startTime) console.log(`   Start:       ${m.startTime}`);
  if (m.duration) console.log(`   Duration:    ${m.duration}`);
  if (m.location) console.log(`   Location:    ${m.location}`);
  console.log(`   Created:     ${m.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:     ${m.updatedAt?.substring(0, 10) || '?'}`);
}

async function cmdMeetingAttachmentList(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const resp = await opFetch(`/meetings/${options.id}/attachments`);

  if (!resp._embedded.elements.length) {
    console.log('No attachments on this meeting.');
    return;
  }

  for (const a of resp._embedded.elements) {
    const size = `${(a.fileSize / 1024).toFixed(1)} KB`;
    const created = a.createdAt?.substring(0, 10) || '';
    const author = halLink(a, 'author');
    console.log(`📎  #${String(a.id).padEnd(8)}  ${a.fileName.padEnd(30)}  ${size.padStart(12)}  ${created}  ${author}`);
  }
  console.log(`\n${resp._embedded.elements.length} attachment(s)`);
}

async function cmdMeetingAttachmentAdd(options) {
  if (!options.id || !options.file) {
    console.error('ERROR: --id and --file are required');
    process.exit(1);
  }

  const filePath = resolve(safePath(options.file) || options.file);
  checkFileSize(filePath);

  const fileContent = readFileSync(filePath);
  const fileName = basename(filePath);

  const form = new FormData();
  form.append('file', new Blob([fileContent]), fileName);
  form.append('metadata', JSON.stringify({ fileName, description: { format: 'plain', raw: '' } }));

  const url = `${baseUrl()}/meetings/${options.id}/attachments`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': authHeader() },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text();
    let json;
    try { json = JSON.parse(body); } catch { json = null; }
    const msg = json?.message || json?.errorIdentifier || body;
    console.error(`ERROR (${resp.status}): ${msg}`);
    process.exit(1);
  }

  const result = await resp.json();
  console.log(`✅ Attachment uploaded to meeting #${options.id}`);
  console.log(`   File: ${result.fileName}`);
  console.log(`   ID: ${result.id}`);
}

// ── Days commands ────────────────────────────────────────────────────────────

async function cmdDayRead(options) {
  if (!options.date) {
    console.error('ERROR: --date is required (YYYY-MM-DD)');
    process.exit(1);
  }

  const d = await opFetch(`/days/${options.date}`);

  const working = d.working ? '✅ Working day' : '❌ Non-working day';
  console.log(`📅 ${d.date}: ${working}`);
  if (d.name) console.log(`   Name: ${d.name}`);
}

async function cmdDaysList(options) {
  const from = options.from || new Date().toISOString().substring(0, 10);
  const to = options.to;

  let url = `/days?filters=[{"date":{"operator":">d","values":["${from}"`;
  if (to) url += `,"${to}"`;
  url += ']}}]&pageSize=31';

  const resp = await opFetch(url);

  if (!resp._embedded.elements.length) {
    console.log('No days found in range.');
    return;
  }

  for (const d of resp._embedded.elements) {
    const working = d.working ? '✅' : '❌';
    const name = d.name ? `  (${d.name})` : '';
    console.log(`  ${working}  ${d.date}${name}`);
  }
  console.log(`\n${resp._embedded.elements.length} day(s)`);
}

async function cmdNonWorkingDaysList() {
  const resp = await opFetch(`/days/non_working?pageSize=${CFG.maxResults}`);

  if (!resp._embedded.elements.length) {
    console.log('No non-working days configured.');
    return;
  }

  for (const d of resp._embedded.elements) {
    const name = d.name || '';
    console.log(`  🚫  ${d.date}  ${name}`);
  }
  console.log(`\n${resp._embedded.elements.length} non-working day(s)`);
}

async function cmdNonWorkingDayRead(options) {
  if (!options.date) {
    console.error('ERROR: --date is required (YYYY-MM-DD)');
    process.exit(1);
  }

  const d = await opFetch(`/days/non_working/${options.date}`);

  console.log(`🚫 Non-Working Day: ${d.date}`);
  if (d.name) console.log(`   Name: ${d.name}`);
}

async function cmdWeekDaysList() {
  const resp = await opFetch('/days/week');

  for (const d of resp._embedded.elements) {
    const working = d.working ? '✅' : '❌';
    const dayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const name = dayNames[d.day] || `Day ${d.day}`;
    console.log(`  ${working}  ${name} (${d.day})`);
  }
}

async function cmdWeekDayRead(options) {
  if (!options.day) {
    console.error('ERROR: --day is required (1=Monday ... 7=Sunday)');
    process.exit(1);
  }

  const d = await opFetch(`/days/week/${options.day}`);

  const working = d.working ? '✅ Working day' : '❌ Non-working day';
  const dayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const name = dayNames[d.day] || `Day ${d.day}`;
  console.log(`📅 ${name}: ${working}`);
}

// ── Configuration commands ───────────────────────────────────────────────────

async function cmdConfigRead() {
  const cfg = await opFetch('/configuration');

  console.log('⚙️ Instance Configuration');
  if (cfg.maximumAttachmentFileSize) console.log(`   Max attachment size: ${cfg.maximumAttachmentFileSize} bytes`);
  if (cfg.perPageOptions) console.log(`   Per-page options:   ${JSON.stringify(cfg.perPageOptions)}`);
  if (cfg.dateFormat) console.log(`   Date format:        ${cfg.dateFormat}`);
  if (cfg.timeFormat) console.log(`   Time format:        ${cfg.timeFormat}`);
  if (cfg.startOfWeek !== undefined) console.log(`   Start of week:      ${cfg.startOfWeek}`);
  if (cfg.activeFeatureFlags?.length) console.log(`   Feature flags:      ${cfg.activeFeatureFlags.join(', ')}`);

  // Print remaining keys
  const shown = ['_type', '_links', 'maximumAttachmentFileSize', 'perPageOptions', 'dateFormat', 'timeFormat', 'startOfWeek', 'activeFeatureFlags'];
  const remaining = Object.entries(cfg).filter(([k]) => !shown.includes(k));
  for (const [key, val] of remaining) {
    const display = typeof val === 'object' ? JSON.stringify(val) : val;
    console.log(`   ${key}: ${display}`);
  }
}

async function cmdProjectConfigRead(options) {
  const project = options.project || CFG.defaultProject;
  if (!project) {
    console.error('ERROR: --project is required (or set OP_DEFAULT_PROJECT)');
    process.exit(1);
  }

  const cfg = await opFetch(`/projects/${project}/configuration`);

  console.log(`⚙️ Project Configuration: ${project}`);
  const skip = ['_type', '_links'];
  for (const [key, val] of Object.entries(cfg)) {
    if (skip.includes(key)) continue;
    const display = typeof val === 'object' ? JSON.stringify(val) : val;
    console.log(`   ${key}: ${display}`);
  }
}

// ── OAuth commands ───────────────────────────────────────────────────────────

async function cmdOauthAppRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const app = await opFetch(`/oauth_applications/${options.id}`);

  console.log(`🔐 OAuth Application #${app.id}`);
  console.log(`   Name:            ${app.name || '?'}`);
  console.log(`   Client ID:       ${app.clientId || '?'}`);
  console.log(`   Confidential:    ${app.confidential ?? '?'}`);
  if (app.redirectUri) console.log(`   Redirect URI:    ${app.redirectUri}`);
  console.log(`   Created:         ${app.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:         ${app.updatedAt?.substring(0, 10) || '?'}`);
}

async function cmdOauthCredentialsRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const cred = await opFetch(`/oauth_client_credentials/${options.id}`);

  console.log(`🔑 OAuth Client Credentials #${cred.id}`);
  console.log(`   Client ID:       ${cred.clientId || '?'}`);
  console.log(`   Confidential:    ${cred.confidential ?? '?'}`);
  console.log(`   Created:         ${cred.createdAt?.substring(0, 10) || '?'}`);
}

// ── Help Text commands ───────────────────────────────────────────────────────

async function cmdHelpTextList() {
  const resp = await opFetch('/help_texts');

  if (!resp._embedded.elements.length) {
    console.log('No help texts found.');
    return;
  }

  for (const h of resp._embedded.elements) {
    const attr = h.attribute || '?';
    const text = h.helpText?.raw?.substring(0, 80) || '';
    console.log(`  ❓  ID: ${String(h.id).padEnd(6)}  ${attr.padEnd(25)}  ${text}${text.length >= 80 ? '...' : ''}`);
  }
  console.log(`\n${resp._embedded.elements.length} help text(s)`);
}

async function cmdHelpTextRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const h = await opFetch(`/help_texts/${options.id}`);

  console.log(`❓ Help Text #${h.id}`);
  console.log(`   Attribute:   ${h.attribute || '?'}`);
  console.log(`   Scope:       ${h.scope || '?'}`);

  if (h.helpText?.raw) {
    console.log(`\n📝 Text:\n${h.helpText.raw}`);
  }
}

// ── Custom Field commands ────────────────────────────────────────────────────

async function cmdCustomFieldItems(options) {
  if (!options.id) {
    console.error('ERROR: --id is required (custom field ID)');
    process.exit(1);
  }

  const resp = await opFetch(`/custom_fields/${options.id}/items`);

  if (!resp._embedded?.elements?.length) {
    console.log('No items found for this custom field.');
    return;
  }

  for (const item of resp._embedded.elements) {
    const indent = item._links?.parent?.href ? '  ' : '';
    console.log(`${indent}  🏷️  ID: ${String(item.id).padEnd(6)}  ${item.value || item.name || '?'}`);
  }
  console.log(`\n${resp._embedded.elements.length} item(s)`);
}

async function cmdCustomFieldItemRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required (custom field item ID)');
    process.exit(1);
  }

  const item = await opFetch(`/custom_field_items/${options.id}`);

  console.log(`🏷️ Custom Field Item #${item.id}`);
  console.log(`   Value:       ${item.value || item.name || '?'}`);
  if (item._links?.parent?.href) {
    const parentId = item._links.parent.href.split('/').pop();
    console.log(`   Parent:      #${parentId}`);
  }
}

async function cmdCustomFieldItemBranch(options) {
  if (!options.id) {
    console.error('ERROR: --id is required (custom field item ID)');
    process.exit(1);
  }

  const resp = await opFetch(`/custom_field_items/${options.id}/branch`);

  if (!resp._embedded?.elements?.length) {
    console.log('No branch items found.');
    return;
  }

  for (const item of resp._embedded.elements) {
    console.log(`  🏷️  ID: ${String(item.id).padEnd(6)}  ${item.value || item.name || '?'}`);
  }
  console.log(`\n${resp._embedded.elements.length} item(s) in branch`);
}

async function cmdCustomOptionRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const opt = await opFetch(`/custom_options/${options.id}`);

  console.log(`🔘 Custom Option #${opt.id}`);
  console.log(`   Value:       ${opt.value || '?'}`);
}

// ── Custom Action commands ───────────────────────────────────────────────────

async function cmdCustomActionRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const ca = await opFetch(`/custom_actions/${options.id}`);

  console.log(`⚡ Custom Action #${ca.id}: ${ca.name || '?'}`);
  if (ca.description) console.log(`   Description: ${ca.description}`);
}

async function cmdCustomActionExecute(options) {
  if (!options.id || !options.wpId) {
    console.error('ERROR: --id and --wp-id are required');
    process.exit(1);
  }

  // Get current work package for lockVersion
  const wp = await opFetch(`/work_packages/${options.wpId}`);

  await opFetch(`/custom_actions/${options.id}/execute`, {
    method: 'POST',
    body: JSON.stringify({
      lockVersion: wp.lockVersion,
      _links: {
        workPackage: { href: `/api/v3/work_packages/${options.wpId}` },
      },
    }),
  });

  console.log(`✅ Custom action #${options.id} executed on WP#${options.wpId}`);
}

// ── Group commands ───────────────────────────────────────────────────────────

async function cmdGroupList() {
  const resp = await opFetch(`/groups?pageSize=${CFG.maxResults}`);

  if (!resp._embedded.elements.length) {
    console.log('No groups found.');
    return;
  }

  for (const g of resp._embedded.elements) {
    const memberCount = g._embedded?.members?.length ?? '?';
    console.log(`  👥  ID: ${String(g.id).padEnd(6)}  ${g.name.padEnd(30)}  ${memberCount} member(s)`);
  }
  console.log(`\n${resp._embedded.elements.length} group(s)`);
}

async function cmdGroupRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const g = await opFetch(`/groups/${options.id}`);

  console.log(`👥 ${g.name}`);
  console.log(`   ID:          ${g.id}`);
  console.log(`   Created:     ${g.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:     ${g.updatedAt?.substring(0, 10) || '?'}`);

  const members = g._embedded?.members || [];
  if (members.length) {
    console.log(`\n   Members (${members.length}):`);
    for (const m of members) {
      const login = m.login ? ` (${m.login})` : '';
      console.log(`     👤  ID: ${String(m.id).padEnd(6)}  ${m.name}${login}`);
    }
  } else {
    console.log('   Members:     none');
  }
}

async function cmdGroupCreate(options) {
  if (!options.name) {
    console.error('ERROR: --name is required');
    process.exit(1);
  }

  const payload = { name: options.name };

  if (options.members) {
    const ids = options.members.split(',').map(id => id.trim());
    payload._links = {
      members: ids.map(id => ({ href: `/api/v3/users/${id}` })),
    };
  }

  const result = await opFetch('/groups', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Group created: ${result.name}`);
  console.log(`   ID: ${result.id}`);
}

async function cmdGroupUpdate(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const payload = {};
  if (options.name) payload.name = options.name;

  if (options.members) {
    const ids = options.members.split(',').map(id => id.trim());
    payload._links = {
      members: ids.map(id => ({ href: `/api/v3/users/${id}` })),
    };
  }

  await opFetch(`/groups/${options.id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Group #${options.id} updated`);
}

async function cmdGroupDelete(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }
  if (!options.confirm) {
    console.error('ERROR: Delete requires --confirm flag for safety');
    process.exit(1);
  }

  await opFetch(`/groups/${options.id}`, { method: 'DELETE' });
  console.log(`✅ Group #${options.id} deleted`);
}

// ── News commands ────────────────────────────────────────────────────────────

async function cmdNewsList(options) {
  const resp = await opFetch(`/news?pageSize=${CFG.maxResults}&sortBy=[["createdAt","desc"]]`);

  if (!resp._embedded.elements.length) {
    console.log('No news found.');
    return;
  }

  for (const n of resp._embedded.elements) {
    const author = halLink(n, 'author');
    const project = halLink(n, 'project');
    const created = n.createdAt?.substring(0, 10) || '?';
    const summary = n.summary ? `  ${n.summary.substring(0, 60)}${n.summary.length > 60 ? '...' : ''}` : '';
    console.log(`📰  #${String(n.id).padEnd(6)}  ${project.padEnd(20)}  ${created}  ${author.padEnd(20)}  ${n.title}${summary}`);
  }
  console.log(`\n${resp._embedded.elements.length} of ${resp.total} news item(s)`);
}

async function cmdNewsRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const n = await opFetch(`/news/${options.id}`);

  console.log(`📰 #${n.id}: ${n.title}`);
  console.log(`   Project:     ${halLink(n, 'project')}`);
  console.log(`   Author:      ${halLink(n, 'author')}`);
  console.log(`   Created:     ${n.createdAt?.substring(0, 10) || '?'}`);
  if (n.summary) console.log(`   Summary:     ${n.summary}`);

  if (n.description?.raw) {
    console.log(`\n📝 Description:\n${n.description.raw}`);
  }
}

async function cmdNewsCreate(options) {
  const project = options.project || CFG.defaultProject;
  if (!project) {
    console.error('ERROR: --project is required (or set OP_DEFAULT_PROJECT)');
    process.exit(1);
  }
  if (!options.title) {
    console.error('ERROR: --title is required');
    process.exit(1);
  }

  // Resolve project to numeric ID
  const projResp = await opFetch(`/projects/${project}`);

  const payload = {
    title: options.title,
    _links: {
      project: { href: `/api/v3/projects/${projResp.id}` },
    },
  };

  if (options.summary) payload.summary = options.summary;
  if (options.description) payload.description = { format: 'markdown', raw: options.description };

  const result = await opFetch('/news', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  console.log(`✅ News created: #${result.id} — ${result.title}`);
}

async function cmdNewsUpdate(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const payload = {};
  if (options.title) payload.title = options.title;
  if (options.summary !== undefined) payload.summary = options.summary;
  if (options.description) payload.description = { format: 'markdown', raw: options.description };

  await opFetch(`/news/${options.id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

  console.log(`✅ News #${options.id} updated`);
}

async function cmdNewsDelete(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }
  if (!options.confirm) {
    console.error('ERROR: Delete requires --confirm flag for safety');
    console.error('Usage: openproject news-delete --id 5 --confirm');
    process.exit(1);
  }

  await opFetch(`/news/${options.id}`, { method: 'DELETE' });
  console.log(`✅ News #${options.id} deleted`);
}

// ── Watcher commands ─────────────────────────────────────────────────────────

async function cmdWatcherList(options) {
  if (!options.wpId) {
    console.error('ERROR: --wp-id is required');
    process.exit(1);
  }

  const resp = await opFetch(`/work_packages/${options.wpId}/watchers`);

  if (!resp._embedded.elements.length) {
    console.log('No watchers on this work package.');
    return;
  }

  for (const u of resp._embedded.elements) {
    const login = u.login ? ` (${u.login})` : '';
    const email = u.email ? `  ${u.email}` : '';
    console.log(`  👁️  ID: ${String(u.id).padEnd(6)}  ${u.name}${login}${email}`);
  }
  console.log(`\n${resp._embedded.elements.length} watcher(s)`);
}

async function cmdWatcherAdd(options) {
  if (!options.wpId || !options.userId) {
    console.error('ERROR: --wp-id and --user-id are required');
    process.exit(1);
  }

  await opFetch(`/work_packages/${options.wpId}/watchers`, {
    method: 'POST',
    body: JSON.stringify({
      user: { href: `/api/v3/users/${options.userId}` },
    }),
  });

  console.log(`✅ User #${options.userId} added as watcher on WP#${options.wpId}`);
}

async function cmdWatcherRemove(options) {
  if (!options.wpId || !options.userId) {
    console.error('ERROR: --wp-id and --user-id are required');
    process.exit(1);
  }

  await opFetch(`/work_packages/${options.wpId}/watchers/${options.userId}`, {
    method: 'DELETE',
  });

  console.log(`✅ User #${options.userId} removed as watcher from WP#${options.wpId}`);
}

async function cmdWatcherAvailable(options) {
  if (!options.wpId) {
    console.error('ERROR: --wp-id is required');
    process.exit(1);
  }

  const resp = await opFetch(`/work_packages/${options.wpId}/available_watchers`);

  if (!resp._embedded.elements.length) {
    console.log('No available watchers.');
    return;
  }

  for (const u of resp._embedded.elements) {
    const login = u.login ? ` (${u.login})` : '';
    console.log(`  👤  ID: ${String(u.id).padEnd(6)}  ${u.name}${login}`);
  }
  console.log(`\n${resp._embedded.elements.length} available watcher(s)`);
}

// ── Notification commands ────────────────────────────────────────────────────

function reasonEmoji(reason) {
  const map = {
    assigned: '👤', commented: '💬', created: '🆕', dateAlert: '📅',
    mentioned: '📣', prioritized: '⚡', processed: '⚙️', responsible: '🎯',
    subscribed: '🔔', scheduled: '🗓️', watched: '👁️',
  };
  return map[reason] || '🔔';
}

async function cmdNotificationList(options) {
  const filters = [];

  if (options.reason) {
    filters.push({ reason: { operator: '=', values: [options.reason] } });
  }
  if (options.project) {
    filters.push({ project: { operator: '=', values: [options.project] } });
  }
  if (options.unread) {
    filters.push({ readIAN: { operator: '=', values: ['f'] } });
  }
  if (options.wpId) {
    filters.push({ resourceId: { operator: '=', values: [options.wpId] } });
  }

  const filterParam = filters.length ? `&filters=${encodeURIComponent(JSON.stringify(filters))}` : '';
  const resp = await opFetch(`/notifications?pageSize=${CFG.maxResults}${filterParam}&sortBy=[["createdAt","desc"]]`);

  if (!resp._embedded.elements.length) {
    console.log('No notifications found.');
    return;
  }

  for (const n of resp._embedded.elements) {
    const emoji = reasonEmoji(n.reason);
    const read = n.readIAN ? '  ' : '🔵';
    const actor = halLink(n, 'actor');
    const resource = halLink(n, 'resource');
    const project = halLink(n, 'project');
    const created = n.createdAt?.substring(0, 16).replace('T', ' ') || '?';
    console.log(`${read} ${emoji}  #${String(n.id).padEnd(8)}  ${n.reason.padEnd(12)}  ${actor.padEnd(20)}  ${resource.padEnd(30)}  ${project}  ${created}`);
  }

  const unreadCount = resp._embedded.elements.filter(n => !n.readIAN).length;
  console.log(`\n${resp._embedded.elements.length} of ${resp.total} notification(s)${unreadCount ? ` (${unreadCount} unread)` : ''}`);
}

async function cmdNotificationRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const n = await opFetch(`/notifications/${options.id}`);

  const emoji = reasonEmoji(n.reason);
  console.log(`${emoji} Notification #${n.id}`);
  console.log(`   Reason:      ${n.reason}`);
  console.log(`   Read:        ${n.readIAN ? 'Yes' : 'No'}`);
  console.log(`   Actor:       ${halLink(n, 'actor')}`);
  console.log(`   Resource:    ${halLink(n, 'resource')}`);
  console.log(`   Project:     ${halLink(n, 'project')}`);
  console.log(`   Created:     ${n.createdAt?.substring(0, 16).replace('T', ' ') || '?'}`);
  console.log(`   Updated:     ${n.updatedAt?.substring(0, 16).replace('T', ' ') || '?'}`);
}

async function cmdNotificationMarkRead(options) {
  if (options.all) {
    const filters = [];
    if (options.project) {
      filters.push({ project: { operator: '=', values: [options.project] } });
    }
    const filterParam = filters.length ? `?filters=${encodeURIComponent(JSON.stringify(filters))}` : '';
    await opFetch(`/notifications/read_ian${filterParam}`, { method: 'POST' });
    console.log('✅ All matching notifications marked as read');
  } else if (options.id) {
    await opFetch(`/notifications/${options.id}/read_ian`, { method: 'POST' });
    console.log(`✅ Notification #${options.id} marked as read`);
  } else {
    console.error('ERROR: --id or --all is required');
    process.exit(1);
  }
}

async function cmdNotificationMarkUnread(options) {
  if (options.all) {
    const filters = [];
    if (options.project) {
      filters.push({ project: { operator: '=', values: [options.project] } });
    }
    const filterParam = filters.length ? `?filters=${encodeURIComponent(JSON.stringify(filters))}` : '';
    await opFetch(`/notifications/unread_ian${filterParam}`, { method: 'POST' });
    console.log('✅ All matching notifications marked as unread');
  } else if (options.id) {
    await opFetch(`/notifications/${options.id}/unread_ian`, { method: 'POST' });
    console.log(`✅ Notification #${options.id} marked as unread`);
  } else {
    console.error('ERROR: --id or --all is required');
    process.exit(1);
  }
}

// ── User commands ────────────────────────────────────────────────────────────

async function cmdUserList(options) {
  const filters = [];

  if (options.status) {
    const statusMap = {
      active: '0', registered: '1', locked: '2', invited: '4',
    };
    const val = statusMap[options.status.toLowerCase()] || options.status;
    filters.push({ status: { operator: '=', values: [val] } });
  }
  if (options.name) {
    filters.push({ name: { operator: '~', values: [options.name] } });
  }
  if (options.group) {
    filters.push({ group: { operator: '=', values: [options.group] } });
  }

  const filterParam = filters.length ? `&filters=${encodeURIComponent(JSON.stringify(filters))}` : '';
  const resp = await opFetch(`/users?pageSize=${CFG.maxResults}${filterParam}&sortBy=[["name","asc"]]`);

  if (!resp._embedded.elements.length) {
    console.log('No users found.');
    return;
  }

  for (const u of resp._embedded.elements) {
    const status = u.status || '?';
    const admin = u.admin ? ' 👑' : '';
    const email = u.email ? `  ${u.email}` : '';
    const login = u.login ? ` (${u.login})` : '';
    console.log(`  👤  ID: ${String(u.id).padEnd(6)}  ${u.name || `${u.firstName} ${u.lastName}`}${login}${admin}  [${status}]${email}`);
  }
  console.log(`\n${resp._embedded.elements.length} of ${resp.total} user(s)`);
}

async function cmdUserRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required (numeric user ID or "me")');
    process.exit(1);
  }

  const u = await opFetch(`/users/${options.id}`);

  console.log(`👤 ${u.name || `${u.firstName} ${u.lastName}`}`);
  console.log(`   ID:          ${u.id}`);
  if (u.login) console.log(`   Login:       ${u.login}`);
  if (u.email) console.log(`   Email:       ${u.email}`);
  console.log(`   Status:      ${u.status || '?'}`);
  console.log(`   Admin:       ${u.admin ? 'Yes' : 'No'}`);
  if (u.language) console.log(`   Language:    ${u.language}`);
  console.log(`   Created:     ${u.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:     ${u.updatedAt?.substring(0, 10) || '?'}`);
  if (u.avatar) console.log(`   Avatar:      ${u.avatar}`);
}

async function cmdUserMe() {
  const u = await opFetch('/users/me');

  console.log(`👤 ${u.name || `${u.firstName} ${u.lastName}`}`);
  console.log(`   ID:          ${u.id}`);
  if (u.login) console.log(`   Login:       ${u.login}`);
  if (u.email) console.log(`   Email:       ${u.email}`);
  console.log(`   Status:      ${u.status || '?'}`);
  console.log(`   Admin:       ${u.admin ? 'Yes' : 'No'}`);
  if (u.language) console.log(`   Language:    ${u.language}`);
  console.log(`   Created:     ${u.createdAt?.substring(0, 10) || '?'}`);
  console.log(`   Updated:     ${u.updatedAt?.substring(0, 10) || '?'}`);
}

async function cmdUserWrite(options, create = false) {
  const payload = {};
  for (const field of ['email', 'login', 'firstName', 'lastName', 'admin', 'language']) {
    if (options[field] !== undefined) payload[field] = options[field];
  }
  if (create) {
    payload.status = options.status;
    if (options.status === 'active') {
      for (const field of ['login', 'firstName', 'lastName']) if (!options[field]) throw new Error(`Active user creation requires --${field.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`);
      payload.password = envSecret(options.passwordEnv || 'OP_NEW_USER_PASSWORD');
    } else if (options.passwordEnv) throw new Error('Use --status active with --password-env');
  } else if (options.passwordEnv) {
    if (options.id !== 'me') throw new Error('Use --id me for password changes');
    payload.password = envSecret(options.passwordEnv);
    payload.currentPassword = envSecret(options.currentPasswordEnv || 'OP_CURRENT_PASSWORD');
  } else if (options.currentPasswordEnv) throw new Error('--current-password-env requires --password-env');
  requireChanges(payload);
  const result = await opFetch(create ? '/users' : `/users/${options.id}`, { method: create ? 'POST' : 'PATCH', body: JSON.stringify(payload) });
  console.log(`✅ ${create ? 'Created' : 'Updated'} user: ${result?.id || options.id}`);
}

async function cmdUserLock(options, unlock = false) {
  await opFetch(`/users/${options.id}/lock`, { method: unlock ? 'DELETE' : 'POST' });
  console.log(`✅ ${unlock ? 'Unlocked' : 'Locked'} user: ${options.id}`);
}

// ── Relation commands ────────────────────────────────────────────────────────

const RELATION_TYPES = [
  'relates', 'duplicates', 'duplicated', 'blocks', 'blocked',
  'precedes', 'follows', 'includes', 'partof', 'requires', 'required',
];

function relationEmoji(type) {
  const map = {
    relates: '🔗', duplicates: '♊', duplicated: '♊',
    blocks: '🚫', blocked: '🚫', precedes: '⏩', follows: '⏪',
    includes: '📦', partof: '🧩', requires: '⚙️', required: '⚙️',
  };
  return map[type] || '🔗';
}

async function cmdRelationList(options) {
  const filters = [];

  if (options.wpId) {
    filters.push({ involved: { operator: '=', values: [options.wpId] } });
  }
  if (options.type) {
    filters.push({ type: { operator: '=', values: [options.type] } });
  }

  const filterParam = filters.length ? `&filters=${encodeURIComponent(JSON.stringify(filters))}` : '';
  const resp = await opFetch(`/relations?pageSize=${CFG.maxResults}${filterParam}`);

  if (!resp._embedded.elements.length) {
    console.log('No relations found.');
    return;
  }

  for (const r of resp._embedded.elements) {
    const fromId = halId(r, 'from') || '?';
    const toId = halId(r, 'to') || '?';
    const emoji = relationEmoji(r.type);
    const desc = r.description ? `  "${r.description}"` : '';
    const lag = r.lag ? `  (lag: ${r.lag}d)` : '';
    console.log(`${emoji}  #${String(r.id).padEnd(6)}  WP#${fromId} → ${r.type} → WP#${toId}${lag}${desc}`);
  }
  console.log(`\n${resp._embedded.elements.length} relation(s)`);
}

async function cmdRelationRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const r = await opFetch(`/relations/${options.id}`);

  const fromId = halId(r, 'from') || '?';
  const toId = halId(r, 'to') || '?';
  const emoji = relationEmoji(r.type);

  console.log(`${emoji} Relation #${r.id}`);
  console.log(`   Type:        ${r.type}`);
  console.log(`   From:        WP#${fromId}`);
  console.log(`   To:          WP#${toId}`);
  if (r.lag != null) console.log(`   Lag:         ${r.lag} day(s)`);
  if (r.description) console.log(`   Description: ${r.description}`);
  if (r.reverseType) console.log(`   Reverse:     ${r.reverseType}`);
}

async function cmdRelationCreate(options) {
  if (!options.wpId || !options.toWpId || !options.type) {
    console.error('ERROR: --wp-id, --to-wp-id, and --type are required');
    process.exit(1);
  }

  const type = options.type.toLowerCase();
  if (!RELATION_TYPES.includes(type)) {
    console.error(`ERROR: Invalid type "${options.type}". Must be one of: ${RELATION_TYPES.join(', ')}`);
    process.exit(1);
  }

  const payload = {
    type,
    _links: {
      to: { href: `/api/v3/work_packages/${options.toWpId}` },
    },
  };

  if (options.description) payload.description = options.description;
  if (options.lag !== undefined) payload.lag = parseInt(options.lag, 10);

  const result = await opFetch(`/work_packages/${options.wpId}/relations`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Relation created: WP#${options.wpId} ${type} WP#${options.toWpId}`);
  console.log(`   ID: ${result.id}`);
}

async function cmdRelationUpdate(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }

  const payload = {};
  if (options.type) {
    const type = options.type.toLowerCase();
    if (!RELATION_TYPES.includes(type)) {
      console.error(`ERROR: Invalid type "${options.type}". Must be one of: ${RELATION_TYPES.join(', ')}`);
      process.exit(1);
    }
    payload.type = type;
  }
  if (options.description !== undefined) payload.description = options.description || null;
  if (options.lag !== undefined) payload.lag = parseInt(options.lag, 10);

  await opFetch(`/relations/${options.id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Relation #${options.id} updated`);
}

async function cmdRelationDelete(options) {
  if (!options.id) {
    console.error('ERROR: --id is required');
    process.exit(1);
  }
  if (!options.confirm) {
    console.error('ERROR: Delete requires --confirm flag for safety');
    console.error('Usage: openproject relation-delete --id 5 --confirm');
    process.exit(1);
  }

  await opFetch(`/relations/${options.id}`, { method: 'DELETE' });
  console.log(`✅ Relation #${options.id} deleted`);
}

// ── Wiki Page commands ──────────────────────────────────────────────────────

async function cmdWikiRead(options) {
  if (!options.id) {
    console.error('ERROR: --id is required (wiki page numeric ID)');
    process.exit(1);
  }

  const wp = await opFetch(`/wiki_pages/${options.id}`);

  console.log(`📖 Wiki Page #${wp.id}: ${wp.title}`);
  console.log(`   Project:     ${halLink(wp, 'project')}`);
  console.log(`   URL:         ${CFG.host}/wiki/${wp.id}`);

  if (wp._links?.attachments?.href) {
    console.log(`   Attachments: ${wp._links.attachments.href}`);
  }
}

async function cmdWikiAttachmentList(options) {
  if (!options.id) {
    console.error('ERROR: --id is required (wiki page numeric ID)');
    process.exit(1);
  }

  const resp = await opFetch(`/wiki_pages/${options.id}/attachments`);

  if (!resp._embedded.elements.length) {
    console.log('No attachments on this wiki page.');
    return;
  }

  for (const a of resp._embedded.elements) {
    const size = `${(a.fileSize / 1024).toFixed(1)} KB`;
    const created = a.createdAt?.substring(0, 10) || '';
    const author = halLink(a, 'author');
    console.log(`📎  #${String(a.id).padEnd(8)}  ${a.fileName.padEnd(30)}  ${size.padStart(12)}  ${created}  ${author}`);
  }
  console.log(`\n${resp._embedded.elements.length} attachment(s)`);
}

async function cmdWikiAttachmentAdd(options) {
  if (!options.id || !options.file) {
    console.error('ERROR: --id and --file are required');
    process.exit(1);
  }

  const filePath = resolve(safePath(options.file) || options.file);
  checkFileSize(filePath);

  const fileContent = readFileSync(filePath);
  const fileName = basename(filePath);

  const form = new FormData();
  form.append('file', new Blob([fileContent]), fileName);
  form.append('metadata', JSON.stringify({ fileName, description: { format: 'plain', raw: '' } }));

  const url = `${baseUrl()}/wiki_pages/${options.id}/attachments`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': authHeader() },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text();
    let json;
    try { json = JSON.parse(body); } catch { json = null; }
    const msg = json?.message || json?.errorIdentifier || body;
    console.error(`ERROR (${resp.status}): ${msg}`);
    process.exit(1);
  }

  const result = await resp.json();
  console.log(`✅ Attachment uploaded to wiki page #${options.id}`);
  console.log(`   File: ${result.fileName}`);
  console.log(`   Size: ${(result.fileSize / 1024).toFixed(1)} KB`);
  console.log(`   ID: ${result.id}`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('openproject')
  .description('OpenClaw OpenProject Skill — project management via API v3')
  .version('2.1.0');

// Work Packages
program.command('wp-list').description('List work packages')
  .option('-p, --project <id>', 'Project identifier')
  .option('-s, --status <name>', 'Filter by exact status name or ID')
  .option('--open', 'Show only open work packages (any non-closed status)')
  .option('--closed', 'Show only closed work packages')
  .option('-a, --assignee <user>', 'Filter by assignee ("me" or user ID)')
  .option('-t, --type <name>', 'Filter by type name or ID')
  .option('--json', 'Output all matching work packages as JSON (paginated; incl. start/due dates + description)')
  .action(wrap(cmdWpList));

program.command('wp-create').description('Create a work package')
  .option('-p, --project <id>', 'Project identifier')
  .requiredOption('-s, --subject <text>', 'Work package subject')
  .option('-d, --description <text>', 'Description (markdown)')
  .option('-t, --type <name>', 'Type name or ID (Task, Bug, Feature...)')
  .option('--priority <name>', 'Priority name or ID')
  .option('--status <name>', 'Initial status name or ID')
  .option('--assignee <id>', 'Assignee user ID', value => numericId(value, 'Assignee'))
  .option('--start-date <date>', 'Start date (YYYY-MM-DD, or none)', nullableDate)
  .option('--due-date <date>', 'Due date (YYYY-MM-DD, or none)', nullableDate)
  .option('--date <date>', 'Milestone date (YYYY-MM-DD, or none)', nullableDate)
  .option('--estimate <duration>', 'Estimated time (e.g. PT2H30M, or none)', nullableDuration)
  .action(wrap(cmdWpCreate));

program.command('wp-read').description('Read work package details')
  .requiredOption('--id <id>', 'Work package ID', numericId)
  .option('--json', 'Output the work package as JSON (incl. start/due dates + description)')
  .action(wrap(cmdWpRead));

program.command('wp-update').description('Update a work package')
  .requiredOption('--id <id>', 'Work package ID', numericId)
  .option('-s, --subject <text>', 'New subject')
  .option('-d, --description <text>', 'New description')
  .option('--status <name>', 'New status name or ID')
  .option('--priority <name>', 'New priority name or ID')
  .option('-t, --type <name>', 'New type name or ID')
  .option('--percent-done <n>', 'Whole percentage done (0-100)', percentageValue)
  .option('-p, --project <id>', 'Move to project ID or identifier', projectRef)
  .option('--assignee <id>', 'Assignee user ID, or none to clear', value => value === 'none' ? value : numericId(value, 'Assignee'))
  .option('--start-date <date>', 'Start date (YYYY-MM-DD, or none)', nullableDate)
  .option('--due-date <date>', 'Due date (YYYY-MM-DD, or none)', nullableDate)
  .option('--date <date>', 'Milestone date (YYYY-MM-DD, or none)', nullableDate)
  .option('--estimate <duration>', 'Estimated time (e.g. PT2H30M, or none)', nullableDuration)
  .action(wrap(cmdWpUpdate));

for (const command of program.commands.filter(command => ['wp-create', 'wp-update'].includes(command.name()))) {
  command.option('--responsible <id>', 'Responsible user ID, or none to clear', optionalId)
    .option('--parent <id>', 'Parent work package ID, or none to remove', optionalId)
    .option('--category <id>', 'Category ID, or none to clear', optionalId)
    .option('--target-version <id>', 'Target version ID, or none to clear', optionalId)
    .option('--remaining <duration>', 'Remaining work (ISO duration, or none to clear)', nullableDuration)
    .option('--schedule-manually <bool>', 'Manual scheduling (true/false)', booleanValue);
}

program.command('wp-delete').description('Delete a work package (requires --confirm)')
  .requiredOption('--id <id>', 'Work package ID', numericId)
  .option('--confirm', 'Confirm deletion (required)')
  .action(wrap(cmdWpDelete));

for (const [command, resource] of [['wp-assignees', 'available_assignees'], ['wp-projects', 'available_projects']]) {
  program.command(command).description(`List work package ${resource.replace('available_', '')} as JSON`)
    .requiredOption('--id <id>', 'Work package ID', numericId)
    .action(wrap(options => cmdWpDiscovery(options, resource)));
}
program.command('wp-relation-candidates').description('Find valid work packages to relate as JSON')
  .requiredOption('--id <id>', 'Source work package ID', numericId)
  .option('--query <text>', 'Search by ID or subject')
  .option('--type <type>', 'Relation type', choice(...RELATION_TYPES), 'relates')
  .action(wrap(options => cmdWpDiscovery(options, 'available_relation_candidates')));

// Projects
program.command('project-list').description('List projects')
  .action(wrap(cmdProjectList));

program.command('project-read').description('Read project details')
  .requiredOption('--id <id>', 'Project identifier or numeric ID')
  .action(wrap(cmdProjectRead));

program.command('project-create').description('Create a project')
  .requiredOption('-n, --name <name>', 'Project name')
  .option('-i, --identifier <id>', 'Project identifier (slug)')
  .option('-d, --description <text>', 'Description')
  .option('--public <bool>', 'Public project (true/false)', booleanValue)
  .option('--parent <id>', 'Parent project ID or identifier', projectRef)
  .action(wrap(cmdProjectCreate));

program.command('project-update').description('Update project attributes')
  .requiredOption('--id <id>', 'Project ID or identifier', projectRef)
  .option('--name <name>', 'Project name')
  .option('--description <text>', 'Description (empty string clears it)')
  .option('--public <bool>', 'Public project (true/false; requires --confirm)', booleanValue)
  .option('--active <bool>', 'Active project (true/false; requires --confirm)', booleanValue)
  .option('--parent <id>', 'Parent project ID/identifier, or none to remove', value => value === 'none' ? value : projectRef(value))
  .option('--confirm', 'Confirm visibility or active-state changes')
  .action(wrap(cmdProjectUpdate));

program.command('project-delete').description('Delete a project')
  .requiredOption('--id <id>', 'Project ID or identifier', projectRef)
  .option('--confirm', 'Confirm deletion')
  .action(wrap(cmdProjectDelete));

program.command('project-assignees').description('List available project assignees as JSON')
  .option('--project <id>', 'Project ID or identifier (defaults to OP_DEFAULT_PROJECT)', projectRef)
  .action(wrap(cmdProjectAssignees));

program.command('project-parent-candidates').description('List eligible parent projects as JSON')
  .option('--project <id>', 'Project ID or identifier; omit for a new project', projectRef)
  .option('--query <text>', 'Filter by project name or identifier')
  .action(wrap(cmdProjectParentCandidates));

// Comments
program.command('comment-list').description('List comments on a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .action(wrap(cmdCommentList));

program.command('comment-add').description('Add a comment to a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .requiredOption('-b, --body <text>', 'Comment body (markdown)')
  .action(wrap(cmdCommentAdd));

program.command('comment-read').description('Read an activity/comment as JSON')
  .requiredOption('--id <id>', 'Activity ID from comment-list', numericId)
  .action(wrap(options => cmdResourceRead(options, 'activities')));

program.command('comment-update').description('Edit an existing activity comment')
  .requiredOption('--id <id>', 'Activity ID from comment-list', numericId)
  .requiredOption('-b, --body <text>', 'Replacement markdown comment')
  .option('--internal <bool>', 'Internal comment (true/false; requires permission)', booleanValue)
  .action(wrap(cmdCommentUpdate));

// Attachments
program.command('attachment-list').description('List attachments on a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .action(wrap(cmdAttachmentList));

program.command('attachment-add').description('Upload an attachment to a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .requiredOption('-f, --file <path>', 'Local file path')
  .action(wrap(cmdAttachmentAdd));

program.command('attachment-delete').description('Delete an attachment (requires --confirm)')
  .requiredOption('--id <id>', 'Attachment ID')
  .option('--confirm', 'Confirm deletion (required)')
  .action(wrap(cmdAttachmentDelete));

// Time Entries
program.command('time-list').description('List time entries')
  .option('-p, --project <id>', 'Project identifier')
  .option('--wp-id <id>', 'Work package ID')
  .action(wrap(cmdTimeList));

program.command('time-create').description('Log time on a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .requiredOption('--hours <n>', 'Hours spent (e.g. 2.5)')
  .option('-c, --comment <text>', 'Comment')
  .option('--date <YYYY-MM-DD>', 'Date spent (default: today)')
  .option('--activity-id <id>', 'Activity type ID')
  .action(wrap(cmdTimeCreate));

program.command('time-update').description('Update a time entry')
  .requiredOption('--id <id>', 'Time entry ID')
  .option('--hours <n>', 'New hours')
  .option('-c, --comment <text>', 'New comment')
  .option('--date <YYYY-MM-DD>', 'New date')
  .action(wrap(cmdTimeUpdate));

program.command('time-delete').description('Delete a time entry (requires --confirm)')
  .requiredOption('--id <id>', 'Time entry ID')
  .option('--confirm', 'Confirm deletion (required)')
  .action(wrap(cmdTimeDelete));

program.command('time-projects').description('List projects available for time tracking as JSON')
  .action(wrap(() => cmdCollectionRead('/time_entries/available_projects')));

// Reference Data
program.command('status-list').description('List all statuses').action(wrap(cmdStatusList));
program.command('type-list').description('List work package types')
  .option('--project <id>', 'Types enabled in this project', projectRef)
  .option('--json', 'Return the full collection as JSON')
  .action(wrap(cmdTypeList));
program.command('priority-list').description('List priorities').action(wrap(cmdPriorityList));

for (const [command, resource] of [
  ['status-read', 'statuses'], ['type-read', 'types'], ['priority-read', 'priorities'], ['category-read', 'categories'],
  ['role-read', 'roles'], ['custom-field-read', 'custom_fields'], ['attachment-read', 'attachments'],
  // The 17.9.7 spec says "activity", but the released server uses "activities".
  ['time-read', 'time_entries'], ['time-activity-read', 'time_entries/activities'],
]) {
  program.command(command).description(`Read ${resource.replaceAll('_', ' ')} metadata as JSON`)
    .requiredOption('--id <id>', 'Resource ID', numericId)
    .action(wrap(options => cmdResourceRead(options, resource)));
}

program.command('role-list').description('List roles available for memberships as JSON')
  .option('--unit <unit>', 'project or system', choice('project', 'system'))
  .option('--grantable <bool>', 'Filter roles selectable for membership (true/false)', booleanValue)
  .action(wrap(cmdRoleList));

program.command('principal-list').description('Search users, groups and placeholders as JSON')
  .option('--type <type>', 'User, Group or PlaceholderUser', choice('User', 'Group', 'PlaceholderUser'))
  .option('--name <text>', 'Search names, email or login')
  .option('--project <id>', 'Filter by project membership', projectRef)
  .option('--page <number>', 'Page number (default: 1)', numericId)
  .action(wrap(cmdPrincipalList));

program.command('sprint-list').description('List visible sprints as JSON')
  .option('--project <id>', 'Project ID or identifier; includes shared sprints', projectRef)
  .option('--defined-in <id>', 'Filter by defining project ID or identifier', projectRef)
  .option('--page <number>', 'Page number (default: 1)', numericId)
  .action(wrap(cmdSprintList));

program.command('sprint-read').description('Read a sprint as JSON')
  .requiredOption('--id <id>', 'Sprint ID', numericId)
  .action(wrap(options => cmdResourceRead(options, 'sprints')));

program.command('member-list').description('List project members')
  .option('-p, --project <id>', 'Project identifier')
  .action(wrap(cmdMemberList));

program.command('member-read').description('Read a membership as JSON')
  .requiredOption('--id <id>', 'Membership ID', numericId)
  .action(wrap(options => cmdResourceRead(options, 'memberships')));

program.command('member-create').description('Create a project membership')
  .option('--project <id>', 'Project ID or identifier (defaults to OP_DEFAULT_PROJECT)', projectRef)
  .requiredOption('--principal <id>', 'User, group or placeholder ID', numericId)
  .option('--principal-type <type>', 'Principal type: user, group, placeholder', choice('user', 'group', 'placeholder'))
  .requiredOption('--roles <ids>', 'Comma-separated role IDs (complete role set)', idList)
  .action(wrap(options => cmdMemberWrite(options, true)));

program.command('member-update').description('Update a membership; --roles replaces all roles')
  .requiredOption('--id <id>', 'Membership ID', numericId)
  .option('--project <id>', 'Project ID or identifier', projectRef)
  .option('--principal <id>', 'User, group or placeholder ID', numericId)
  .option('--principal-type <type>', 'Principal type: user, group, placeholder', choice('user', 'group', 'placeholder'))
  .option('--roles <ids>', 'Comma-separated complete role set', idList)
  .action(wrap(options => cmdMemberWrite(options)));

program.command('member-delete').description('Delete a membership')
  .requiredOption('--id <id>', 'Membership ID', numericId)
  .option('--confirm', 'Confirm deletion')
  .action(wrap(options => cmdResourceDelete(options, 'memberships')));

program.command('version-list').description('List project versions/milestones')
  .option('-p, --project <id>', 'Project identifier')
  .action(wrap(cmdVersionList));

program.command('version-read').description('Read a version as JSON')
  .requiredOption('--id <id>', 'Version ID', numericId)
  .action(wrap(options => cmdResourceRead(options, 'versions')));

for (const action of ['create', 'update']) {
  const command = program.command(`version-${action}`).description(`${action === 'create' ? 'Create' : 'Update'} a version`);
  if (action === 'update') command.requiredOption('--id <id>', 'Version ID', numericId);
  command[action === 'create' ? 'requiredOption' : 'option']('--name <name>', 'Version name')
    .option('--project <id>', 'Defining project ID or identifier (create defaults to OP_DEFAULT_PROJECT)', projectRef)
    .option('--description <text>', 'Description (empty string clears it)')
    .option('--status <status>', 'open, locked or closed', choice('open', 'locked', 'closed'))
    .option('--sharing <sharing>', 'none, descendants, hierarchy, tree or system', choice('none', 'descendants', 'hierarchy', 'tree', 'system'))
    .option('--start-date <date>', 'YYYY-MM-DD, or none to clear', value => value === 'none' ? value : dateValue(value))
    .option('--end-date <date>', 'YYYY-MM-DD, or none to clear', value => value === 'none' ? value : dateValue(value))
    .action(wrap(options => cmdVersionWrite(options, action === 'create')));
}

program.command('version-delete').description('Delete a version')
  .requiredOption('--id <id>', 'Version ID', numericId)
  .option('--confirm', 'Confirm deletion')
  .action(wrap(options => cmdResourceDelete(options, 'versions')));

program.command('category-list').description('List project categories')
  .option('-p, --project <id>', 'Project identifier')
  .action(wrap(cmdCategoryList));

// Users
program.command('user-list').description('List users')
  .option('-s, --status <status>', 'Filter by status (active, registered, locked, invited)')
  .option('-n, --name <text>', 'Search by name (partial match)')
  .option('-g, --group <id>', 'Filter by group ID')
  .action(wrap(cmdUserList));

program.command('user-read').description('Read user details')
  .requiredOption('--id <id>', 'User numeric ID')
  .action(wrap(cmdUserRead));

program.command('user-me').description('Show current authenticated user')
  .action(wrap(cmdUserMe));

for (const action of ['create', 'update']) {
  const command = program.command(`user-${action}`).description(`${action === 'create' ? 'Create or invite' : 'Update'} a user`);
  if (action === 'create') {
    command.requiredOption('--email <email>', 'Email address')
      .option('--status <status>', 'invited (email only) or active', choice('invited', 'active'), 'invited')
      .option('--admin <bool>', 'Administrator (true/false)', booleanValue, false)
      .option('--language <code>', 'Language code', 'en');
  } else {
    command.requiredOption('--id <id>', 'User ID, or me', value => value === 'me' ? value : numericId(value))
      .option('--email <email>', 'Email address')
      .option('--admin <bool>', 'Administrator (true/false)', booleanValue)
      .option('--language <code>', 'Language code')
      .option('--current-password-env <name>', 'Current-password variable for self changes (default: OP_CURRENT_PASSWORD)', envName);
  }
  command.option('--login <login>', 'Login name')
    .option('--first-name <name>', 'First name')
    .option('--last-name <name>', 'Last name')
    .option('--password-env <name>', 'Password variable (active creation defaults to OP_NEW_USER_PASSWORD)', envName)
    .action(wrap(options => cmdUserWrite(options, action === 'create')));
}

program.command('user-delete').description('Delete a user')
  .requiredOption('--id <id>', 'User ID', numericId)
  .option('--confirm', 'Confirm deletion')
  .action(wrap(options => cmdResourceDelete(options, 'users')));

for (const action of ['lock', 'unlock']) {
  program.command(`user-${action}`).description(`${action === 'lock' ? 'Lock' : 'Unlock'} a user`)
    .requiredOption('--id <id>', 'User ID', numericId)
    .action(wrap(options => cmdUserLock(options, action === 'unlock')));
}

// Documents
program.command('document-list').description('List documents')
  .action(wrap(cmdDocumentList));
program.command('document-read').description('Read a document')
  .requiredOption('--id <id>', 'Document ID')
  .action(wrap(cmdDocumentRead));
program.command('document-update').description('Update a document')
  .requiredOption('--id <id>', 'Document ID')
  .option('--title <text>', 'New title')
  .option('-d, --description <text>', 'New description')
  .action(wrap(cmdDocumentUpdate));

// Revisions
program.command('revision-read').description('Read a revision')
  .requiredOption('--id <id>', 'Revision ID')
  .action(wrap(cmdRevisionRead));
program.command('revision-list-by-wp').description('List revisions for a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .action(wrap(cmdRevisionListByWp));

// Capabilities & Actions
program.command('capability-list').description('List capabilities')
  .option('--context <id>', 'Filter by workspace ID, "global", or API context (w<ID>/p<ID>/g)')
  .option('--action <id>', 'Filter by action')
  .option('--principal <id>', 'Filter by principal (user/group ID)')
  .action(wrap(cmdCapabilityList));
program.command('capability-global').description('List global capabilities')
  .action(wrap(cmdCapabilityGlobal));
program.command('action-list').description('List available actions')
  .action(wrap(cmdActionList));
program.command('action-read').description('Read an action')
  .requiredOption('--id <id>', 'Action ID')
  .action(wrap(cmdActionRead));

// My Preferences
program.command('my-preferences-read').description('View my preferences')
  .action(wrap(cmdMyPreferencesRead));
program.command('my-preferences-update').description('Update my preferences')
  .option('--time-zone <tz>', 'Time zone')
  .option('--auto-hide-popups <bool>', 'Auto-hide popups (true/false)')
  .option('--comment-order <order>', 'Comment order (asc/desc)')
  .option('--warn-on-leaving-unsaved <bool>', 'Warn on leaving unsaved (true/false)')
  .action(wrap(cmdMyPreferencesUpdate));

// Render
program.command('render-markdown').description('Render markdown to HTML')
  .requiredOption('--text <text>', 'Markdown text to render')
  .action(wrap(cmdRenderMarkdown));
program.command('render-plain').description('Render plain text to HTML')
  .requiredOption('--text <text>', 'Plain text to render')
  .action(wrap(cmdRenderPlain));

// Posts (Forum)
program.command('post-read').description('Read a forum post')
  .requiredOption('--id <id>', 'Post ID')
  .action(wrap(cmdPostRead));
program.command('post-attachment-list').description('List attachments on a forum post')
  .requiredOption('--id <id>', 'Post ID')
  .action(wrap(cmdPostAttachmentList));

// Reminders
program.command('reminder-list').description('List my reminders')
  .action(wrap(cmdReminderList));
program.command('reminder-create').description('Create a reminder for a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .requiredOption('--remind-at <ISO>', 'Reminder date-time (ISO 8601)')
  .option('--note <text>', 'Reminder note')
  .action(wrap(cmdReminderCreate));
program.command('reminder-update').description('Update a reminder')
  .requiredOption('--id <id>', 'Reminder ID')
  .option('--remind-at <ISO>', 'New reminder date-time')
  .option('--note <text>', 'New note')
  .action(wrap(cmdReminderUpdate));
program.command('reminder-delete').description('Delete a reminder (requires --confirm)')
  .requiredOption('--id <id>', 'Reminder ID')
  .option('--confirm', 'Confirm deletion (required)')
  .action(wrap(cmdReminderDelete));

// Project Statuses
program.command('project-status-read').description('Read a project status')
  .requiredOption('--id <id>', 'Project status ID')
  .action(wrap(cmdProjectStatusRead));

// Project Phases (Enterprise)
program.command('project-phase-definition-list').description('List project phase definitions (Enterprise)')
  .action(wrap(cmdProjectPhaseDefinitionList));

program.command('project-phase-definition-read').description('Read a project phase definition (Enterprise)')
  .requiredOption('--id <id>', 'Phase definition ID')
  .action(wrap(cmdProjectPhaseDefinitionRead));

program.command('project-phase-read').description('Read a project phase (Enterprise)')
  .requiredOption('--id <id>', 'Project phase ID')
  .action(wrap(cmdProjectPhaseRead));

// Portfolios (Enterprise)
program.command('portfolio-list').description('List portfolios (Enterprise)')
  .action(wrap(cmdPortfolioList));

program.command('portfolio-read').description('Read a portfolio (Enterprise)')
  .requiredOption('--id <id>', 'Portfolio ID')
  .action(wrap(cmdPortfolioRead));

program.command('portfolio-update').description('Update a portfolio (Enterprise)')
  .requiredOption('--id <id>', 'Portfolio ID')
  .option('-n, --name <name>', 'New name')
  .option('-d, --description <text>', 'New description')
  .action(wrap(cmdPortfolioUpdate));

program.command('portfolio-delete').description('Delete a portfolio (Enterprise, requires --confirm)')
  .requiredOption('--id <id>', 'Portfolio ID')
  .option('--confirm', 'Confirm deletion (required)')
  .action(wrap(cmdPortfolioDelete));

// Programs (Enterprise)
program.command('program-list').description('List programs (Enterprise)')
  .action(wrap(cmdProgramList));

program.command('program-read').description('Read a program (Enterprise)')
  .requiredOption('--id <id>', 'Program ID')
  .action(wrap(cmdProgramRead));

program.command('program-update').description('Update a program (Enterprise)')
  .requiredOption('--id <id>', 'Program ID')
  .option('-n, --name <name>', 'New name')
  .option('-d, --description <text>', 'New description')
  .action(wrap(cmdProgramUpdate));

program.command('program-delete').description('Delete a program (Enterprise, requires --confirm)')
  .requiredOption('--id <id>', 'Program ID')
  .option('--confirm', 'Confirm deletion (required)')
  .action(wrap(cmdProgramDelete));

// Placeholder Users (Enterprise)
program.command('placeholder-user-list').description('List placeholder users (Enterprise)')
  .action(wrap(cmdPlaceholderUserList));

program.command('placeholder-user-read').description('Read a placeholder user (Enterprise)')
  .requiredOption('--id <id>', 'Placeholder user ID')
  .action(wrap(cmdPlaceholderUserRead));

program.command('placeholder-user-create').description('Create a placeholder user (Enterprise)')
  .requiredOption('-n, --name <name>', 'Placeholder name')
  .action(wrap(cmdPlaceholderUserCreate));

program.command('placeholder-user-update').description('Update a placeholder user (Enterprise)')
  .requiredOption('--id <id>', 'Placeholder user ID')
  .option('-n, --name <name>', 'New name')
  .action(wrap(cmdPlaceholderUserUpdate));

program.command('placeholder-user-delete').description('Delete a placeholder user (Enterprise, requires --confirm)')
  .requiredOption('--id <id>', 'Placeholder user ID')
  .option('--confirm', 'Confirm deletion (required)')
  .action(wrap(cmdPlaceholderUserDelete));

// Budgets (Enterprise)
program.command('budget-read').description('Read a budget (Enterprise)')
  .requiredOption('--id <id>', 'Budget ID')
  .action(wrap(cmdBudgetRead));

program.command('budget-list').description('List project budgets (Enterprise)')
  .option('-p, --project <id>', 'Project identifier')
  .action(wrap(cmdBudgetList));

// Meetings (Enterprise)
program.command('meeting-read').description('Read a meeting (Enterprise)')
  .requiredOption('--id <id>', 'Meeting ID', numericId)
  .option('--json', 'Return the full API record as JSON')
  .action(wrap(cmdMeetingRead));

program.command('meeting-list').description('List visible meetings as JSON')
  .option('--page <number>', 'Page number (default: 1)', numericId)
  .action(wrap(cmdMeetingList));

for (const action of ['create', 'update']) {
  const command = program.command(`meeting-${action}`).description(`${action === 'create' ? 'Create' : 'Update'} a meeting`);
  if (action === 'create') {
    command.option('--project <id>', 'Project ID or identifier (defaults to OP_DEFAULT_PROJECT)', projectRef)
      .requiredOption('--title <title>', 'Meeting title')
      .requiredOption('--start-time <timestamp>', 'ISO 8601 start time with timezone', timestampValue);
  } else {
    command.requiredOption('--id <id>', 'Meeting ID', numericId)
      .option('--title <title>', 'Meeting title')
      .option('--start-time <timestamp>', 'ISO 8601 start time with timezone', timestampValue);
  }
  command.option('--location <text>', 'Location (empty string clears it)')
    .option('--duration <duration>', 'ISO 8601 duration, e.g. PT1H', durationValue)
    .option('--state <state>', 'open, draft, in_progress, cancelled or closed', choice('open', 'draft', 'in_progress', 'cancelled', 'closed'))
    .option('--template <bool>', 'Whether this meeting is a template (true/false)', booleanValue)
    .option('--sharing <sharing>', 'Template sharing: none, descendants or system', choice('none', 'descendants', 'system'))
    .option('--notify <bool>', 'Send participant notifications (true/false)', booleanValue)
    .action(wrap(options => cmdMeetingWrite(options, action === 'create')));
}

program.command('meeting-delete').description('Delete a meeting')
  .requiredOption('--id <id>', 'Meeting ID', numericId)
  .option('--confirm', 'Confirm deletion')
  .action(wrap(options => cmdResourceDelete(options, 'meetings')));

for (const [kind, resource] of Object.entries(MEETING_CONTENT)) {
  const prefix = `meeting-${kind}`;
  const list = program.command(`${prefix}-list`).description(`List meeting ${kind} records as JSON`)
    .requiredOption('--meeting-id <id>', 'Meeting ID', numericId);
  if (kind === 'outcome') list.requiredOption('--agenda-item-id <id>', 'Agenda item ID', numericId);
  list.action(wrap(options => cmdMeetingContentList(options, kind)));
  program.command(`${prefix}-read`).description(`Read a meeting ${kind} as JSON`)
    .requiredOption('--id <id>', `${kind} ID`, numericId)
    .action(wrap(options => cmdResourceRead(options, resource)));
  program.command(`${prefix}-delete`).description(`Delete a meeting ${kind}`)
    .requiredOption('--id <id>', `${kind} ID`, numericId)
    .option('--confirm', 'Confirm deletion')
    .action(wrap(options => cmdResourceDelete(options, resource)));
  for (const action of ['create', 'update']) {
    const command = program.command(`${prefix}-${action}`).description(`${action === 'create' ? 'Create' : 'Update'} a meeting ${kind}`);
    if (action === 'update') command.requiredOption('--id <id>', `${kind} ID`, numericId);
    else if (kind === 'outcome') command.requiredOption('--agenda-item-id <id>', 'Agenda item ID', numericId);
    else command.requiredOption('--meeting-id <id>', 'Meeting ID', numericId);
    if (kind === 'section') command[action === 'create' ? 'requiredOption' : 'option']('--title <title>', 'Section title');
    else {
      command.option('--notes <text>', 'Markdown notes (empty string clears them)')
        .option('--wp-id <id>', 'Linked work package ID, or none to clear', optionalId);
      if (kind === 'agenda-item') {
        command.option('--title <title>', 'Agenda title (required for simple items)')
          .option('--duration-minutes <minutes>', 'Whole minutes, or none to clear', minutesValue)
          .option('--presenter-id <id>', 'Presenter user ID, or none to clear', optionalId)
          .option('--section-id <id>', 'Section ID, or none to clear', optionalId);
      } else command.option('--kind <kind>', 'information or work_package', choice('information', 'work_package'));
    }
    command.action(wrap(options => cmdMeetingContentWrite(options, kind, action === 'create')));
  }
}

program.command('meeting-attachment-list').description('List meeting attachments (Enterprise)')
  .requiredOption('--id <id>', 'Meeting ID')
  .action(wrap(cmdMeetingAttachmentList));

program.command('meeting-attachment-add').description('Upload attachment to meeting (Enterprise)')
  .requiredOption('--id <id>', 'Meeting ID')
  .requiredOption('-f, --file <path>', 'Local file path')
  .action(wrap(cmdMeetingAttachmentAdd));

// Days
program.command('day-read').description('Check if a date is a working day')
  .requiredOption('--date <YYYY-MM-DD>', 'Date to check')
  .action(wrap(cmdDayRead));

program.command('days-list').description('List days in a date range')
  .option('--from <YYYY-MM-DD>', 'Start date (default: today)')
  .option('--to <YYYY-MM-DD>', 'End date')
  .action(wrap(cmdDaysList));

program.command('non-working-days-list').description('List all non-working days')
  .action(wrap(cmdNonWorkingDaysList));

program.command('non-working-day-read').description('View a non-working day')
  .requiredOption('--date <YYYY-MM-DD>', 'Date')
  .action(wrap(cmdNonWorkingDayRead));

program.command('week-days-list').description('List week day configuration (working/non-working)')
  .action(wrap(cmdWeekDaysList));

program.command('week-day-read').description('View a week day configuration')
  .requiredOption('--day <1-7>', 'Day number (1=Monday, 7=Sunday)')
  .action(wrap(cmdWeekDayRead));

// Configuration
program.command('config-read').description('View instance configuration')
  .action(wrap(cmdConfigRead));

program.command('project-config-read').description('View project configuration')
  .option('-p, --project <id>', 'Project identifier')
  .action(wrap(cmdProjectConfigRead));

// OAuth
program.command('oauth-app-read').description('Read an OAuth application')
  .requiredOption('--id <id>', 'OAuth application ID')
  .action(wrap(cmdOauthAppRead));

program.command('oauth-credentials-read').description('Read OAuth client credentials')
  .requiredOption('--id <id>', 'OAuth client credentials ID')
  .action(wrap(cmdOauthCredentialsRead));

// Help Texts
program.command('help-text-list').description('List attribute help texts')
  .action(wrap(cmdHelpTextList));

program.command('help-text-read').description('Read a help text')
  .requiredOption('--id <id>', 'Help text ID')
  .action(wrap(cmdHelpTextRead));

// Custom Fields & Options
program.command('custom-field-items').description('List items for a hierarchical custom field')
  .requiredOption('--id <id>', 'Custom field ID')
  .action(wrap(cmdCustomFieldItems));

program.command('custom-field-item-read').description('Read a custom field item')
  .requiredOption('--id <id>', 'Custom field item ID')
  .action(wrap(cmdCustomFieldItemRead));

program.command('custom-field-item-branch').description('Get a custom field item branch (ancestors)')
  .requiredOption('--id <id>', 'Custom field item ID')
  .action(wrap(cmdCustomFieldItemBranch));

program.command('custom-option-read').description('Read a custom option value')
  .requiredOption('--id <id>', 'Custom option ID')
  .action(wrap(cmdCustomOptionRead));

// Custom Actions
program.command('custom-action-read').description('Read a custom action')
  .requiredOption('--id <id>', 'Custom action ID')
  .action(wrap(cmdCustomActionRead));

program.command('custom-action-execute').description('Execute a custom action on a work package')
  .requiredOption('--id <id>', 'Custom action ID')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .action(wrap(cmdCustomActionExecute));

// Groups
program.command('group-list').description('List groups')
  .action(wrap(cmdGroupList));

program.command('group-read').description('Read group details with members')
  .requiredOption('--id <id>', 'Group ID')
  .action(wrap(cmdGroupRead));

program.command('group-create').description('Create a group')
  .requiredOption('-n, --name <name>', 'Group name')
  .option('-m, --members <ids>', 'Comma-separated user IDs')
  .action(wrap(cmdGroupCreate));

program.command('group-update').description('Update a group')
  .requiredOption('--id <id>', 'Group ID')
  .option('-n, --name <name>', 'New group name')
  .option('-m, --members <ids>', 'New comma-separated user IDs (replaces all)')
  .action(wrap(cmdGroupUpdate));

program.command('group-delete').description('Delete a group (requires --confirm)')
  .requiredOption('--id <id>', 'Group ID')
  .option('--confirm', 'Confirm deletion (required)')
  .action(wrap(cmdGroupDelete));

// News
program.command('news-list').description('List news')
  .action(wrap(cmdNewsList));

program.command('news-read').description('Read news details')
  .requiredOption('--id <id>', 'News ID')
  .action(wrap(cmdNewsRead));

program.command('news-create').description('Create a news item')
  .requiredOption('--title <text>', 'News headline')
  .option('-p, --project <id>', 'Project identifier')
  .option('-s, --summary <text>', 'Short summary')
  .option('-d, --description <text>', 'Full description (markdown)')
  .action(wrap(cmdNewsCreate));

program.command('news-update').description('Update a news item')
  .requiredOption('--id <id>', 'News ID')
  .option('--title <text>', 'New headline')
  .option('-s, --summary <text>', 'New summary')
  .option('-d, --description <text>', 'New description (markdown)')
  .action(wrap(cmdNewsUpdate));

program.command('news-delete').description('Delete a news item (requires --confirm)')
  .requiredOption('--id <id>', 'News ID')
  .option('--confirm', 'Confirm deletion (required)')
  .action(wrap(cmdNewsDelete));

// Watchers
program.command('watcher-list').description('List watchers on a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .action(wrap(cmdWatcherList));

program.command('watcher-add').description('Add a watcher to a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .requiredOption('--user-id <id>', 'User ID to add as watcher')
  .action(wrap(cmdWatcherAdd));

program.command('watcher-remove').description('Remove a watcher from a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .requiredOption('--user-id <id>', 'User ID to remove')
  .action(wrap(cmdWatcherRemove));

program.command('watcher-available').description('List users available as watchers')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .action(wrap(cmdWatcherAvailable));

// Notifications
program.command('notification-list').description('List notifications')
  .option('--unread', 'Show only unread notifications')
  .option('--reason <reason>', 'Filter by reason (assigned, commented, mentioned, watched, ...)')
  .option('-p, --project <id>', 'Filter by project ID')
  .option('--wp-id <id>', 'Filter by work package ID')
  .action(wrap(cmdNotificationList));

program.command('notification-read').description('Read notification details')
  .requiredOption('--id <id>', 'Notification ID')
  .action(wrap(cmdNotificationRead));

program.command('notification-mark-read').description('Mark notification(s) as read')
  .option('--id <id>', 'Notification ID')
  .option('--all', 'Mark all notifications as read')
  .option('-p, --project <id>', 'Filter by project (with --all)')
  .action(wrap(cmdNotificationMarkRead));

program.command('notification-mark-unread').description('Mark notification(s) as unread')
  .option('--id <id>', 'Notification ID')
  .option('--all', 'Mark all notifications as unread')
  .option('-p, --project <id>', 'Filter by project (with --all)')
  .action(wrap(cmdNotificationMarkUnread));

// Relations
program.command('relation-list').description('List relations')
  .option('--wp-id <id>', 'Filter by work package ID (shows all relations involving this WP)')
  .option('-t, --type <type>', 'Filter by relation type (relates, blocks, follows, precedes, ...)')
  .action(wrap(cmdRelationList));

program.command('relation-read').description('Read relation details')
  .requiredOption('--id <id>', 'Relation ID')
  .action(wrap(cmdRelationRead));

program.command('relation-create').description('Create a relation between work packages')
  .requiredOption('--wp-id <id>', 'Source work package ID')
  .requiredOption('--to-wp-id <id>', 'Target work package ID')
  .requiredOption('-t, --type <type>', 'Relation type: relates, duplicates, blocks, precedes, follows, includes, partof, requires')
  .option('-d, --description <text>', 'Description')
  .option('--lag <days>', 'Lag in days (for precedes/follows)')
  .action(wrap(cmdRelationCreate));

program.command('relation-update').description('Update a relation')
  .requiredOption('--id <id>', 'Relation ID')
  .option('-t, --type <type>', 'New relation type')
  .option('-d, --description <text>', 'New description (empty string to clear)')
  .option('--lag <days>', 'New lag in days')
  .action(wrap(cmdRelationUpdate));

program.command('relation-delete').description('Delete a relation (requires --confirm)')
  .requiredOption('--id <id>', 'Relation ID')
  .option('--confirm', 'Confirm deletion (required)')
  .action(wrap(cmdRelationDelete));

// Wiki Pages
program.command('wiki-read').description('Read a wiki page')
  .requiredOption('--id <id>', 'Wiki page numeric ID')
  .action(wrap(cmdWikiRead));

program.command('wiki-attachment-list').description('List attachments on a wiki page')
  .requiredOption('--id <id>', 'Wiki page numeric ID')
  .action(wrap(cmdWikiAttachmentList));

program.command('wiki-attachment-add').description('Upload an attachment to a wiki page')
  .requiredOption('--id <id>', 'Wiki page numeric ID')
  .requiredOption('-f, --file <path>', 'Local file path')
  .action(wrap(cmdWikiAttachmentAdd));

function wrap(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err.statusCode) {
        console.error(`ERROR (${err.statusCode}): ${err.message}`);
      } else {
        console.error(`ERROR: ${err.message}`);
      }
      process.exit(1);
    }
  };
}

program.parse();
