import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { cfg, PLANS } from './lib/config.js';
import { LANGUAGES, LANGUAGE_BY_CODE } from './lib/languages.js';
import { db, audit } from './lib/db.js';
import { enc, dec, hashPassword, matchPassword, passwordProblem, hmac, tokenHash, randomToken } from './lib/crypto.js';
import { bus } from './lib/bus.js';
import { getPrefs, mergePrefs } from './lib/prefs.js';
import { purgeOld } from './lib/maintenance.js';
import { send, httpError, readJson, readRaw, parseMultipart, limited, clientIp, securityHeaders } from './lib/http.js';
import { currentUser, createSession, destroySession, emailClean, validEmail, publicUser, effectivePlan, newId, makeLinkCode, getUser } from './lib/auth.js';
import { saveUpload, getOwnedUpload, getUpload, readUpload, deleteUpload, publicUpload } from './lib/files.js';
import { chatTurn, usage, rateMessage, analyzeUpload } from './lib/chat.js';
import * as brain from './lib/brain.js';
import { transcribe, llmSelfCheck, llmEnabled, visionEnabled, sttEnabled, searchEnabled } from './lib/ai.js';
import { ffmpegAvailable, createJob, planAiMontage, publicJob } from './lib/media.js';
import { payInfo, createPayment, attachReceipt, decide, listPayments, publicPayment, getPayment } from './lib/billing.js';
import { startBot, botEnabled, getBotUsername, broadcast } from './lib/telegram.js';

const PUBLIC_DIR = path.join(cfg.root, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

brain.seedKnowledge();
try { for (const d of fs.readdirSync(cfg.tmpDir)) if (d.startsWith('job-')) fs.rmSync(path.join(cfg.tmpDir, d), { recursive: true, force: true }); } catch { /* */ }

// Kunlik avtomatik zaxira (oxirgi 7 ta saqlanadi). Fayllar (uploads/) uchun alohida zaxira kerak.
function autoBackup() {
  try {
    const dir = path.join(path.dirname(cfg.dbPath), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'auto-' + new Date().toISOString().slice(0, 10) + '.sqlite');
    if (!fs.existsSync(out)) db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('auto-')).sort().slice(0, -7)) fs.rmSync(path.join(dir, f), { force: true });
  } catch (e) { console.error('[backup]', e.message); }
}
async function dispatchScheduledBroadcast() {
  if (!botEnabled()) return;
  const due = db.prepare("SELECT * FROM scheduled_broadcasts WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 1").get(new Date().toISOString());
  if (!due) return;
  const claim = db.prepare("UPDATE scheduled_broadcasts SET status='sending',started_at=datetime('now') WHERE id=? AND status='scheduled'").run(due.id);
  if (!claim.changes) return;
  try {
    const result = await broadcast(due.text);
    db.prepare("UPDATE scheduled_broadcasts SET status='sent',sent=?,total=?,error=NULL WHERE id=? AND status='sending'").run(result.sent, result.total, due.id);
    audit(due.admin_id, 'broadcast.scheduled.sent', '', `${due.id} ${result.sent}/${result.total}`);
  } catch (e) {
    db.prepare("UPDATE scheduled_broadcasts SET status='failed',error=? WHERE id=? AND status='sending'").run(String(e.message || e).slice(0, 300), due.id);
    audit(due.admin_id, 'broadcast.scheduled.failed', '', due.id);
    console.error('[scheduled broadcast]', e);
  }
}
setTimeout(() => { try { purgeOld(); } catch (e) { console.error('[purge]', e.message); } }, 10000).unref();
setInterval(() => { try { purgeOld(); } catch { /* */ } }, 3600000).unref();
if (cfg.env !== 'test' && process.env.AUTO_BACKUP !== '0') { setTimeout(autoBackup, 60000).unref(); setInterval(autoBackup, 6 * 3600000).unref(); }
if (cfg.env !== 'test') setInterval(() => { dispatchScheduledBroadcast().catch((e) => console.error('[scheduled broadcast]', e)); }, 5000).unref();
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); process.exit(1); }); // docker restart qayta ishga tushiradi

// ---------------- Router ----------------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false, admin: !!opts.admin });
}
const ok = (ctx, data = {}, status = 200) => send(ctx.res, status, data);
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const decodeSeg = (s) => { try { return decodeURIComponent(s); } catch { throw httpError(400, 'Noto‘g‘ri so‘rov'); } };

async function readFile(ctx, { maxBytes, allowKinds, projectId }) {
  const ct = ctx.req.headers['content-type'] || '';
  if (!ct.startsWith('multipart/form-data')) throw httpError(400, 'Fayl multipart/form-data shaklida yuborilsin');
  const raw = await readRaw(ctx.req, maxBytes + 65536);
  const { fields, files } = parseMultipart(raw, ct);
  const f = files.find((x) => x.name === 'file') || files[0];
  if (!f) throw httpError(400, 'Fayl tanlanmadi');
  return { fields, up: saveUpload({ userId: ctx.user.id, buf: f.data, name: f.filename, clientType: f.type, maxBytes, allowKinds, projectId: projectId ?? (fields.project_id || null) }) };
}

// ---------------- Public ----------------
route('GET', '/api/health', (ctx) => { db.prepare('SELECT 1').get(); ok(ctx, { ok: true, app: 'SYNAPTOX', time: new Date().toISOString() }); }, { auth: false });
route('GET', '/api/config', (ctx) => ok(ctx, {
  contact: cfg.contact, bot: botEnabled() ? getBotUsername() : '', pwMin: 10,
  languages: LANGUAGES,
  features: { llm: llmEnabled(), aiMontage: llmEnabled(), search: searchEnabled(), vision: visionEnabled(), stt: sttEnabled(), montage: ffmpegAvailable, payments: payInfo().configured },
  plans: Object.values(PLANS),
}), { auth: false });

// ---------------- Auth ----------------
route('POST', '/api/auth/register', async (ctx) => {
  if (limited('reg:' + ctx.ip, 10, 3600000)) throw httpError(429, 'Juda ko‘p urinish. Keyinroq qayta urinib ko‘ring.');
  const b = await readJson(ctx.req);
  if (b.website) throw httpError(400, 'So‘rov rad etildi'); // honeypot: botlar to'ldiradi
  const name = str(b.name, 70).replace(/[\u0000-\u001f<>]/g, ''), email = emailClean(b.email), password = String(b.password || '');
  if (name.length < 2) throw httpError(400, 'Ism kamida 2 ta belgidan iborat bo‘lsin');
  if (!validEmail(email)) throw httpError(400, 'Email manzilini tekshiring');
  const pwErr = passwordProblem(password, email, name);
  if (pwErr) throw httpError(400, pwErr);
  const id = newId();
  const pwHash = await hashPassword(password);
  try { db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)').run(id, email, name, pwHash); } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw httpError(409, 'Bu email bilan akkaunt mavjud');
    throw e;
  }
  audit(id, 'register', ctx.ip);
  createSession(ctx.res, id, ctx.req);
  ok(ctx, { user: publicUser(getUser(id)) }, 201);
}, { auth: false });

route('POST', '/api/auth/login', async (ctx) => {
  if (limited('login:' + ctx.ip, 20, 900000)) throw httpError(429, 'Juda ko‘p urinish. 15 daqiqadan keyin qayta urinib ko‘ring.');
  const b = await readJson(ctx.req);
  const email = emailClean(b.email), password = String(b.password || '').slice(0, 200);
  if (limited('login-email:' + email, 8, 900000)) throw httpError(429, 'Bu akkaunt uchun juda ko‘p urinish. 15 daqiqadan keyin urinib ko‘ring.');
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const good = u && u.password_hash ? await matchPassword(password, u.password_hash) : (await matchPassword(password, 'aa:' + '0'.repeat(128)), false); // vaqt farqini yashirish
  if (!good) { audit(u?.id, 'login.fail', ctx.ip); throw httpError(401, 'Email yoki parol noto‘g‘ri'); }
  if (u.blocked) throw httpError(403, 'Akkaunt bloklangan. Admin bilan bog‘laning: ' + cfg.contact);
  audit(u.id, 'login', ctx.ip);
  createSession(ctx.res, u.id, ctx.req);
  ok(ctx, { user: publicUser(u) });
}, { auth: false });

