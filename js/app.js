import * as db from './db.js';
import { parseBooklog } from './booklog.js';
import { buildIndex } from './related.js';
import { buildBookNotePrompt, splitSections, mdBlockToHtml } from './booknote.js';
import { DEFAULT_CATEGORIES, ndcToCategory, parseCategories, buildClassifyPrompt, parseClassifyResult } from './categories.js';
import { LENSES, buildDiscoverPrompt, parseDiscoverResult, amazonSearchUrl } from './discover.js';
import { parseWantText, WANT_SOURCES } from './wantimport.js';
import { checkLibrary } from './calil.js';
import { statsHtml, attachTooltips, scoreOf } from './stats.js';
import { parseNdlItems, searchBooks, ndlSubjects, normalizeIsbn, coverCandidates, googleCover, bookSummary, setBooksKey, isbn13to10, authorWorks, wikiSummary, relatedLinks } from './books.js';
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
  categories: DEFAULT_CATEGORIES,
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
  state.categories = parseCategories(await db.getMeta('categories', ''));
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
let shelfCat = ''; // '' = すべて, '-' = 未分類
const SORTS = {
  added: { label: '登録日', key: b => dateInput(b.createdAt) },
  finished: { label: '読了日', key: b => dateInput(b.finishedAt) },
  published: { label: '刊行日', key: b => (b.year || '').replace(/[^\d-]/g, '') },
  score: { label: '評価', key: b => scoreOf(b) ? String(scoreOf(b)).padStart(2, '0') : '' },
};

function renderShelf() {
  setTab('shelf');
  setTitle('本棚');
  const filters = [['reading', '読書中'], ['want', '読みたい'], ['done', '読了'], ['all', 'すべて']];
  const q = shelfQuery.normalize('NFKC').toLowerCase();
  const list = state.books
    .filter(b => shelfFilter === 'all' || b.status === shelfFilter)
    .filter(b => !q || `${b.title} ${b.author}`.normalize('NFKC').toLowerCase().includes(q))
    .filter(b => !shelfCat || (shelfCat === '-' ? !b.category : b.category === shelfCat))
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
    ${shelfFilter === 'want' ? `<div class="actions" style="padding-bottom:0"><a class="btn btn--plain" href="#add">まとめて追加</a><button class="btn btn--plain" id="lib-check">図書館の貸出状況を確認</button></div>` : ''}
    <div class="sort-bar">
      <label for="shelf-sort">並び順</label>
      <select id="shelf-sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === shelfSort ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <select id="shelf-cat" aria-label="カテゴリで絞り込む"><option value="">全カテゴリ</option>${state.categories.map(c => `<option ${c === shelfCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="-" ${shelfCat === '-' ? 'selected' : ''}>未分類</option></select>
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
  const lib = document.getElementById('lib-check');
  if (lib) lib.addEventListener('click', async () => {
    lib.disabled = true;
    lib.textContent = '確認しています…';
    try {
      const r = await checkBooksAtLibrary(state.books.filter(b => b.status === 'want'));
      toast(`${r.checked}冊を確認しました${r.skipped ? `(ISBNのない${r.skipped}冊は除く)` : ''}`, 4000);
      renderShelf();
    } catch (e) { toast(e.message, 4000); lib.disabled = false; lib.textContent = '図書館の貸出状況を確認'; }
  });
  document.getElementById('shelf-cat').addEventListener('change', e => { shelfCat = e.target.value; renderShelf(); });
  document.getElementById('shelf-dir').addEventListener('click', () => { shelfAsc = !shelfAsc; db.setMeta('shelfAsc', shelfAsc); renderShelf(); });
}

// 並び順に合わせて、一覧に出す日付を変える
function shelfDateLabel(b) {
  if (b.status === 'want' && wantLabel(b) && shelfSort !== 'published' && shelfSort !== 'score') return wantLabel(b);
  if (shelfSort === 'published') return b.year ? `${b.year}年刊` : '';
  if (shelfSort === 'score') return scoreOf(b) ? `評価 ${scoreOf(b)}` : '未評価';
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
    <section class="list-section"><h2 class="list-section__header">読みたい本をまとめて追加</h2>
      <div class="card"><textarea id="w-text" class="field" rows="6" placeholder="図書館の予約一覧やAmazonのほしい物リストを全選択してコピーしたもの、AmazonのURL、ISBN、書名を1行ずつ…"></textarea></div>
      <div class="card" style="margin-top:var(--space-3)"><div class="row"><label for="w-source">入手先</label><select id="w-source">${WANT_SOURCES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div></div>
      <div class="actions"><button class="btn btn--tinted" id="w-parse">読み取る</button></div>
      <div id="w-preview"></div>
    </section>
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
          <div class="note__tools">${Object.entries(FORMAT_LABEL).map(([k, l]) => `<button class="btn btn--small btn--tinted" data-i="${i}" data-format="${k}">${l}で読む</button>`).join('')}<button class="btn btn--small btn--plain" data-want-i="${i}">読みたい</button></div></div></li>`;
      }).join('')}</ul></section>`;
      results.querySelectorAll('[data-i]').forEach(btn => btn.addEventListener('click', () => addBook(found[Number(btn.dataset.i)], btn.dataset.format)));
      results.querySelectorAll('[data-want-i]').forEach(btn => btn.addEventListener('click', async () => {
        const n = await addWants([{ ...found[Number(btn.dataset.wantI)] }], '');
        btn.outerHTML = `<span class="small muted">${n ? '読みたいに追加しました' : '登録済みです'}</span>`;
      }));
    } catch (err) {
      results.innerHTML = `<p class="pad muted">${esc(err.message)}。電波のある場所で試すか、下から手で登録してください。</p>`;
    }
  });
  document.getElementById('m-add').addEventListener('click', () => {
    const title = document.getElementById('m-title').value.trim();
    if (!title) { document.getElementById('m-title').focus(); return; }
    addBook({ title, author: document.getElementById('m-author').value.trim() }, document.getElementById('m-format').value);
  });
  document.getElementById('w-parse').addEventListener('click', parseWants);
}

