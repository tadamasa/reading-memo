/**
 * 読書ハブ: 読書メモアプリ(https://tadamasa.github.io/reading-memo/)の本とメモを、このスプレッドシートに同期する受け口。
 *
 * 使い方は hub/README.md を参照。
 *  1. 新しいスプレッドシート → 拡張機能 → Apps Script に、このファイルを貼る
 *  2. setup を一度実行(合言葉が実行ログに出る)
 *  3. デプロイ → 新しいデプロイ → ウェブアプリ(実行ユーザー: 自分、アクセス: 全員)
 *  4. 出たURLと合言葉を、読書メモアプリの設定に入れる
 *
 * シート「books」「notes」は、ほかのApps Script(日記アプリなど)からそのまま読める表になっている。
 * 最後の列 json がアプリの元データ。人が表を書き換えても、アプリには反映されない(json が正)。
 */

// books の kindlePlus・kindlePlusAt は json の後ろに足した列(2026-11)。古い表は開いたときに見出しを足して埋める。
const BOOK_COLS = ['id', 'rev', 'mtime', 'deleted', 'title', 'author', 'status', 'category', 'score', 'finishedAt', 'json', 'kindlePlus', 'kindlePlusAt'];
const NOTE_COLS = ['id', 'rev', 'mtime', 'deleted', 'date', 'bookId', 'bookTitle', 'kind', 'text', 'quote', 'json'];
const STATUS = { want: '読みたい', reading: '読書中', done: '読了', stopped: '中断' };
// Kindle+(読み放題)の対象か。アプリの book.ku.status と表の言葉の対応
const KINDLE_PLUS = { yes: '対象', no: '対象外', none: 'Kindle版なし', check: '調べる' };
const PAGE = 400; // 1回の応答で返す最大件数

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  sheet_('books', BOOK_COLS);
  sheet_('notes', NOTE_COLS);
  Logger.log('合言葉: ' + props.getProperty('TOKEN'));
}

// さくら(Muse)専用の合言葉を発行する。端末用の合言葉(TOKEN)とは別物で、
// スクリプトプロパティの SAKURA_TOKEN を消せば、端末の同期に影響なくさくらだけ止められる。
// さくら用の合言葉では、本・メモの追加と更新はできるが、削除は受け付けない。
function setupSakura() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SAKURA_TOKEN')) props.setProperty('SAKURA_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  sheet_('books', BOOK_COLS);
  sheet_('notes', NOTE_COLS);
  Logger.log('さくら用合言葉: ' + props.getProperty('SAKURA_TOKEN'));
}

// 外部(ほかのAIやショートカット)から、本の追加とKindle+の切り替えだけをするための合言葉。
// 同期用の合言葉(TOKEN)とは別物で、URLの ?token= で送ったときだけ通る。本・メモの読み取りや削除はできない。
// 止める・作り直すときは、スクリプト プロパティの API_TOKEN を消す(消したあと setupApi を実行すれば新しい値になる)。
function setupApi() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) props.setProperty('API_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  sheet_('books', BOOK_COLS);
  sheet_('notes', NOTE_COLS);
  Logger.log('API用合言葉: ' + props.getProperty('API_TOKEN'));
}

function doGet() {
  return json_({ ok: true, app: 'reading-hub' });
}

// 受け取る: { token, since, books: [{id, mtime, deleted, data}], notes: [...] }
// 返す:     { ok, rev, more, books: [{id, mtime, deleted, data}], notes: [...] }  (rev が since より新しいもの)
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return json_({ ok: false, error: 'bad json' });
  const propsAuth = PropertiesService.getScriptProperties();
  // API用合言葉(URLの ?token= だけ)。本文は { addBook: {...} } か { setKindlePlus: {...} } のどちらか一つだけ
  const apiToken = propsAuth.getProperty('API_TOKEN');
  if (apiToken && e.parameter && e.parameter.token === apiToken) {
    const keys = Object.keys(req);
    if (keys.length !== 1 || (keys[0] !== 'addBook' && keys[0] !== 'setKindlePlus')) return json_({ ok: false, error: 'unauthorized' });
    return json_(keys[0] === 'addBook' ? apiAddBook_(req.addBook) : apiSetKindlePlus_(req.setKindlePlus));
  }
  // 合言葉は本文の token でも、URLのパラメータ(?token=)でも受け付ける
  const given = req.token || (e.parameter && e.parameter.token) || '';
  const isSakura = !!given && given === propsAuth.getProperty('SAKURA_TOKEN');
  if (!given || (!isSakura && given !== propsAuth.getProperty('TOKEN'))) return json_({ ok: false, error: 'unauthorized' });
  return json_(sync_(req, isSakura));
}

