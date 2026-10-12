// 書誌の検索。Google Books(ブラウザから直接呼べる)を主に使い、
// 国立国会図書館サーチ(NDC分類と件名)は呼べた場合だけ補う。
// 本アプリは国立国会図書館サーチのAPIを利用しています。

export function normalizeIsbn(s) {
  const d = (s || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (d.length === 13) return d;
  if (d.length === 10) {
    const core = '978' + d.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
    return core + ((10 - (sum % 10)) % 10);
  }
  return null;
}

function fromGoogle(item) {
  const v = item.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const isbn = (ids.find(x => x.type === 'ISBN_13') || {}).identifier || normalizeIsbn((ids.find(x => x.type === 'ISBN_10') || {}).identifier);
  return {
    isbn13: isbn || null,
    title: [v.title, v.subtitle].filter(Boolean).join(' '),
    author: (v.authors || []).join(', '),
    publisher: v.publisher || '',
    year: (v.publishedDate || '').slice(0, 4),
    pages: v.pageCount || null,
    description: v.description || '',
    thumbnail: v.imageLinks ? (v.imageLinks.thumbnail || '').replace('http://', 'https://') : '',
  };
}

export async function searchBooks(query) {
  const isbn = normalizeIsbn(query);
  const q = isbn ? `isbn:${isbn}` : query;
  let data;
  try { data = await googleBooks(`q=${encodeURIComponent(q)}&maxResults=10&langRestrict=ja`); }
  catch (e) { throw new Error(`書誌検索に失敗しました(${e.message})`); }
  return (data.items || []).map(fromGoogle).filter(b => b.title);
}

// NDC分類と件名を補う。CORSなどで失敗したら null を返す。
export async function ndlSubjects({ isbn13, title, author }) {
  const params = isbn13 ? `isbn=${isbn13}` : `title=${encodeURIComponent(title)}${author ? `&creator=${encodeURIComponent(author.split(/[,、 ]/)[0])}` : ''}`;
  try {
    const res = await fetch(`https://ndlsearch.ndl.go.jp/api/opensearch?${params}&cnt=1`);
    if (!res.ok) return null;
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    const item = xml.getElementsByTagName('item')[0];
    if (!item) return null;
    let ndc = null;
    const subjects = [];
    for (const el of item.getElementsByTagName('*')) {
      if (el.localName !== 'subject') continue;
      const type = el.getAttribute('xsi:type') || '';
      const text = el.textContent.trim();
      if (!text) continue;
      if (/NDC/.test(type)) { if (!ndc) ndc = text; }
      else if (!/NDLC|DDC|LCC|UDC/.test(type)) subjects.push(text);
    }
    return { ndc, subjects: [...new Set(subjects)] };
  } catch {
    return null;
  }
}

// ---------- Google Books ----------
// キーなしの呼び出しは世界中の利用者で1日の上限を分け合っていて、すぐ 429 になる。
// 設定で自分のキー(無料、1日1000回)を入れればそれを使う。
let booksKey = '';
export function setBooksKey(k) { booksKey = (k || '').trim(); }

export async function googleBooks(params) {
  const url = `https://www.googleapis.com/books/v1/volumes?${params}${booksKey ? `&key=${encodeURIComponent(booksKey)}` : ''}`;
  const res = await fetch(url);
  if (res.status === 429) { const e = new Error('Google Booksの1日の上限に達しています'); e.status = 429; throw e; }
  if (!res.ok) { const e = new Error(`Google Books ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// ---------- 書影 ----------
// 画像のURLを候補として並べ、<img> で順に試す(読めなければ次へ)。APIもキーも使わない。
// 1) 国立国会図書館サーチの書影(ISBNのある本。非営利は申請不要)
// 2) Amazonの商品画像(ブクログのアイテムIDはISBN10かASINなので、Kindle本も出る)
export function ndlThumbUrl(isbn13) {
  return isbn13 ? `https://ndlsearch.ndl.go.jp/thumbnail/${isbn13}.jpg` : null;
}

export function isbn13to10(isbn13) {
  if (!isbn13 || !/^978\d{10}$/.test(isbn13)) return null;
  return isbn13.slice(3, 12) + isbn10Check(isbn13);
}

export function amazonCoverUrl(id) {
  return id && /^[0-9A-Z]{10}$/.test(id) ? `https://m.media-amazon.com/images/P/${id}.09.MZZZZZZZ.jpg` : null;
}

export function coverCandidates(book) {
  return [...new Set([
    ndlThumbUrl(book.isbn13),
    amazonCoverUrl(book.itemId),
    amazonCoverUrl(isbn13to10(book.isbn13)),
  ].filter(Boolean))];
}

function shortTitle(title) {
  return (title || '').replace(/[(（][^()（）]*[)）]/g, ' ').split(/[ 　:：〜~―-]/).filter(Boolean)[0] || title;
}

function firstAuthor(author) {
  return (author || '').split(/[,、/／]/)[0].replace(/\s+/g, ' ').trim();
}

// 候補がすべて外れたときの最後の手段。見つからなければ null、通信の失敗は例外。
export async function googleCover({ isbn13, title, author }) {
  const q = isbn13 ? `isbn:${isbn13}` : `intitle:${shortTitle(title)}${author ? ` inauthor:${firstAuthor(author).replace(/\s/g, '')}` : ''}`;
  const data = await googleBooks(`q=${encodeURIComponent(q)}&maxResults=3`);
  for (const item of data.items || []) {
    const links = (item.volumeInfo || {}).imageLinks;
    if (links && links.thumbnail) return links.thumbnail.replace('http://', 'https://').replace('&edge=curl', '');
  }
  return null;
}

// ---------- 著者の他の作品 ----------
// Google Books で探し、使えなければ国立国会図書館サーチで探す。
const titleKey = s => (s || '').normalize('NFKC').replace(/[\s(（:：].*$/, '').toLowerCase();

function dedupe(list, name, limit) {
  const seen = new Set();
  const out = [];
  const squash = x => x.replace(/[\s,、・]/g, '');
  const n = squash(name);
  for (const b of list) {
    if (!b.title || !squash(b.author).includes(n)) continue; // 同姓などの混入を除く
    const k = titleKey(b.title);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
    if (out.length >= limit) break;
  }
  return out;
}

async function authorWorksGoogle(name, limit) {
  const data = await googleBooks(`q=${encodeURIComponent(`inauthor:"${name}"`)}&maxResults=40&orderBy=newest&printType=books`);
  return dedupe((data.items || []).map(fromGoogle), name, limit);
}

// 「福島, 章, 1936-」「福島章 著」→「福島章」
function cleanNdlName(s) {
  let n = (s || '').trim().replace(/,?\s*\d{4}-(\d{4})?$/, '').replace(/\s*(著|編|訳|作|文|絵|監修|編著)$/, '').trim();
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(n)) n = n.replace(/,\s*/g, '');
  return n;
}

export function parseNdlItems(xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  const out = [];
  for (const item of xml.getElementsByTagName('item')) {
    const get = local => [...item.getElementsByTagName('*')].filter(el => el.localName === local);
    const text = local => (get(local)[0] || {}).textContent || '';
    const isbn = get('identifier').find(el => /ISBN/.test(el.getAttribute('xsi:type') || ''));
    out.push({
      isbn13: isbn ? normalizeIsbn(isbn.textContent) : null,
      title: text('title').trim(),
      author: get('creator').map(el => cleanNdlName(el.textContent)).filter(Boolean).join(', '),
      publisher: text('publisher').trim(),
      year: (text('issued') || text('date') || '').match(/\d{4}/)?.[0] || '',
      pages: null, description: '', thumbnail: '',
    });
  }
  return out;
}

async function authorWorksNdl(name, limit) {
  const res = await fetch(`https://ndlsearch.ndl.go.jp/api/opensearch?creator=${encodeURIComponent(name)}&mediatype=books&cnt=80`);
  if (!res.ok) throw new Error(`国立国会図書館サーチ ${res.status}`);
  const list = parseNdlItems(await res.text()).sort((a, b) => (b.year || '').localeCompare(a.year || ''));
  return dedupe(list, name, limit);
}

// 戻り値: { works, source }。両方だめなら最初の失敗理由で例外。
export async function authorWorks(author, limit = 20) {
  const name = firstAuthor(author);
  if (!name) return { works: [], source: '' };
  let firstErr = null;
  try {
    const works = await authorWorksGoogle(name, limit);
    if (works.length) return { works, source: 'Google Books' };
  } catch (e) { firstErr = e; }
  try {
    return { works: await authorWorksNdl(name, limit), source: '国立国会図書館サーチ' };
  } catch (e) {
    throw firstErr || e;
  }
}

// ---------- 本の概要 ----------
// 1) openBD(版元ドットコムとTRCのデータ。キー不要、ISBNのある本)
// 2) Google Books(キーなしだと止まりがち)
// 3) 国立国会図書館サーチの注記
// 4) Wikipediaの作品記事(著者名が本文に出てくるときだけ採用。古典やKindle本向け)
export function openbdText(item) {
  const tc = item?.onix?.CollateralDetail?.TextContent || [];
  const pick = type => (tc.find(t => t.TextType === type) || {}).Text;
  return (pick('03') || pick('02') || pick('04') || '').trim();
}

async function summaryOpenbd(isbn13) {
  if (!isbn13) return '';
  const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${isbn13}`);
  if (!res.ok) return '';
  const [item] = await res.json();
  return openbdText(item);
}

async function summaryGoogle({ isbn13, title, author }) {
  const q = isbn13 ? `isbn:${isbn13}` : `intitle:${shortTitle(title)}${author ? ` inauthor:${firstAuthor(author).replace(/\s/g, '')}` : ''}`;
  const data = await googleBooks(`q=${encodeURIComponent(q)}&maxResults=3`);
  for (const item of data.items || []) {
    const d = (item.volumeInfo || {}).description;
    if (d) return d.replace(/<[^>]+>/g, '').trim();
  }
  return '';
}

// NDLの注記は「索引あり」などが多いので、ある程度長い文だけ採る
async function summaryNdl({ isbn13 }) {
  if (!isbn13) return '';
  const res = await fetch(`https://ndlsearch.ndl.go.jp/api/opensearch?isbn=${isbn13}&cnt=1`);
  if (!res.ok) return '';
  const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
  const item = xml.getElementsByTagName('item')[0];
  if (!item) return '';
  return [...item.getElementsByTagName('*')].filter(el => el.localName === 'description')
    .map(el => el.textContent.trim()).filter(t => t.length >= 40).join('\n');
}

async function summaryWiki({ title, author }) {
  const w = await wikiSummary(shortTitle(title));
  const surname = firstAuthor(author).split(' ')[0].slice(0, 2);
  return w && surname && w.extract.includes(surname) ? w.extract : '';
}

// 戻り値: { text, source }、どこにもなければ null、通信に失敗した先があれば { failed: true }。
export async function bookSummary(book) {
  const tries = [['openBD', () => summaryOpenbd(book.isbn13)], ['Google Books', () => summaryGoogle(book)], ['国立国会図書館サーチ', () => summaryNdl(book)], ['Wikipedia', () => summaryWiki(book)]];
  let failed = false;
  for (const [source, fn] of tries) {
    try { const text = await fn(); if (text) return { text, source }; } catch { failed = true; }
  }
  return failed ? { text: '', failed: true } : null;
}

// ---------- Wikipedia(著者や作品の概要) ----------
export async function wikiSummary(name) {
  if (!name) return null;
  try {
    const res = await fetch(`https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/\s/g, ''))}`);
    if (!res.ok) return null;
    const d = await res.json();
    if (d.type !== 'standard' || !d.extract) return null;
    return { title: d.title, extract: d.extract, url: d.content_urls && d.content_urls.mobile ? d.content_urls.mobile.page : `https://ja.wikipedia.org/wiki/${encodeURIComponent(d.title)}` };
  } catch {
    return null;
  }
}

// ---------- 関連リンク ----------
// APIキーなしで済むよう、各サービスの検索結果へのリンクとして出す
export function relatedLinks(book) {
  const t = shortTitle(book.title);
  const a = firstAuthor(book.author);
  const ta = [t, a].filter(Boolean).join(' ');
  const enc = encodeURIComponent;
  const g = q => `https://www.google.com/search?q=${enc(q)}`;
  const booklog = book.itemId ? `https://booklog.jp/item/1/${enc(book.itemId)}`
    : book.isbn13 ? `https://booklog.jp/search?keyword=${enc(book.isbn13)}` : `https://booklog.jp/search?keyword=${enc(ta)}`;
  return [
    { group: '動画', label: 'YouTubeで探す', url: `https://www.youtube.com/results?search_query=${enc(ta)}` },
    { group: '動画', label: '著者のインタビュー', url: `https://www.youtube.com/results?search_query=${enc(`${a} インタビュー`)}`, hide: !a },
    { group: '書評', label: 'ブクログ', url: booklog },
    { group: '書評', label: '読書メーター', url: `https://bookmeter.com/search?keyword=${enc(t)}` },
    { group: '書評', label: 'ネットの書評', url: g(`${ta} 書評`) },
    { group: '書評', label: '新聞の書評(好書好日)', url: g(`site:book.asahi.com ${t}`) },
    { group: '映像化', label: '映画・ドラマ化', url: g(`${t} 映画化 OR ドラマ化 OR 映像化`) },
    { group: '映像化', label: 'Filmarks', url: `https://filmarks.com/search/movies?q=${enc(t)}` },
    { group: '調べる', label: 'Wikipedia', url: `https://ja.wikipedia.org/w/index.php?search=${enc(t)}` },
    { group: '調べる', label: '近くの図書館(カーリル)', url: book.isbn13 ? `https://calil.jp/book/${book.isbn13.slice(3, 12)}${isbn10Check(book.isbn13)}` : `https://calil.jp/search?q=${enc(ta)}` },
  ].filter(l => !l.hide);
}

function isbn10Check(isbn13) {
  const core = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(core[i]) * (10 - i);
  const c = (11 - (sum % 11)) % 11;
  return c === 10 ? 'X' : String(c);
}
