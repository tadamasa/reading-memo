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
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=10&langRestrict=ja`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`書誌検索に失敗しました (${res.status})`);
  const data = await res.json();
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

// ---------- 書影 ----------
// 1) 国立国会図書館サーチの書影API(ISBNがある本。非営利は申請不要)
// 2) Google Books(ISBNがない電子書籍などは書名と著者で探す)
export function ndlThumbUrl(isbn13) {
  return isbn13 ? `https://ndlsearch.ndl.go.jp/thumbnail/${isbn13}.jpg` : null;
}

// 画像として読めるかを確かめる(書影がないとNDLはXMLのエラーを返す)
export function probeImage(url, timeout = 8000) {
  return new Promise(resolve => {
    if (!url) return resolve(false);
    const img = new Image();
    const t = setTimeout(() => { img.src = ''; resolve(false); }, timeout);
    img.onload = () => { clearTimeout(t); resolve(img.naturalWidth > 10); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.src = url;
  });
}

function shortTitle(title) {
  return (title || '').replace(/[(（][^()（）]*[)）]/g, ' ').split(/[ 　:：〜~―-]/).filter(Boolean)[0] || title;
}

function firstAuthor(author) {
  return (author || '').split(/[,、/／]/)[0].replace(/\s+/g, ' ').trim();
}

export async function googleCover({ isbn13, title, author }) {
  const q = isbn13 ? `isbn:${isbn13}` : `intitle:${shortTitle(title)}${author ? ` inauthor:${firstAuthor(author).replace(/\s/g, '')}` : ''}`;
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=3`);
  if (!res.ok) throw new Error(`Google Books ${res.status}`);
  const data = await res.json();
  for (const item of data.items || []) {
    const links = (item.volumeInfo || {}).imageLinks;
    if (links && links.thumbnail) return links.thumbnail.replace('http://', 'https://').replace('&edge=curl', '');
  }
  return null;
}

// 見つからなければ 'none' を返す(何度も探しに行かないため)
export async function findCover(book) {
  const ndl = ndlThumbUrl(book.isbn13);
  if (ndl && await probeImage(ndl)) return ndl;
  try {
    const g = await googleCover(book);
    if (g && await probeImage(g)) return g;
  } catch {
    return null; // 通信エラーは次回また試す
  }
  return 'none';
}

// ---------- 著者の他の作品 ----------
export async function authorWorks(author, limit = 20) {
  const name = firstAuthor(author);
  if (!name) return [];
  const q = `inauthor:"${name}"`;
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=40&orderBy=newest&printType=books`);
  if (!res.ok) throw new Error(`著者の作品を取得できませんでした (${res.status})`);
  const data = await res.json();
  const seen = new Set();
  const out = [];
  const key = s => s.normalize('NFKC').replace(/[\s(（].*$/, '').toLowerCase();
  for (const item of data.items || []) {
    const b = fromGoogle(item);
    // 著者名が本当に含まれるものだけ(同姓などの混入を除く)
    if (!b.author.replace(/\s/g, '').includes(name.replace(/\s/g, ''))) continue;
    const k = key(b.title);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
    if (out.length >= limit) break;
  }
  return out;
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