// 受け取った本・メモを表に書き、since より新しい行を返す(アプリ・さくら・APIの共通の書き込み口)
function sync_(req, isSakura) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    let rev = Number(props.getProperty('REV') || 0);
    const since = Number(req.since || 0);
    const titles = {};
    const fresh = []; // since より新しい行(両シート分)
    for (const name of ['books', 'notes']) {
      const cols = name === 'books' ? BOOK_COLS : NOTE_COLS;
      const sh = sheet_(name, cols);
      const values = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).getValues() : [];
      const index = {};
      values.forEach((r, i) => { index[r[0]] = i; });
      if (name === 'books') values.forEach(r => { if (r[0]) titles[r[0]] = r[4]; });
      let changed = false;
      for (const item of req[name] || []) {
        if (!item || !item.id) continue;
        if (isSakura && item.deleted) continue; // さくら用合言葉では削除を受け付けない
        const i = index[item.id];
        if (i !== undefined && Number(values[i][2]) > Number(item.mtime || 0)) continue; // 表のほうが新しい
        rev += 1;
        if (name === 'books' && item.data) titles[item.id] = item.data.title || '';
        const row = name === 'books' ? bookRow_(item, rev) : noteRow_(item, rev, titles);
        if (i === undefined) { index[item.id] = values.length; values.push(row); } else values[i] = row;
        changed = true;
      }
      if (changed) {
        const need = values.length + 1 - sh.getMaxRows();
        if (need > 0) { sh.insertRowsAfter(sh.getMaxRows(), need); sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@'); }
        sh.getRange(2, 1, values.length, cols.length).setValues(values);
      }
      for (const r of values) if (Number(r[1]) > since) fresh.push({ name, rev: Number(r[1]), r, last: cols.indexOf('json') });
    }
    props.setProperty('REV', String(rev));
    // 古い順に PAGE 件まで返す。残りがあれば more を立て、返した最後の rev を次の起点にする
    fresh.sort((x, y) => x.rev - y.rev);
    const page = fresh.slice(0, PAGE);
    const out = { ok: true, books: [], notes: [], more: fresh.length > PAGE, rev: fresh.length > PAGE ? page[page.length - 1].rev : rev };
    for (const f of page) {
      const deleted = String(f.r[3]) === 'true';
      out[f.name].push({ id: String(f.r[0]), mtime: Number(f.r[2]), deleted, data: deleted ? null : parse_(f.r[f.last]) });
    }
    return out;
  } finally {
    lock.releaseLock();
  }
}

function bookRow_(item, rev) {
  const b = item.data || {};
  const score = b.score || (b.rating ? b.rating * 2 : '');
  return [item.id, String(rev), String(Number(item.mtime || 0)), String(!!item.deleted), b.title || '', b.author || '', STATUS[b.status] || b.status || '',
    b.category || '', score, b.finishedAt || '', item.deleted ? '' : cell_(b)].concat(item.deleted ? ['', ''] : kindlePlusCells_(b));
}

function kindlePlusCells_(b) {
  const ku = b && b.ku;
  return ku && KINDLE_PLUS[ku.status] ? [KINDLE_PLUS[ku.status], String(ku.at || '').slice(0, 10)] : ['', ''];
}

function noteRow_(item, rev, titles) {
  const n = item.data || {};
  return [item.id, String(rev), String(Number(item.mtime || 0)), String(!!item.deleted), (n.createdAt || '').slice(0, 10), n.bookId || '', titles[n.bookId] || '',
    n.kind || '', n.text || '', n.quote || '', item.deleted ? '' : cell_(n)];
}

