import * as db from './db.js';
import { parseBooklog } from './booklog.js';
import { buildIndex } from './related.js';
import { searchBooks, ndlSubjects, normalizeIsbn, coverCandidates, googleCover, bookSummary, setBooksKey, isbn13to10, authorWorks, wikiSummary, relatedLinks } from './books.js';
import * as gemini from './gemini.js';
import { exportData, importData } from './backup.js';

// ---------- 状態 ----------
const state = {
  books: [],
  notes: [],
  index: null,
  currentBookId: null,
  draftKind: null,
  lastSaved: null, // 保存直後のメモ(再会を出すため)
};

const FORMAT_LABEL = { paper: '紙', ebook: '電子', audio: 'オーディオ' };
const STATUS_LABEL = { reading: '読書中', want: '読みたい', done: '読了', stopped: '中断' };
const KINDS = [
  ['quote', '引用'], ['impression', '感想'], ['question', '問い'],
  ['objection', '反論'], ['association', '連想'], ['action', '行動'],
];
const KIND_LABEL = Object.fromEntries(KINDS);
const POS_UNIT = { paper: 'page', ebook: 'loc', audio: 'time' };
const POS_LABEL = { page: 'ページ', loc: '位置 / %', time: '再生時刻' };
const POS_PLACEHOLDER = { page: '例 128', loc: '例 1520 または 42%', time: '例 1:23:45' };

const $view = document.getElementById('view');

// ---------- ユーティリティ ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ms = 2600) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

