/*
 * AERO Mail - single-file full-stack mail application
 * Render entry point: node server.js
 * Backend: Supabase Auth + Postgres + private Storage, Resend email API/webhooks.
 * Keep all secrets in Render Environment. Never commit .env files.
 */
'use strict';

try { require('dotenv').config({ path: '.env.local' }); require('dotenv').config(); } catch (_) {}
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const sanitizeHtml = require('sanitize-html');

const PORT = Number(process.env.PORT || 10000);
const APP_URL = String(process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '');
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';
const RESEND_FROM_NAME = String(process.env.RESEND_FROM_NAME || 'AERO Mail').replace(/[<>\r\n]/g, '').slice(0, 80);
const DEFAULT_DOMAIN = String(process.env.MAILBOX_DEFAULT_DOMAIN || process.env.NEXT_PUBLIC_MAILBOX_DEFAULT_DOMAIN || 'aero.ist').toLowerCase();
const MAILBOX_ALLOWED_DOMAINS = csv('MAILBOX_ALLOWED_DOMAINS');
const RESEND_SENDING_DOMAINS = csv('RESEND_SENDING_DOMAINS');
const RESEND_RECEIVING_DOMAINS = csv('RESEND_RECEIVING_DOMAINS');
const MAX_FILE = 15 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const BUCKET = 'mail-attachments';

function csv(name) {
  return String(process.env[name] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function safeName(name) {
  return String(name || 'attachment').replace(/[\\/\u0000-\u001f\u007f]/g, '_').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 140) || 'attachment';
}
function emailList(value) {
  const vals = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = new Set();
  for (const item of vals) {
    if (typeof item !== 'string') continue;
    const matches = item.match(/[A-Z0-9.!#$%&'*+\/= ?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi) || [];
    matches.forEach((x) => out.add(x.replace(/\s/g, '').toLowerCase()));
  }
  return [...out];
}
function senderParts(value) {
  const email = emailList(value)[0] || String(value || 'unknown@unknown.invalid').trim().toLowerCase();
  const name = String(value || '').includes('<') ? String(value).slice(0, String(value).indexOf('<')).trim().replace(/^['"]|['"]$/g, '') : '';
  return { email, name: name || null };
}
function plainTextToHtml(text) {
  const escaped = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<div style="font-family:Arial,sans-serif;line-height:1.6;white-space:pre-wrap">' + escaped + '</div>';
}
function cleanEmailHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['address','article','b','blockquote','br','caption','code','div','em','figcaption','figure','h1','h2','h3','h4','hr','i','li','ol','p','pre','s','span','strong','table','tbody','td','th','thead','tr','u','ul','a'],
    allowedAttributes: { a: ['href','name','target','rel'], '*': ['style'] },
    allowedSchemes: ['http','https','mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }) },
  });
}
function htmlToText(html) {
  return String(html || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '')); }
function asArray(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }

async function downloadInboundBuffer(rawUrl) {
  const initial = new URL(rawUrl);
  const allowedHost = (host) => host === 'inbound-cdn.resend.com' || host.endsWith('.resend.com');
  if (initial.protocol !== 'https:' || !allowedHost(initial.hostname)) throw new Error('Unexpected attachment download host from Resend.');
  const response = await fetch(initial, { signal: AbortSignal.timeout(25000), cache: 'no-store' });
  if (!response.ok) throw new Error('Could not download an inbound attachment.');
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== 'https:' || !allowedHost(finalUrl.hostname)) throw new Error('Resend attachment redirected to an unexpected host.');
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_FILE) throw new Error('An inbound attachment exceeds the per-file limit.');
  if (!response.body) throw new Error('Resend returned an empty attachment response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_FILE) { await reader.cancel(); throw new Error('An inbound attachment exceeds the per-file limit.'); }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks, total);
}

let supabaseAdmin;
let resendClient;
let pool;
let initError = null;

async function loadSdkClients() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
    throw new Error('Missing Supabase environment variables. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.');
  }
  const { createClient } = await import('@supabase/supabase-js');
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  if (!RESEND_API_KEY) throw new Error('Missing RESEND_API_KEY.');
  const { Resend } = await import('resend');
  resendClient = new Resend(RESEND_API_KEY);
}

async function initializeDatabase() {
  if (!DATABASE_URL) throw new Error('Missing DATABASE_URL. In Supabase, open Connect and copy the Session Pooler connection string into Render Environment.');
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
  await pool.query(`
    create extension if not exists pgcrypto;
    create table if not exists public.mailboxes (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null,
      email text unique not null,
      domain text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists public.messages (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null,
      from_email text not null,
      from_name text,
      to_email text[] not null default '{}',
      cc_email text[] not null default '{}',
      bcc_email text[] not null default '{}',
      reply_to_email text[] not null default '{}',
      internet_message_id text,
      subject text,
      body_text text,
      body_html text,
      attachments jsonb not null default '[]'::jsonb,
      folder text not null default 'inbox' check (folder in ('inbox','sent','archive','trash','drafts')),
      is_read boolean not null default false,
      is_starred boolean not null default false,
      provider_message_id text,
      received_at timestamptz not null default now()
    );
    alter table public.messages add column if not exists cc_email text[] not null default '{}';
    alter table public.messages add column if not exists bcc_email text[] not null default '{}';
    alter table public.messages add column if not exists reply_to_email text[] not null default '{}';
    alter table public.messages add column if not exists internet_message_id text;
    create index if not exists messages_user_folder_received on public.messages(user_id,folder,received_at desc);
    create index if not exists messages_user_starred on public.messages(user_id,is_starred);
    create unique index if not exists messages_provider_message_id_unique on public.messages(user_id,provider_message_id) where provider_message_id is not null;
    create table if not exists public.domain_requests (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null,
      domain text not null,
      requested_email text not null,
      status text not null default 'pending' check (status in ('pending','verified','rejected','active')),
      provider_domain_id text,
      created_at timestamptz not null default now()
    );
  `);
  const { error } = await supabaseAdmin.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_FILE });
  if (error && !/already exists|duplicate/i.test(error.message || '')) throw new Error('Could not create private attachment bucket: ' + error.message);
}

async function requireUser(req, res, next) {
  try {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Please sign in.' });
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data || !data.user) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    req.user = data.user;
    next();
  } catch (e) { next(e); }
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE, files: MAX_ATTACHMENTS } });