route('POST', '/api/auth/logout', (ctx) => { destroySession(ctx.req, ctx.res); ok(ctx, { ok: true }); }, { auth: false });
route('POST', '/api/auth/logout-all', (ctx) => { db.prepare('DELETE FROM sessions WHERE user_id=?').run(ctx.user.id); destroySession(ctx.req, ctx.res); audit(ctx.user.id, 'logout.all', ctx.ip); ok(ctx, { ok: true }); });
route('GET', '/api/auth/me', (ctx) => ok(ctx, { user: publicUser(ctx.user), usage: usage(ctx.user), plan: effectivePlan(ctx.user) }));


// ---- Telegram orqali kirish / ro'yxatdan o'tish (email shart emas) ----
route('POST', '/api/auth/tg-start', async (ctx) => {
  if (!botEnabled() || !getBotUsername()) throw httpError(503, 'Telegram bot hozircha ulanmagan', 'NO_BOT');
  if (limited('tgstart:' + ctx.ip, 10, 600000)) throw httpError(429, 'Juda ko‘p urinish. Biroz kuting.');
  const token = randomToken(24);
  db.prepare('DELETE FROM tg_logins WHERE expires_at<?').run(Date.now());
  db.prepare('INSERT INTO tg_logins(token_hash,ip,ua,expires_at) VALUES(?,?,?,?)').run(tokenHash('tgl:' + token), ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 160), Date.now() + 5 * 60000);
  ok(ctx, { token, url: `https://t.me/${getBotUsername()}?start=login_${token}`, expires_in: 300 });
}, { auth: false });
route('POST', '/api/auth/tg-poll', async (ctx) => {
  if (limited('tgpoll:' + ctx.ip, 200, 600000)) throw httpError(429, 'Juda ko‘p so‘rov');
  const token = String((await readJson(ctx.req)).token || '');
  if (!/^[0-9a-f]{48}$/.test(token)) throw httpError(400, 'Noto‘g‘ri kod');
  const h = tokenHash('tgl:' + token);
  const row = db.prepare('SELECT * FROM tg_logins WHERE token_hash=?').get(h);
  if (!row || row.expires_at < Date.now() || row.status === 'cancelled' || row.status === 'used') throw httpError(410, 'Kirish so‘rovi eskirgan yoki bekor qilingan. Qaytadan urinib ko‘ring.');
  if (row.status === 'pending') return ok(ctx, { status: 'pending' });
  const u = getUser(row.user_id);
  if (!u || u.blocked) throw httpError(403, 'Akkaunt bloklangan. Admin: ' + cfg.contact);
  db.prepare("UPDATE tg_logins SET status='used' WHERE token_hash=? AND status='confirmed'").run(h);
  audit(u.id, 'login.telegram', ctx.ip);
  createSession(ctx.res, u.id, ctx.req);
  ok(ctx, { status: 'ok', user: publicUser(u) });
}, { auth: false });

// ---- Parolni tiklash: kod Telegram orqali yuboriladi (SMTP kerak emas) ----
route('POST', '/api/auth/forgot', async (ctx) => {
  const email = emailClean((await readJson(ctx.req)).email);
  if (limited('forgot:' + ctx.ip, 5, 3600000) || limited('forgot-email:' + email, 3, 3600000)) throw httpError(429, 'Juda ko‘p urinish. Keyinroq urinib ko‘ring.');
  const u = validEmail(email) ? db.prepare('SELECT * FROM users WHERE email=?').get(email) : null;
  if (u && u.tg_id && !u.blocked && botEnabled()) {
    const code = randomToken(4).toUpperCase();
    db.prepare('INSERT OR REPLACE INTO reset_codes(user_id,code_hash,attempts,expires_at) VALUES(?,?,0,?)').run(u.id, hmac('reset:' + code), Date.now() + 10 * 60000);
    bus.emit('auth:reset', { userId: u.id, code });
    audit(u.id, 'password.forgot', ctx.ip);
  }
  // Akkaunt mavjudligini oshkor qilmaslik uchun javob har doim bir xil
  ok(ctx, { ok: true, message: 'Agar bu email Telegramga bog‘langan akkauntga tegishli bo‘lsa, tiklash kodi botga yuborildi (10 daqiqa amal qiladi). Telegram bog‘lanmagan bo‘lsa, admin bilan bog‘laning: ' + cfg.contact });
}, { auth: false });
route('POST', '/api/auth/reset', async (ctx) => {
  const b = await readJson(ctx.req);
  const email = emailClean(b.email), code = String(b.code || '').trim().toUpperCase(), password = String(b.password || '');
  if (limited('reset:' + ctx.ip, 15, 3600000) || limited('reset-email:' + email, 10, 3600000)) throw httpError(429, 'Juda ko‘p urinish');
  const bad = () => httpError(400, 'Kod noto‘g‘ri yoki muddati o‘tgan');
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const rc = u && db.prepare('SELECT * FROM reset_codes WHERE user_id=?').get(u.id);
  if (!rc || rc.expires_at < Date.now() || rc.attempts >= 5) throw bad();
  if (rc.code_hash !== hmac('reset:' + code)) { db.prepare('UPDATE reset_codes SET attempts=attempts+1 WHERE user_id=?').run(u.id); throw bad(); }
  const pwErr = passwordProblem(password, email, u.name);
  if (pwErr) throw httpError(400, pwErr);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(password), u.id);
  db.prepare('DELETE FROM reset_codes WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  audit(u.id, 'password.reset', ctx.ip);
  ok(ctx, { ok: true });
}, { auth: false });

route('POST', '/api/auth/change-password', async (ctx) => {
  if (limited('pw:' + ctx.user.id, 10, 900000)) throw httpError(429, 'Juda ko‘p urinish');
  const b = await readJson(ctx.req);
  const next = String(b.next || '');
  if (ctx.user.password_hash && !(await matchPassword(String(b.current || ''), ctx.user.password_hash))) throw httpError(403, 'Joriy parol noto‘g‘ri');
  if (!ctx.user.password_hash) throw httpError(400, 'Telegram akkauntida parol yo‘q. Saytda email bilan ro‘yxatdan o‘tib, /link orqali bog‘lang.');
  const pwErr = passwordProblem(next, ctx.user.email, ctx.user.name);
  if (pwErr) throw httpError(400, pwErr);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(next), ctx.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(ctx.user.id); // boshqa qurilmalardan chiqarish
  createSession(ctx.res, ctx.user.id, ctx.req);
  audit(ctx.user.id, 'password.change', ctx.ip);
  ok(ctx, { ok: true });
});

route('POST', '/api/me/delete', async (ctx) => {
  const b = await readJson(ctx.req);
  if (ctx.user.password_hash ? !(await matchPassword(String(b.password || ''), ctx.user.password_hash)) : b.confirm !== 'DELETE') throw httpError(403, 'Tasdiqlash noto‘g‘ri');
  if (ctx.user.role === 'admin') throw httpError(400, 'Admin akkauntini bu yerdan o‘chirib bo‘lmaydi');
  for (const up of db.prepare('SELECT * FROM uploads WHERE user_id=?').all(ctx.user.id)) deleteUpload(up);
  audit(ctx.user.id, 'account.delete', ctx.ip);
  db.prepare('DELETE FROM users WHERE id=?').run(ctx.user.id); // CASCADE
  db.prepare("DELETE FROM knowledge WHERE scope=?").run(ctx.user.id);
  destroySession(ctx.req, ctx.res);
  ok(ctx, { ok: true });
});

route('GET', '/api/me/export', (ctx) => {
  const u = ctx.user;
  const convs = db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY created_at').all(u.id).map((c) => ({
    id: c.id, title: dec(c.title_enc), created_at: c.created_at,
    messages: db.prepare('SELECT role,content_enc,created_at FROM messages WHERE conversation_id=? ORDER BY rowid').all(c.id).map((m) => ({ role: m.role, content: dec(m.content_enc), created_at: m.created_at })),
  }));
  const data = {
    exported_at: new Date().toISOString(), profile: publicUser(u), conversations: convs,
    projects: db.prepare('SELECT * FROM projects WHERE user_id=?').all(u.id).map((p) => ({ ...p, notes: dec(p.notes_enc), notes_enc: undefined })),
    files: db.prepare('SELECT id,original_name,mime_type,size,created_at FROM uploads WHERE user_id=?').all(u.id),
    memory: db.prepare('SELECT question,answer,source FROM knowledge WHERE scope=?').all(u.id).map((k) => ({ question: dec(k.question), answer: dec(k.answer), source: k.source })),
  };
  send(ctx.res, 200, JSON.stringify(data, null, 2), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="synaptox-export.json"' });
});