// 日付欄(<input type="date">)用に、端末の時刻でのYYYY-MM-DDにする
function dateInput(iso) {
  if (!iso) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function yearsAgo(iso) {
  if (!iso) return '';
  const days = (Date.now() - new Date(iso).getTime()) / 864e5;
  if (days < 30) return '';
  if (days < 365) return `${Math.round(days / 30)}か月前`;
  return `${Math.floor(days / 365)}年前`;
}

function bookById(id) { return state.books.find(b => b.id === id); }

function notesOf(bookId) {
  return state.notes
    .filter(n => n.bookId === bookId || (n.linkedBookIds || []).includes(bookId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function index() {
  if (!state.index) state.index = buildIndex(state.books, state.notes);
  return state.index;
}

function invalidate() { state.index = null; }

function posText(pos) {
  if (!pos || !pos.value) return '';
  if (pos.unit === 'page') return `p.${pos.value}`;
  if (pos.unit === 'time') return `${pos.value}`;
  return /%$/.test(pos.value) ? pos.value : `No.${pos.value}`;
}

function progressOf(book, pos) {
  if (!pos || !pos.value) return null;
  if (pos.unit === 'page' && book.pages) return Math.min(1, Number(pos.value) / book.pages) || null;
  const m = /^(\d+(?:\.\d+)?)%$/.exec(pos.value);
  if (m) return Math.min(1, Number(m[1]) / 100);
  return null;
}

function setTitle(text, { back = false } = {}) {
  document.getElementById('nav-title').textContent = text;
  document.getElementById('nav-title-large').textContent = text;
  document.getElementById('back').hidden = !back;
  document.title = `${text} - 読書メモ`;
}

function setTab(tab) {
  for (const a of document.querySelectorAll('.tabbar__item')) {
    const on = a.dataset.tab === tab;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

async function load() {
  [state.books, state.notes] = await Promise.all([db.getAll('books'), db.getAll('notes')]);
  state.currentBookId = await db.getMeta('currentBookId');
  setBooksKey(await db.getMeta('booksKey', ''));
  shelfSort = (await db.getMeta('shelfSort')) || shelfSort;
  if (!SORTS[shelfSort]) shelfSort = 'added';
  shelfAsc = !!(await db.getMeta('shelfAsc'));
  invalidate();
}

async function saveBook(book) {
  book.updatedAt = new Date().toISOString();
  await db.put('books', book);
  const i = state.books.findIndex(b => b.id === book.id);
  if (i >= 0) state.books[i] = book; else state.books.push(book);
  invalidate();
}

async function saveNote(note) {
  note.updatedAt = new Date().toISOString();
  await db.put('notes', note);
  const i = state.notes.findIndex(n => n.id === note.id);
  if (i >= 0) state.notes[i] = note; else state.notes.push(note);
  invalidate();
}

// ---------- 再会: 関連する過去の本・メモ ----------
function reunions({ text, author, excludeBookId }) {
  const idx = index();
  const notes = idx.search({ text, author, excludeBookId }, { type: 'note', limit: 3, minScore: 0.12 });
  const books = idx.search({ text, author, excludeBookId }, { type: 'book', limit: 4, minScore: 0.1 })
    .filter(r => { const b = bookById(r.doc.bookId); return b && b.status !== 'want'; });
  return { notes, books: books.slice(0, 3) };
}

function reunionHtml(r, kind) {
  const b = bookById(r.doc.bookId);
  if (!b) return '';
  const note = kind === 'note' ? state.notes.find(n => n.id === r.doc.id) : null;
  const when = b.finishedAt || b.createdAt;
  const ago = yearsAgo(when);
  return `<li class="reunion" data-book="${esc(b.id)}">
    <div class="reunion__title">${esc(b.title)}</div>
    <div class="reunion__why">${esc([b.author, ago && `${ago}に${b.status === 'done' ? '読了' : '登録'}`, ...r.reasons].filter(Boolean).join(' ・ '))}</div>
    ${note ? `<p class="reunion__text">${esc(note.text)}</p>` : ''}
    <div class="reunion__reply" hidden>
      <textarea aria-label="${esc(b.title)}につなげるメモ" placeholder="今の本とつなげて一言"></textarea>
      <div class="note__tools"><button class="btn btn--small btn--prominent" data-act="link-save">つなげて保存</button><button class="btn btn--small btn--plain" data-act="link-cancel">やめる</button></div>
    </div>
    <div class="note__tools"><button class="btn btn--small btn--tinted" data-act="link-open">つなげて一言</button><a class="btn btn--small btn--plain" href="#book/${esc(b.id)}">本を見る</a></div>
  </li>`;
}

function reunionSection(found, header) {
  if (!found.notes.length && !found.books.length) return '';
  return `<section class="list-section"><h2 class="list-section__header">${esc(header)}</h2>
    <ul class="list list--inset" data-reunion>
      ${found.notes.map(r => reunionHtml(r, 'note')).join('')}
      ${found.books.map(r => reunionHtml(r, 'book')).join('')}
    </ul>
    <p class="list-section__footer">書名やメモに共通する語から探しています。つなげたメモは、今の本と過去の本の両方に残ります。</p>
  </section>`;
}

// 「つなげて一言」の操作。fromBookId = 今読んでいる本
function bindReunion(root, fromBookId, onSaved) {
  root.querySelectorAll('[data-reunion] .reunion').forEach(li => {
    const reply = li.querySelector('.reunion__reply');
    li.querySelector('[data-act="link-open"]').addEventListener('click', () => {
      reply.hidden = false;
      reply.querySelector('textarea').focus();
    });
    li.querySelector('[data-act="link-cancel"]').addEventListener('click', () => { reply.hidden = true; });
    li.querySelector('[data-act="link-save"]').addEventListener('click', async () => {
      const text = reply.querySelector('textarea').value.trim();
      if (!text) return;
      await saveNote({
        id: db.uid(), bookId: fromBookId, text, quote: '', kind: 'association',
        pos: null, linkedBookIds: [li.dataset.book], createdAt: new Date().toISOString(), source: 'app',
      });
      reply.hidden = true;
      toast('過去の本とつなげて保存しました');
      if (onSaved) onSaved();
    });
  });
}

// ---------- 記録 ----------
async function renderWrite() {
  setTab('write');
  setTitle('記録');
  const reading = state.books.filter(b => b.status === 'reading')
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  if (!reading.find(b => b.id === state.currentBookId)) state.currentBookId = reading[0] ? reading[0].id : null;
  const book = bookById(state.currentBookId);

  if (!book) {
    $view.innerHTML = `<div class="empty">
      <p class="empty__title">読書中の本がありません</p>
      <p class="empty__message">本棚で本を追加するか、読書状態を「読書中」にすると、ここからすぐにメモできます。</p>
      <a class="btn btn--prominent" href="#add">本を追加</a>
    </div>`;
    return;
  }

  const unit = POS_UNIT[book.format] || 'page';
  const last = notesOf(book.id).find(n => n.bookId === book.id && n.pos && n.pos.value);
  const lastPos = last && last.pos.unit === unit ? last.pos.value : '';
  const recent = notesOf(book.id).slice(0, 5);
  const saved = state.lastSaved && state.lastSaved.bookId === book.id ? state.lastSaved : null;

  $view.innerHTML = `
    <div class="book-chips" role="tablist" aria-label="読書中の本">
      ${reading.map(b => `<button class="chip ${b.id === book.id ? 'is-active' : ''}" role="tab" aria-selected="${b.id === book.id}" data-id="${esc(b.id)}">${esc(b.title)}</button>`).join('')}
      <a class="chip chip--add" href="#add">＋ 本を追加</a>
    </div>
    <div class="card">
      <textarea class="field field--note" id="note-text" placeholder="思いつき・フレーズ・問い…&#10;音声はキーボードのマイクで" aria-label="メモ"></textarea>
      <textarea class="field field--quote" id="note-quote" placeholder="本文の引用(任意)" aria-label="引用" hidden></textarea>
    </div>
    <div class="kinds" role="group" aria-label="種類(任意)">
      ${KINDS.map(([k, l]) => `<button class="kind ${state.draftKind === k ? 'is-active' : ''}" data-kind="${k}" aria-pressed="${state.draftKind === k}">${l}</button>`).join('')}
    </div>
    <div class="card" style="margin-top: var(--space-3)">
      <div class="row"><label for="note-pos">${POS_LABEL[unit]}</label><input id="note-pos" inputmode="${unit === 'page' ? 'numeric' : 'text'}" placeholder="${POS_PLACEHOLDER[unit]}" value="${esc(lastPos)}"></div>
    </div>
    <div class="actions">
      <button class="btn btn--tinted" id="toggle-quote">引用を添える</button>
      <button class="btn btn--prominent" id="save-note">保存</button>
    </div>
    <div id="after-save">${saved ? reunionSection(reunions({ text: [saved.quote, saved.text].join(' '), author: book.author, excludeBookId: book.id }), '再会: 関連しそうな過去の読書') : ''}</div>
    ${recent.length ? `<section class="list-section"><h2 class="list-section__header">この本の最近のメモ</h2>
      <ul class="list list--inset">${recent.map(n => noteHtml(n, { showBook: n.bookId !== book.id })).join('')}</ul></section>` : ''}
  `;

  $view.querySelectorAll('.chip[data-id]').forEach(c => c.addEventListener('click', async () => {
    state.currentBookId = c.dataset.id;
    state.lastSaved = null;
    await db.setMeta('currentBookId', c.dataset.id);
    renderWrite();
  }));
  $view.querySelectorAll('.kind').forEach(k => k.addEventListener('click', () => {
    state.draftKind = state.draftKind === k.dataset.kind ? null : k.dataset.kind;
    $view.querySelectorAll('.kind').forEach(x => {
      const on = x.dataset.kind === state.draftKind;
      x.classList.toggle('is-active', on);
      x.setAttribute('aria-pressed', on);
    });
  }));
  const quote = document.getElementById('note-quote');
  document.getElementById('toggle-quote').addEventListener('click', () => { quote.hidden = !quote.hidden; if (!quote.hidden) quote.focus(); });
  document.getElementById('save-note').addEventListener('click', async () => {
    const text = document.getElementById('note-text').value.trim();
    const q = quote.value.trim();
    if (!text && !q) { document.getElementById('note-text').focus(); return; }
    const posValue = document.getElementById('note-pos').value.trim();
    const pos = posValue ? { unit, value: posValue } : null;
    const note = {
      id: db.uid(), bookId: book.id, text, quote: q, kind: state.draftKind || (q && !text ? 'quote' : null),
      pos, progress: progressOf(book, pos), linkedBookIds: [], createdAt: new Date().toISOString(), source: 'app',
    };
    await saveNote(note);
    await saveBook(book); // 並び順(最近使った本を先頭)のため
    state.lastSaved = note;
    state.draftKind = null;
    renderWrite();
    const after = document.getElementById('after-save');
    if (after && after.children.length) {
      toast('保存しました。関連しそうな過去の本があります');
      after.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else toast('保存しました');
  });
  bindReunion($view, book.id, renderWrite);
  bindNoteTools($view, renderWrite);
}

// ---------- メモの表示とAI ----------
function noteHtml(n, { showBook = false } = {}) {
  const b = bookById(n.bookId);
  const linked = (n.linkedBookIds || []).map(bookById).filter(Boolean);
  const meta = [
    fmtDate(n.createdAt), posText(n.pos), n.kind && KIND_LABEL[n.kind],
    n.source && n.source.startsWith('booklog') ? 'ブクログ' : '',
  ].filter(Boolean);
  return `<li class="note" data-note="${esc(n.id)}">
    ${n.quote ? `<blockquote class="note__quote">${esc(n.quote)}</blockquote>` : ''}
    ${n.text ? `<p class="note__text">${esc(n.text)}</p>` : ''}
    <div class="note__meta">${meta.map(esc).join(' ・ ')}
      ${showBook && b ? ` ・ <a href="#book/${esc(b.id)}" style="color:var(--color-accent);text-decoration:none">${esc(b.title)}</a>` : ''}
      ${linked.length ? ` ・ つながり: ${linked.map(x => `<a href="#book/${esc(x.id)}" style="color:var(--color-accent);text-decoration:none">${esc(x.title)}</a>`).join('、')}` : ''}
    </div>
    <div class="note__tools">
      <button class="btn btn--small btn--plain" data-act="ai-open">AIと考える</button>
      <span data-ai-modes hidden>${gemini.modes().map(m => `<button class="btn btn--small btn--tinted" data-ai="${m.key}">${esc(m.label)}</button>`).join(' ')}</span>
      <button class="btn btn--small btn--plain" data-act="delete" style="color:var(--color-destructive);margin-left:auto">削除</button>
    </div>
    <div class="ai-slot"></div>
  </li>`;
}

function bindNoteTools(root, rerender) {
  root.querySelectorAll('.note[data-note]').forEach(li => {
    const note = state.notes.find(n => n.id === li.dataset.note);
    if (!note) return;
    li.querySelector('[data-act="ai-open"]').addEventListener('click', e => { e.currentTarget.hidden = true; li.querySelector('[data-ai-modes]').hidden = false; });
    li.querySelectorAll('[data-ai]').forEach(btn => btn.addEventListener('click', () => runAi(li, note, btn.dataset.ai, btn.textContent, rerender)));
    li.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm('このメモを削除しますか?')) return;
      await db.del('notes', note.id);
      state.notes = state.notes.filter(n => n.id !== note.id);
      invalidate();
      rerender();
    });
  });
}

async function runAi(li, note, mode, label, rerender) {
  const slot = li.querySelector('.ai-slot');
  const apiKey = await db.getMeta('geminiKey');
  if (!apiKey) { toast('設定でGemini APIキーを入れてください'); return; }
  const model = (await db.getMeta('geminiModel')) || gemini.DEFAULT_MODEL;
  const book = bookById(note.bookId) || { title: '' };
  const rel = index().search({ text: [note.quote, note.text].join(' '), excludeBookId: note.bookId }, { type: 'note', limit: 3, minScore: 0.12 })
    .map(r => { const n = state.notes.find(x => x.id === r.doc.id); const b = bookById(r.doc.bookId); return n && b ? { text: n.text, bookTitle: b.title } : null; })
    .filter(Boolean);
  slot.innerHTML = `<div class="ai-answer"><span class="ai-answer__label">AI(${esc(label)})</span>考えています…</div>`;
  try {
    const answer = await gemini.ask({ apiKey, model, mode, book, note, related: rel });
    slot.innerHTML = `<div class="ai-answer"><span class="ai-answer__label">AI(${esc(label)})・AIの一般知識を含みます</span>${esc(answer)}</div>
      <div class="reunion__reply"><textarea placeholder="答えてみる(自分の言葉で)" aria-label="AIへの答え"></textarea>
      <div class="note__tools"><button class="btn btn--small btn--prominent" data-act="answer">メモとして保存</button></div></div>`;
    slot.querySelector('[data-act="answer"]').addEventListener('click', async () => {
      const text = slot.querySelector('textarea').value.trim();
      if (!text) return;
      await saveNote({
        id: db.uid(), bookId: note.bookId, text, quote: '', kind: mode === 'devil' ? 'objection' : 'question',
        pos: null, linkedBookIds: [], replyTo: note.id, aiPrompt: answer, createdAt: new Date().toISOString(), source: 'app-ai',
      });
      toast('自分の答えを保存しました');
      rerender();
    });
  } catch (e) {
    slot.innerHTML = `<div class="ai-answer">${esc(e.message)}</div>`;
  }
}

// ---------- 書影 ----------
// 候補URLを <img> で順に試し、読めたURLを本に保存する(次からはそれを直接出す)。
// 全部だめなら Google Books に1冊ずつ問い合わせる。上限(429)に当たったらその日は諦める。
const COVER_V = 2; // 旧版で「なし」と判定した本も探し直す
const COVER_RETRY_DAYS = 30;

function coverHtml(b, size = 'sm') {
  const initial = esc((b.title || '').replace(/^[「『(（\s]+/, '').slice(0, 1));
  const saved = b.cover && b.cover !== 'none' ? [b.cover] : [];
  const stale = b.cover === 'none' && (b.coverV !== COVER_V || Date.now() - Date.parse(b.coverCheckedAt || 0) > COVER_RETRY_DAYS * 864e5);
  const cands = [...new Set([...saved, ...(b.thumbnail ? [b.thumbnail] : []),
    ...(b.cover === 'none' && !stale ? [] : coverCandidates(b))])];
  const ph = `<span class="cover__ph">${initial}</span>`;
  if (!cands.length) return `<span class="cover cover--${size}" aria-hidden="true">${ph}</span>`;
  return `<span class="cover cover--${size}" data-cover="${esc(b.id || '')}" data-cands="${esc(cands.slice(1).join(' '))}" aria-hidden="true">${ph}<img src="${esc(cands[0])}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
}

function coverLoaded(img) {
  const box = img.parentElement;
  // Amazonは画像がないと1×1のGIFを返すので、小さすぎる画像は失敗扱い
  if (img.naturalWidth <= 2) return coverFailed(img);
  box.classList.add('has-img');
  const b = bookById(box.dataset.cover);
  if (b && b.cover !== img.src) {
    b.cover = img.src;
    b.coverV = COVER_V;
    b.coverCheckedAt = new Date().toISOString();
    db.put('books', b); // 並び順を変えないよう updatedAt は触らない
  }
}

function coverFailed(img) {
  const box = img.parentElement;
  const rest = (box.dataset.cands || '').split(' ').filter(Boolean);
  if (rest.length) {
    box.dataset.cands = rest.slice(1).join(' ');
    img.src = rest[0];
    return;
  }
  img.remove();
  box.classList.remove('has-img');
  const b = bookById(box.dataset.cover);
  if (b) queueGoogleCover(b);
}

// <img> の load/error はバブリングしないので、捕捉フェーズでまとめて受ける
document.addEventListener('load', e => { if (e.target.tagName === 'IMG' && e.target.parentElement?.classList.contains('cover')) coverLoaded(e.target); }, true);
document.addEventListener('error', e => { if (e.target.tagName === 'IMG' && e.target.parentElement?.classList.contains('cover')) coverFailed(e.target); }, true);

const googleQueue = [];
const googleQueued = new Set();
let googleBusy = false;
let googleBlocked = false;

function queueGoogleCover(b) {
  if (googleBlocked || googleQueued.has(b.id) || !navigator.onLine) return;
  googleQueued.add(b.id);
  googleQueue.push(b);
  pumpGoogle();
}

async function pumpGoogle() {
  if (googleBusy) return;
  googleBusy = true;
  while (googleQueue.length && !googleBlocked) {
    const b = googleQueue.shift();
    try {
      const url = await googleCover(b);
      b.cover = url || 'none';
      b.coverV = COVER_V;
      b.coverCheckedAt = new Date().toISOString();
      await db.put('books', b);
      if (url) document.querySelectorAll(`[data-cover="${CSS.escape(b.id)}"]`).forEach(x => {
        x.dataset.cands = '';
        x.insertAdjacentHTML('beforeend', `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">`);
      });
    } catch (e) {
      if ([429, 403, 503].includes(e.status)) googleBlocked = true; // 今回は諦める(保存しないので次回また試す)
    }
    await new Promise(r => setTimeout(r, 400));
  }
  googleBusy = false;
}

// ---------- 本棚 ----------
let shelfFilter = 'reading';
let shelfQuery = '';
let shelfSort = 'added'; // added | finished | published
let shelfAsc = false;
const SORTS = {
  added: { label: '登録日', key: b => dateInput(b.createdAt) },
  finished: { label: '読了日', key: b => dateInput(b.finishedAt) },
  published: { label: '刊行日', key: b => (b.year || '').replace(/[^\d-]/g, '') },
};

function renderShelf() {
  setTab('shelf');
  setTitle('本棚');
  const filters = [['reading', '読書中'], ['want', '読みたい'], ['done', '読了'], ['all', 'すべて']];
  const q = shelfQuery.normalize('NFKC').toLowerCase();
  const list = state.books
    .filter(b => shelfFilter === 'all' || b.status === shelfFilter)
    .filter(b => !q || `${b.title} ${b.author}`.normalize('NFKC').toLowerCase().includes(q))
    .sort((a, b) => {
      const ka = SORTS[shelfSort].key(a), kb = SORTS[shelfSort].key(b);
      if (!ka !== !kb) return ka ? -1 : 1; // 日付のない本は最後
      return shelfAsc ? ka.localeCompare(kb) : kb.localeCompare(ka);
    });
  const counts = Object.fromEntries(filters.map(([k]) => [k, k === 'all' ? state.books.length : state.books.filter(b => b.status === k).length]));
  $view.innerHTML = `
    <label class="search"><span aria-hidden="true">⌕</span><input id="shelf-q" type="search" placeholder="書名・著者で絞り込み" value="${esc(shelfQuery)}" aria-label="本棚を検索"></label>
    <div class="segmented-wrap" style="margin-top: var(--space-3)"><div class="segmented" role="tablist">
      ${filters.map(([k, l]) => `<button class="segmented__item ${k === shelfFilter ? 'is-active' : ''}" role="tab" aria-selected="${k === shelfFilter}" data-f="${k}">${l} ${counts[k]}</button>`).join('')}
    </div></div>
    <div class="pad"><a class="btn btn--tinted btn--large" href="#add">本を追加</a></div>
    <div class="sort-bar">
      <label for="shelf-sort">並び順</label>
      <select id="shelf-sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === shelfSort ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <button class="btn btn--small btn--plain" id="shelf-dir" aria-label="並びの向きを切り替える">${shelfAsc ? '古い順 ↑' : '新しい順 ↓'}</button>
    </div>
    <section class="list-section">
      ${list.length ? `<ul class="list list--inset">${list.slice(0, 300).map(b => {
        const n = state.notes.filter(x => x.bookId === b.id).length;
        return `<li><a class="list__row" href="#book/${esc(b.id)}" style="color:inherit;text-decoration:none">
          ${coverHtml(b)}<div class="list__text"><span class="list__title">${esc(b.title)}</span>
          <span class="list__subtitle">${esc([b.author, shelfDateLabel(b), n && `メモ${n}`].filter(Boolean).join(' ・ '))}</span></div>
          <span class="list__chevron" aria-hidden="true">›</span></a></li>`;
      }).join('')}</ul>${list.length > 300 ? `<p class="list-section__footer">先頭300冊を表示しています。検索で絞り込めます。</p>` : ''}`
      : `<div class="empty"><p class="empty__message">該当する本はありません。設定からブクログの記録を取り込めます。</p></div>`}
    </section>`;
  const input = document.getElementById('shelf-q');
  input.addEventListener('input', () => {
    shelfQuery = input.value;
    const pos = input.selectionStart;
    renderShelf();
    const again = document.getElementById('shelf-q');
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  $view.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { shelfFilter = b.dataset.f; renderShelf(); }));
  document.getElementById('shelf-sort').addEventListener('change', e => { shelfSort = e.target.value; db.setMeta('shelfSort', shelfSort); renderShelf(); });
  document.getElementById('shelf-dir').addEventListener('click', () => { shelfAsc = !shelfAsc; db.setMeta('shelfAsc', shelfAsc); renderShelf(); });
}

// 並び順に合わせて、一覧に出す日付を変える
function shelfDateLabel(b) {
  if (shelfSort === 'published') return b.year ? `${b.year}年刊` : '';
  if (shelfSort === 'added') return b.createdAt ? `${fmtDate(b.createdAt)}登録` : '';
  return b.finishedAt ? `${fmtDate(b.finishedAt)}読了` : '';
}

// ---------- 本を追加 ----------
function renderAdd() {
  setTab('shelf');
  setTitle('本を追加', { back: true });
  $view.innerHTML = `
    <form id="add-form" class="search" role="search"><span aria-hidden="true">⌕</span><input id="add-q" type="search" placeholder="ISBN・書名・著者" aria-label="本を検索" enterkeyhint="search"></form>
    <p class="list-section__footer">ISBNは本の裏表紙のバーコード下の数字(978から始まる13桁)です。</p>
    <div id="add-results"></div>
    <section class="list-section"><h2 class="list-section__header">見つからないときは手で登録</h2>
      <div class="card">
        <div class="row"><label for="m-title">書名</label><input id="m-title"></div>
        <div class="row"><label for="m-author">著者</label><input id="m-author"></div>
        <div class="row"><label for="m-format">媒体</label><select id="m-format">${Object.entries(FORMAT_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
      </div>
      <div class="actions"><button class="btn btn--tinted" id="m-add">この内容で登録</button></div>
    </section>`;
  const form = document.getElementById('add-form');
  const results = document.getElementById('add-results');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const q = document.getElementById('add-q').value.trim();
    if (!q) return;
    results.innerHTML = `<p class="pad muted">検索しています…</p>`;
    try {
      const found = await searchBooks(q);
      if (!found.length) { results.innerHTML = `<p class="pad muted">見つかりませんでした。下から手で登録できます。</p>`; return; }
      results.innerHTML = `<section class="list-section"><ul class="list list--inset">${found.map((b, i) => {
        const dup = state.books.find(x => (b.isbn13 && x.isbn13 === b.isbn13));
        return `<li class="list__row">${coverHtml(b)}<div class="list__text"><span class="list__title">${esc(b.title)}</span>
          <span class="list__subtitle">${esc([b.author, b.publisher, b.year].filter(Boolean).join(' ・ '))}${dup ? ' ・ 登録済み' : ''}</span>
          <div class="note__tools">${Object.entries(FORMAT_LABEL).map(([k, l]) => `<button class="btn btn--small btn--tinted" data-i="${i}" data-format="${k}">${l}で読む</button>`).join('')}</div></div></li>`;
      }).join('')}</ul></section>`;
      results.querySelectorAll('[data-i]').forEach(btn => btn.addEventListener('click', () => addBook(found[Number(btn.dataset.i)], btn.dataset.format)));
    } catch (err) {
      results.innerHTML = `<p class="pad muted">${esc(err.message)}。電波のある場所で試すか、下から手で登録してください。</p>`;
    }
  });
  document.getElementById('m-add').addEventListener('click', () => {
    const title = document.getElementById('m-title').value.trim();
    if (!title) { document.getElementById('m-title').focus(); return; }
    addBook({ title, author: document.getElementById('m-author').value.trim() }, document.getElementById('m-format').value);
  });
  setTimeout(() => document.getElementById('add-q').focus(), 50);
}

