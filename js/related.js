// 関連する過去の本・メモを探す。
// 日本語は分かち書きなしでも効く「文字2-gram」のTF-IDFとコサイン類似度で計算する。
// 端末内だけで完結し、モデルのダウンロードも外部送信もしない。

const SERIES = /[(（][^()（）]*(文庫|新書|選書|叢書|シリーズ|ブックス|BOOKS|books|Kindle)[^()（）]*[)）]/g;
const STOP = new Set(['ない', 'する', 'こと', 'もの', 'ため', 'これ', 'それ', 'よう', 'から', 'まで', 'して', 'ます', 'です', 'った', 'いる', 'ある', 'なる', 'の本', 'ての', 'との', 'への', '何か', 'は何', 'え方', 'の考', 'とは', 'のす', 'すめ']);

export function normalize(s) {
  return (s || '').normalize('NFKC').toLowerCase().replace(SERIES, ' ');
}

export function tokens(s) {
  const t = normalize(s);
  const out = [];
  // 英数字は単語単位
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.push(w);
  // かな漢字カナは2文字ずつ(記号や空白をまたがない)
  for (const run of t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) || []) {
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i++) {
      const g = run.slice(i, i + 2);
      // ひらがなだけの2-gramは助詞などが多いので除く
      if (/^[\p{Script=Hiragana}]+$/u.test(g) || STOP.has(g)) continue;
      out.push(g);
    }
  }
  return out;
}

function tf(list) {
  const m = new Map();
  for (const t of list) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

export class RelatedIndex {
  // docs: [{ id, type: 'book'|'note', bookId, text, author }]
  constructor(docs) {
    this.docs = docs;
    const df = new Map();
    this.tfs = docs.map(d => {
      const m = tf(tokens(d.text));
      for (const k of m.keys()) df.set(k, (df.get(k) || 0) + 1);
      return m;
    });
    const n = docs.length || 1;
    this.idf = new Map();
    for (const [k, v] of df) this.idf.set(k, Math.log(1 + n / v));
    this.vecs = this.tfs.map(m => this.weigh(m));
  }

  weigh(m) {
    const v = new Map();
    let norm = 0;
    for (const [k, c] of m) {
      const w = (1 + Math.log(c)) * (this.idf.get(k) || Math.log(1 + this.docs.length));
      v.set(k, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [k, w] of v) v.set(k, w / norm);
    return v;
  }

  // query: { text, author, excludeBookId }
  search(query, { limit = 5, type = null, minScore = 0.08 } = {}) {
    const q = this.weigh(tf(tokens(query.text)));
    const author = normalize(query.author).replace(/\s/g, '');
    const results = [];
    this.docs.forEach((d, i) => {
      if (type && d.type !== type) return;
      if (query.excludeBookId && (d.bookId === query.excludeBookId || d.id === query.excludeBookId)) return;
      let score = 0;
      const shared = [];
      for (const [k, w] of q) {
        const w2 = this.vecs[i].get(k);
        if (w2) { score += w * w2; shared.push([k, w * w2]); }
      }
      const reasons = [];
      const dAuthor = normalize(d.author).replace(/\s/g, '');
      if (author && dAuthor && dAuthor === author) { score += 0.3; reasons.push('同じ著者'); }
      if (score < minScore) return;
      shared.sort((a, b) => b[1] - a[1]);
      const words = [...new Set(mergeGrams(shared.slice(0, 10).map(s => s[0]))
        .flatMap(w => w.split(/[\p{Script=Hiragana}]+/u)).filter(w => w.length >= 2))];
      if (words.length) reasons.push('共通: ' + words.slice(0, 3).join('・'));
      results.push({ doc: d, score, reasons });
    });
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

// 隣り合う2-gram(「精神」「神医」→「精神医」)をつないで読みやすい語にする
export function mergeGrams(grams) {
  const out = [];
  const used = new Set();
  for (const g of grams) {
    if (used.has(g)) continue;
    let word = g;
    used.add(g);
    let extended = true;
    while (extended) {
      extended = false;
      for (const h of grams) {
        if (used.has(h)) continue;
        if (word.endsWith(h[0]) && h.length === 2) { word += h[1]; used.add(h); extended = true; }
        else if (h[1] === word[0] && h.length === 2) { word = h[0] + word; used.add(h); extended = true; }
      }
    }
    out.push(word);
  }
  return out;
}

export function bookText(book, notes = []) {
  return [book.title, book.title, (book.subjects || []).join(' '), (book.tags || []).join(' '),
    ...notes.map(n => n.text)].join(' ');
}

export function buildIndex(books, notes) {
  const notesByBook = new Map();
  for (const n of notes) {
    if (!notesByBook.has(n.bookId)) notesByBook.set(n.bookId, []);
    notesByBook.get(n.bookId).push(n);
  }
  const bookMap = new Map(books.map(b => [b.id, b]));
  const docs = [];
  for (const b of books) {
    docs.push({ id: b.id, type: 'book', bookId: b.id, text: bookText(b, notesByBook.get(b.id)), author: b.author });
  }
  for (const n of notes) {
    const b = bookMap.get(n.bookId);
    docs.push({ id: n.id, type: 'note', bookId: n.bookId, text: [n.quote, n.text].filter(Boolean).join(' '), author: b ? b.author : '' });
  }
  return new RelatedIndex(docs);
}