// Resend webhook uses the exact unmodified raw request body for signature verification.
app.post('/api/inbound', express.raw({ type: 'application/json', limit: '2mb' }), async (req, res) => {
  const uploadedPaths = [];
  const committed = new Set();
  try {
    if (!RESEND_WEBHOOK_SECRET) return res.status(503).json({ error: 'RESEND_WEBHOOK_SECRET is not configured.' });
    const rawPayload = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!rawPayload) return res.status(400).json({ error: 'Empty webhook request.' });
    let event;
    try {
      event = resendClient.webhooks.verify({
        payload: rawPayload,
        headers: {
          id: req.headers['svix-id'] || '',
          timestamp: req.headers['svix-timestamp'] || '',
          signature: req.headers['svix-signature'] || '',
        },
        webhookSecret: RESEND_WEBHOOK_SECRET,
      });
    } catch (_) { return res.status(401).json({ error: 'Invalid webhook signature.' }); }
    if (event.type !== 'email.received') return res.json({ ok: true, ignored: event.type || 'unknown event' });
    const emailId = event.data && (event.data.email_id || event.data.id);
    if (!emailId) return res.status(400).json({ error: 'Resend event has no email ID.' });

    const { data: received, error: retrieveError } = await resendClient.emails.receiving.get(emailId);
    if (retrieveError || !received) throw new Error(retrieveError?.message || 'Could not retrieve received email from Resend.');
    const candidates = [...new Set(emailList(received.received_for).concat(emailList(received.to), emailList(event.data?.to)))];
    const allowed = candidates.filter((addr) => RESEND_RECEIVING_DOMAINS.includes((addr.split('@')[1] || '').toLowerCase()));
    if (!allowed.length) return res.json({ ok: true, ignored: 'No recipient is enabled for receiving.' });
    const { data: boxes, error: boxError } = await supabaseAdmin.from('mailboxes').select('user_id,email').in('email', allowed);
    if (boxError) throw boxError;
    if (!boxes?.length) return res.json({ ok: true, ignored: 'No registered app mailbox for recipient.' });
    const users = [...new Set(boxes.map((b) => b.user_id))];
    const { data: dupes, error: dupeError } = await supabaseAdmin.from('messages').select('user_id').eq('provider_message_id', emailId).in('user_id', users);
    if (dupeError) throw dupeError;
    const done = new Set((dupes || []).map((d) => d.user_id));
    const targetUsers = users.filter((u) => !done.has(u));
    if (!targetUsers.length) return res.json({ ok: true, duplicate: true });

    const sender = senderParts(String(received.from || event.data?.from || 'unknown@unknown.invalid'));
    const subject = String(received.subject || event.data?.subject || '(no subject)').slice(0, 998);
    const bodyHtml = cleanEmailHtml(String(received.html || ''));
    const bodyText = String(received.text || '').trim() || htmlToText(bodyHtml);
    const { data: listData, error: listError } = await resendClient.emails.receiving.attachments.list({ emailId });
    if (listError) throw new Error(listError.message || 'Could not list received attachments.');
    const rawList = listData?.data || listData || [];
    const attachmentRows = Array.isArray(rawList) ? rawList : [];
    let sum = 0;
    const downloaded = [];
    for (const item of attachmentRows.slice(0, MAX_ATTACHMENTS)) {
      const expected = Number(item.size || 0);
      if (expected > MAX_FILE || (expected && sum + expected > MAX_TOTAL)) continue;
      let dl = item.download_url;
      if (!dl && item.id) {
        const got = await resendClient.emails.receiving.attachments.get({ id: item.id, emailId });
        if (got.error || !got.data?.download_url) throw new Error(got.error?.message || 'Could not get attachment download URL.');
        dl = got.data.download_url;
      }
      if (!dl) continue;
      const buffer = await downloadInboundBuffer(dl);
      if (buffer.length > MAX_FILE || sum + buffer.length > MAX_TOTAL) continue;
      sum += buffer.length;
      downloaded.push({ name: safeName(item.filename), type: item.content_type || 'application/octet-stream', buffer });
    }

    let saved = 0;
    for (const userId of targetUsers) {
      const ownedBoxes = boxes.filter((b) => b.user_id === userId);
      const stored = [];
      for (const file of downloaded) {
        const path = userId + '/' + crypto.randomUUID() + '-' + file.name.replace(/\s+/g, '_');
        const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.type, upsert: false });
        if (error) throw error;
        uploadedPaths.push(path);
        stored.push({ name: file.name, type: file.type, size: file.buffer.length, path });
      }
      const { error } = await supabaseAdmin.from('messages').insert({
        user_id: userId,
        from_email: sender.email,
        from_name: sender.name,
        to_email: ownedBoxes.map((b) => b.email),
        cc_email: emailList(received.cc),
        bcc_email: emailList(received.bcc),
        reply_to_email: emailList(received.reply_to),
        subject,
        body_text: bodyText,
        body_html: bodyHtml,
        attachments: stored,
        folder: 'inbox',
        is_read: false,
        provider_message_id: emailId,
        internet_message_id: received.message_id || null,
        received_at: received.created_at || event.created_at || new Date().toISOString(),
      });
      if (error && error.code !== '23505') throw error;
      if (!error) {
        saved += 1;
        stored.forEach((a) => committed.add(a.path));
      } else if (stored.length) {
        await supabaseAdmin.storage.from(BUCKET).remove(stored.map((a) => a.path));
      }
    }
    return res.json({ ok: true, saved, attachmentCount: downloaded.length });
  } catch (error) {
    const remove = uploadedPaths.filter((p) => !committed.has(p));
    if (remove.length) { try { await supabaseAdmin.storage.from(BUCKET).remove(remove); } catch (_) {} }
    console.error('Inbound webhook failed:', error.message);
    return res.status(500).json({ error: 'Inbound email processing failed.' });
  }
});

app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => initError ? res.status(503).json({ ok: false, error: initError.message }) : res.json({ ok: true, service: 'AERO Mail', database: Boolean(pool), timestamp: new Date().toISOString() }));
app.get('/', (req, res) => {
  if (initError) return res.status(503).type('html').send('<h1>AERO Mail setup required</h1><p>' + String(initError.message).replace(/[<>&]/g, '') + '</p><p>Add the required environment variables in Render, then redeploy.</p>');
  const page = APP_HTML
    .replace('__SUPABASE_URL__', JSON.stringify(SUPABASE_URL))
    .replace('__SUPABASE_ANON_KEY__', JSON.stringify(SUPABASE_ANON_KEY))
    .replace('__DEFAULT_DOMAIN__', JSON.stringify(DEFAULT_DOMAIN));
  res.type('html').send(page);
});

app.get('/api/mailboxes', requireUser, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin.from('mailboxes').select('id,email,domain,created_at').eq('user_id', req.user.id).order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ mailboxes: data || [] });
  } catch (e) { next(e); }
});
app.post('/api/mailboxes', requireUser, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const match = email.match(/^([a-z0-9][a-z0-9._+-]{0,63})@([a-z0-9.-]+\.[a-z]{2,})$/);
    if (!match || match[1].startsWith('.') || match[1].endsWith('.') || match[1].includes('..')) return res.status(400).json({ error: 'Enter a valid email address.' });
    const domain = match[2];
    if (!MAILBOX_ALLOWED_DOMAINS.includes(domain)) return res.status(403).json({ error: 'This domain is not enabled yet. The domain administrator must verify it and add it to MAILBOX_ALLOWED_DOMAINS.' });
    const { data: existing } = await supabaseAdmin.from('mailboxes').select('id,user_id,email,domain').eq('email', email).maybeSingle();
    if (existing) return res.status(409).json({ error: 'This email address is already registered.' });
    const { data, error } = await supabaseAdmin.from('mailboxes').insert({ user_id: req.user.id, email, domain }).select('id,email,domain,created_at').single();
    if (error) { if (error.code === '23505') return res.status(409).json({ error: 'This email address is already taken.' }); throw error; }
    res.status(201).json({ mailbox: data });
  } catch (e) { next(e); }
});
app.post('/api/domain-requests', requireUser, async (req, res, next) => {
  try {
    const domain = String(req.body.domain || '').trim().toLowerCase();
    const local = String(req.body.local_part || '').trim().toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) return res.status(400).json({ error: 'Enter a valid domain.' });
    if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(local)) return res.status(400).json({ error: 'Enter a valid mailbox name.' });
    const requested = local + '@' + domain;
    const { data: existing } = await supabaseAdmin.from('mailboxes').select('id').eq('email', requested).maybeSingle();
    if (existing) return res.status(409).json({ error: 'That mailbox is already registered.' });
    const { data, error } = await supabaseAdmin.from('domain_requests').insert({ user_id: req.user.id, domain, requested_email: requested }).select().single();
    if (error) throw error;
    res.status(201).json({ request: data, message: 'Request submitted. The domain owner must verify DNS and approve it before mailbox creation.' });
  } catch (e) { next(e); }
});