// 1セルは5万字まで。読書ノートなどで超えるときは長い項目を削って入れる
function cell_(obj) {
  let s = JSON.stringify(obj);
  if (s.length < 49000) return s;
  const slim = Object.assign({}, obj, { related: undefined, bookNote: undefined, description: (obj.description || '').slice(0, 2000) });
  return JSON.stringify(slim);
}

function sheet_(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (sh) addCols_(sh, cols);
  if (!sh) {
    sh = ss.insertSheet(name);
    // 日付などが勝手に変換されないよう、すべて書式なしテキストにする
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// 列を後ろに足した版のハブを古い表で動かしたとき: 見出しを足し、本の行は json から新しい列を埋める
function addCols_(sh, cols) {
  const width = sh.getLastColumn ? sh.getLastColumn() : cols.length;
  const head = sh.getRange(1, 1, 1, Math.max(width, 1)).getValues()[0].filter(String);
  if (head.length >= cols.length || head.join() !== cols.slice(0, head.length).join()) return;
  const add = cols.length - head.length;
  if (sh.getMaxColumns && sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
  sh.getRange(1, head.length + 1, sh.getMaxRows(), add).setNumberFormat('@');
  sh.getRange(1, head.length + 1, 1, add).setValues([cols.slice(head.length)]).setFontWeight('bold');
  if (sh.getLastRow() < 2 || cols !== BOOK_COLS) return;
  const j = cols.indexOf('json');
  const rows = sh.getRange(2, j + 1, sh.getLastRow() - 1, 1).getValues();
  sh.getRange(2, j + 2, rows.length, 2).setValues(rows.map(r => kindlePlusCells_(parse_(r[0]))));
}

// ---------- 外部API(API用合言葉) ----------
// POST {URL}?token=<API用合言葉>
//   { "addBook": { "title": "…", "author": "…", "isbn13": "…", "itemId": "ASIN", "status": "want", "wantReason": "…", "kindlePlus": "調べる" } }
//   { "setKindlePlus": { "isbn13" か "itemId" か "id" か "title": "…", "status": "対象" } }
// 表に書くだけで、アプリは次の同期で受け取る。

// 対象 / 対象外 / Kindle版なし / 調べる(または yes / no / none / check)。空文字・null は記録を消す
function kuStatus_(v) {
  if (v === '' || v === null) return '';
  const s = String(v === undefined ? '' : v).trim();
  if (KINDLE_PLUS[s]) return s;
  for (const k in KINDLE_PLUS) if (KINDLE_PLUS[k] === s) return k;
  return null;
}

// ISBN-10 も 13 桁に直す。ISBNでなければ空文字
function isbn13_(v) {
  const s = String(v || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  let core;
  if (/^97[89]\d{10}$/.test(s)) core = s.slice(0, 12);
  else if (/^\d{9}[\dX]$/.test(s)) core = '978' + s.slice(0, 9);
  else return '';
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  const full = core + ((10 - (sum % 10)) % 10);
  return s.length === 13 && full !== s ? '' : full;
}

function normTitle_(t) { return String(t || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase(); }

// 本を探す。id → ISBN → ASIN(itemId) → 書名(完全一致)の順で、最初に見つかった条件の本を返す
function findBooks_(q) {
  const sh = sheet_('books', BOOK_COLS);
  if (sh.getLastRow() < 2) return [];
  const j = BOOK_COLS.indexOf('json');
  const books = sh.getRange(2, 1, sh.getLastRow() - 1, BOOK_COLS.length).getValues()
    .filter(r => String(r[3]) !== 'true').map(r => parse_(r[j])).filter(Boolean);
  const isbn = isbn13_(q.isbn13 || q.isbn);
  const item = String(q.itemId || q.asin || '').trim().toUpperCase();
  const title = normTitle_(q.title);
  const tests = [
    q.id && (b => b.id === String(q.id)),
    isbn && (b => b.isbn13 === isbn),
    item && (b => String(b.itemId || '').toUpperCase() === item),
    title && (b => normTitle_(b.title) === title),
  ].filter(Boolean);
  for (const t of tests) { const hit = books.filter(t); if (hit.length) return hit; }
  return [];
}

function apiAddBook_(a) {
  if (!a || typeof a !== 'object') return { ok: false, error: 'bad request' };
  const title = String(a.title || '').trim();
  if (!title) return { ok: false, error: 'title required' };
  const isbn13 = isbn13_(a.isbn13 || a.isbn) || null;
  const itemId = String(a.itemId || a.asin || '').trim().toUpperCase();
  const ku = a.kindlePlus === undefined ? '' : kuStatus_(a.kindlePlus);
  if (ku === null) return { ok: false, error: 'bad kindlePlus' };
  // 同じISBN・ASINの本がもうあれば足さない(書名だけの本は、同じ書名があれば足さない)
  const same = findBooks_({ isbn13, itemId, title: isbn13 || itemId ? '' : title });
  if (same.length) {
    // 既にある本に kindlePlus が付いてきたら、それだけ切り替える
    if (a.kindlePlus !== undefined) return Object.assign(apiSetKindlePlus_({ id: same[0].id, status: a.kindlePlus }), { existed: true });
    return { ok: true, id: same[0].id, title: same[0].title, existed: true };
  }
  const status = STATUS[a.status] ? a.status : 'want';
  const now = new Date();
  const iso = now.toISOString();
  const id = now.getTime().toString(36) + Math.random().toString(36).slice(2, 8);
  const book = {
    id, isbn13, itemId: itemId || null, title, author: String(a.author || '').trim(), publisher: String(a.publisher || '').trim(), year: String(a.year || '').trim(),
    pages: null, description: '', tags: [], subjects: [], ndc: null, cover: null, format: itemId && /^B/.test(itemId) ? 'ebook' : 'paper',
    status, wantSource: null, createdAt: iso, updatedAt: iso, source: String(a.source || 'api'),
  };
  if (a.wantReason) book.wantReason = String(a.wantReason).trim();
  if (status === 'done') book.finishedAt = iso.slice(0, 10);
  if (ku) book.ku = { status: ku, at: iso };
  sync_({ since: Number.MAX_SAFE_INTEGER, books: [{ id, mtime: now.getTime(), data: book }] }, true);
  return { ok: true, id, title, existed: false, kindlePlus: ku ? KINDLE_PLUS[ku] : '' };
}

function apiSetKindlePlus_(a) {
  if (!a || typeof a !== 'object') return { ok: false, error: 'bad request' };
  const ku = kuStatus_(a.status === undefined ? a.kindlePlus : a.status);
  if (ku === null) return { ok: false, error: 'bad status' };
  const hit = findBooks_(a);
  if (!hit.length) return { ok: false, error: 'not found' };
  if (hit.length > 1) return { ok: false, error: 'ambiguous', candidates: hit.slice(0, 10).map(b => ({ id: b.id, title: b.title, author: b.author || '' })) };
  const book = hit[0];
  const now = new Date();
  if (ku) book.ku = { status: ku, at: now.toISOString() }; else delete book.ku;
  book.updatedAt = now.toISOString();
  sync_({ since: Number.MAX_SAFE_INTEGER, books: [{ id: book.id, mtime: now.getTime(), data: book }] }, true);
  return { ok: true, id: book.id, title: book.title, kindlePlus: ku ? KINDLE_PLUS[ku] : '' };
}

function parse_(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * ほかのApps Script(日記アプリなど)から使う例: ある日の読書メモを返す。
 * 日記アプリ側では SpreadsheetApp.openById('読書ハブのID') で開いて、同じように notes シートを読めばよい。
 */
function readingNotesOn(date) {
  const sh = sheet_('notes', NOTE_COLS);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, NOTE_COLS.length).getValues()
    .filter(r => r[4] === date && String(r[3]) !== 'true')
    .map(r => ({ bookTitle: r[6], kind: r[7], text: r[8], quote: r[9] }));
}