// ---------------- Profile ----------------
route('PATCH', '/api/profile', async (ctx) => {
  const b = await readJson(ctx.req);
  const name = b.name === undefined ? ctx.user.name : str(b.name, 70);
  if (name.length < 2) throw httpError(400, 'Ism kamida 2 ta belgi bo‘lsin');
  const lang = b.lang === undefined ? ctx.user.lang : (LANGUAGE_BY_CODE.has(b.lang) ? b.lang : 'uz');
  const phone = b.phone === undefined ? ctx.user.phone : str(b.phone, 30);
  if (phone && !/^[+\d\s()-]{5,30}$/.test(phone)) throw httpError(400, 'Telefon raqami noto‘g‘ri');
  const bio = b.bio === undefined ? ctx.user.bio : str(b.bio, 300);
  db.prepare('UPDATE users SET name=?,lang=?,phone=?,bio=? WHERE id=?').run(name, lang, phone, bio, ctx.user.id);
  ok(ctx, { user: publicUser(getUser(ctx.user.id)) });
});
route('POST', '/api/profile/avatar', async (ctx) => {
  const { up } = await readFile(ctx, { maxBytes: 3 * 1048576, allowKinds: ['image'], projectId: null });
  if (ctx.user.avatar_id) { const old = getOwnedUpload(ctx.user.avatar_id, ctx.user.id); if (old) deleteUpload(old); }
  db.prepare('UPDATE users SET avatar_id=? WHERE id=?').run(up.id, ctx.user.id);
  ok(ctx, { user: publicUser(getUser(ctx.user.id)) });
});
route('POST', '/api/telegram/link-code', (ctx) => ok(ctx, { code: makeLinkCode(ctx.user.id), bot: getBotUsername(), expires_in: 600 }));
route('POST', '/api/telegram/unlink', (ctx) => {
  if (!ctx.user.password_hash) throw httpError(400, 'Faqat Telegram bilan kirilgan akkauntni uzib bo‘lmaydi');
  db.prepare('UPDATE users SET tg_id=NULL, tg_username=NULL WHERE id=?').run(ctx.user.id);
  ok(ctx, { user: publicUser(getUser(ctx.user.id)) });
});

// ---------------- Chat ----------------
route('GET', '/api/conversations', (ctx) => ok(ctx, {
  conversations: db.prepare('SELECT id,title_enc,project_id,source,created_at,updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 200').all(ctx.user.id)
    .map((c) => ({ id: c.id, title: dec(c.title_enc), project_id: c.project_id, source: c.source, created_at: c.created_at, updated_at: c.updated_at })),
}));
route('GET', '/api/conversations/:id/messages', (ctx) => {
  const c = db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(ctx.params.id, ctx.user.id);
  if (!c) throw httpError(404, 'Suhbat topilmadi');
  ok(ctx, { messages: db.prepare('SELECT id,role,content_enc,meta,rating,created_at FROM messages WHERE conversation_id=? ORDER BY rowid').all(c.id).map((m) => ({ id: m.id, role: m.role, content: dec(m.content_enc), source: m.meta ? JSON.parse(m.meta).source : undefined, rating: m.rating, created_at: m.created_at })) });
});
route('PATCH', '/api/conversations/:id', async (ctx) => {
  const b = await readJson(ctx.req);
  const title = str(b.title, 80);
  if (!title) throw httpError(400, 'Sarlavha bo‘sh bo‘lmasin');
  const r = db.prepare('UPDATE conversations SET title_enc=? WHERE id=? AND user_id=?').run(enc(title), ctx.params.id, ctx.user.id);
  if (!r.changes) throw httpError(404, 'Suhbat topilmadi');
  ok(ctx, { ok: true });
});
route('DELETE', '/api/conversations/:id', (ctx) => {
  const r = db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(ctx.params.id, ctx.user.id);
  if (!r.changes) throw httpError(404, 'Suhbat topilmadi');
  ok(ctx, { ok: true });
});
route('POST', '/api/chat', async (ctx) => {
  if (limited('chat:' + ctx.user.id, 30, 60000)) throw httpError(429, 'Xabarlar juda tez yuborilmoqda. Bir daqiqa kuting.');
  const b = await readJson(ctx.req);
  const text = String(b.message || '').trim();
  if (!text || text.length > 12000) throw httpError(400, 'Xabar 1–12000 belgi bo‘lishi kerak');
  const uploads = (Array.isArray(b.uploadIds) ? b.uploadIds.slice(0, 5) : []).map((id) => getOwnedUpload(id, ctx.user.id));
  if (uploads.some((u) => !u)) throw httpError(404, 'Fayl topilmadi');
  const projectId = b.projectId && db.prepare('SELECT 1 FROM projects WHERE id=? AND user_id=?').get(String(b.projectId), ctx.user.id) ? String(b.projectId) : null;
  const r = await chatTurn({ user: ctx.user, text, conversationId: String(b.conversationId || ''), source: 'web', projectId, uploads });
  ok(ctx, r);
});
route('POST', '/api/messages/:id/rating', async (ctx) => {
  const b = await readJson(ctx.req);
  if (!rateMessage(ctx.user.id, ctx.params.id, Number(b.rating) || 0)) throw httpError(404, 'Xabar topilmadi');
  ok(ctx, { ok: true });
});
route('POST', '/api/voice', async (ctx) => {
  if (!sttEnabled()) throw httpError(503, 'Serverda ovozni matnga aylantirish sozlanmagan (STT_URL). Brauzer mikrofonidan foydalaning.', 'STT_UNAVAILABLE');
  if (limited('voice:' + ctx.user.id, 20, 60000)) throw httpError(429, 'Juda tez');
  const raw = await readRaw(ctx.req, 15 * 1048576);
  const { files, fields } = parseMultipart(raw, ctx.req.headers['content-type']);
  if (!files[0]) throw httpError(400, 'Audio topilmadi');
  const language = String(fields.language || '').toLowerCase();
  const text = await transcribe(files[0].data, files[0].filename || 'voice.webm', files[0].type || 'audio/webm', LANGUAGE_BY_CODE.has(language) ? language : '');
  if (!text) throw httpError(422, 'Ovozni tanib bo‘lmadi');
  ok(ctx, { text });
});