app.get('/api/messages', requireUser, async (req, res, next) => {
  try {
    const folder = String(req.query.folder || 'inbox');
    if (folder === 'starred') {
      const { data, error } = await supabaseAdmin.from('messages').select('id,from_email,from_name,to_email,subject,body_text,folder,is_read,is_starred,received_at,attachments').eq('user_id', req.user.id).eq('is_starred', true).neq('folder', 'trash').order('received_at', { ascending: false }).limit(150);
      if (error) throw error;
      return res.json({ messages: data || [] });
    }
    if (!['inbox','sent','archive','trash','drafts'].includes(folder)) return res.status(400).json({ error: 'Invalid folder.' });
    let query = supabaseAdmin.from('messages').select('id,from_email,from_name,to_email,subject,body_text,folder,is_read,is_starred,received_at,attachments').eq('user_id', req.user.id).eq('folder', folder).order('received_at', { ascending: false }).limit(150);
    const search = String(req.query.q || '').trim().slice(0, 100).replace(/[%_(),]/g, ' ');
    if (search) query = query.or('subject.ilike.%' + search + '%,from_email.ilike.%' + search + '%,body_text.ilike.%' + search + '%');
    const { data, error } = await query;
    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (e) { next(e); }
});
app.get('/api/messages/:id', requireUser, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin.from('messages').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Message not found.' });
    if (data.folder === 'inbox' && !data.is_read) await supabaseAdmin.from('messages').update({ is_read: true }).eq('id', data.id).eq('user_id', req.user.id);
    res.json({ message: data });
  } catch (e) { next(e); }
});
app.patch('/api/messages/:id', requireUser, async (req, res, next) => {
  try {
    const update = {};
    if (typeof req.body.is_starred === 'boolean') update.is_starred = req.body.is_starred;
    if (typeof req.body.is_read === 'boolean') update.is_read = req.body.is_read;
    if (['inbox','sent','archive','trash','drafts'].includes(req.body.folder)) update.folder = req.body.folder;
    if (!Object.keys(update).length) return res.status(400).json({ error: 'No valid changes supplied.' });
    const { data, error } = await supabaseAdmin.from('messages').update(update).eq('id', req.params.id).eq('user_id', req.user.id).select('id,folder,is_starred,is_read').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Message not found.' });
    res.json({ message: data });
  } catch (e) { next(e); }
});
app.delete('/api/messages/:id', requireUser, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin.from('messages').delete().eq('id', req.params.id).eq('user_id', req.user.id).eq('folder', 'trash').select('id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Only messages already in Trash can be permanently deleted.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/attachments', requireUser, upload.array('files', MAX_ATTACHMENTS), async (req, res, next) => {
  const uploaded = [];
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Choose at least one file.' });
    const total = files.reduce((n, f) => n + f.size, 0);
    if (files.some((f) => f.size > MAX_FILE) || total > MAX_TOTAL) return res.status(413).json({ error: 'Attachments are limited to 15 MB per file, 20 MB combined and 10 files.' });
    for (const file of files) {
      const name = safeName(file.originalname);
      const path = req.user.id + '/outgoing/' + crypto.randomUUID() + '-' + name.replace(/\s+/g, '_');
      const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype || 'application/octet-stream', upsert: false });
      if (error) throw error;
      uploaded.push({ path, name, type: file.mimetype || 'application/octet-stream', size: file.size });
    }
    res.status(201).json({ attachments: uploaded });
  } catch (e) {
    if (uploaded.length) { try { await supabaseAdmin.storage.from(BUCKET).remove(uploaded.map((a) => a.path)); } catch (_) {} }
    next(e);
  }
});
app.get('/api/attachments', requireUser, async (req, res, next) => {
  try {
    const path = String(req.query.path || '');
    if (!path || !path.startsWith(req.user.id + '/')) return res.status(403).json({ error: 'Invalid attachment path.' });
    const { data: rows, error } = await supabaseAdmin.from('messages').select('attachments').eq('user_id', req.user.id);
    if (error) throw error;
    const allowed = (rows || []).some((row) => (row.attachments || []).some((a) => a.path === path));
    if (!allowed) return res.status(404).json({ error: 'Attachment not found.' });
    const { data, error: signError } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 60);
    if (signError || !data?.signedUrl) throw signError || new Error('Unable to create attachment link.');
    res.json({ url: data.signedUrl });
  } catch (e) { next(e); }
});

