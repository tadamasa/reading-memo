// ブクログの本棚エクスポートCSV(Shift_JIS、ヘッダ行なし、17列)を読み込む。
// 列: 0サービスID 1アイテムID 2ISBN13 3カテゴリ 4評価 5読書状況 6レビュー 7タグ 8読書メモ
//     9登録日時 10読了日 11タイトル 12作者 13出版社 14発行年 15ジャンル 16ページ数

export function decodeBooklog(buffer) {
  const bytes = new Uint8Array(buffer);
  // UTF-8で読めればUTF-8、だめならShift_JIS
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const STATUS = { '読み終わった': 'done', 'いま読んでる': 'reading', '読みたい': 'want', '積読': 'want' };
const FORMAT = { '電子書籍': 'ebook', 'オーディオブック': 'audio' };

function isoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// 1行を { book, notes } に変換する。本とメモのidは呼び出し側で振る。
export function rowToRecord(r) {
  if (r.length < 17) return null;
  const title = r[11].trim();
  if (!title) return null;
  if (r[15] === '映画') return null; // 本以外は取り込まない
  const booklogKey = `${r[0]}:${r[1]}`;
  const registered = isoDate(r[9]);
  const finished = isoDate(r[10]);
  const book = {
    booklogKey,
    isbn13: r[2].trim() || null,
    itemId: r[1].trim(),
    title,
    author: r[12].trim(),
    publisher: r[13].trim(),
    year: r[14].trim(),
    pages: r[16] ? Number(r[16]) || null : null,
    format: FORMAT[r[15]] || 'paper',
    status: STATUS[r[5]] || 'done',
    rating: r[4] ? Number(r[4]) || null : null,
    tags: r[7] ? r[7].split(',').map(s => s.trim()).filter(Boolean) : [],
    startedAt: null,
    finishedAt: STATUS[r[5]] === 'done' ? finished : null,
    createdAt: registered ? `${registered}T00:00:00` : new Date().toISOString(),
    source: 'booklog',
  };
  const notes = [];
  const when = (finished || registered || new Date().toISOString().slice(0, 10)) + 'T00:00:00';
  if (r[6].trim()) notes.push({ text: r[6].trim(), kind: 'impression', createdAt: when, source: 'booklog-review' });
  if (r[8].trim()) notes.push({ text: r[8].trim(), kind: null, createdAt: when, source: 'booklog-memo' });
  return { book, notes };
}

export function parseBooklog(buffer) {
  const text = decodeBooklog(buffer);
  const rows = parseCsv(text);
  const records = [];
  let skipped = 0;
  for (const r of rows) {
    const rec = rowToRecord(r);
    if (rec) records.push(rec); else skipped++;
  }
  return { records, skipped };
}
