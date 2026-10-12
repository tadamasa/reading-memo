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