async function addBook(info, format) {
  const existing = info.isbn13 && state.books.find(b => b.isbn13 === info.isbn13);
  const book = existing || {
    id: db.uid(), isbn13: info.isbn13 || null, title: info.title, author: info.author || '',
    publisher: info.publisher || '', year: info.year || '', pages: info.pages || null,
    description: info.description || '', tags: [], subjects: [], ndc: null, cover: info.thumbnail || null,
    createdAt: new Date().toISOString(), source: 'app',
  };
  book.format = format;
  book.status = 'reading';
  book.startedAt = book.startedAt || new Date().toISOString().slice(0, 10);
  await saveBook(book);
  state.currentBookId = book.id;
  await db.setMeta('currentBookId', book.id);
  // 件名とNDCは後から補う(失敗しても登録は済んでいる)
  ndlSubjects(book).then(async r => { if (r && (r.ndc || r.subjects.length)) { Object.assign(book, r); await saveBook(book); } });
  toast(existing ? '読書中にしました' : '登録しました');
  location.hash = `#book/${book.id}`;
}

// ---------- 本の詳細 ----------
function renderBook(id) {
  const book = bookById(id);
  if (!book) { location.hash = '#shelf'; return; }
  setTab('shelf');
  setTitle(book.title, { back: true });
  const notes = notesOf(book.id);
  const found = reunions({ text: [book.title, (book.subjects || []).join(' '), book.description || ''].join(' '), author: book.author, excludeBookId: book.id });
  $view.innerHTML = `
    <div class="book-head book-head--cover">
      ${coverHtml(book, 'lg')}
      <div>
        <h2>${esc(book.title)}</h2>
        <p class="muted">${esc([book.author, book.publisher, book.year].filter(Boolean).join(' ・ '))}</p>
        ${(book.ndc || (book.subjects || []).length) ? `<div class="tags">${book.ndc ? `<span class="tag">NDC ${esc(book.ndc)}</span>` : ''}${(book.subjects || []).map(s => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}
      </div>
    </div>
    <section class="list-section" id="summary-section">
      <h2 class="list-section__header">概要</h2>
      <div id="summary"><p class="list-section__footer">${navigator.onLine ? '探しています…' : 'オフラインのため表示できません。'}</p></div>
    </section>
    <div class="card">
      <div class="row"><label for="b-status">状態</label><select id="b-status">${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${book.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="row"><label for="b-format">媒体</label><select id="b-format">${Object.entries(FORMAT_LABEL).map(([k, l]) => `<option value="${k}" ${book.format === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="row"><label for="b-pages">ページ数</label><input id="b-pages" inputmode="numeric" value="${esc(book.pages || '')}"></div>
      <div class="row"><label for="b-added">登録日</label><input id="b-added" type="date" value="${dateInput(book.createdAt)}"></div>
      <div class="row"><label for="b-started">読み始めた日</label><input id="b-started" type="date" value="${dateInput(book.startedAt)}"></div>
      <div class="row"><label for="b-finished">読了日</label><input id="b-finished" type="date" value="${dateInput(book.finishedAt)}"></div>
    </div>
    ${book.status === 'reading' ? `<div class="actions"><a class="btn btn--prominent" href="#write" id="b-write">この本にメモする</a></div>` : ''}
    <section class="list-section"><h2 class="list-section__header">メモ ${notes.length}</h2>
      ${notes.length ? `<ul class="list list--inset">${notes.map(n => noteHtml(n, { showBook: n.bookId !== book.id })).join('')}</ul>` : `<p class="list-section__footer">まだメモはありません。</p>`}
    </section>
    ${reunionSection(found, '関連しそうな過去の読書')}
    ${linksSection(book)}
    <section class="list-section" id="author-section" ${book.author ? '' : 'hidden'}>
      <h2 class="list-section__header">${esc(firstName(book.author))}の他の作品</h2>
      <div id="author-wiki"></div>
      <div id="author-mine"></div>
      <div id="author-works"><p class="list-section__footer">探しています…</p></div>
    </section>
    <div class="actions"><button class="btn btn--plain" id="b-ndl">国立国会図書館の件名を補う</button></div>`;
  if (book.author) loadAuthor(book);
  loadSummary(book);
  const update = async e => {
    book.status = document.getElementById('b-status').value;
    book.format = document.getElementById('b-format').value;
    book.pages = Number(document.getElementById('b-pages').value) || null;
    const added = document.getElementById('b-added').value;
    if (added && added !== dateInput(book.createdAt)) book.createdAt = `${added}T00:00:00`;
    book.startedAt = document.getElementById('b-started').value || null;
    book.finishedAt = document.getElementById('b-finished').value || null;
    const today = dateInput(new Date().toISOString());
    // 状態を「読了」にしたら今日を読了日に、「読書中」にしたら今日を読み始めた日に(空のときだけ)
    if (book.status === 'done' && !book.finishedAt) book.finishedAt = today;
    if (book.status === 'reading' && !book.startedAt) book.startedAt = today;
    // 読了日を入れたら状態も読了に
    if (e && e.target.id === 'b-finished' && book.finishedAt && (book.status === 'reading' || book.status === 'want')) book.status = 'done';
    await saveBook(book);
    ['b-status', 'b-started', 'b-finished'].forEach(i => { const el = document.getElementById(i); if (el) el.value = i === 'b-status' ? book.status : dateInput(i === 'b-started' ? book.startedAt : book.finishedAt); });
    renderBook(id);
  };
  ['b-status', 'b-format', 'b-pages', 'b-added', 'b-started', 'b-finished'].forEach(i => document.getElementById(i).addEventListener('change', update));
  const w = document.getElementById('b-write');
  if (w) w.addEventListener('click', () => { state.currentBookId = book.id; db.setMeta('currentBookId', book.id); });
  document.getElementById('b-ndl').addEventListener('click', async () => {
    const r = await ndlSubjects(book);
    if (!r) { toast('国立国会図書館から取得できませんでした'); return; }
    Object.assign(book, r);
    await saveBook(book);
    toast(r.ndc || r.subjects.length ? '件名を補いました' : '件名は見つかりませんでした');
    renderBook(id);
  });
  bindReunion($view, book.id, () => renderBook(id));
  bindNoteTools($view, () => renderBook(id));
}

function firstName(author) {
  return (author || '').split(/[,、/／]/)[0].trim();
}

function linksSection(book) {
  const links = relatedLinks(book);
  const groups = [...new Set(links.map(l => l.group))];
  return `<section class="list-section"><h2 class="list-section__header">関連リンク</h2>
    <ul class="list list--inset">${groups.map(g => `<li class="list__row links-row">
      <span class="links-row__group">${esc(g)}</span>
      <span class="links-row__items">${links.filter(l => l.group === g).map(l => `<a class="btn btn--small btn--tinted" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}</span>
    </li>`).join('')}</ul>
    <p class="list-section__footer">各サービスの検索結果を開きます。</p></section>`;
}

// ---------- 概要 ----------
// 取れた概要は本に保存する。どこにもなければ30日は探し直さない。
function showSummary(book) {
  const box = document.getElementById('summary');
  if (!box) return;
  if (!book.description) { box.innerHTML = `<p class="list-section__footer">概要は見つかりませんでした。</p>`; return; }
  const long = book.description.length > 140;
  box.innerHTML = `<div class="card"><p class="summary${long ? ' is-clamped' : ''}">${esc(book.description)}</p>
    ${long ? `<button class="btn btn--small btn--plain" id="summary-more">続きを読む</button>` : ''}</div>
    ${book.descriptionSource ? `<p class="list-section__footer">出典: ${esc(book.descriptionSource)}</p>` : ''}`;
  const more = document.getElementById('summary-more');
  if (more) more.addEventListener('click', () => {
    const p = box.querySelector('.summary');
    p.classList.toggle('is-clamped');
    more.textContent = p.classList.contains('is-clamped') ? '続きを読む' : '閉じる';
  });
}

async function loadSummary(book) {
  const fresh = book.descriptionCheckedAt && Date.now() - Date.parse(book.descriptionCheckedAt) < 30 * 864e5;
  if (book.description || fresh || !navigator.onLine) return showSummary(book);
  const r = await bookSummary(book);
  if (r && r.failed) { showSummary(book); return; } // 次に開いたときまた探す
  book.descriptionCheckedAt = new Date().toISOString();
  if (r) { book.description = r.text; book.descriptionSource = r.source; invalidate(); }
  await db.put('books', book); // 並び順を変えないよう updatedAt は触らない
  if (bookById(book.id) && location.hash === `#book/${book.id}`) showSummary(book);
}

const authorCache = new Map();

async function loadAuthor(book) {
  const name = firstName(book.author);
  const box = document.getElementById('author-works');
  const wikiBox = document.getElementById('author-wiki');
  const mineBox = document.getElementById('author-mine');
  const norm = s => (s || '').normalize('NFKC').replace(/[\s(（:：].*$/, '').toLowerCase();
  const nameKey = name.replace(/\s/g, '');

  // 1) 本棚にある同じ著者の本(端末内なので必ず出る)
  const mine = state.books.filter(b => b.id !== book.id && (b.author || '').replace(/\s/g, '').includes(nameKey));
  if (mine.length) {
    mineBox.innerHTML = `<p class="list-section__footer" style="margin-bottom:var(--space-2)">本棚にある本 ${mine.length}冊</p>
      <ul class="list list--inset">${mine.map(b => `<li><a class="list__row" href="#book/${esc(b.id)}" style="color:inherit;text-decoration:none">
        ${coverHtml(b)}<div class="list__text"><span class="list__title">${esc(b.title)}</span>
        <span class="list__subtitle">${esc([STATUS_LABEL[b.status], b.year].filter(Boolean).join(' ・ '))}</span></div></a></li>`).join('')}</ul>`;
  }

  // 2) ネットで探す他の作品
  if (!navigator.onLine) { box.innerHTML = `<p class="list-section__footer">オフラインのため、ほかの作品は探せません。</p>`; return; }
  try {
    if (!authorCache.has(name)) authorCache.set(name, Promise.all([authorWorks(name), wikiSummary(name)]));
    const [{ works, source }, wiki] = await authorCache.get(name);
    if (!document.body.contains(box)) return; // 画面を離れた
    if (wiki) {
      wikiBox.innerHTML = `<div class="card author-wiki"><p class="small" style="margin:0">${esc(wiki.extract.slice(0, 160))}${wiki.extract.length > 160 ? '…' : ''}</p>
        <a class="small" href="${esc(wiki.url)}" target="_blank" rel="noopener" style="color:var(--color-accent);text-decoration:none">Wikipediaで読む</a></div>`;
    }
    const inShelf = w => state.books.find(b => (w.isbn13 && b.isbn13 === w.isbn13) || norm(b.title) === norm(w.title));
    const others = works.filter(w => norm(w.title) !== norm(book.title) && !(w.isbn13 && w.isbn13 === book.isbn13) && !inShelf(w));
    if (!others.length) { box.innerHTML = `<p class="list-section__footer">本棚にない作品は見つかりませんでした。</p>`; return; }
    box.innerHTML = `<p class="list-section__footer" style="margin:var(--space-4) 0 var(--space-2)">まだ読んでいない作品 ${others.length}冊</p>
      <ul class="list list--inset">${others.map((w, i) => `<li class="list__row">${coverHtml({ ...w, id: '' })}
        <div class="list__text"><span class="list__title">${esc(w.title)}</span>
        <span class="list__subtitle">${esc([w.year, w.publisher].filter(Boolean).join(' ・ '))}</span></div>
        <button class="btn btn--small btn--tinted" data-want="${i}">読みたい</button></li>`).join('')}</ul>
      <p class="list-section__footer">${esc(source)}の情報です。同名の別人の本が混じることがあります。</p>`;
    box.querySelectorAll('[data-want]').forEach(btn => btn.addEventListener('click', async () => {
      const w = others[Number(btn.dataset.want)];
      await saveBook({
        id: db.uid(), isbn13: w.isbn13 || null, title: w.title, author: w.author, publisher: w.publisher,
        year: w.year, pages: w.pages, description: w.description, tags: [], subjects: [], ndc: null,
        cover: w.thumbnail || null, format: 'paper', status: 'want', createdAt: new Date().toISOString(), source: 'app',
      });
      btn.outerHTML = `<span class="small muted">追加済み</span>`;
      toast('「読みたい」に追加しました');
    }));
  } catch (e) {
    authorCache.delete(name);
    box.innerHTML = `<p class="list-section__footer">ほかの作品を探せませんでした(${esc(e.message)})。${e.status === 429 ? '設定でGoogle BooksのAPIキーを入れると安定します。' : ''}</p>`;
  }
}

// ---------- メモ一覧 ----------
let notesQuery = '';
function renderNotes() {
  setTab('notes');
  setTitle('メモ');
  const q = notesQuery.normalize('NFKC').toLowerCase();
  const list = state.notes
    .filter(n => !q || `${n.text} ${n.quote}`.normalize('NFKC').toLowerCase().includes(q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $view.innerHTML = `
    <label class="search"><span aria-hidden="true">⌕</span><input id="notes-q" type="search" placeholder="メモを検索" value="${esc(notesQuery)}" aria-label="メモを検索"></label>
    <section class="list-section">
      ${list.length ? `<ul class="list list--inset">${list.slice(0, 200).map(n => noteHtml(n, { showBook: true })).join('')}</ul>` : `<div class="empty"><p class="empty__message">メモはまだありません。</p></div>`}
    </section>`;
  const input = document.getElementById('notes-q');
  input.addEventListener('change', () => { notesQuery = input.value; renderNotes(); });
  bindNoteTools($view, renderNotes);
}

// ---------- 設定 ----------
async function renderSettings() {
  setTab('settings');
  setTitle('設定');
  const [key, model, lastBackup, persisted, booksKey] = await Promise.all([
    db.getMeta('geminiKey', ''), db.getMeta('geminiModel', ''), db.getMeta('lastBackupAt'),
    navigator.storage && navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
    db.getMeta('booksKey', ''),
  ]);
  const imported = state.books.filter(b => b.source === 'booklog').length;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $view.innerHTML = `
    <section class="list-section"><h2 class="list-section__header">バックアップ</h2>
      <div class="card">
        <p class="small muted" style="margin:0">データはこのiPhoneの中だけにあります。定期的に書き出して「ファイル」アプリ(iCloud Drive)に保存してください。</p>
        <p class="small" style="margin:var(--space-2) 0 0">最後の書き出し: ${lastBackup ? fmtDate(lastBackup) : 'まだありません'}</p>
      </div>
      <div class="actions"><button class="btn btn--prominent" id="export">書き出す</button><label class="btn btn--tinted">読み込む<input type="file" id="import" accept="application/json,.json" hidden></label></div>
      ${!standalone ? `<p class="list-section__footer">Safariの共有ボタンから「ホーム画面に追加」してから使ってください。追加しないと、しばらく開かないうちにデータが消えることがあります。</p>` : ''}
      <p class="list-section__footer">保存領域の保護: ${persisted ? '有効' : '未許可'}</p>
    </section>
    <section class="list-section"><h2 class="list-section__header">ブクログから取り込む</h2>
      <div class="card"><p class="small muted" style="margin:0">ブクログの「データのエクスポート」で書き出したCSVを選びます。同じ本は二重に登録されません。${imported ? `取り込み済み: ${imported}冊` : ''}</p></div>
      <div class="actions"><label class="btn btn--tinted">CSVを選ぶ<input type="file" id="booklog" accept=".csv,text/csv" hidden></label></div>
    </section>
    <section class="list-section"><h2 class="list-section__header">AI(Gemini)</h2>
      <div class="card">
        <div class="row"><label for="g-key">APIキー</label><input id="g-key" type="password" autocomplete="off" value="${esc(key)}" placeholder="Google AI Studioで取得"></div>
        <div class="row"><label for="g-model">モデル</label><input id="g-model" value="${esc(model)}" placeholder="${gemini.DEFAULT_MODEL}"></div>
      </div>
      <p class="list-section__footer">無料枠では、送った内容がGoogleの製品改善に使われ、人が読むこともあります。AIに送るのは、メモの「問い返す」などを押したときだけです。キーはこの端末にだけ保存され、書き出しファイルにも含まれません。</p>
    </section>
    <section class="list-section"><h2 class="list-section__header">書影と本の情報</h2>
      <div class="card">
        <div class="row"><label for="b-key">Google Books キー</label><input id="b-key" type="password" autocomplete="off" value="${esc(booksKey)}" placeholder="任意"></div>
      </div>
      <p class="list-section__footer">書影は国立国会図書館とAmazonの画像を使い、キーは要りません。Google Booksはキーなしだと世界中の利用者で上限を分け合うため、よく止まります。Google CloudでBooks APIを有効にしたキー(無料)を入れると、本の検索と著者の作品一覧が安定します。</p>
      <div class="actions"><button class="btn btn--tinted" id="diag">接続を確かめる</button></div>
      <div id="diag-out"></div>
    </section>
    <section class="list-section"><h2 class="list-section__header">このアプリについて</h2>
      <p class="list-section__footer">本 ${state.books.length}冊 ・ メモ ${state.notes.length}件。書誌の検索にGoogle Books APIと国立国会図書館サーチのAPIを利用しています。</p>
    </section>`;

  document.getElementById('export').addEventListener('click', async () => {
    try { if (await exportData()) { toast('書き出しました'); renderSettings(); } } catch (e) { toast(e.message); }
  });
  document.getElementById('import').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { const n = await importData(await f.text()); await load(); toast(`${n}件を読み込みました`); renderSettings(); } catch (err) { toast(err.message); }
  });
  document.getElementById('booklog').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { const r = await importBooklog(await f.arrayBuffer()); toast(`${r.books}冊・メモ${r.notes}件を取り込みました`, 4000); renderSettings(); } catch (err) { toast(`取り込めませんでした: ${err.message}`); }
  });
  const saveKey = async () => {
    await db.setMeta('geminiKey', document.getElementById('g-key').value.trim());
    await db.setMeta('geminiModel', document.getElementById('g-model').value.trim());
    toast('保存しました');
  };
  document.getElementById('g-key').addEventListener('change', saveKey);
  document.getElementById('b-key').addEventListener('change', async e => {
    const k = e.target.value.trim();
    await db.setMeta('booksKey', k);
    setBooksKey(k);
    toast('保存しました');
  });
  document.getElementById('diag').addEventListener('click', runDiagnostics);
  document.getElementById('g-model').addEventListener('change', saveKey);
}

// 実機で何が届いて何が止まっているかを一覧する
async function runDiagnostics() {
  const out = document.getElementById('diag-out');
  const sample = state.books.find(b => b.isbn13) || { isbn13: '9784101001616', itemId: '4101001618', title: '', author: '' };
  const img = url => new Promise(res => {
    const i = new Image();
    const t = setTimeout(() => res('時間切れ'), 10000);
    i.onload = () => { clearTimeout(t); res(i.naturalWidth > 2 ? `OK(${i.naturalWidth}×${i.naturalHeight})` : '画像なし'); };
    i.onerror = () => { clearTimeout(t); res('読めない'); };
    i.referrerPolicy = 'no-referrer';
    i.src = url;
  });
  const http = async url => {
    try {
      const r = await fetch(url);
      if (r.ok) return 'OK';
      let why = '';
      try { const j = await r.json(); why = (j.error && (j.error.errors?.[0]?.reason || j.error.status || j.error.message)) || ''; } catch {}
      return `HTTP ${r.status}${why ? ` ${why}` : ''}`;
    } catch (e) { return `通信できない(${e.message})`; }
  };
  const key = await db.getMeta('booksKey', '');
  const checks = [
    ['国立国会図書館の書影', () => img(`https://ndlsearch.ndl.go.jp/thumbnail/${sample.isbn13}.jpg`)],
    ['Amazonの書影', () => img(`https://m.media-amazon.com/images/P/${sample.itemId || isbn13to10(sample.isbn13)}.09.MZZZZZZZ.jpg`)],
    [key ? 'Google Books(キーあり)' : 'Google Books(キーなし)', () => http(`https://www.googleapis.com/books/v1/volumes?q=isbn:${sample.isbn13}${key ? `&key=${encodeURIComponent(key)}` : ''}`)],
    ['国立国会図書館サーチ', () => http(`https://ndlsearch.ndl.go.jp/api/opensearch?isbn=${sample.isbn13}&cnt=1`)],
    ['Wikipedia', () => http('https://ja.wikipedia.org/api/rest_v1/page/summary/%E5%A4%8F%E7%9B%AE%E6%BC%B1%E7%9F%B3')],
  ];
  out.innerHTML = `<ul class="list list--inset">${checks.map(([label], i) => `<li class="list__row"><div class="list__text"><span class="list__title">${label}</span></div><span class="list__value" id="diag-${i}">確認中…</span></li>`).join('')}</ul>
    <p class="list-section__footer">確かめた本: ${esc(sample.title || '新潮文庫の見本')}</p>`;
  await Promise.all(checks.map(async ([, fn], i) => { document.getElementById(`diag-${i}`).textContent = await fn(); }));
}

async function importBooklog(buffer) {
  const { records } = parseBooklog(buffer);
  const byKey = new Map(state.books.filter(b => b.booklogKey).map(b => [b.booklogKey, b]));
  const byIsbn = new Map(state.books.filter(b => b.isbn13).map(b => [b.isbn13, b]));
  const books = [];
  const notes = [];
  for (const { book, notes: ns } of records) {
    if (byKey.has(book.booklogKey) || (book.isbn13 && byIsbn.has(book.isbn13))) continue;
    book.id = db.uid();
    book.subjects = [];
    book.ndc = null;
    books.push(book);
    for (const n of ns) notes.push({ id: db.uid(), bookId: book.id, quote: '', pos: null, linkedBookIds: [], ...n });
  }
  await db.putMany('books', books);
  await db.putMany('notes', notes);
  await load();
  return { books: books.length, notes: notes.length };
}

// ---------- ルーティング ----------
async function route() {
  const [name, arg] = location.hash.replace(/^#/, '').split('/');
  window.scrollTo(0, 0);
  switch (name) {
    case 'shelf': return renderShelf();
    case 'add': return renderAdd();
    case 'book': return renderBook(decodeURIComponent(arg || ''));
    case 'notes': return renderNotes();
    case 'settings': return renderSettings();
    default: return renderWrite();
  }
}

document.getElementById('back').addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = '#shelf'));
addEventListener('hashchange', route);

// Large Title の折り畳み
const nav = document.getElementById('nav');
const sentinel = document.createElement('div');
sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;';
document.body.prepend(sentinel);
new IntersectionObserver(([e]) => nav.classList.toggle('is-collapsed', !e.isIntersecting), { threshold: 0 }).observe(sentinel);

(async function start() {
  await load();
  db.requestPersist();
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// テスト用に公開
window.__app = { state, importBooklog, normalizeIsbn };