app.post('/api/drafts', requireUser, async (req, res, next) => {
  try {
    const to = String(req.body.to || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (to.length > 25 || to.some((x) => !validEmail(x))) return res.status(400).json({ error: 'Check the recipient email addresses.' });
    const subject = String(req.body.subject || '').slice(0, 998);
    const html = cleanEmailHtml(req.body.html || '');
    const text = String(req.body.text || htmlToText(html)).slice(0, 100000);
    const attachmentRows = Array.isArray(req.body.attachments) ? req.body.attachments : [];
    if (attachmentRows.some((a) => !a || typeof a.path !== 'string' || !a.path.startsWith(req.user.id + '/outgoing/'))) return res.status(403).json({ error: 'An attachment does not belong to your account.' });
    const { data: box } = await supabaseAdmin.from('mailboxes').select('email').eq('user_id', req.user.id).order('created_at').limit(1).maybeSingle();
    const payload = { user_id: req.user.id, from_email: box?.email || req.user.email || '', to_email: to, subject, body_text: text, body_html: html, attachments: attachmentRows, folder: 'drafts', is_read: true };
    const id = String(req.body.id || '');
    let result;
    if (id) result = await supabaseAdmin.from('messages').update(payload).eq('id', id).eq('user_id', req.user.id).eq('folder', 'drafts').select('id').maybeSingle();
    else result = await supabaseAdmin.from('messages').insert(payload).select('id').single();
    if (result.error) throw result.error;
    if (!result.data) return res.status(404).json({ error: 'Draft not found.' });
    res.json({ id: result.data.id });
  } catch (e) { next(e); }
});

app.post('/api/send', requireUser, async (req, res, next) => {
  const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
  try {
    const to = String(req.body.to || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const cc = String(req.body.cc || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const bcc = String(req.body.bcc || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const subject = String(req.body.subject || '').trim().slice(0, 998);
    const html = cleanEmailHtml(req.body.html || '');
    const text = String(req.body.text || htmlToText(html)).slice(0, 100000);
    const allRecipients = to.concat(cc, bcc);
    if (!to.length || !subject || !text.trim()) return res.status(400).json({ error: 'Recipient, subject and message are required.' });
    if (allRecipients.length > 25 || allRecipients.some((x) => !validEmail(x))) return res.status(400).json({ error: 'Use up to 25 valid recipient addresses.' });
    if (attachments.length > MAX_ATTACHMENTS || attachments.some((a) => !a || typeof a.path !== 'string' || !a.path.startsWith(req.user.id + '/outgoing/'))) return res.status(403).json({ error: 'Invalid attachment list.' });
    const { data: box, error: boxError } = await supabaseAdmin.from('mailboxes').select('email,domain').eq('user_id', req.user.id).order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (boxError) throw boxError;
    if (!box) return res.status(403).json({ error: 'Create an AERO Mail address before sending email.' });
    if (!RESEND_SENDING_DOMAINS.includes(box.domain.toLowerCase())) return res.status(403).json({ error: 'Your mailbox domain is not enabled for Resend sending.' });

    const resendAttachments = [];
    const storedAttachments = [];
    let total = 0;
    for (const item of attachments) {
      const { data: blob, error } = await supabaseAdmin.storage.from(BUCKET).download(item.path);
      if (error || !blob) throw error || new Error('Could not read an uploaded attachment.');
      const buffer = Buffer.from(await blob.arrayBuffer());
      if (buffer.length > MAX_FILE || buffer.length !== Number(item.size)) throw new Error('An attachment failed its file-size check.');
      total += buffer.length;
      if (total > MAX_TOTAL) throw new Error('Attachments exceed the 20 MB combined limit.');
      const name = safeName(item.name);
      const type = /^[\w.+-]+\/[\w.+-]+$/.test(item.type || '') ? item.type : 'application/octet-stream';
      resendAttachments.push({ filename: name, content: buffer.toString('base64'), contentType: type });
      storedAttachments.push({ name, type, size: buffer.length, path: item.path });
    }
    const { data: sent, error: sendError } = await resendClient.emails.send({
      from: RESEND_FROM_NAME + ' <' + box.email + '>',
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject,
      html: html || plainTextToHtml(text),
      text,
      replyTo: box.email,
      attachments: resendAttachments,
    }, { idempotencyKey: String(req.headers['idempotency-key'] || crypto.randomUUID()) });
    if (sendError || !sent?.id) return res.status(502).json({ error: sendError?.message || 'Resend did not accept this email.' });
    const { error: saveError } = await supabaseAdmin.from('messages').insert({
      user_id: req.user.id, from_email: box.email, from_name: RESEND_FROM_NAME,
      to_email: to, cc_email: cc, bcc_email: bcc, subject, body_text: text, body_html: html,
      attachments: storedAttachments, folder: 'sent', is_read: true, provider_message_id: sent.id,
    });
    if (saveError && saveError.code !== '23505') console.error('Email sent but Sent copy could not be saved:', saveError.message);
    if (req.body.draftId) await supabaseAdmin.from('messages').delete().eq('id', req.body.draftId).eq('user_id', req.user.id).eq('folder', 'drafts');
    res.json({ ok: true, id: sent.id, warning: saveError && saveError.code !== '23505' ? 'Email was sent, but its Sent copy could not be saved.' : undefined });
  } catch (e) { next(e); }
});

app.post('/api/compose/improve', requireUser, async (req, res, next) => {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(503).json({ error: 'AI writing is not configured. Add OPENAI_API_KEY in Render Environment.' });
    const text = String(req.body.text || '').slice(0, 12000);
    const style = String(req.body.style || 'professional').slice(0, 40);
    if (!text.trim()) return res.status(400).json({ error: 'Write a draft first.' });
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', input: 'Rewrite this email in a ' + style + ' style. Preserve its meaning, facts and names. Return only the revised email body.\n\n' + text }),
    });
    const result = await response.json();
    if (!response.ok) return res.status(502).json({ error: result.error?.message || 'AI writing request failed.' });
    const improved = result.output?.flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n') || '';
    if (!improved) return res.status(502).json({ error: 'AI returned an empty response.' });
    res.json({ text: improved });
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const message = err && err.message ? err.message : 'Unexpected server error.';
  const status = err && err.name === 'MulterError' ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : (err.status || 500);
  if (status >= 500) console.error('API error:', message);
  res.status(status).json({ error: status >= 500 ? 'Server error. Check the Render service logs and environment variables.' : message });
});

const APP_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#10243c"><title>AERO Mail</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--navy:#10243c;--blue:#1769d2;--red:#e5484d;--ink:#24364b;--muted:#8491a3;--line:#e8edf3;--bg:#f5f7fa;--white:#fff;--shadow:0 18px 50px rgba(19,43,70,.12)}*{box-sizing:border-box}body{margin:0;font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--ink)}button,input,textarea,select{font:inherit}button{cursor:pointer;border:0}.hidden{display:none!important}.muted{color:var(--muted)}.small{font-size:12px}.brand{display:flex;align-items:center;gap:11px;color:var(--navy);font:800 20px Manrope}.brandmark{width:38px;height:38px;border-radius:12px;background:var(--navy);color:white;display:grid;place-items:center;font:800 24px Manrope;position:relative}.brandmark:after{content:'';width:8px;height:8px;position:absolute;right:5px;bottom:5px;background:var(--red);border-radius:50%;border:2px solid var(--navy)}.btn{border-radius:9px;padding:10px 14px;font-size:13px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;gap:8px}.btn-primary{background:var(--blue);color:#fff;box-shadow:0 5px 15px #1769d226}.btn-primary:hover{background:#1259b8}.btn-light{background:#f2f6fb;color:#53677f}.btn-light:hover{background:#e8eff8}.btn-danger{color:#c33d43;background:#fff0f0}.iconbtn{width:35px;height:35px;border-radius:9px;background:transparent;color:#7a899d;display:grid;place-items:center;font-size:17px}.iconbtn:hover{background:#eef4fb;color:var(--blue)}
.authscreen{min-height:100vh;display:grid;place-items:center;padding:22px;background:radial-gradient(circle at 20% 8%,#e4efff,transparent 34%),radial-gradient(circle at 90% 90%,#ffe9e9,transparent 30%),#f5f8fc}.authcard{width:min(440px,100%);padding:36px;background:#fff;border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow)}.authcard .brand{justify-content:center;margin-bottom:26px}.authcard h1{text-align:center;font:800 25px Manrope;margin:0 0 7px}.authcard p{text-align:center;color:var(--muted);font-size:13px;margin:0 0 23px}.field{display:grid;gap:7px;margin:13px 0}.field label{font-size:12px;font-weight:700;color:#61748b}.field input,.field select{height:45px;border:1px solid #dfe6ef;border-radius:9px;padding:0 12px;outline:0;background:#fff}.field input:focus,.field select:focus{border-color:#8db6ec;box-shadow:0 0 0 3px #1769d212}.authswitch{text-align:center;margin-top:18px;font-size:12px;color:var(--muted)}.textlink{background:none;color:var(--blue);font-weight:700}.authnotice{font-size:12px;padding:10px;border-radius:8px;background:#eef5ff;color:#31577e;margin:12px 0}.autherror{background:#fff0f0;color:#b53b41}
.app{height:100vh;display:flex;flex-direction:column}.topbar{height:68px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:28px;padding:0 24px;flex-shrink:0}.topbar .brand{width:222px;flex-shrink:0}.search{height:39px;max-width:520px;flex:1;display:flex;align-items:center;gap:9px;background:#f4f7fa;border:1px solid #edf1f6;border-radius:10px;padding:0 12px;color:#94a0af}.search input{background:none;border:0;outline:0;flex:1;min-width:0;font-size:13px;color:var(--ink)}.userarea{margin-left:auto;display:flex;align-items:center;gap:10px}.avatar{width:34px;height:34px;background:#e8f1ff;color:#2b65a6;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800}.useremail{font-size:11px;color:#64758b;max-width:175px;overflow:hidden;text-overflow:ellipsis}.workspace{display:flex;min-height:0;flex:1}.sidebar{width:245px;flex-shrink:0;background:#fff;border-right:1px solid var(--line);padding:20px 15px;display:flex;flex-direction:column;gap:7px}.composebtn{height:45px;width:100%;justify-content:center;margin-bottom:15px}.navtitle{font-size:10px;color:#a0acb9;letter-spacing:1.5px;font-weight:800;padding:10px 12px 4px}.navitem{height:40px;border-radius:9px;background:transparent;color:#6c7b8e;display:flex;align-items:center;gap:12px;padding:0 12px;text-align:left;font-size:13px}.navitem:hover{background:#f5f8fc}.navitem.active{background:#edf4ff;color:var(--blue);font-weight:800}.navitem .count{margin-left:auto;font-size:10px;background:#e8eef7;padding:3px 7px;border-radius:20px}.domainbox{margin-top:auto;background:#f6f8fb;border:1px solid #edf1f5;padding:13px;border-radius:11px}.domainbox b{font-size:11px}.domainbox p{font-size:10px;line-height:1.5;color:#8996a7;margin:6px 0 10px}.main{flex:1;min-width:0;overflow:auto}.pagehead{display:flex;align-items:center;justify-content:space-between;padding:28px 32px 17px}.eyebrow{font-size:10px;letter-spacing:1.6px;color:#a0adbc;font-weight:800;margin-bottom:6px}.pagehead h1{font:800 25px Manrope;margin:0 0 5px;color:#1b3048}.pagehead p{font-size:12px;color:var(--muted);margin:0}.listtools{display:flex;align-items:center;gap:8px;margin:0 32px;background:#fff;border:1px solid var(--line);border-radius:11px 11px 0 0;padding:10px 13px}.listtools .spacer{flex:1}.listtools select{border:1px solid #e7ecf2;padding:7px 9px;border-radius:7px;font-size:11px;color:#6e7f94;background:#fff}.messagelist{margin:0 32px 30px;background:#fff;border:1px solid var(--line);border-top:0;border-radius:0 0 11px 11px;overflow:hidden}.msgrow{min-height:66px;display:flex;align-items:center;gap:13px;padding:0 17px;border-bottom:1px solid #f0f3f7;cursor:pointer}.msgrow:last-child{border-bottom:0}.msgrow:hover{background:#f8fbff}.msgrow.unread{background:#fbfdff}.msgrow.unread .sender,.msgrow.unread .subject{font-weight:800;color:#25384d}.star{background:none;color:#c0c9d3;font-size:17px;padding:3px}.star.on{color:#e8ad35}.sender{width:190px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:#4e6076}.subject{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:#53647a}.subject span{color:#a1acb9;font-weight:400}.msgrow time{color:#9aa5b2;font-size:10px;white-space:nowrap}.empty{min-height:300px;display:grid;place-items:center;text-align:center;color:#93a0b0;padding:30px}.emptyicon{margin:auto;width:60px;height:60px;border-radius:19px;background:#eff5fc;color:#5790cc;display:grid;place-items:center;font-size:25px}.empty h3{font:800 16px Manrope;color:#364c66;margin:13px 0 6px}.empty p{font-size:12px;margin:0 0 15px}.reader{margin:28px 32px;background:#fff;border:1px solid var(--line);border-radius:13px;padding:23px 28px;min-height:360px}.readerbar{display:flex;gap:7px;align-items:center;margin-bottom:22px}.readerbar .spacer{flex:1}.reader h2{font:800 24px Manrope;margin:0 0 22px;color:#1d334d}.fromrow{display:flex;align-items:center;gap:11px;border-bottom:1px solid var(--line);padding-bottom:17px}.frommeta{flex:1;display:grid;gap:4px}.frommeta b{font-size:12px}.frommeta span{font-size:11px;color:#8592a2}.mailbody{padding:24px 2px;line-height:1.75;font-size:13px;color:#384d65;min-height:150px;overflow-wrap:anywhere}.mailbody img{max-width:100%}.attachments{display:flex;gap:8px;flex-wrap:wrap;margin:15px 0}.att{border:1px solid #e1e8f0;background:#f9fbfd;border-radius:8px;padding:9px 11px;color:#456886;text-decoration:none;font-size:11px}.composewrap{padding:25px 32px;max-width:1050px;margin:auto}.composecard{background:#fff;border:1px solid var(--line);border-radius:13px;overflow:hidden}.composeheading{display:flex;align-items:center;justify-content:space-between;padding:18px 21px;border-bottom:1px solid #eff2f6}.composeheading h2{font:800 22px Manrope;margin:0}.composefield{display:flex;align-items:center;gap:15px;padding:0 21px;min-height:49px;border-bottom:1px solid #eff2f6;font-size:12px;color:#7b899b}.composefield label{width:55px}.composefield input{border:0;outline:0;flex:1;min-width:0;color:#31445c;font-size:12px}.editorbar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid #eff2f6}.editorbar select{height:30px;border:1px solid #e3eaf1;border-radius:6px;padding:0 7px;color:#65768b;font-size:11px}.editorbar button{height:30px;min-width:31px;background:#f5f8fb;color:#6f8196;border-radius:6px;font-size:12px}.editorbar button:hover{background:#eaf2fd;color:#1769d2}.editor{padding:20px 22px;min-height:270px;outline:0;line-height:1.7;font-size:13px;color:#354960}.editor:empty:before{content:'Write your message here…';color:#aab4c0}.composebottom{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:13px 17px;border-top:1px solid #eff2f6}.fileinput{display:none}.filelabel{font-size:11px;color:#657990;cursor:pointer;padding:8px 10px;border:1px solid #e5ebf2;border-radius:7px}.filetag{font-size:10px;background:#f0f5fa;color:#5b7189;padding:6px 8px;border-radius:6px}.composebottom .spacer{flex:1}.toast{position:fixed;right:20px;bottom:20px;z-index:30;max-width:360px;padding:12px 16px;background:#142a43;color:white;border-radius:10px;box-shadow:var(--shadow);font-size:12px}.toast.bad{background:#a83940}.modalbg{position:fixed;inset:0;z-index:25;background:#10243c88;display:grid;place-items:center;padding:16px}.modal{width:min(470px,100%);background:#fff;border-radius:16px;padding:24px;box-shadow:var(--shadow)}.modal h2{font:800 20px Manrope;margin:0 0 7px}.modal p{font-size:12px;line-height:1.6;color:#8793a3}.modalfoot{display:flex;justify-content:flex-end;gap:9px;margin-top:18px}.status{font-size:10px;color:#93a0af;padding:13px 32px;border-top:1px solid var(--line);background:#fff}.online{display:inline-block;width:6px;height:6px;border-radius:50%;background:#2db784;margin-right:7px}
@media(max-width:900px){.sidebar{width:210px}.topbar{gap:12px;padding:0 15px}.topbar .brand{width:auto}.pagehead{padding:22px 20px 15px}.listtools{margin:0 20px}.messagelist{margin:0 20px 20px}.reader{margin:20px}.sender{width:145px}}@media(max-width:680px){.app{height:100dvh}.topbar{height:58px;padding:0 11px}.topbar .brand span:last-child{display:none}.topbar .brand{width:38px}.search{height:36px}.useremail{display:none}.workspace{position:relative}.sidebar{position:absolute;z-index:8;top:0;bottom:0;left:-260px;width:250px;transition:left .2s;box-shadow:none}.sidebar.open{left:0;box-shadow:0 0 0 100vw #10243c55}.pagehead{padding:18px 13px 13px}.pagehead h1{font-size:22px}.pagehead p{font-size:10px}.listtools{margin:0 10px;padding:8px}.messagelist{margin:0 10px 16px}.msgrow{min-height:62px;padding:0 9px;gap:7px}.sender{width:88px;font-size:10px}.subject{font-size:10px}.subject span{display:none}.msgrow time{font-size:9px}.reader{margin:12px;padding:18px 14px}.reader h2{font-size:20px}.composewrap{padding:13px 9px}.composeheading{padding:14px}.composefield{padding:0 13px}.editor{min-height:230px;padding:17px 14px}.composebottom{padding:11px}.status{padding:10px 14px}.hide-mobile{display:none!important}.authcard{padding:27px 21px}}
</style></head><body>
<div id="authScreen" class="authscreen"><div class="authcard"><div class="brand"><span class="brandmark">A</span><span>AERO Mail</span></div><h1 id="authTitle">Welcome to AERO Mail</h1><p id="authSub">Your professional email workspace.</p><div id="authNotice" class="authnotice hidden"></div><div class="field"><label>Email address</label><input id="authEmail" type="email" autocomplete="email" placeholder="you@example.com"></div><div class="field"><label>Password</label><input id="authPassword" type="password" autocomplete="current-password" placeholder="At least 8 characters"></div><div class="field hidden" id="nameField"><label>Your name</label><input id="displayName" placeholder="Full name"></div><button class="btn btn-primary" id="authSubmit" style="width:100%;height:45px">Sign in</button><div class="authswitch"><span id="authSwitchText">New to AERO Mail?</span> <button class="textlink" id="authSwitch">Create account</button></div><div class="authswitch">Secure sign-in powered by Supabase</div></div></div>
<div id="appScreen" class="app hidden"><header class="topbar"><button class="iconbtn" id="menuToggle" aria-label="Menu">☰</button><div class="brand"><span class="brandmark">A</span><span>AERO Mail</span></div><div class="search">⌕ <input id="searchInput" placeholder="Search mail and people"><span class="muted small hide-mobile">↵</span></div><div class="userarea"><span class="useremail" id="userEmail"></span><span class="avatar" id="userAvatar">A</span><button class="iconbtn" id="signOut" title="Sign out">⇥</button></div></header><div class="workspace"><aside class="sidebar" id="sidebar"><button class="btn btn-primary composebtn" id="newMail">＋ Compose email</button><div class="navtitle">MAILBOX</div><button class="navitem active" data-folder="inbox">▣ Inbox <span class="count" id="inboxCount">0</span></button><button class="navitem" data-folder="starred">☆ Starred</button><button class="navitem" data-folder="sent">➤ Sent</button><button class="navitem" data-folder="drafts">▤ Drafts</button><button class="navitem" data-folder="archive">▱ Archive</button><button class="navitem" data-folder="trash">⌫ Trash</button><div class="domainbox"><b>Your email address</b><p id="mailboxAddress">No mailbox yet</p><button class="btn btn-light" style="width:100%;font-size:11px" id="manageDomain">＋ Request a domain</button></div></aside><main class="main" id="main"></main></div><div class="status"><span class="online"></span>AERO Mail services · Protected connection</div></div>
<div id="modalBg" class="modalbg hidden"><div class="modal" id="modalContent"></div></div><div id="toast" class="toast hidden"></div>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script><script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js"></script>
<script>
(function(){
const SB_URL=__SUPABASE_URL__;const SB_KEY=__SUPABASE_ANON_KEY__;const DEFAULT_DOMAIN=__DEFAULT_DOMAIN__;
if(!window.supabase||!SB_URL||!SB_KEY){document.getElementById('authNotice').textContent='Application configuration is incomplete. Check SUPABASE_URL and SUPABASE_ANON_KEY in Render.';document.getElementById('authNotice').classList.remove('hidden');return;}
const sb=window.supabase.createClient(SB_URL,SB_KEY);let session=null,folder='inbox',currentMessage=null,mailboxes=[],attachments=[],draftId=null,isSignup=false,searchTimer=null;
const $=id=>document.getElementById(id);const main=$('main');
function toast(text,bad){$('toast').textContent=text;$('toast').classList.toggle('bad',!!bad);$('toast').classList.remove('hidden');setTimeout(()=>$('toast').classList.add('hidden'),3700);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function dateLabel(v){if(!v)return '';const d=new Date(v);if(Number.isNaN(d.getTime()))return '';const now=new Date();return d.toDateString()===now.toDateString()?d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):d.toLocaleDateString([], {month:'short',day:'numeric'});}
async function api(path,opts){opts=opts||{};opts.headers=Object.assign({},opts.headers||{},{Authorization:'Bearer '+(session?session.access_token:'')});if(opts.body&&!(opts.body instanceof FormData)&&typeof opts.body!=='string'){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(opts.body);}const r=await fetch(path,opts);let data={};try{data=await r.json();}catch(e){}if(!r.ok)throw new Error(data.error||'Request failed ('+r.status+').');return data;}
function showAuth(){ $('authScreen').classList.remove('hidden');$('appScreen').classList.add('hidden'); }
function showApp(){ $('authScreen').classList.add('hidden');$('appScreen').classList.remove('hidden');$('userEmail').textContent=session.user.email||'';$('userAvatar').textContent=(session.user.email||'A').slice(0,1).toUpperCase(); }
function setAuthMode(signup){isSignup=signup;$('authTitle').textContent=signup?'Create your AERO Mail account':'Welcome to AERO Mail';$('authSub').textContent=signup?'Start with your own professional mailbox.':'Sign in to your professional email workspace.';$('authSubmit').textContent=signup?'Create account':'Sign in';$('nameField').classList.toggle('hidden',!signup);$('authSwitchText').textContent=signup?'Already have an account?':'New to AERO Mail?';$('authSwitch').textContent=signup?'Sign in':'Create account';$('authPassword').autocomplete=signup?'new-password':'current-password';$('authNotice').classList.add('hidden');}
$('authSwitch').onclick=()=>setAuthMode(!isSignup);
$('authSubmit').onclick=async()=>{const email=$('authEmail').value.trim().toLowerCase(),password=$('authPassword').value;const notice=$('authNotice');if(!email||!password){notice.textContent='Enter your email address and password.';notice.classList.remove('hidden');notice.classList.add('autherror');return;}try{$('authSubmit').disabled=true;$('authSubmit').textContent='Please wait…';if(isSignup){const {data,error}=await sb.auth.signUp({email,password,options:{data:{display_name:$('displayName').value.trim()}}});if(error)throw error;if(data.session){session=data.session;await startApp();}else{notice.textContent='Account created. Check your email to confirm your address, then sign in.';notice.classList.remove('hidden');notice.classList.remove('autherror');setAuthMode(false);}}else{const {data,error}=await sb.auth.signInWithPassword({email,password});if(error)throw error;session=data.session;await startApp();}}catch(e){notice.textContent=e.message;notice.classList.remove('hidden');notice.classList.add('autherror');}finally{$('authSubmit').disabled=false;$('authSubmit').textContent=isSignup?'Create account':'Sign in';}};
$('authPassword').addEventListener('keydown',e=>{if(e.key==='Enter')$('authSubmit').click();});
$('signOut').onclick=async()=>{await sb.auth.signOut();session=null;showAuth();};
async function startApp(){showApp();try{const d=await api('/api/mailboxes');mailboxes=d.mailboxes||[];renderMailbox();if(!mailboxes.length){showCreateMailbox();return;}await loadMessages();}catch(e){toast(e.message,true);}}
function renderMailbox(){$('mailboxAddress').textContent=mailboxes.length?mailboxes.map(m=>m.email).join(', '):'No mailbox yet';}
function showCreateMailbox(){openModal('<h2>Create your email address</h2><p>Choose a mailbox on a domain enabled by the AERO Mail administrator.</p><div class="field"><label>Email username</label><input id="newLocal" placeholder="j" value="j"></div><div class="field"><label>Domain</label><input id="newDomain" value="'+esc(DEFAULT_DOMAIN)+'" placeholder="aero.ist"></div><div class="authnotice">A domain must be verified and enabled by the administrator before it can receive mail.</div><div class="modalfoot"><button class="btn btn-light" id="cancelModal">Cancel</button><button class="btn btn-primary" id="createMailbox">Create mailbox</button></div>');$('cancelModal').onclick=closeModal;$('createMailbox').onclick=async()=>{try{const email=$('newLocal').value.trim()+'@'+$('newDomain').value.trim();const d=await api('/api/mailboxes',{method:'POST',body:{email}});mailboxes.push(d.mailbox);renderMailbox();closeModal();toast('Mailbox created: '+email);await loadMessages();}catch(e){toast(e.message,true);}};}
function openModal(html){$('modalContent').innerHTML=html;$('modalBg').classList.remove('hidden');}function closeModal(){$('modalBg').classList.add('hidden');}
$('modalBg').onclick=e=>{if(e.target===$('modalBg'))closeModal();};
$('manageDomain').onclick=()=>{openModal('<h2>Request a custom domain</h2><p>Request an address on a domain you own. The domain owner must verify it with Resend and approve it before it becomes active.</p><div class="field"><label>Domain name</label><input id="reqDomain" placeholder="example.com"></div><div class="field"><label>Preferred mailbox name</label><input id="reqLocal" placeholder="hello"></div><div class="modalfoot"><button class="btn btn-light" id="closeReq">Cancel</button><button class="btn btn-primary" id="sendReq">Submit request</button></div>');$('closeReq').onclick=closeModal;$('sendReq').onclick=async()=>{try{const d=await api('/api/domain-requests',{method:'POST',body:{domain:$('reqDomain').value,local_part:$('reqLocal').value}});toast(d.message);closeModal();}catch(e){toast(e.message,true);}};};
$('menuToggle').onclick=()=>$('sidebar').classList.toggle('open');
document.querySelectorAll('[data-folder]').forEach(b=>b.onclick=()=>{folder=b.dataset.folder;currentMessage=null;document.querySelectorAll('.navitem').forEach(x=>x.classList.toggle('active',x===b));$('sidebar').classList.remove('open');loadMessages();});
$('searchInput').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadMessages(),250);});
async function loadMessages(){try{const q=$('searchInput').value.trim();const d=await api('/api/messages?folder='+encodeURIComponent(folder)+'&q='+encodeURIComponent(q));const rows=d.messages||[];if(folder==='inbox')$('inboxCount').textContent=rows.filter(x=>!x.is_read).length;renderList(rows);}catch(e){main.innerHTML='<div class="empty"><div><h3>Could not load mail</h3><p>'+esc(e.message)+'</p></div></div>';}}
function folderTitle(){return ({inbox:'Inbox',sent:'Sent',starred:'Starred',drafts:'Drafts',archive:'Archive',trash:'Trash'})[folder]||'Inbox';}
function renderList(rows){main.innerHTML='<div class="pagehead"><div><div class="eyebrow">YOUR WORKSPACE</div><h1>'+folderTitle()+'</h1><p>Manage your conversations and stay connected.</p></div><button class="btn btn-primary" id="headCompose">＋ Compose</button></div><div class="listtools"><span class="small muted">'+rows.length+' message'+(rows.length===1?'':'s')+'</span><span class="spacer"></span><button class="iconbtn" id="refreshList" title="Refresh">↻</button><select id="sortList"><option value="new">Newest first</option><option value="old">Oldest first</option></select></div><div class="messagelist" id="messageRows"></div>';
$('headCompose').onclick=()=>compose();$('refreshList').onclick=loadMessages;$('sortList').onchange=()=>{if($('sortList').value==='old')rows.reverse();renderRows(rows);};renderRows(rows);}
function renderRows(rows){const el=$('messageRows');if(!rows.length){el.innerHTML='<div class="empty"><div><div class="emptyicon">✉</div><h3>Your '+folderTitle().toLowerCase()+' is clear</h3><p>New messages will appear here.</p><button class="btn btn-light" id="emptyCompose">Compose email</button></div></div>';const c=$('emptyCompose');if(c)c.onclick=()=>compose();return;}el.innerHTML=rows.map(m=>'<div class="msgrow '+(!m.is_read?'unread':'')+'" data-id="'+esc(m.id)+'"><button class="star '+(m.is_starred?'on':'')+'" data-star="'+esc(m.id)+'" title="Star">'+(m.is_starred?'★':'☆')+'</button><div class="sender">'+esc(folder==='sent'?(m.to_email||[]).join(', '):(m.from_name||m.from_email))+'</div><div class="subject">'+esc(m.subject||'(no subject)')+' <span>— '+esc((m.body_text||'').slice(0,100))+'</span></div><time>'+esc(dateLabel(m.received_at))+'</time></div>').join('');el.querySelectorAll('.msgrow').forEach(row=>row.onclick=()=>openMessage(row.dataset.id));el.querySelectorAll('[data-star]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const m=rows.find(x=>x.id===b.dataset.star);try{await api('/api/messages/'+m.id,{method:'PATCH',body:{is_starred:!m.is_starred}});loadMessages();}catch(err){toast(err.message,true);}});}
async function openMessage(id){try{const d=await api('/api/messages/'+id);currentMessage=d.message;renderReader(currentMessage);}catch(e){toast(e.message,true);}}
function renderReader(m){const files=(m.attachments||[]).map((a,i)=>'<button class="att" data-download="'+i+'" type="button">↧ '+esc(a.name)+' · '+Math.max(1,Math.round((a.size||0)/1024))+' KB</button>').join('');const body=m.body_html?DOMPurify.sanitize(m.body_html):'<div style="white-space:pre-wrap">'+esc(m.body_text||'')+'</div>';const isDraft=m.folder==='drafts';main.innerHTML='<div class="reader"><div class="readerbar"><button class="btn btn-light" id="backList">← Back</button><span class="spacer"></span><button class="iconbtn" id="readerStar" title="Star">'+(m.is_starred?'★':'☆')+'</button><button class="iconbtn" id="readerArchive" title="Archive">▱</button><button class="iconbtn" id="readerTrash" title="Move to trash">⌫</button>'+(m.folder==='trash'?'<button class="iconbtn" id="readerDelete" title="Delete permanently">×</button>':'')+'</div><h2>'+esc(m.subject||'(no subject)')+'</h2><div class="fromrow"><div class="avatar">'+esc((m.from_name||m.from_email||'?').slice(0,1).toUpperCase())+'</div><div class="frommeta"><b>'+esc((m.from_name?m.from_name+' ': '')+'<'+m.from_email+'>')+'</b><span>To: '+esc((m.to_email||[]).join(', '))+'</span></div><time class="muted small">'+esc(new Date(m.received_at).toLocaleString())+'</time></div><div class="mailbody">'+body+'</div><div class="attachments">'+files+'</div><div class="readerbar"><button class="btn btn-primary" id="replyBtn">↶ Reply</button><button class="btn btn-light" id="forwardBtn">↗ Forward</button>'+(isDraft?'<button class="btn btn-light" id="editDraft">Edit draft</button>':'')+'</div></div>';
main.querySelectorAll('[data-download]').forEach(b=>b.onclick=async()=>{try{const a=(m.attachments||[])[Number(b.dataset.download)];const d=await api('/api/attachments?path='+encodeURIComponent(a.path));const link=document.createElement('a');link.href=d.url;link.target='_blank';link.rel='noopener';document.body.appendChild(link);link.click();link.remove();}catch(e){toast(e.message,true);}});$('backList').onclick=loadMessages;$('readerStar').onclick=async()=>{await api('/api/messages/'+m.id,{method:'PATCH',body:{is_starred:!m.is_starred}});openMessage(m.id);};$('readerArchive').onclick=async()=>{await api('/api/messages/'+m.id,{method:'PATCH',body:{folder:'archive'}});toast('Message archived');loadMessages();};$('readerTrash').onclick=async()=>{await api('/api/messages/'+m.id,{method:'PATCH',body:{folder:'trash'}});toast('Moved to Trash');loadMessages();};if($('readerDelete'))$('readerDelete').onclick=async()=>{if(!confirm('Permanently delete this message?'))return;await api('/api/messages/'+m.id,{method:'DELETE'});toast('Message deleted');loadMessages();};$('replyBtn').onclick=()=>compose({to:m.reply_to_email?.[0]||m.from_email,subject:'Re: '+(m.subject||''),text:'\n\nOn '+new Date(m.received_at).toLocaleString()+', '+m.from_email+' wrote:\n'+(m.body_text||'').split('\n').map(x=>'> '+x).join('\n')});$('forwardBtn').onclick=()=>compose({subject:'Fwd: '+(m.subject||''),text:'\n\n-------- Forwarded message --------\nFrom: '+m.from_email+'\nSubject: '+m.subject+'\n\n'+(m.body_text||'')});if($('editDraft'))$('editDraft').onclick=()=>compose({id:m.id,to:(m.to_email||[]).join(', '),subject:m.subject,html:m.body_html,text:m.body_text,attachments:m.attachments||[]});}
function compose(prefill){prefill=prefill||{};attachments=(prefill.attachments||[]).slice();draftId=prefill.id||null;main.innerHTML='<div class="composewrap"><div class="composeheading" style="margin-bottom:15px"><h2>Compose message</h2><button class="btn btn-light" id="closeCompose">✕ Close</button></div><div class="composecard"><div class="composefield"><label>To</label><input id="toField" placeholder="recipient@example.com" value="'+esc(prefill.to||'')+'"></div><div class="composefield"><label>Cc</label><input id="ccField" placeholder="Optional recipients" value="'+esc(prefill.cc||'')+'"></div><div class="composefield"><label>Bcc</label><input id="bccField" placeholder="Optional recipients" value="'+esc(prefill.bcc||'')+'"></div><div class="composefield"><label>Subject</label><input id="subjectField" placeholder="Email subject" value="'+esc(prefill.subject||'')+'"></div><div class="editorbar"><select id="fontSize"><option value="3">Normal</option><option value="2">Small</option><option value="4">Large</option><option value="5">Very large</option></select><button data-cmd="bold"><b>B</b></button><button data-cmd="italic"><i>I</i></button><button data-cmd="underline"><u>U</u></button><button data-cmd="insertUnorderedList">• List</button><button data-cmd="insertOrderedList">1. List</button><button data-cmd="justifyLeft">⇤</button><button data-cmd="justifyCenter">↔</button><button data-cmd="justifyRight">⇥</button><input type="color" id="fontColor" title="Text color" value="#34475e" style="width:31px;height:30px;border:0;background:transparent;padding:0"></div><div id="editor" class="editor" contenteditable="true">'+(prefill.html?DOMPurify.sanitize(prefill.html):esc(prefill.text||'').replace(/\n/g,'<br>'))+'</div><div class="composebottom"><label class="filelabel" for="fileAttach">＋ Attach files</label><input class="fileinput" id="fileAttach" type="file" multiple><button class="btn btn-light" id="aiImprove">✦ Improve writing</button><select id="writingStyle" style="border:1px solid #e5ebf2;border-radius:7px;padding:8px;font-size:11px;color:#60718a"><option>professional</option><option>friendly</option><option>formal</option><option>concise</option><option>warm</option><option>persuasive</option></select><div id="fileTags" style="display:flex;gap:5px;flex-wrap:wrap"></div><span class="spacer"></span><button class="btn btn-light" id="saveDraft">Save draft</button><button class="btn btn-primary" id="sendMail">➤ Send</button></div></div></div>';
$('closeCompose').onclick=()=>{folder='drafts';loadMessages();};document.querySelectorAll('[data-cmd]').forEach(b=>b.onclick=()=>{document.execCommand(b.dataset.cmd,false,null);$('editor').focus();});$('fontSize').onchange=()=>{document.execCommand('fontSize',false,$('fontSize').value);$('editor').focus();};$('fontColor').onchange=()=>{document.execCommand('foreColor',false,$('fontColor').value);$('editor').focus();};renderAttachmentTags();$('fileAttach').onchange=async e=>{const files=Array.from(e.target.files||[]);if(!files.length)return;const fd=new FormData();files.forEach(f=>fd.append('files',f));try{const d=await api('/api/attachments',{method:'POST',body:fd});attachments=attachments.concat(d.attachments||[]);renderAttachmentTags();toast('Attachment uploaded');}catch(err){toast(err.message,true);}e.target.value='';};$('saveDraft').onclick=saveDraft;$('sendMail').onclick=sendMail;$('aiImprove').onclick=async()=>{try{const text=$('editor').innerText;const d=await api('/api/compose/improve',{method:'POST',body:{text,style:$('writingStyle').value}});$('editor').innerText=d.text;toast('Draft improved');}catch(e){toast(e.message,true);}};}
function renderAttachmentTags(){const el=$('fileTags');if(!el)return;el.innerHTML=attachments.map((a,i)=>'<span class="filetag">'+esc(a.name)+' <button data-remove="'+i+'" style="background:none;color:#b44">×</button></span>').join('');el.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{attachments.splice(Number(b.dataset.remove),1);renderAttachmentTags();});}
function composePayload(){const html=cleanEditorHtml($('editor').innerHTML);return {id:draftId,to:$('toField').value,cc:$('ccField').value,bcc:$('bccField').value,subject:$('subjectField').value,html,text:$('editor').innerText,attachments};}
function cleanEditorHtml(html){return DOMPurify.sanitize(html,{USE_PROFILES:{html:true}});}
async function saveDraft(){try{const d=await api('/api/drafts',{method:'POST',body:composePayload()});draftId=d.id;toast('Draft saved');}catch(e){toast(e.message,true);}}
async function sendMail(){try{const payload=composePayload();$('sendMail').disabled=true;$('sendMail').textContent='Sending…';const d=await api('/api/send',{method:'POST',body:Object.assign(payload,{draftId})});toast(d.warning||'Email sent successfully');folder='sent';document.querySelectorAll('.navitem').forEach(x=>x.classList.toggle('active',x.dataset.folder===folder));loadMessages();}catch(e){toast(e.message,true);}finally{const b=$('sendMail');if(b){b.disabled=false;b.textContent='➤ Send';}}}
$('newMail').onclick=()=>compose();
setAuthMode(false);sb.auth.getSession().then(({data})=>{if(data.session){session=data.session;startApp();}});sb.auth.onAuthStateChange((_event,newSession)=>{session=newSession;if(!newSession)showAuth();});
})();
</script></body></html>`;

async function main() {
  try {
    await loadSdkClients();
    await initializeDatabase();
  } catch (e) {
    initError = e;
    console.error('AERO Mail startup configuration error:', e.message);
    // Let Render start and expose a clear health/configuration error rather than crash-looping.
  }
  app.listen(PORT, '0.0.0.0', () => console.log('AERO Mail listening on port ' + PORT));
}
main();