// ---------------- Projects ----------------
const projRow = (p) => ({ id: p.id, name: p.name, description: p.description, status: p.status, created_at: p.created_at, updated_at: p.updated_at });
const ownedProject = (id, userId) => db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(id, userId);
route('GET', '/api/projects', (ctx) => ok(ctx, {
  projects: db.prepare('SELECT p.*, (SELECT count(*) FROM tasks t WHERE t.project_id=p.id) tasks, (SELECT count(*) FROM tasks t WHERE t.project_id=p.id AND t.done=1) done, (SELECT count(*) FROM uploads u WHERE u.project_id=p.id) files FROM projects p WHERE p.user_id=? ORDER BY p.updated_at DESC, p.rowid DESC').all(ctx.user.id)
    .map((p) => ({ ...projRow(p), tasks: p.tasks, done: p.done, files: p.files })),
}));
route('POST', '/api/projects', async (ctx) => {
  const b = await readJson(ctx.req);
  const name = str(b.name, 100), description = str(b.description, 1000);
  if (name.length < 2) throw httpError(400, 'Loyiha nomi kamida 2 ta belgi bo‘lsin');
  if (db.prepare('SELECT count(*) n FROM projects WHERE user_id=?').get(ctx.user.id).n >= 200) throw httpError(400, 'Loyihalar soni chegarasi (200)');
  const id = newId();
  db.prepare('INSERT INTO projects(id,user_id,name,description) VALUES(?,?,?,?)').run(id, ctx.user.id, name, description);
  ok(ctx, { project: projRow(ownedProject(id, ctx.user.id)) }, 201);
});
route('GET', '/api/projects/:id', (ctx) => {
  const p = ownedProject(ctx.params.id, ctx.user.id);
  if (!p) throw httpError(404, 'Loyiha topilmadi');
  ok(ctx, {
    project: { ...projRow(p), notes: dec(p.notes_enc) || '' },
    tasks: db.prepare('SELECT id,title,done,created_at FROM tasks WHERE project_id=? ORDER BY done, rowid').all(p.id),
    files: db.prepare('SELECT * FROM uploads WHERE project_id=? ORDER BY created_at DESC').all(p.id).map(publicUpload),
    conversations: db.prepare('SELECT id,title_enc,updated_at FROM conversations WHERE project_id=? ORDER BY updated_at DESC').all(p.id).map((c) => ({ id: c.id, title: dec(c.title_enc), updated_at: c.updated_at })),
  });
});
route('PATCH', '/api/projects/:id', async (ctx) => {
  const p = ownedProject(ctx.params.id, ctx.user.id);
  if (!p) throw httpError(404, 'Loyiha topilmadi');
  const b = await readJson(ctx.req);
  const name = b.name === undefined ? p.name : str(b.name, 100);
  if (name.length < 2) throw httpError(400, 'Loyiha nomi kamida 2 ta belgi bo‘lsin');
  const status = b.status === undefined ? p.status : (['active', 'paused', 'done'].includes(b.status) ? b.status : p.status);
  db.prepare("UPDATE projects SET name=?,description=?,status=?,notes_enc=?,updated_at=datetime('now') WHERE id=?")
    .run(name, b.description === undefined ? p.description : str(b.description, 1000), status, b.notes === undefined ? p.notes_enc : enc(String(b.notes).slice(0, 20000)), p.id);
  ok(ctx, { project: projRow(ownedProject(p.id, ctx.user.id)) });
});
route('DELETE', '/api/projects/:id', (ctx) => {
  const r = db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(ctx.params.id, ctx.user.id);
  if (!r.changes) throw httpError(404, 'Loyiha topilmadi');
  ok(ctx, { ok: true });
});
route('POST', '/api/projects/:id/tasks', async (ctx) => {
  const p = ownedProject(ctx.params.id, ctx.user.id);
  if (!p) throw httpError(404, 'Loyiha topilmadi');
  const title = str((await readJson(ctx.req)).title, 200);
  if (!title) throw httpError(400, 'Vazifa matni bo‘sh');
  const id = newId();
  db.prepare('INSERT INTO tasks(id,project_id,title) VALUES(?,?,?)').run(id, p.id, title);
  ok(ctx, { task: db.prepare('SELECT id,title,done FROM tasks WHERE id=?').get(id) }, 201);
});
route('PATCH', '/api/tasks/:id', async (ctx) => {
  const t = db.prepare('SELECT t.* FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND p.user_id=?').get(ctx.params.id, ctx.user.id);
  if (!t) throw httpError(404, 'Vazifa topilmadi');
  const b = await readJson(ctx.req);
  db.prepare('UPDATE tasks SET done=?, title=? WHERE id=?').run(b.done === undefined ? t.done : (b.done ? 1 : 0), b.title === undefined ? t.title : (str(b.title, 200) || t.title), t.id);
  ok(ctx, { ok: true });
});
route('DELETE', '/api/tasks/:id', (ctx) => {
  const r = db.prepare('DELETE FROM tasks WHERE id=? AND project_id IN (SELECT id FROM projects WHERE user_id=?)').run(ctx.params.id, ctx.user.id);
  if (!r.changes) throw httpError(404, 'Vazifa topilmadi');
  ok(ctx, { ok: true });
});

// ---------------- Files ----------------
route('GET', '/api/uploads', (ctx) => ok(ctx, { uploads: db.prepare("SELECT * FROM uploads WHERE user_id=? AND id<>COALESCE((SELECT avatar_id FROM users WHERE id=?),'') AND id NOT IN (SELECT receipt_upload_id FROM payments WHERE receipt_upload_id IS NOT NULL) ORDER BY created_at DESC, rowid DESC LIMIT 500").all(ctx.user.id, ctx.user.id).map(publicUpload) }));
route('POST', '/api/uploads', async (ctx) => {
  const limit = Math.min(effectivePlan(ctx.user).uploadMb, cfg.maxUploadMb) * 1048576;
  const { up } = await readFile(ctx, { maxBytes: limit });
  audit(ctx.user.id, 'upload', ctx.ip, up.kind + ' ' + up.size);
  ok(ctx, { upload: publicUpload(up) }, 201);
});
route('PATCH', '/api/uploads/:id', async (ctx) => {
  const up = getOwnedUpload(ctx.params.id, ctx.user.id);
  if (!up) throw httpError(404, 'Fayl topilmadi');
  const b = await readJson(ctx.req);
  const pid = b.project_id ? String(b.project_id) : null;
  if (pid && !ownedProject(pid, ctx.user.id)) throw httpError(404, 'Loyiha topilmadi');
  const name = b.name === undefined ? up.original_name : (str(b.name, 200) || up.original_name);
  db.prepare('UPDATE uploads SET project_id=?, original_name=? WHERE id=?').run(b.project_id === undefined ? up.project_id : pid, name, up.id);
  ok(ctx, { upload: publicUpload(getUpload(up.id)) });
});
route('DELETE', '/api/uploads/:id', (ctx) => {
  const up = getOwnedUpload(ctx.params.id, ctx.user.id);
  if (!up) throw httpError(404, 'Fayl topilmadi');
  if (ctx.user.avatar_id === up.id) db.prepare('UPDATE users SET avatar_id=NULL WHERE id=?').run(ctx.user.id);
  deleteUpload(up);
  ok(ctx, { ok: true });
});
route('POST', '/api/uploads/:id/analyze', async (ctx) => {
  const up = getOwnedUpload(ctx.params.id, ctx.user.id);
  if (!up) throw httpError(404, 'Fayl topilmadi');
  if (limited('analyze:' + ctx.user.id, 20, 60000)) throw httpError(429, 'Juda tez');
  const text = await analyzeUpload(up, true);
  if (!text) throw httpError(422, up.kind === 'video' ? 'Video mazmunini tahlil qilish qo‘llab-quvvatlanmaydi (audio yo‘lakni «Montaj» orqali ajratib oling)' : up.kind === 'image' ? 'Rasmni tavsiflash uchun vision modeli (OLLAMA_VISION_MODEL) sozlanmagan' : up.kind === 'audio' ? 'Ovozni matnga aylantirish (STT_URL) sozlanmagan' : 'Matnni ajratib bo‘lmadi', 'NO_ANALYZER');
  ok(ctx, { text, summary: brain.quickSummary(text, up.original_name) });
});
route('GET', '/api/files/:id', (ctx) => serveUpload(ctx, getOwnedUpload(ctx.params.id, ctx.user.id)));