// ---------- 読みたいの一本化 ----------
const normTitle = s => (s || '').normalize('NFKC').replace(/[\s(（:：「」『』].*$/, '').toLowerCase();

function findOnShelf(c) {
  return state.books.find(b => (c.isbn13 && b.isbn13 === c.isbn13) || (c.asin && b.itemId === c.asin) || (c.title && normTitle(b.title) === normTitle(c.title)));
}

// 書名だけ・ISBNだけの行を、国会図書館サーチ(だめならGoogle Books)で補う
async function resolveWant(c) {
  const isbn13 = c.isbn ? normalizeIsbn(c.isbn) : c.asin && /^\d{9}[\dX]$/.test(c.asin) ? normalizeIsbn(c.asin) : null;
  const base = { title: c.title, author: c.author, isbn13, asin: c.asin, short: c.short };
  const q = isbn13 ? `isbn=${isbn13}` : c.title ? `title=${encodeURIComponent(c.title)}${c.author ? `&creator=${encodeURIComponent(c.author.split(/[ ,、]/)[0])}` : ''}` : null;
  if (!q) return base;
  try {
    const res = await fetch(`https://ndlsearch.ndl.go.jp/api/opensearch?${q}&mediatype=books&cnt=3`);
    const hit = res.ok ? parseNdlItems(await res.text())[0] : null;
    if (hit) return { ...base, title: base.title || hit.title, author: base.author || hit.author, isbn13: isbn13 || hit.isbn13, publisher: hit.publisher, year: hit.year, matched: 'ndl' };
  } catch { /* 次へ */ }
  try {
    const hit = (await searchBooks(isbn13 || [c.title, c.author].filter(Boolean).join(' ')))[0];
    if (hit) return { ...base, title: base.title || hit.title, author: base.author || hit.author, isbn13: isbn13 || hit.isbn13, publisher: hit.publisher, year: hit.year, description: hit.description, matched: 'google' };
  } catch { /* 補えなくても書名だけで登録できる */ }
  return base;
}

async function parseWants() {
  const box = document.getElementById('w-preview');
  const cands = parseWantText(document.getElementById('w-text').value);
  if (!cands.length) { box.innerHTML = `<p class="list-section__footer">本が見つかりませんでした。1行に1冊ずつ貼ってください。</p>`; return; }
  box.innerHTML = `<p class="list-section__footer">${cands.length}件を照合しています…</p>`;
  const resolved = [];
  for (let i = 0; i < cands.length; i += 3) resolved.push(...await Promise.all(cands.slice(i, i + 3).map(resolveWant)));
  box.innerHTML = `<ul class="list list--inset">${resolved.map((c, i) => {
    const mine = findOnShelf(c);
    return `<li class="list__row want-row">
      <input type="checkbox" data-w="${i}" ${mine ? '' : 'checked'} aria-label="追加する">
      ${coverHtml({ title: c.title || '?', isbn13: c.isbn13, itemId: c.asin, id: '' })}
      <div class="list__text">
        <input class="want-title" data-wt="${i}" value="${esc(c.title)}" placeholder="${c.asin ? `Kindle本 ${esc(c.asin)}(書名を入れてください)` : '書名'}">
        <input class="want-author" data-wa="${i}" value="${esc(c.author || '')}" placeholder="著者">
        <span class="list__subtitle">${esc([c.publisher, c.year, mine ? `登録済み(${STATUS_LABEL[mine.status]})` : '', c.short ? '短縮URLは読めないので書名で照合' : ''].filter(Boolean).join(' ・ '))}</span>
      </div></li>`;
  }).join('')}</ul>
    <div class="actions"><button class="btn btn--prominent" id="w-add">選んだ本を読みたいに追加</button></div>`;
  document.getElementById('w-add').addEventListener('click', async () => {
    const picked = resolved.map((c, i) => ({ ...c, title: box.querySelector(`[data-wt="${i}"]`).value.trim(), author: box.querySelector(`[data-wa="${i}"]`).value.trim(), on: box.querySelector(`[data-w="${i}"]`).checked }))
      .filter(c => c.on && c.title);
    const n = await addWants(picked, document.getElementById('w-source').value);
    toast(`${n}冊を「読みたい」に追加しました`);
    location.hash = '#shelf';
    shelfFilter = 'want';
  });
}

async function addWants(list, source) {
  const books = [];
  for (const c of list) {
    const mine = findOnShelf(c);
    if (mine) {
      if (source && mine.status === 'want' && !mine.wantSource) { mine.wantSource = source; books.push(mine); }
      continue;
    }
    books.push({ id: db.uid(), isbn13: c.isbn13 || null, itemId: c.asin || null, title: c.title, author: c.author || '', publisher: c.publisher || '', year: c.year || '',
      pages: c.pages || null, description: c.description || '', tags: [], subjects: [], ndc: null, cover: c.thumbnail || null, format: c.asin && /^B/.test(c.asin) ? 'ebook' : 'paper',
      status: 'want', wantSource: source || null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: 'app' });
  }
  await db.putMany('books', books);
  await load();
  return books.filter(b => b.createdAt === b.updatedAt).length;
}

// 地元の図書館の貸出状況(カーリル)
async function libraryConfig() {
  const [appkey, systemid, name] = await Promise.all([db.getMeta('calilKey', ''), db.getMeta('calilSystem', ''), db.getMeta('calilName', '')]);
  return { appkey, systemid: systemid || 'Osaka_Suita', name: name || '吹田市立図書館' };
}

async function checkBooksAtLibrary(books) {
  const cfg = await libraryConfig();
  const targets = books.filter(b => b.isbn13);
  const res = await checkLibrary({ appkey: cfg.appkey, systemid: cfg.systemid, isbns: targets.map(b => b.isbn13) });
  for (const b of targets) if (res.has(b.isbn13)) b.library = res.get(b.isbn13);
  await db.putMany('books', targets.filter(b => b.library));
  return { checked: targets.length, skipped: books.length - targets.length };
}

function wantLabel(b) {
  const src = (WANT_SOURCES.find(([k]) => k === (b.wantSource || '')) || [])[1];
  return [b.wantSource ? src : '', b.library ? `図書館: ${b.library.status}` : ''].filter(Boolean).join(' ・ ');
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
// 縦に長くならないよう、この本の記録・メモ・関連情報をタブで分ける。選んだタブは画面をまたいで覚えておく。
const BOOK_PANES = [['book', 'この本'], ['notes', 'メモ'], ['relate', '広げる']];
let bookPane = 'book';
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
        ${book.wantReason ? `<p class="small muted">きっかけ ${esc(book.wantReason)}</p>` : ''}
        ${book.category ? `<div class="tags tags--cat"><span class="tag tag--cat">${esc(book.category)}${book.categoryBy === 'ai' ? '(AI)' : ''}</span></div>` : ''}
        ${(book.ndc || (book.subjects || []).length) ? `<div class="tags">${book.ndc ? `<span class="tag">NDC ${esc(book.ndc)}</span>` : ''}${(book.subjects || []).map(s => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}
      </div>
    </div>
    <div class="pane-tabs"><div class="segmented segmented--wide" role="tablist">
      ${BOOK_PANES.map(([k, l]) => `<button class="segmented__item ${k === bookPane ? 'is-active' : ''}" role="tab" aria-selected="${k === bookPane}" data-pane="${k}">${l}${k === 'notes' ? ` ${notes.length}` : ''}</button>`).join('')}
    </div></div>

    <div class="pane" data-pane-body="book" ${bookPane === 'book' ? '' : 'hidden'}>
    ${book.status === 'want' && book.isbn13 ? `<section class="list-section"><h2 class="list-section__header">図書館</h2><div id="library"></div></section>` : ''}
    <div class="card record">
      <div class="record__grid">
        <label class="mini"><span>状態</span><select id="b-status">${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${book.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="mini"><span>媒体</span><select id="b-format">${Object.entries(FORMAT_LABEL).map(([k, l]) => `<option value="${k}" ${book.format === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="mini"><span>ページ数</span><input id="b-pages" inputmode="numeric" value="${esc(book.pages || '')}" placeholder="—"></label>
      </div>
      <div class="row score-row"><label for="b-score">評価</label>
        <input id="b-score" type="range" min="1" max="10" step="1" value="${scoreOf(book) || 5}" class="${scoreOf(book) ? '' : 'is-unset'}" aria-valuetext="${scoreOf(book) ? `${scoreOf(book)}点` : '未評価'}">
        <output id="b-score-out" for="b-score">${scoreOf(book) ? `${scoreOf(book)}<small>/10</small>` : '未評価'}</output>
        <button class="btn btn--small btn--plain" id="b-score-clear" aria-label="評価を消す" ${scoreOf(book) ? '' : 'hidden'}>消す</button></div>
      <div class="row"><label for="b-cat">カテゴリ</label><select id="b-cat"><option value="">未分類</option>${[...new Set([...state.categories, ...(book.category ? [book.category] : [])])].map(c => `<option ${c === book.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      ${book.status === 'want' ? `<div class="row"><label for="b-wsrc">入手先</label><select id="b-wsrc">${WANT_SOURCES.map(([k, l]) => `<option value="${k}" ${k === (book.wantSource || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
      <div class="record__grid record__grid--dates">
        <label class="mini"><span>登録日</span><input id="b-added" type="date" value="${dateInput(book.createdAt)}"></label>
        <label class="mini"><span>読み始め</span><input id="b-started" type="date" value="${dateInput(book.startedAt)}"></label>
        <label class="mini"><span>読了日</span><input id="b-finished" type="date" value="${dateInput(book.finishedAt)}"></label>
      </div>
    </div>
    <section class="list-section" id="summary-section">
      <h2 class="list-section__header">概要</h2>
      <div id="summary"><p class="list-section__footer">${navigator.onLine ? '探しています…' : 'オフラインのため表示できません。'}</p></div>
    </section>
    <section class="list-section" id="booknote-section">
      <h2 class="list-section__header">読書ノート(AI)</h2>
      <div id="booknote"></div>
    </section>
    <div class="actions"><button class="btn btn--plain" id="b-ndl">国立国会図書館の件名を補う</button></div>
    </div>

    <div class="pane" data-pane-body="notes" ${bookPane === 'notes' ? '' : 'hidden'}>
    ${book.status === 'reading' ? `<div class="actions" style="padding-top:0"><a class="btn btn--prominent" href="#write" id="b-write">この本にメモする</a></div>` : ''}
    <section class="list-section" style="margin-top:0">
      ${notes.length ? `<ul class="list list--inset">${notes.map(n => noteHtml(n, { showBook: n.bookId !== book.id })).join('')}</ul>` : `<p class="list-section__footer">まだメモはありません。</p>`}
    </section>
    </div>

    <div class="pane relate" data-pane-body="relate" ${bookPane === 'relate' ? '' : 'hidden'}>
    <p class="relate__lead">この本から広がる本や情報です。左右にスクロールできます。</p>
    ${reunionSection(found, '関連しそうな過去の読書')}
    <section class="list-section" id="discover-section">
      <h2 class="list-section__header">関連する本</h2>
      <div id="discover">${book.related ? '' : `<div class="actions" style="padding-top:0"><button class="btn btn--tinted" id="discover-go">関連する本を探す</button></div>`}</div>
    </section>
    <section class="list-section" id="author-section" ${book.author ? '' : 'hidden'}>
      <h2 class="list-section__header">${esc(firstName(book.author))}の他の作品</h2>
      <div id="author-wiki"></div>
      <div id="author-mine"></div>
      <div id="author-works"><p class="list-section__footer">探しています…</p></div>
    </section>
    ${linksSection(book)}
    </div>`;
  $view.querySelectorAll('[data-pane]').forEach(btn => btn.addEventListener('click', () => {
    bookPane = btn.dataset.pane;
    $view.querySelectorAll('[data-pane]').forEach(b => { const on = b === btn; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on); });
    $view.querySelectorAll('[data-pane-body]').forEach(el => { el.hidden = el.dataset.paneBody !== bookPane; });
  }));
  if (book.author) loadAuthor(book);
  loadSummary(book);
  showBookNote(book);
  if (book.related) showDiscover(book);
  else document.getElementById('discover-go').addEventListener('click', () => discover(book));
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
  const wsrc = document.getElementById('b-wsrc');
  if (wsrc) wsrc.addEventListener('change', async () => { book.wantSource = wsrc.value || null; await saveBook(book); toast('入手先を保存しました'); });
  if (book.status === 'want' && book.isbn13) showLibrary(book);
  document.getElementById('b-cat').addEventListener('change', async e => {
    book.category = e.target.value || null;
    book.categoryBy = book.category ? 'user' : null;
    await saveBook(book);
    const head = $view.querySelector('.book-head--cover > div');
    head.querySelectorAll('.tags--cat').forEach(t => t.remove());
    if (book.category) head.querySelector('.muted').insertAdjacentHTML('afterend', `<div class="tags tags--cat"><span class="tag tag--cat">${esc(book.category)}</span></div>`);
    toast(book.category ? `「${book.category}」にしました` : '未分類にしました');
  });
  const scoreEl = document.getElementById('b-score');
  const scoreOut = document.getElementById('b-score-out');
  const scoreClear = document.getElementById('b-score-clear');
  scoreEl.addEventListener('input', () => {
    scoreEl.classList.remove('is-unset');
    scoreOut.innerHTML = `${scoreEl.value}<small>/10</small>`;
    scoreEl.setAttribute('aria-valuetext', `${scoreEl.value}点`);
  });
  scoreEl.addEventListener('change', async () => {
    book.score = Number(scoreEl.value);
    scoreClear.hidden = false;
    await saveBook(book);
  });
  scoreClear.addEventListener('click', async () => {
    book.score = null;
    book.rating = null;
    scoreEl.classList.add('is-unset');
    scoreOut.textContent = '未評価';
    scoreClear.hidden = true;
    await saveBook(book);
  });
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
  if (bookPane === 'notes') clampNotes($view);
  else $view.querySelector('[data-pane="notes"]').addEventListener('click', () => clampNotes($view), { once: true });
}

// 長いメモ(ブクログの感想など)は数行で畳み、押すと全文を出す
function clampNotes(root) {
  root.querySelectorAll('.note__text, .note__quote').forEach(p => {
    p.classList.add('is-clamped');
    if (p.scrollHeight <= p.clientHeight + 2) { p.classList.remove('is-clamped'); return; }
    const btn = document.createElement('button');
    btn.className = 'btn btn--small btn--plain note__more';
    btn.textContent = '続きを読む';
    btn.addEventListener('click', () => { const open = p.classList.toggle('is-clamped'); btn.textContent = open ? '続きを読む' : '閉じる'; });
    p.after(btn);
  });
}

function firstName(author) {
  return (author || '').split(/[,、/／]/)[0].trim();
}

function linksSection(book) {
  const links = relatedLinks(book);
  const groups = [...new Set(links.map(l => l.group))];
  return `<details class="fold"><summary>関連リンク<small>外部のサイトで探す</small></summary><div class="fold__body">
    <ul class="list list--inset">${groups.map(g => `<li class="list__row links-row">
      <span class="links-row__group">${esc(g)}</span>
      <span class="links-row__items">${links.filter(l => l.group === g).map(l => `<a class="btn btn--small btn--tinted" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}</span>
    </li>`).join('')}</ul>
    <p class="list-section__footer">各サービスの検索結果を開きます。</p></div></details>`;
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

// ---------- 読書ノート(AI) ----------
// ボタンを押したときだけ、GeminiにWeb検索させて「戦略的読書ノート」を作る。結果は本に保存する。
function showBookNote(book, { busy = false, error = '' } = {}) {
  const box = document.getElementById('booknote');
  if (!box) return;
  const n = book.bookNote;
  if (busy) { box.innerHTML = `<p class="list-section__footer">GeminiがWebを調べて書いています。1分ほどかかることがあります…</p>`; return; }
  const go = label => `<div class="actions" style="padding-top:var(--space-2)"><button class="btn ${n ? 'btn--plain' : 'btn--tinted'}" id="booknote-go">${label}</button></div>`;
  if (!n) {
    box.innerHTML = `${error ? `<p class="list-section__footer">${esc(error)}</p>` : ''}
      <p class="list-section__footer">中心的な問い、主張と論理構造、主要概念、応用と批評、関連キーワードを、Web検索で調べてまとめます。書名と著者名、内容紹介をGeminiに送ります。</p>${go('読書ノートを作る')}`;
  } else {
    const sections = splitSections(n.text);
    box.innerHTML = `<div class="booknote">${sections.map((sec, i) => `<details class="booknote__sec" ${i < 2 ? 'open' : ''}>
        <summary>${sec.no ? `<span class="booknote__no">${esc(sec.no)}</span>` : ''}${esc(sec.title || '本文')}</summary>
        <div class="booknote__body">${mdBlockToHtml(sec.lines)}</div></details>`).join('')}</div>
      ${n.sources && n.sources.length ? `<details class="booknote__src"><summary>調べたページ ${n.sources.length}件</summary><ul>${n.sources.map(x => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></li>`).join('')}</ul></details>` : ''}
      <p class="list-section__footer">Geminiが${n.searched ? 'Web検索をもとに' : 'Web検索なしで'}書いたものです(${fmtDate(n.at)})。誤りが混じることがあります。${error ? ` ${esc(error)}` : ''}</p>${go('作り直す')}`;
  }
  document.getElementById('booknote-go').addEventListener('click', () => makeBookNote(book));
}

async function makeBookNote(book) {
  const apiKey = await db.getMeta('geminiKey');
  if (!apiKey) { showBookNote(book, { error: '設定でGeminiのAPIキーを入れると使えます。' }); return; }
  showBookNote(book, { busy: true });
  try {
    const model = (await db.getMeta('geminiModel')) || gemini.DEFAULT_MODEL;
    const r = await gemini.generateGrounded({ apiKey, model, prompt: buildBookNotePrompt(book) });
    if (!r.text) throw new Error('空の答えが返りました');
    book.bookNote = { text: r.text, sources: r.sources, searched: r.searched, at: new Date().toISOString() };
    await db.put('books', book);
    showBookNote(book);
  } catch (e) {
    showBookNote(book, { error: `作れませんでした(${e.message})` });
  }
}

async function showLibrary(book, force = false) {
  const box = document.getElementById('library');
  if (!box) return;
  const cfg = await libraryConfig();
  if (!cfg.appkey) { box.innerHTML = `<p class="list-section__footer">設定でカーリルのキーを入れると、${esc(cfg.name)}の貸出状況が出ます。</p>`; return; }
  const fresh = book.library && Date.now() - Date.parse(book.library.at) < 864e5;
  if (force || !fresh) {
    box.innerHTML = `<p class="list-section__footer">${esc(cfg.name)}を確認しています…</p>`;
    try { await checkBooksAtLibrary([book]); } catch (e) { box.innerHTML = `<p class="list-section__footer">${esc(e.message)}</p>`; return; }
  }
  const L = book.library;
  if (!L || !document.body.contains(box)) return;
  const libs = Object.entries(L.libs || {});
  box.innerHTML = `<div class="card"><p style="margin:0"><b>${esc(L.status)}</b> <span class="small muted">${esc(cfg.name)}</span></p>
    ${libs.length ? `<p class="small muted" style="margin:var(--space-1) 0 0">${libs.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' / ')}</p>` : ''}
    <div class="note__tools">${L.reserveurl ? `<a class="btn btn--small btn--tinted" href="${esc(L.reserveurl)}" target="_blank" rel="noopener">予約ページを開く</a>` : ''}<button class="btn btn--small btn--plain" id="lib-refresh">確認し直す</button></div></div>
    <p class="list-section__footer">カーリルの情報です(${fmtDate(L.at)}確認)。</p>`;
  document.getElementById('lib-refresh').addEventListener('click', () => showLibrary(book, true));
}

// ---------- 関連する本 ----------
// ボタンを押したときだけ探す。Geminiのキーがあれば三つのレンズで提案、なければ国会図書館の件名で探す。
async function discover(book) {
  const box = document.getElementById('discover');
  box.innerHTML = `<p class="list-section__footer">探しています…</p>`;
  try {
    const apiKey = await db.getMeta('geminiKey');
    let items, source;
    if (apiKey) {
      const model = (await db.getMeta('geminiModel')) || gemini.DEFAULT_MODEL;
      const recentTitles = state.books.filter(b => b.status === 'done' && b.id !== book.id)
        .sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || '')).slice(0, 60).map(b => b.title.replace(/[(（].*$/, '').trim());
      // カテゴリが付いていれば、読んだ冊数の少ない分野を「まだ触れていない領域」の手がかりにする
      const counts = new Map(state.categories.filter(c => c !== 'その他').map(c => [c, 0]));
      for (const b of state.books) if (b.status === 'done' && counts.has(b.category)) counts.set(b.category, counts.get(b.category) + 1);
      const rareFields = state.books.some(b => b.category) ? [...counts].sort((a, b) => a[1] - b[1]).slice(0, 4).map(([c]) => c) : [];
      const text = await gemini.generateJson({ apiKey, model, prompt: buildDiscoverPrompt({ book, notes: notesOf(book.id), recentTitles, rareFields }) });
      items = parseDiscoverResult(text, state.books.filter(b => b.id !== book.id));
      source = 'gemini';
    } else {
      items = await discoverBySubject(book);
      source = 'ndl';
    }
    book.related = { at: new Date().toISOString(), source, items };
    await db.put('books', book);
    if (document.body.contains(box)) showDiscover(book);
  } catch (e) {
    if (!document.body.contains(box)) return;
    box.innerHTML = `<p class="list-section__footer">探せませんでした(${esc(e.message)})。</p><div class="actions" style="padding-top:0"><button class="btn btn--tinted" id="discover-go">もう一度探す</button></div>`;
    document.getElementById('discover-go').addEventListener('click', () => discover(book));
  }
}

// キーがないとき: 件名(NDL)が分かればその件名で、なければカテゴリ名で国会図書館サーチを引く
async function discoverBySubject(book) {
  if (!(book.subjects || []).length) {
    const r = await ndlSubjects(book);
    if (r && (r.ndc || r.subjects.length)) { Object.assign(book, r); await db.put('books', book); }
  }
  const subject = (book.subjects || [])[0];
  if (!subject) throw new Error('件名が見つかりません。設定でGeminiのキーを入れると、AIが関連する本を提案します');
  const res = await fetch(`https://ndlsearch.ndl.go.jp/api/opensearch?subject=${encodeURIComponent(subject)}&mediatype=books&cnt=40`);
  if (!res.ok) throw new Error(`国立国会図書館サーチ ${res.status}`);
  const norm = s => (s || '').normalize('NFKC').replace(/[\s(（:：].*$/, '').toLowerCase();
  const seen = new Set([norm(book.title)]);
  return parseNdlItems(await res.text()).filter(w => { const k = norm(w.title); if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.year || '').localeCompare(a.year || '')).slice(0, 12)
    .map(w => {
      const mine = state.books.find(b => norm(b.title) === norm(w.title));
      return { lens: 'subject', title: w.title, author: w.author, year: w.year, isbn13: w.isbn13, link: `国立国会図書館の件名「${subject}」がこの本と共通`, mineId: mine ? mine.id : null };
    });
}

// 古い提案は reason だけを持っている
const whyOf = x => x.link || x.reason || '';

function discoverDetailHtml(x, book) {
  const lens = LENSES.find(l => l[0] === x.lens);
  const item = (label, text) => text ? `<div class="why"><span class="why__label">${label}</span><p>${esc(text)}</p></div>` : '';
  return `<p class="discover-detail__title"><b>${esc(x.title)}</b> <span class="small muted">${esc([x.author, x.year].filter(Boolean).join(' ・ '))}</span></p>
    ${item('選んだ観点', lens ? `${lens[1]}: ${lens[2]}` : x.lens === 'subject' ? '同じ件名の本' : '')}
    ${item(`『${book.title.replace(/[(（].*$/, '').trim()}』とのつながり`, whyOf(x))}
    ${item('この本で新しく得られるもの', x.gain)}
    ${item('あなたのメモとの関係', x.memo)}
    ${!x.gain && x.lens !== 'subject' ? '<p class="small muted" style="margin:var(--space-2) 0 0">前の形式の提案です。「探し直す」で、つながりと得られるものを詳しく出し直せます。</p>' : ''}`;
}

function showDiscover(book) {
  const box = document.getElementById('discover');
  if (!box) return;
  const { items = [], source, at } = book.related || {};
  const row = (x, i) => {
    const mine = x.mineId && bookById(x.mineId);
    const lens = lensOf(x.lens);
    return `<li class="list__row discover-row">${lens ? `<b class="lens lens--${esc(x.lens)}">${esc(lens[1])}</b>` : ''}${coverHtml({ title: x.title, isbn13: x.isbn13 || null, id: '' })}
      <div class="list__text"><span class="list__title">${esc(x.title)}</span>
        <span class="list__subtitle">${esc([x.author, x.year].filter(Boolean).join(' ・ '))}</span>
        ${whyOf(x) ? `<span class="discover-why">${esc(whyOf(x))}</span>` : ''}
        <button class="discover-more" data-dwhy="${i}" aria-expanded="false">選んだ理由</button>
        <span class="discover-actions">
          <a class="btn btn--small btn--plain" href="${esc(amazonSearchUrl(x))}" target="_blank" rel="noopener">Amazon</a>
          ${mine ? `<a class="btn btn--small btn--plain" href="#book/${esc(mine.id)}">${esc(STATUS_LABEL[mine.status])}</a>`
            : `<button class="btn btn--small btn--tinted" data-dwant="${i}">読みたい</button>`}
        </span></div></li>`;
  };
  // レンズごとに行を分けると縦に伸びるので、一本の横スクロールにまとめてレンズは札で示す
  const lensOf = k => LENSES.find(l => l[0] === k);
  const order = source === 'gemini' ? LENSES.map(l => l[0]) : [];
  const sorted = items.map((x, i) => [x, i]).sort((a, b) => order.indexOf(a[0].lens) - order.indexOf(b[0].lens));
  box.innerHTML = (items.length ? `
      ${source === 'gemini' ? `<details class="discover-legend"><summary>4つの視点について</summary>${LENSES.filter(([k]) => items.some(x => x.lens === k)).map(([k, label, desc]) => `<p><b class="lens">${esc(label)}</b> ${esc(desc)}</p>`).join('')}</details>` : ''}
      <ul class="list carousel">${sorted.map(([x, i]) => row(x, i)).join('')}</ul>
      <div class="discover-detail" id="discover-detail" hidden></div>`
    : `<p class="list-section__footer">関連する本は見つかりませんでした。</p>`) + `
    <p class="list-section__footer">${source === 'gemini' ? 'Geminiの提案です。実在しない本が混じることがあるので、Amazonで確かめてください。' : '国立国会図書館サーチの件名で探しました。'} ${fmtDate(at)}</p>
    <div class="actions" style="padding-top:0"><button class="btn btn--plain" id="discover-go">探し直す</button></div>`;
  document.getElementById('discover-go').addEventListener('click', () => discover(book));
  // カードの「選んだ理由」で、列の下に理由の全文を出す(もう一度押すと閉じる)
  const detail = document.getElementById('discover-detail');
  box.querySelectorAll('[data-dwhy]').forEach(btn => btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    box.querySelectorAll('[data-dwhy]').forEach(b => { b.setAttribute('aria-expanded', 'false'); b.closest('li').classList.remove('is-picked'); });
    if (open) { detail.hidden = true; return; }
    btn.setAttribute('aria-expanded', 'true');
    btn.closest('li').classList.add('is-picked');
    detail.innerHTML = discoverDetailHtml(items[Number(btn.dataset.dwhy)], book);
    detail.hidden = false;
    detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }));
  box.querySelectorAll('[data-dwant]').forEach(btn => btn.addEventListener('click', async () => {
    const x = items[Number(btn.dataset.dwant)];
    const nb = { id: db.uid(), isbn13: x.isbn13 || null, title: x.title, author: x.author, publisher: '', year: x.year, pages: null, description: '',
      tags: [], subjects: [], ndc: null, cover: null, format: 'paper', status: 'want', createdAt: new Date().toISOString(), source: 'app', wantReason: `『${book.title.replace(/[(（].*$/, '').trim()}』から${whyOf(x) ? `: ${whyOf(x)}` : ''}` };
    await saveBook(nb);
    x.mineId = nb.id;
    await db.put('books', book);
    btn.outerHTML = `<span class="small muted">追加済み</span>`;
    toast('「読みたい」に追加しました');
  }));
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
      <ul class="list carousel">${mine.map(b => `<li><a class="list__row" href="#book/${esc(b.id)}" style="color:inherit;text-decoration:none">
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
      <ul class="list carousel">${others.map((w, i) => `<li class="list__row">${coverHtml({ ...w, id: '' })}
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
// 一度に全部出すと長くなるので、少しずつ出す
const NOTES_PAGE = 20;
let notesShown = NOTES_PAGE;
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
      ${list.length ? `<ul class="list list--inset">${list.slice(0, notesShown).map(n => noteHtml(n, { showBook: true })).join('')}</ul>` : `<div class="empty"><p class="empty__message">メモはまだありません。</p></div>`}
      ${list.length > notesShown ? `<div class="actions"><button class="btn btn--tinted" id="notes-more">さらに${Math.min(NOTES_PAGE, list.length - notesShown)}件を表示(残り${list.length - notesShown}件)</button></div>` : ''}
    </section>`;
  const more = document.getElementById('notes-more');
  if (more) more.addEventListener('click', () => { const y = scrollY; notesShown += NOTES_PAGE; renderNotes(); scrollTo(0, y); });
  const input = document.getElementById('notes-q');
  input.addEventListener('change', () => { notesQuery = input.value; notesShown = NOTES_PAGE; renderNotes(); });
  bindNoteTools($view, renderNotes);
  clampNotes($view);
}

// ---------- 分析 ----------
let statsRange = 'all';
let statsCat = '';
let statsView = 'overview';
function renderStats() {
  setTab('stats');
  setTitle('分析');
  $view.innerHTML = statsHtml(state.books, statsRange, { categories: state.categories, category: statsCat, view: statsView });
  $view.querySelectorAll('[data-sview]').forEach(b => b.addEventListener('click', () => { statsView = b.dataset.sview; renderStats(); }));
  $view.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => { statsRange = b.dataset.range; renderStats(); }));
  const cat = document.getElementById('stats-cat');
  if (cat) cat.addEventListener('change', () => { statsCat = cat.value; renderStats(); });
  if (!$view.dataset.tips) { attachTooltips($view); $view.dataset.tips = '1'; }
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
  const calil = await libraryConfig();
  const imported = state.books.filter(b => b.source === 'booklog').length;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $view.innerHTML = `
    <details class="fold" open><summary>バックアップ</summary><div class="fold__body">
      <div class="card">
        <p class="small muted" style="margin:0">データはこのiPhoneの中だけにあります。定期的に書き出して「ファイル」アプリ(iCloud Drive)に保存してください。</p>
        <p class="small" style="margin:var(--space-2) 0 0">最後の書き出し: ${lastBackup ? fmtDate(lastBackup) : 'まだありません'}</p>
      </div>
      <div class="actions"><button class="btn btn--prominent" id="export">書き出す</button><label class="btn btn--tinted">読み込む<input type="file" id="import" accept="application/json,.json" hidden></label></div>
      ${!standalone ? `<p class="list-section__footer">Safariの共有ボタンから「ホーム画面に追加」してから使ってください。追加しないと、しばらく開かないうちにデータが消えることがあります。</p>` : ''}
      <p class="list-section__footer">保存領域の保護: ${persisted ? '有効' : '未許可'}</p>
    </div></details>
    <details class="fold"><summary>ブクログから取り込む</summary><div class="fold__body">
      <div class="card"><p class="small muted" style="margin:0">ブクログの「データのエクスポート」で書き出したCSVを選びます。同じ本は二重に登録されません。${imported ? `取り込み済み: ${imported}冊` : ''}</p></div>
      <div class="actions"><label class="btn btn--tinted">CSVを選ぶ<input type="file" id="booklog" accept=".csv,text/csv" hidden></label></div>
    </div></details>
    <details class="fold"><summary>AI(Gemini)</summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="g-key">APIキー</label><input id="g-key" type="password" autocomplete="off" value="${esc(key)}" placeholder="Google AI Studioで取得"></div>
        <div class="row"><label for="g-model">モデル</label><input id="g-model" value="${esc(model)}" placeholder="${gemini.DEFAULT_MODEL}"></div>
      </div>
      <p class="list-section__footer">無料枠では、送った内容がGoogleの製品改善に使われ、人が読むこともあります。AIに送るのは、メモの「問い返す」などを押したときだけです。キーはこの端末にだけ保存され、書き出しファイルにも含まれません。</p>
    </div></details>
    <details class="fold"><summary>カテゴリ</summary><div class="fold__body">
      <div class="card"><textarea id="cat-list" class="field" rows="8" aria-label="カテゴリの一覧(1行に1つ)">${esc(state.categories.join('\n'))}</textarea></div>
      <p class="list-section__footer">1行に1つ。並び順がそのまま選択肢の順になります。名前を変えても、すでに付けた本のカテゴリは変わりません。</p>
      <div class="card" style="margin-top:var(--space-3)"><p class="small" style="margin:0">未分類 <b id="cat-left">${state.books.filter(b => !b.category).length}</b>冊</p><p class="small muted" id="cat-progress" style="margin:var(--space-1) 0 0"></p></div>
      <div class="actions"><button class="btn btn--tinted" id="cat-auto">未分類の本をまとめて分類</button></div>
      <p class="list-section__footer">国立国会図書館の分類(NDC)が分かる本はそれを使い、残りは書名と著者名だけをGeminiに送って分類します(100冊ずつ)。結果は本の詳細でいつでも直せます。</p>
    </div></details>
    <details class="fold"><summary>図書館(カーリル)</summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="c-key">アプリキー</label><input id="c-key" type="password" autocomplete="off" value="${esc(calil.appkey)}" placeholder="カーリルで無料登録"></div>
        <div class="row"><label for="c-name">図書館</label><input id="c-name" value="${esc(calil.name)}"></div>
        <div class="row"><label for="c-sys">システムID</label><input id="c-sys" value="${esc(calil.systemid)}"></div>
      </div>
      <p class="list-section__footer">「読みたい」の本が地元の図書館にあるか、貸出中かを確かめます。キーは calil.jp/api/dashboard/ で無料で取れます。吹田市立図書館のシステムIDは Osaka_Suita です。</p>
    </div></details>
    <details class="fold"><summary>書影と本の情報</summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="b-key">Google Books キー</label><input id="b-key" type="password" autocomplete="off" value="${esc(booksKey)}" placeholder="任意"></div>
      </div>
      <p class="list-section__footer">書影は国立国会図書館とAmazonの画像を使い、キーは要りません。Google Booksはキーなしだと世界中の利用者で上限を分け合うため、よく止まります。Google CloudでBooks APIを有効にしたキー(無料)を入れると、本の検索と著者の作品一覧が安定します。</p>
      <div class="actions"><button class="btn btn--tinted" id="diag">接続を確かめる</button></div>
      <div id="diag-out"></div>
    </div></details>
    <details class="fold"><summary>このアプリについて</summary><div class="fold__body">
      <p class="list-section__footer">本 ${state.books.length}冊 ・ メモ ${state.notes.length}件。書誌の検索にGoogle Books APIと国立国会図書館サーチのAPIを利用しています。</p>
    </div></details>`;

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
  [['c-key', 'calilKey'], ['c-name', 'calilName'], ['c-sys', 'calilSystem']].forEach(([id, key]) => document.getElementById(id).addEventListener('change', async e => {
    await db.setMeta(key, e.target.value.trim());
    toast('保存しました');
  }));
  document.getElementById('cat-list').addEventListener('change', async e => {
    state.categories = parseCategories(e.target.value);
    await db.setMeta('categories', state.categories.join('\n'));
    e.target.value = state.categories.join('\n');
    toast('カテゴリを保存しました');
  });
  document.getElementById('cat-auto').addEventListener('click', autoCategorize);
  document.getElementById('g-model').addEventListener('change', saveKey);
}

// 未分類の本にカテゴリを付ける。NDC → Gemini(100冊ずつ)の順。手で付けたものは触らない。
let categorizing = false;
async function autoCategorize() {
  if (categorizing) return;
  const btn = document.getElementById('cat-auto');
  const progress = text => { const el = document.getElementById('cat-progress'); if (el) el.textContent = text; };
  const left = () => { const el = document.getElementById('cat-left'); if (el) el.textContent = state.books.filter(b => !b.category).length; };
  categorizing = true;
  btn.disabled = true;
  try {
    const cats = state.categories;
    const byNdc = state.books.filter(b => !b.category && b.ndc).map(b => [b, ndcToCategory(b.ndc, cats)]).filter(([, c]) => c);
    for (const [b, c] of byNdc) { b.category = c; b.categoryBy = 'ndc'; }
    if (byNdc.length) await db.putMany('books', byNdc.map(([b]) => b));
    left();
    const rest = state.books.filter(b => !b.category);
    if (!rest.length) { progress(`NDCで${byNdc.length}冊を分類しました。`); return; }
    const apiKey = await db.getMeta('geminiKey');
    if (!apiKey) { progress(`NDCで${byNdc.length}冊を分類しました。残り${rest.length}冊はGeminiのAPIキーを入れると分類できます。`); return; }
    const model = (await db.getMeta('geminiModel')) || gemini.DEFAULT_MODEL;
    let done = 0;
    for (let i = 0; i < rest.length; i += 100) {
      const batch = rest.slice(i, i + 100);
      progress(`Geminiで分類中… ${i}/${rest.length}冊`);
      let text;
      try { text = await gemini.generateJson({ apiKey, model, prompt: buildClassifyPrompt(batch, cats) }); }
      catch (e) {
        progress(`${done}冊を分類したところで止まりました(${e.message})。もう一度押すと続きから分類します。`);
        return;
      }
      const result = parseClassifyResult(text, batch, cats);
      const changed = batch.filter(b => result.has(b.id));
      for (const b of changed) { b.category = result.get(b.id); b.categoryBy = 'ai'; }
      await db.putMany('books', changed);
      done += changed.length;
      left();
    }
    progress(`分類しました(NDC ${byNdc.length}冊、Gemini ${done}冊)。分析タブで内訳を見られます。`);
  } finally {
    categorizing = false;
    if (document.body.contains(btn)) btn.disabled = false;
  }
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
    case 'stats': return renderStats();
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
  // Safariのタブはホーム画面のアプリと保存場所が別で、使わないと7日で消える
  if (!(matchMedia('(display-mode: standalone)').matches || navigator.standalone)) document.getElementById('tab-warning').hidden = false;
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// テスト用に公開
window.__app = { state, importBooklog, normalizeIsbn };
