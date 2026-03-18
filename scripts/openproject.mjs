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
import { basename, resolve, posix } from 'node:path';
import { Buffer } from 'node:buffer';
import { config } from 'dotenv';
import { Command } from 'commander';

// ── Config ──────────────────────────────────────────────────────────────────

config(); // load .env

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
    let json;
    try { json = JSON.parse(body); } catch { json = null; }

    if (!resp.ok) {
      const msg = json?.message
        || json?.errorIdentifier
        || json?._embedded?.errors?.map(e => e.message).join(', ')
        || body
        || resp.statusText;
      const err = new Error(msg);
      err.statusCode = resp.status;
      throw err;
    }

    return json;
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

// ── Work Package commands ───────────────────────────────────────────────────

async function cmdWpList(options) {
  const project = options.project || CFG.defaultProject;
  const filters = [];

  if (project) {
    const projResp = await opFetch(`/projects/${project}`);
    filters.push({ project: { operator: '=', values: [String(projResp.id)] } });
  }
  if (options.status) {
    // Resolve status name to ID
    const statuses = await opFetch('/statuses');
    const match = statuses._embedded.elements.find(
      s => s.name.toLowerCase() === options.status.toLowerCase()
    );
    if (match) filters.push({ status: { operator: '=', values: [String(match.id)] } });
  }
  if (options.assignee === 'me') {
    filters.push({ assignee: { operator: '=', values: ['me'] } });
  } else if (options.assignee) {
    filters.push({ assignee: { operator: '=', values: [options.assignee] } });
  }
  if (options.type) {
    filters.push({ type: { operator: '=', values: [options.type] } });
  }

  const filterParam = filters.length ? `&filters=${encodeURIComponent(JSON.stringify(filters))}` : '';
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
  if (!options.subject) {
    console.error('ERROR: --subject is required');
    process.exit(1);
  }

  const payload = {
    subject: options.subject,
    _links: {
      type: { href: null },
      priority: { href: null },
    },
  };

  if (options.description) {
    payload.description = { format: 'markdown', raw: options.description };
  }

  // Resolve type
  if (options.type) {
    const types = await opFetch(`/projects/${project}/types`);
    const match = types._embedded.elements.find(
      t => t.name.toLowerCase() === options.type.toLowerCase()
    );
    if (match) payload._links.type = { href: `/api/v3/types/${match.id}` };
  }

  // Resolve priority
  if (options.priority) {
    const priorities = await opFetch('/priorities');
    const match = priorities._embedded.elements.find(
      p => p.name.toLowerCase() === options.priority.toLowerCase()
    );
    if (match) payload._links.priority = { href: `/api/v3/priorities/${match.id}` };
  }

  // Clean null links
  if (!payload._links.type.href) delete payload._links.type;
  if (!payload._links.priority.href) delete payload._links.priority;
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

  console.log(`📋 #${wp.id}: ${wp.subject}`);
  console.log(`   Type:        ${halLink(wp, 'type')}`);
  console.log(`   Status:      ${halLink(wp, 'status')}`);
  console.log(`   Priority:    ${halLink(wp, 'priority')}`);
  console.log(`   Assignee:    ${halLink(wp, 'assignee')}`);
  console.log(`   Author:      ${halLink(wp, 'author')}`);
  console.log(`   Project:     ${halLink(wp, 'project')}`);
  console.log(`   Version:     ${halLink(wp, 'version')}`);
  console.log(`   Category:    ${halLink(wp, 'category')}`);
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

  // Get current work package for lockVersion
  const current = await opFetch(`/work_packages/${options.id}`);
  const payload = { lockVersion: current.lockVersion, _links: {} };

  if (options.subject) payload.subject = options.subject;
  if (options.description) payload.description = { format: 'markdown', raw: options.description };
  if (options.percentDone !== undefined) payload.percentageDone = parseInt(options.percentDone, 10);

  if (options.status) {
    const statuses = await opFetch('/statuses');
    const match = statuses._embedded.elements.find(
      s => s.name.toLowerCase() === options.status.toLowerCase()
    );
    if (match) payload._links.status = { href: `/api/v3/statuses/${match.id}` };
  }

  if (options.priority) {
    const priorities = await opFetch('/priorities');
    const match = priorities._embedded.elements.find(
      p => p.name.toLowerCase() === options.priority.toLowerCase()
    );
    if (match) payload._links.priority = { href: `/api/v3/priorities/${match.id}` };
  }

  if (options.type) {
    const projectId = halId(current, 'project');
    if (projectId) {
      const types = await opFetch(`/projects/${projectId}/types`);
      const match = types._embedded.elements.find(
        t => t.name.toLowerCase() === options.type.toLowerCase()
      );
      if (match) payload._links.type = { href: `/api/v3/types/${match.id}` };
    }
  }

  if (Object.keys(payload._links).length === 0) delete payload._links;

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
  if (options.public !== undefined) payload.public = options.public === 'true';

  const result = await opFetch('/projects', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  console.log(`✅ Created project: ${result.name}`);
  console.log(`   Identifier: ${result.identifier}`);
  console.log(`   ID: ${result.id}`);
  console.log(`   URL: ${CFG.host}/projects/${result.identifier}`);
}

// ── Comment (Activity) commands ─────────────────────────────────────────────

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

async function cmdTypeList() {
  const resp = await opFetch('/types');
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

  const resp = await opFetch(`/projects/${project}/memberships?pageSize=${CFG.maxResults}`);

  if (!resp._embedded.elements.length) {
    console.log('No members found.');
    return;
  }

  for (const m of resp._embedded.elements) {
    const user = halLink(m, 'principal');
    const roles = m._embedded?.roles?.map(r => r.name).join(', ') || halLink(m, 'roles');
    console.log(`  👤  ${user.padEnd(25)}  ${roles}`);
  }
  console.log(`\n${resp._embedded.elements.length} member(s)`);
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
  .version('1.3.0');

// Work Packages
program.command('wp-list').description('List work packages')
  .option('-p, --project <id>', 'Project identifier')
  .option('-s, --status <name>', 'Filter by status name')
  .option('-a, --assignee <user>', 'Filter by assignee ("me" or user ID)')
  .option('-t, --type <name>', 'Filter by type name')
  .action(wrap(cmdWpList));

program.command('wp-create').description('Create a work package')
  .option('-p, --project <id>', 'Project identifier')
  .requiredOption('-s, --subject <text>', 'Work package subject')
  .option('-d, --description <text>', 'Description (markdown)')
  .option('-t, --type <name>', 'Type (Task, Bug, Feature...)')
  .option('--priority <name>', 'Priority name')
  .action(wrap(cmdWpCreate));

program.command('wp-read').description('Read work package details')
  .requiredOption('--id <id>', 'Work package ID')
  .action(wrap(cmdWpRead));

program.command('wp-update').description('Update a work package')
  .requiredOption('--id <id>', 'Work package ID')
  .option('-s, --subject <text>', 'New subject')
  .option('-d, --description <text>', 'New description')
  .option('--status <name>', 'New status name')
  .option('--priority <name>', 'New priority name')
  .option('-t, --type <name>', 'New type name')
  .option('--percent-done <n>', 'Percentage done (0-100)')
  .action(wrap(cmdWpUpdate));

program.command('wp-delete').description('Delete a work package (requires --confirm)')
  .requiredOption('--id <id>', 'Work package ID')
  .option('--confirm', 'Confirm deletion (required)')
  .action(wrap(cmdWpDelete));

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
  .option('--public <bool>', 'Public project (true/false)')
  .action(wrap(cmdProjectCreate));

// Comments
program.command('comment-list').description('List comments on a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .action(wrap(cmdCommentList));

program.command('comment-add').description('Add a comment to a work package')
  .requiredOption('--wp-id <id>', 'Work package ID')
  .requiredOption('-b, --body <text>', 'Comment body (markdown)')
  .action(wrap(cmdCommentAdd));

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

// Reference Data
program.command('status-list').description('List all statuses').action(wrap(cmdStatusList));
program.command('type-list').description('List work package types').action(wrap(cmdTypeList));
program.command('priority-list').description('List priorities').action(wrap(cmdPriorityList));

program.command('member-list').description('List project members')
  .option('-p, --project <id>', 'Project identifier')
  .action(wrap(cmdMemberList));

program.command('version-list').description('List project versions/milestones')
  .option('-p, --project <id>', 'Project identifier')
  .action(wrap(cmdVersionList));

program.command('category-list').description('List project categories')
  .option('-p, --project <id>', 'Project identifier')
  .action(wrap(cmdCategoryList));

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