function serveUpload(ctx, up) {
  if (!up) throw httpError(404, 'Fayl topilmadi');
  const buf = readUpload(up);
  const inline = ['image', 'video', 'audio'].includes(up.kind) || up.mime_type === 'application/pdf';
  const download = new URL(ctx.req.url, 'http://x').searchParams.get('download') === '1';
  const headers = {
    'Content-Type': up.mime_type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0, must-revalidate',
    'Content-Disposition': `${inline && !download ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(up.original_name)}`,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(ctx.req.headers.range || '');
  if (range && buf.length) {
    let start = range[1] === '' ? Math.max(0, buf.length - Number(range[2])) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? buf.length - 1 : Math.min(Number(range[2]), buf.length - 1);
    if (start > end || start >= buf.length) return send(ctx.res, 416, '', { 'Content-Range': `bytes */${buf.length}` });
    return send(ctx.res, 206, buf.subarray(start, end + 1), { ...headers, 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Content-Length': end - start + 1 });
  }
  send(ctx.res, 200, buf, { ...headers, 'Content-Length': buf.length });
}

// ---------------- Montage ----------------
route('POST', '/api/montage/ai-plan', async (ctx) => {
  if (limited('montage-ai:' + ctx.user.id, 10, 3600000)) throw httpError(429, 'AI montaj so‘rovlari limiti tugadi. Bir soatdan keyin qayta urinib ko‘ring.');
  const b = await readJson(ctx.req);
  const prompt = str(b.prompt, 500);
  if (!prompt) throw httpError(400, 'AI montaj uchun qanday video kerakligini yozing');
  const plan = await planAiMontage(ctx.user.id, { prompt, clipIds: b.clipIds, musicIds: Array.isArray(b.musicIds) ? b.musicIds.slice(0, 20) : [] });
  audit(ctx.user.id, 'montage.ai.plan', ctx.ip, `${plan.clips.length} clips`);
  ok(ctx, { plan });
});
route('POST', '/api/montage', async (ctx) => {
  const b = await readJson(ctx.req);
  const plan = effectivePlan(ctx.user);
  let kind = b.kind === 'extract_audio' ? 'extract_audio' : 'montage', spec;
  if (kind === 'extract_audio') spec = { uploadId: String(b.uploadId || '') };
  else {
    if (!Array.isArray(b.clips) || !b.clips.length) throw httpError(400, 'Kamida bitta klip tanlang');
    spec = {
      clips: b.clips.slice(0, 20).map((c) => ({ uploadId: String(c.uploadId || ''), start: Number(c.start) || 0, end: c.end === '' || c.end == null ? undefined : Number(c.end), duration: Number(c.duration) || 3 })),
      preset: String(b.preset || '720p'), filter: String(b.filter || 'none'), speed: Number(b.speed) || 1, text: str(b.text, 120), mute: !!b.mute,
      musicUploadId: b.musicUploadId ? String(b.musicUploadId) : '', musicMode: b.musicMode === 'replace' ? 'replace' : 'mix', musicVolume: Number(b.musicVolume ?? 0.6), name: str(b.name, 60),
    };
  }
  const id = createJob(ctx.user, kind, spec, plan);
  audit(ctx.user.id, 'montage.start', ctx.ip, kind);
  ok(ctx, { job: publicJob(db.prepare('SELECT * FROM video_jobs WHERE id=?').get(id)) }, 202);
});
route('GET', '/api/montage', (ctx) => ok(ctx, { jobs: db.prepare('SELECT * FROM video_jobs WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 30').all(ctx.user.id).map(publicJob) }));
route('GET', '/api/montage/:id', (ctx) => {
  const j = db.prepare('SELECT * FROM video_jobs WHERE id=? AND user_id=?').get(ctx.params.id, ctx.user.id);
  if (!j) throw httpError(404, 'Ish topilmadi');
  ok(ctx, { job: publicJob(j) });
});

// ---------------- Billing ----------------
route('GET', '/api/billing', (ctx) => ok(ctx, {
  plan: effectivePlan(ctx.user), plan_until: ctx.user.plan_until, plans: Object.values(PLANS), pay: payInfo(),
  payments: listPayments(ctx.user.id).map(publicPayment), usage: usage(ctx.user),
}));
route('POST', '/api/billing/checkout', async (ctx) => {
  if (!payInfo().configured) throw httpError(503, 'To‘lov rekvizitlari hali sozlanmagan. Admin bilan bog‘laning: ' + cfg.contact, 'PAY_NOT_CONFIGURED');
  if (limited('checkout:' + ctx.user.id, 10, 3600000)) throw httpError(429, 'Juda ko‘p urinish');
  const b = await readJson(ctx.req);
  ok(ctx, { payment: publicPayment(createPayment(ctx.user, String(b.plan || ''))), pay: payInfo() }, 201);
});
route('POST', '/api/billing/:id/receipt', async (ctx) => {
  const p = getPayment(ctx.params.id);
  if (!p || p.user_id !== ctx.user.id) throw httpError(404, 'To‘lov topilmadi');
  const { up } = await readFile(ctx, { maxBytes: 10 * 1048576, allowKinds: ['image', 'document'], projectId: null });
  ok(ctx, { payment: publicPayment(attachReceipt(ctx.user, p.id, up.id)) });
});

// ---------------- Admin ----------------
const A = { admin: true };
const csvCell = (value) => {
  let text = String(value ?? '');
  if (/^[\s]*[=+@]|^[\s]*-(?!\d)/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};
function paymentFilters(url) {
  const params = url.searchParams;
  const status = params.get('status') || 'all';
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const q = String(params.get('q') || '').trim().slice(0, 100).replace(/[%_]/g, '');
  if (!['all', 'awaiting_receipt', 'review', 'approved', 'rejected', 'cancelled'].includes(status)) throw httpError(400, 'To‘lov holati noto‘g‘ri');
  const validDate = (value) => {
    if (!value) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!validDate(from) || !validDate(to)) throw httpError(400, 'Sana YYYY-MM-DD formatida bo‘lsin');
  if (from && to && from > to) throw httpError(400, 'Boshlanish sanasi tugash sanasidan keyin bo‘lmasin');
  return { status, from, to, q };
}
function getFilteredPayments(filters) {
  const rows = db.prepare(`SELECT p.*,u.name uname,u.email uemail,u.tg_username utg
    FROM payments p JOIN users u ON u.id=p.user_id
    WHERE (?='all' OR p.status=?)
      AND (?='' OR date(p.created_at)>=?)
      AND (?='' OR date(p.created_at)<=?)
      AND (?='' OR lower(u.name) LIKE '%'||lower(?)||'%' OR lower(COALESCE(u.email,'')) LIKE '%'||lower(?)||'%' OR lower(COALESCE(u.tg_username,'')) LIKE '%'||lower(?)||'%')
    ORDER BY p.created_at DESC LIMIT 1000`).all(filters.status, filters.status, filters.from, filters.from, filters.to, filters.to, filters.q, filters.q, filters.q, filters.q);
  const summary = rows.reduce((s, p) => {
    s.count++;
    if (p.status === 'approved') s.approved_total += p.amount;
    if (p.status === 'review') s.pending++;
    return s;
  }, { count: 0, approved_total: 0, pending: 0 });
  return { rows, summary };
}
function recordUndo(adminId, action, detail, snapshot) {
  const id = newId();
  db.prepare('INSERT INTO admin_undo(id,admin_id,action,detail,snapshot_json,expires_at) VALUES(?,?,?,?,?,?)')
    .run(id, adminId, action, detail.slice(0, 200), JSON.stringify(snapshot), Date.now() + 15 * 60000);
  return id;
}
route('GET', '/api/admin/overview', (ctx) => {
  const c = (sql, ...a) => db.prepare(sql).get(...a).n;
  const activity = db.prepare(`
    WITH RECURSIVE days(day) AS (
      SELECT date('now', '-13 days')
      UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < date('now')
    ),
    registration_days AS (SELECT date(created_at) day, count(*) n FROM users WHERE created_at >= date('now', '-13 days') GROUP BY date(created_at)),
    message_days AS (SELECT date(created_at) day, count(*) n FROM messages WHERE role='user' AND created_at >= date('now', '-13 days') GROUP BY date(created_at))
    SELECT days.day, COALESCE(registration_days.n, 0) registrations, COALESCE(message_days.n, 0) messages
    FROM days LEFT JOIN registration_days ON registration_days.day=days.day
      LEFT JOIN message_days ON message_days.day=days.day ORDER BY days.day
  `).all();
  ok(ctx, {
    users: c('SELECT count(*) n FROM users'), paid: c("SELECT count(*) n FROM users WHERE plan<>'free' AND plan_until>?", Date.now()),
    new_users_7d: c("SELECT count(*) n FROM users WHERE created_at>=date('now','-6 days')"),
    active_today: c("SELECT count(*) n FROM users WHERE last_seen>=date('now')"),
    messages_today: c("SELECT count(*) n FROM messages WHERE role='user' AND created_at>=date('now')"), messages_total: c("SELECT count(*) n FROM messages WHERE role='user'"),
    files: c('SELECT count(*) n FROM uploads'), pending_payments: c("SELECT count(*) n FROM payments WHERE status='review'"),
    projects: c('SELECT count(*) n FROM projects'), failed_jobs: c("SELECT count(*) n FROM video_jobs WHERE status='failed'"),
    revenue: c("SELECT COALESCE(sum(amount),0) n FROM payments WHERE status='approved'"), knowledge: c("SELECT count(*) n FROM knowledge WHERE scope='global'"),
    telegram_users: c('SELECT count(*) n FROM users WHERE tg_id IS NOT NULL'),
    alerts: [
      { id: 'login_failures', label: 'Oxirgi 24 soatda muvaffaqiyatsiz kirishlar', count: c("SELECT count(*) n FROM audit_log WHERE action='login.fail' AND created_at>=datetime('now','-1 day')"), level: 'warn' },
      { id: 'failed_jobs', label: 'Oxirgi 24 soatdagi muvaffaqiyatsiz montajlar', count: c("SELECT count(*) n FROM video_jobs WHERE status='failed' AND created_at>=datetime('now','-1 day')"), level: 'bad' },
      { id: 'stale_payments', label: '48 soatdan beri kutilayotgan to‘lovlar', count: c("SELECT count(*) n FROM payments WHERE status='review' AND created_at<datetime('now','-2 days')"), level: 'warn' },
      { id: 'failed_broadcasts', label: 'Yuborilmagan e’lonlar', count: c("SELECT count(*) n FROM scheduled_broadcasts WHERE status='failed'"), level: 'bad' },
    ],
    activity,
  });
}, A);
route('GET', '/api/admin/users', (ctx) => {
  const params = new URL(ctx.req.url, 'http://x').searchParams;
  const q = '%' + String(params.get('q') || '').slice(0, 100).toLowerCase().replace(/[%_]/g, '') + '%';
  const status = params.get('status') || 'all';
  if (!['all', 'active', 'blocked', 'paid'].includes(status)) throw httpError(400, 'Foydalanuvchi filtri noto‘g‘ri');
  const stateFilter = status === 'active' ? 'blocked=0' : status === 'blocked' ? 'blocked=1' : status === 'paid' ? "plan<>'free' AND plan_until>?" : '1=1';
  const args = status === 'paid' ? [Date.now(), q, q, q, q] : [q, q, q, q];
  const users = db.prepare(`SELECT * FROM users WHERE ${stateFilter}
    AND (lower(COALESCE(email,'')) LIKE ? OR lower(name) LIKE ? OR COALESCE(tg_id,'') LIKE ? OR lower(COALESCE(tg_username,'')) LIKE ?)
    ORDER BY created_at DESC LIMIT 200`).all(...args).map((u) => ({
    id: u.id, email: u.email, name: u.name, tg_id: u.tg_id, tg_username: u.tg_username,
    role: u.role, plan: publicUser(u).plan, plan_until: publicUser(u).plan_until,
    has_password: !!u.password_hash, created_at: u.created_at, blocked: !!u.blocked, last_seen: u.last_seen,
  }));
  ok(ctx, { users });
}, A);
route('GET', '/api/admin/users.csv', (ctx) => {
  const params = new URL(ctx.req.url, 'http://x').searchParams;
  const q = '%' + String(params.get('q') || '').slice(0, 100).toLowerCase().replace(/[%_]/g, '') + '%';
  const status = params.get('status') || 'all';
  if (!['all', 'active', 'blocked', 'paid'].includes(status)) throw httpError(400, 'Foydalanuvchi filtri noto‘g‘ri');
  const condition = status === 'active' ? 'blocked=0' : status === 'blocked' ? 'blocked=1' : status === 'paid' ? "plan<>'free' AND plan_until>?" : '1=1';
  const args = status === 'paid' ? [Date.now(), q, q, q, q] : [q, q, q, q];
  const rows = db.prepare(`SELECT id,name,email,tg_username,role,plan,plan_until,blocked,created_at,last_seen FROM users WHERE ${condition}
    AND (lower(COALESCE(email,'')) LIKE ? OR lower(name) LIKE ? OR COALESCE(tg_id,'') LIKE ? OR lower(COALESCE(tg_username,'')) LIKE ?)
    ORDER BY created_at DESC LIMIT 5000`).all(...args);
  const csv = [['ID', 'Ism', 'Email', 'Telegram', 'Rol', 'Tarif', 'Tarif tugashi', 'Bloklangan', 'Ro‘yxatdan o‘tgan', 'Oxirgi faollik'], ...rows.map((u) => [u.id, u.name, u.email, u.tg_username, u.role, publicUser(u).plan, u.plan_until ? new Date(u.plan_until).toISOString() : '', u.blocked ? 'Ha' : 'Yo‘q', u.created_at, u.last_seen])].map((r) => r.map(csvCell).join(',')).join('\r\n');
  send(ctx.res, 200, '\uFEFF' + csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="synaptox-users.csv"' });
}, A);
route('GET', '/api/admin/activity', (ctx) => {
  const days = new URL(ctx.req.url, 'http://x').searchParams.get('period') || '7';
  if (!['7', '30'].includes(days)) throw httpError(400, 'Davr 7 yoki 30 kun bo‘lishi kerak');
  const start = `-${Number(days) - 1} days`;
  const daily = db.prepare(`SELECT date(m.created_at) day,count(*) messages,count(DISTINCT c.user_id) active_users
    FROM messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE m.role='user' AND m.created_at>=date('now',?) GROUP BY date(m.created_at) ORDER BY day`).all(start);
  const leaderboard = db.prepare(`SELECT u.id,u.name,u.email,u.tg_username,count(m.id) messages
    FROM users u JOIN conversations c ON c.user_id=u.id JOIN messages m ON m.conversation_id=c.id
    WHERE m.role='user' AND m.created_at>=date('now',?) AND u.blocked=0
    GROUP BY u.id ORDER BY messages DESC,u.created_at DESC LIMIT 10`).all(start);
  ok(ctx, { period: Number(days), daily, leaderboard });
}, A);
route('GET', '/api/admin/payments.csv', (ctx) => {
  const filters = paymentFilters(new URL(ctx.req.url, 'http://x'));
  const { rows } = getFilteredPayments(filters);
  const csv = [['ID', 'Sana', 'Foydalanuvchi', 'Email', 'Telegram', 'Tarif', 'Summa', 'Valyuta', 'Holat', 'Qaror sanasi'], ...rows.map((p) => [p.id, p.created_at, p.uname, p.uemail, p.utg, p.plan, p.amount, p.currency, p.status, p.decided_at])].map((r) => r.map(csvCell).join(',')).join('\r\n');
  send(ctx.res, 200, '\uFEFF' + csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="synaptox-payments.csv"' });
}, A);
route('GET', '/api/admin/undo', (ctx) => {
  ok(ctx, { actions: db.prepare('SELECT id,action,detail,created_at,expires_at FROM admin_undo WHERE undone_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 100').all(Date.now()) });
}, A);
route('POST', '/api/admin/undo/:id', (ctx) => {
  const entry = db.prepare('SELECT * FROM admin_undo WHERE id=? AND undone_at IS NULL AND expires_at>?').get(ctx.params.id, Date.now());
  if (!entry) throw httpError(404, 'Qaytarish muddati tugagan yoki amal allaqachon qaytarilgan');
  const snap = JSON.parse(entry.snapshot_json);
  let restoredPayment = null;
  db.exec('BEGIN');
  try {
    if (snap.type === 'user') {
      const user = getUser(snap.userId);
      if (!user || user.blocked !== snap.after.blocked || user.plan !== snap.after.plan || user.plan_until !== snap.after.plan_until) throw httpError(409, 'Foydalanuvchi ma’lumotlari keyin o‘zgargan; xavfsiz qaytarib bo‘lmaydi');
      db.prepare('UPDATE users SET blocked=?,plan=?,plan_until=? WHERE id=?').run(snap.before.blocked, snap.before.plan, snap.before.plan_until, snap.userId);
      if (snap.before.blocked && !snap.after.blocked) db.prepare('DELETE FROM sessions WHERE user_id=?').run(snap.userId);
    } else if (snap.type === 'payment') {
      const payment = getPayment(snap.paymentId);
      const user = getUser(snap.userId);
      if (!payment || !user || payment.status !== snap.after.payment_status || user.plan !== snap.after.plan || user.plan_until !== snap.after.plan_until) throw httpError(409, 'To‘lov yoki tarif keyin o‘zgargan; xavfsiz qaytarib bo‘lmaydi');
      db.prepare('UPDATE payments SET status=?,decided_at=?,decided_by=? WHERE id=?').run(snap.before.payment_status, snap.before.decided_at, snap.before.decided_by, snap.paymentId);
      db.prepare('UPDATE users SET plan=?,plan_until=? WHERE id=?').run(snap.before.plan, snap.before.plan_until, snap.userId);
      restoredPayment = getPayment(snap.paymentId);
    } else throw httpError(400, 'Qaytarib bo‘lmaydigan amal');
    db.prepare("UPDATE admin_undo SET undone_at=datetime('now') WHERE id=?").run(entry.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (restoredPayment) bus.emit('payment:undone', { payment: restoredPayment });
  audit(ctx.user.id, 'admin.undo', ctx.ip, `${entry.action}: ${entry.detail}`);
  ok(ctx, { ok: true });
}, A);
route('GET', '/api/admin/users/:id/summary', (ctx) => {
  const user = getUser(ctx.params.id);
  if (!user) throw httpError(404, 'Foydalanuvchi topilmadi');
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const payments = db.prepare('SELECT plan,amount,currency,status,created_at,decided_at FROM payments WHERE user_id=? ORDER BY created_at DESC LIMIT 10').all(user.id);
  ok(ctx, {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: publicUser(user).plan, plan_until: publicUser(user).plan_until, tg_username: user.tg_username, created_at: user.created_at, last_seen: user.last_seen, blocked: !!user.blocked },
    stats: {
      projects: count('SELECT count(*) n FROM projects WHERE user_id=?', user.id),
      conversations: count('SELECT count(*) n FROM conversations WHERE user_id=?', user.id),
      messages: count("SELECT count(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? AND m.role='user'", user.id),
      uploads: count('SELECT count(*) n FROM uploads WHERE user_id=?', user.id),
      payments: count('SELECT count(*) n FROM payments WHERE user_id=?', user.id),
      approved_total: count("SELECT COALESCE(sum(amount),0) n FROM payments WHERE user_id=? AND status='approved'", user.id),
    },
    payments,
  });
}, A);
route('PATCH', '/api/admin/users/:id', async (ctx) => {
  const t = getUser(ctx.params.id);
  if (!t) throw httpError(404, 'Foydalanuvchi topilmadi');
  const before = { blocked: t.blocked, plan: t.plan, plan_until: t.plan_until };
  const b = await readJson(ctx.req);
  if (b.blocked !== undefined) {
    if (t.role === 'admin') throw httpError(400, 'Adminni bloklab bo‘lmaydi');
    db.prepare('UPDATE users SET blocked=? WHERE id=?').run(b.blocked ? 1 : 0, t.id);
    if (b.blocked) db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.id);
  }
  if (b.plan !== undefined) {
    if (!['free', 'pro', 'max'].includes(b.plan)) throw httpError(400, 'Noto‘g‘ri tarif');
    const days = b.plan === 'free' ? 0 : Number(b.days ?? 30);
    if (!Number.isInteger(days) || days < (b.plan === 'free' ? 0 : 1) || days > 3650) throw httpError(400, 'Tarif muddati 1–3650 kun oralig‘ida bo‘lishi kerak');
    db.prepare('UPDATE users SET plan=?, plan_until=? WHERE id=?').run(b.plan, b.plan === 'free' ? 0 : Date.now() + days * 86400000, t.id);
  }
  const fresh = getUser(t.id);
  const after = { blocked: fresh.blocked, plan: fresh.plan, plan_until: fresh.plan_until };
  let undo_id = null;
  if (before.blocked !== after.blocked || before.plan !== after.plan || before.plan_until !== after.plan_until) {
    undo_id = recordUndo(ctx.user.id, 'Foydalanuvchi holati/tarifi', t.name, { type: 'user', userId: t.id, before, after });
  }
  audit(ctx.user.id, 'admin.user.update', ctx.ip, t.id + ' ' + JSON.stringify({ blocked: b.blocked, plan: b.plan }));
  ok(ctx, { user: publicUser(fresh), undo_id });
}, A);
route('POST', '/api/admin/users/:id/reset-password', async (ctx) => {
  const t = getUser(ctx.params.id);
  if (!t || !t.email) throw httpError(404, 'Email bilan ro‘yxatdan o‘tgan foydalanuvchi topilmadi');
  if (t.role === 'admin') throw httpError(400, 'Admin parolini bu yerdan o‘zgartirib bo‘lmaydi');
  const temp = randomToken(6) + 'A-' + Math.floor(Math.random() * 90 + 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(temp), t.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.id);
  audit(ctx.user.id, 'admin.password.reset', ctx.ip, t.id);
  ok(ctx, { temp_password: temp });
}, A);
route('GET', '/api/admin/payments', (ctx) => {
  const filters = paymentFilters(new URL(ctx.req.url, 'http://x'));
  const { rows, summary } = getFilteredPayments(filters);
  ok(ctx, { payments: rows.slice(0, 200).map((p) => ({ ...publicPayment(p), user: p.uname, email: p.uemail, tg: p.utg })), summary });
}, A);
route('GET', '/api/admin/payments/:id/receipt', (ctx) => {
  const p = getPayment(ctx.params.id);
  if (!p || !p.receipt_upload_id) throw httpError(404, 'Chek topilmadi');
  serveUpload(ctx, getUpload(p.receipt_upload_id));
}, A);
route('POST', '/api/admin/payments/:id/:action', async (ctx) => {
  if (!['approve', 'reject'].includes(ctx.params.action)) throw httpError(404, 'Topilmadi');
  const beforePayment = getPayment(ctx.params.id);
  if (!beforePayment) throw httpError(404, 'To‘lov topilmadi');
  const beforeUser = getUser(beforePayment.user_id);
  const changed = decide(ctx.params.id, ctx.params.action === 'approve', ctx.user.id);
  const afterUser = getUser(beforePayment.user_id);
  const undo_id = recordUndo(ctx.user.id, ctx.params.action === 'approve' ? 'To‘lovni tasdiqlash' : 'To‘lovni rad etish', beforePayment.id, {
    type: 'payment', paymentId: beforePayment.id, userId: beforePayment.user_id,
    before: { payment_status: beforePayment.status, decided_at: beforePayment.decided_at, decided_by: beforePayment.decided_by, plan: beforeUser.plan, plan_until: beforeUser.plan_until },
    after: { payment_status: changed.status, plan: afterUser.plan, plan_until: afterUser.plan_until },
  });
  ok(ctx, { payment: publicPayment(changed), undo_id });
}, A);
route('GET', '/api/admin/knowledge', (ctx) => ok(ctx, { entries: db.prepare("SELECT id,question,answer,source,score,uses,created_at FROM knowledge WHERE scope='global' ORDER BY created_at DESC, rowid DESC").all() }), A);
route('POST', '/api/admin/knowledge', async (ctx) => {
  const b = await readJson(ctx.req);
  const id = brain.learn('global', b.question, b.answer, 'admin');
  if (!id) throw httpError(400, 'Savol va javobni to‘ldiring (savol variantlarini | bilan ajrating)');
  ok(ctx, { id }, 201);
}, A);
route('DELETE', '/api/admin/knowledge/:id', (ctx) => {
  const r = db.prepare("DELETE FROM knowledge WHERE id=? AND scope='global'").run(ctx.params.id);
  if (!r.changes) throw httpError(404, 'Topilmadi');
  ok(ctx, { ok: true });
}, A);
route('POST', '/api/admin/broadcast', async (ctx) => {
  const text = str((await readJson(ctx.req)).text, 3500);
  if (text.length < 2) throw httpError(400, 'Matn bo‘sh');
  if (!botEnabled()) throw httpError(503, 'Telegram bot sozlanmagan');
  audit(ctx.user.id, 'broadcast', ctx.ip);
  ok(ctx, await broadcast(text));
}, A);
route('GET', '/api/admin/broadcasts', (ctx) => {
  ok(ctx, { broadcasts: db.prepare('SELECT id,text,scheduled_at,status,sent,total,error,created_at FROM scheduled_broadcasts ORDER BY scheduled_at DESC LIMIT 100').all() });
}, A);
route('POST', '/api/admin/broadcasts', async (ctx) => {
  if (!botEnabled()) throw httpError(503, 'Telegram bot sozlanmagan');
  const body = await readJson(ctx.req);
  const text = str(body.text, 3500);
  const timestamp = Date.parse(String(body.scheduled_at || ''));
  if (text.length < 2) throw httpError(400, 'Matn bo‘sh');
  if (!Number.isFinite(timestamp) || timestamp <= Date.now() || timestamp > Date.now() + 365 * 86400000) throw httpError(400, 'Yuborish vaqti hozirdan keyin va 365 kun ichida bo‘lsin');
  const id = newId();
  db.prepare('INSERT INTO scheduled_broadcasts(id,admin_id,text,scheduled_at) VALUES(?,?,?,?)').run(id, ctx.user.id, text, new Date(timestamp).toISOString());
  audit(ctx.user.id, 'broadcast.scheduled', ctx.ip, id);
  ok(ctx, { id, scheduled_at: new Date(timestamp).toISOString() }, 201);
}, A);
route('DELETE', '/api/admin/broadcasts/:id', (ctx) => {
  const result = db.prepare("UPDATE scheduled_broadcasts SET status='cancelled' WHERE id=? AND status='scheduled'").run(ctx.params.id);
  if (!result.changes) throw httpError(409, 'E’lon topilmadi yoki yuborish boshlangan');
  audit(ctx.user.id, 'broadcast.scheduled.cancel', ctx.ip, ctx.params.id);
  ok(ctx, { ok: true });
}, A);
route('GET', '/api/admin/audit', (ctx) => ok(ctx, { log: db.prepare('SELECT a.id,a.action,a.ip,a.detail,a.created_at,u.email,u.name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200').all() }), A);


// ---------------- Sozlamalar, maxfiylik, yutuqlar ----------------
route('PATCH', '/api/prefs', async (ctx) => {
  const b = await readJson(ctx.req);
  const prefs = mergePrefs(getPrefs(ctx.user), b.prefs || {});
  const sets = ['prefs=?'], vals = [JSON.stringify(prefs)];
  if (b.instructions !== undefined) { sets.push('ai_instructions_enc=?'); vals.push(String(b.instructions).trim() ? enc(String(b.instructions).trim().slice(0, 1000)) : null); }
  db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals, ctx.user.id);
  audit(ctx.user.id, 'prefs.update', ctx.ip);
  ok(ctx, { user: publicUser(getUser(ctx.user.id)) });
});
route('DELETE', '/api/conversations', (ctx) => ok(ctx, { deleted: db.prepare('DELETE FROM conversations WHERE user_id=?').run(ctx.user.id).changes }));
route('DELETE', '/api/memory', (ctx) => ok(ctx, { deleted: brain.forgetPersonal(ctx.user.id) }));

const BADGES = [
  ['first', '💬', 'Birinchi xabar', 'AI ga birinchi savolingizni berdingiz', (s) => s.total >= 1],
  ['m100', '🗨️', '100 xabar', '100 ta savol berdingiz', (s) => s.total >= 100],
  ['s3', '🔥', '3 kunlik seriya', 'Ketma-ket 3 kun foydalandingiz', (s) => s.longest >= 3],
  ['s7', '⚡', '7 kunlik seriya', 'Ketma-ket 7 kun foydalandingiz', (s) => s.longest >= 7],
  ['proj', '📁', 'Loyiha egasi', 'Birinchi loyihangizni yaratdingiz', (s) => s.projects >= 1],
  ['files', '🗂️', 'Fayl kolleksioneri', '10 ta fayl yukladingiz', (s) => s.files >= 10],
  ['montage', '🎬', 'Montajchi', 'Birinchi videongizni montaj qildingiz', (s) => s.montages >= 1],
  ['tg', '✈️', 'Telegram ulangan', 'Web va Telegram bir akkauntda', (s) => s.tg],
  ['teach', '🧠', 'Ustoz', 'AI ga 3 ta narsa o‘rgatdingiz', (s) => s.memory >= 3],
  ['pro', '⭐', 'Premium', 'Pullik tarif egasi', (s) => s.paid],
];
route('GET', '/api/profile/summary', (ctx) => {
  const u = ctx.user;
  const days = db.prepare("SELECT date(m.created_at) d, count(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? AND m.role='user' GROUP BY d ORDER BY d DESC LIMIT 800").all(u.id);
  const set = new Map(days.map((x) => [x.d, x.n]));
  const dayStr = (off) => new Date(Date.now() - off * 86400000).toISOString().slice(0, 10);
  let streak = 0; for (let i = set.has(dayStr(0)) ? 0 : 1; set.has(dayStr(i)); i++) streak++;
  let longest = 0, run = 0, prev = null;
  for (const d of [...set.keys()].sort()) { run = prev && (Date.parse(d) - Date.parse(prev)) === 86400000 ? run + 1 : 1; longest = Math.max(longest, run); prev = d; }
  const total = db.prepare("SELECT count(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? AND m.role='user'").get(u.id).n;
  const c = (sql) => db.prepare(sql).get(u.id).n;
  const st = { total, streak, longest, projects: c('SELECT count(*) n FROM projects WHERE user_id=?'), files: c('SELECT count(*) n FROM uploads WHERE user_id=?'), montages: c("SELECT count(*) n FROM video_jobs WHERE user_id=? AND status='done'"),
    memory: c('SELECT count(*) n FROM knowledge WHERE scope=?'), tg: !!u.tg_id, paid: effectivePlan(u).id !== 'free' && u.role !== 'admin' };
  const level = 1 + Math.floor(total / 25), titles = ['Yangi', 'Izlanuvchi', 'Izlanuvchi', 'Tajribali', 'Tajribali', 'Tajribali', 'Tajribali', 'Ustoz'];
  ok(ctx, {
    total, streak, longest, level, level_title: titles[Math.min(level - 1, titles.length - 1)], next_level_in: 25 - (total % 25), level_progress: (total % 25) / 25,
    chart: Array.from({ length: 14 }, (_, i) => ({ day: dayStr(13 - i), n: set.get(dayStr(13 - i)) || 0 })),
    badges: BADGES.map(([id, icon, title, desc, f]) => ({ id, icon, title, desc, earned: !!f(st) })),
    member_days: Math.max(1, Math.ceil((Date.now() - Date.parse(String(u.created_at).replace(' ', 'T') + 'Z')) / 86400000)),
  });
});

route('GET', '/api/stats', (ctx) => {
  const n = (t) => db.prepare(`SELECT count(*) n FROM ${t} WHERE user_id=?`).get(ctx.user.id).n;
  ok(ctx, { projects: n('projects'), conversations: n('conversations'), files: n('uploads'), memory: db.prepare('SELECT count(*) n FROM knowledge WHERE scope=?').get(ctx.user.id).n });
});

function normalizeHost(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const protocol = url.protocol === 'https:' ? 'https' : 'http';
    const port = url.port || (protocol === 'https' ? '443' : '80');
    return `${url.hostname.toLowerCase()}:${port}`;
  } catch {
    return raw.toLowerCase().replace(/\.$/, '');
  }
}

function isSameOrigin(req, origin) {
  const reqHost = normalizeHost(req.headers.host || req.headers['x-forwarded-host'] || '');
  if (!reqHost || !origin) return !origin;
  const originHost = normalizeHost(origin);
  return reqHost === originHost;
}

// ---------------- Dispatcher ----------------
async function handleApi(req, res, p) {
  const method = req.method;
  const ip = clientIp(req);
  if (limited('api:' + ip, 600, 60000)) throw httpError(429, 'Juda ko‘p so‘rov');
  // CSRF: cookie bilan ishlaydigan o'zgartiruvchi so'rovlar faqat bizning JS dan (maxsus sarlavha) qabul qilinadi
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && req.headers['x-requested-with'] !== 'synaptox') throw httpError(403, 'So‘rov manbasi noto‘g‘ri');
  const origin = req.headers.origin;
  if (origin && !['GET', 'HEAD'].includes(method)) {
    try { if (!isSameOrigin(req, origin)) throw 0; } catch { throw httpError(403, 'Origin ruxsat etilmagan'); }
  }
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(p);
    if (!m) continue;
    const ctx = { req, res, ip, user: null, params: {} };
    r.keys.forEach((k, i) => { ctx.params[k] = decodeSeg(m[i + 1]); });
    if (r.auth) {
      ctx.user = currentUser(req);
      if (!ctx.user) throw httpError(401, 'Kirish talab qilinadi');
      if (r.admin && ctx.user.role !== 'admin') throw httpError(403, 'Faqat admin uchun');
    } else ctx.user = currentUser(req);
    return r.handler(ctx);
  }
  throw httpError(404, 'API endpoint topilmadi');
}

async function serveStatic(req, res, p) {
  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'Method Not Allowed');
  let rel;
  try { rel = decodeURIComponent(p === '/' ? '/index.html' : p).replace(/^\/+/, ''); } catch { return send(res, 400, 'Bad request'); }
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return send(res, 404, 'Not found');
  let target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  let stat;
  try { stat = await fs.promises.stat(target); } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
  }
  if (!stat?.isFile()) {
    if (path.extname(rel)) return send(res, 404, 'Not found');
    target = path.join(PUBLIC_DIR, 'index.html'); // SPA
    stat = await fs.promises.stat(target);
  }
  const ext = path.extname(target);
  res.writeHead(200, securityHeaders({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': target.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300', 'Content-Length': stat.size }));
  if (req.method === 'HEAD') return res.end();
  await pipeline(fs.createReadStream(target), res);
}

export const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  const run = p.startsWith('/api/') ? handleApi(req, res, p) : serveStatic(req, res, p);
  run.catch((e) => {
    if (res.headersSent || res.destroyed) return;
    if (!e.status) console.error('[server]', e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Ichki server xatosi', ...(e.code ? { code: e.code } : {}) });
  });
});
server.maxHeadersCount = 100;

setInterval(() => {
  try {
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    db.prepare('DELETE FROM link_codes WHERE expires_at<?').run(Date.now());
  } catch { /* keyingi safar */ }
}, 600000).unref();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.requestTimeout = 300000;
  server.listen(cfg.port, () => {
    console.log(`SYNAPTOX tayyor: http://localhost:${cfg.port}  [${cfg.env}]  montaj:${ffmpegAvailable ? 'ha' : 'yo‘q'} llm:${llmEnabled() ? 'ha' : 'yo‘q'} bot:${botEnabled() ? 'ha' : 'yo‘q'}`);
    startBot();
    llmSelfCheck();
  });
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => { try { db.close(); } catch { /* */ } process.exit(0); }); server.closeIdleConnections(); setTimeout(() => process.exit(0), 3000).unref(); });
