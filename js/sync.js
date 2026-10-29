// 読書ハブ(自分のGoogleスプレッドシート + Apps Script)との自動同期。
// 端末内のIndexedDBが正で、変わった本・メモだけを送り、ハブで変わったものだけを受け取る。
// 同じ本やメモを二つの端末で直したときは、mtime(最後に書いた時刻)が新しい方を残す。
import * as db from './db.js';

const BATCH = 300; // 1回に送る件数
let dirty = { books: {}, notes: {} }; // 未送信: { id: { mtime, deleted } }
let cfg = { url: '', token: '' };
let timer = null;
let running = null;
let saveTimer = null;
let onRemoteChange = () => {};
const listeners = new Set();
export const status = { state: 'off', lastAt: null, error: '', pending: 0 };

function emit() {
  status.pending = Object.keys(dirty.books).length + Object.keys(dirty.notes).length;
  listeners.forEach(fn => fn(status));
}
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function saveDirty() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.setMeta('syncDirty', dirty), 300);
}

function mark(name, changes) {
  for (const c of changes) dirty[name][c.id] = { mtime: c.mtime || Date.now(), deleted: !!c.deleted };
  saveDirty();
  emit();
  schedule();
}

export async function initSync(opts = {}) {
  if (opts.onRemoteChange) onRemoteChange = opts.onRemoteChange;
  const [url, token, saved, lastAt] = await Promise.all([db.getMeta('syncUrl', ''), db.getMeta('syncToken', ''), db.getMeta('syncDirty'), db.getMeta('syncLastAt')]);
  cfg = { url, token };
  if (saved) dirty = { books: saved.books || {}, notes: saved.notes || {} };
  status.state = url ? 'idle' : 'off';
  status.lastAt = lastAt;
  db.onChange(mark);
  emit();
}

export function enabled() { return !!(cfg.url && cfg.token); }

// 書いてから少し待ってまとめて送る
export function schedule(delay = 4000) {
  if (!enabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

async function post(body) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    // text/plain にすると事前確認(CORS preflight)が要らず、Apps Scriptで受けられる
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`読書ハブ HTTP ${res.status}`);
  let data;
  try { data = await res.json(); } catch { throw new Error('読書ハブの応答を読めませんでした(URLが正しいか、デプロイのアクセスが「全員」か確かめてください)'); }
  if (!data.ok) throw new Error(data.error === 'unauthorized' ? '合言葉が違います' : `読書ハブ: ${data.error}`);
  return data;
}

function takeBatch() {
  const out = { books: [], notes: [] };
  let n = 0;
  for (const name of ['books', 'notes']) {
    for (const [id, d] of Object.entries(dirty[name])) {
      if (n >= BATCH) return out;
      out[name].push([id, d]);
      n++;
    }
  }
  return out;
}

async function apply(name, items) {
  let changed = 0;
  for (const it of items) {
    const pending = dirty[name][it.id];
    if (pending && pending.mtime >= it.mtime) continue; // 手元の未送信のほうが新しい
    const local = await db.get(name, it.id);
    if (local && (local.mtime || 0) > it.mtime) continue;
    if (it.deleted) { if (local) { await db.del(name, it.id, { silent: true }); changed++; } continue; }
    if (!it.data) continue;
    it.data.mtime = it.mtime;
    if (local && (local.mtime || 0) === it.mtime) continue; // 同じもの
    await db.put(name, it.data, { silent: true });
    changed++;
  }
  return changed;
}

export function syncNow() {
  if (!enabled()) return Promise.resolve(0);
  if (running) return running;
  running = (async () => {
    status.state = 'syncing'; status.error = ''; emit();
    let changed = 0;
    try {
      let cursor = Number(await db.getMeta('syncCursor', 0)) || 0;
      for (let guard = 0; guard < 100; guard++) {
        const batch = takeBatch();
        const body = { token: cfg.token, since: cursor, books: [], notes: [] };
        for (const name of ['books', 'notes']) {
          for (const [id, d] of batch[name]) {
            const rec = d.deleted ? null : await db.get(name, id);
            body[name].push(rec ? { id, mtime: rec.mtime || d.mtime, data: rec } : { id, mtime: d.mtime, deleted: true });
          }
        }
        const res = await post(body);
        for (const name of ['books', 'notes']) {
          // 送っている間に書き直されたものは、次の回に送る
          for (const item of body[name]) if (dirty[name][item.id] && dirty[name][item.id].mtime <= item.mtime) delete dirty[name][item.id];
        }
        changed += await apply('books', res.books || []);
        changed += await apply('notes', res.notes || []);
        cursor = res.rev;
        await db.setMeta('syncCursor', cursor);
        saveDirty();
        const left = Object.keys(dirty.books).length + Object.keys(dirty.notes).length;
        if (!res.more && !left) break;
      }
      status.lastAt = new Date().toISOString();
      await db.setMeta('syncLastAt', status.lastAt);
      status.state = 'idle';
    } catch (e) {
      status.state = 'error';
      status.error = navigator.onLine === false ? 'オフラインです' : e.message;
    } finally {
      running = null;
      emit();
    }
    if (changed) await onRemoteChange(changed);
    return changed;
  })();
  return running;
}

// 接続: 手元のデータをすべて未送信にして、最初から同期する
export async function connect(url, token) {
  cfg = { url: url.trim(), token: token.trim() };
  await db.setMeta('syncUrl', cfg.url);
  await db.setMeta('syncToken', cfg.token);
  await db.setMeta('syncCursor', 0);
  for (const name of ['books', 'notes']) {
    for (const r of await db.getAll(name)) dirty[name][r.id] = { mtime: r.mtime || 1, deleted: false };
  }
  await db.setMeta('syncDirty', dirty);
  status.state = 'idle';
  emit();
  return syncNow();
}

export async function disconnect() {
  cfg = { url: '', token: '' };
  clearTimeout(timer);
  await Promise.all(['syncUrl', 'syncToken', 'syncCursor', 'syncLastAt'].map(k => db.setMeta(k, null)));
  dirty = { books: {}, notes: {} };
  await db.setMeta('syncDirty', dirty);
  status.state = 'off'; status.lastAt = null; status.error = '';
  emit();
}
