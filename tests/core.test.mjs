// node --test tests/ で実行。ブクログCSVの読み込みと関連検索の基本動作を確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, rowToRecord, decodeBooklog } from '../js/booklog.js';
import { tokens, buildIndex } from '../js/related.js';
import { normalizeIsbn } from '../js/books.js';

test('引用符の中の改行とカンマを1フィールドとして読む', () => {
  const rows = parseCsv('a,"b,\r\nc",d\r\ne,f,g\r\n');
  assert.deepEqual(rows, [['a', 'b,\r\nc', 'd'], ['e', 'f', 'g']]);
});

test('Shift_JISのCSVを文字化けなく読む', () => {
  const sjis = new Uint8Array([0x93, 0xc7, 0x82, 0xdd, 0x8f, 0x49, 0x82, 0xed, 0x82, 0xc1, 0x82, 0xbd]); // 読み終わった
  assert.equal(decodeBooklog(sjis.buffer), '読み終わった');
});

test('ブクログの1行を本とメモに変換する', () => {
  const r = ['1', '412101796X', '9784121017963', '', '4', '読み終わった', 'よかった', 'a,b', 'メモ', '2008-07-25 18:42:00', '2008-07-25 00:00:00', '犯罪精神医学入門', '福島章', '中央公論新社', '2005', '電子書籍', '248'];
  const { book, notes } = rowToRecord(r);
  assert.equal(book.status, 'done');
  assert.equal(book.format, 'ebook');
  assert.equal(book.finishedAt, '2008-07-25');
  assert.equal(book.booklogKey, '1:412101796X');
  assert.equal(notes.length, 2);
});

test('映画は取り込まない', () => {
  const r = ['1', 'X', '', '', '', '読み終わった', '', '', '', '2020-01-01 00:00:00', '', '映画名', '', '', '', '映画', ''];
  assert.equal(rowToRecord(r), null);
});

test('ISBN10を13桁に直す', () => {
  assert.equal(normalizeIsbn('412101796X'), '9784121017963');
  assert.equal(normalizeIsbn('978-4-12-101796-3'), '9784121017963');
});

test('2-gramは助詞だけの組を除く', () => {
  assert.ok(tokens('精神分析の入門').includes('精神'));
  assert.ok(!tokens('のための').includes('ため'));
});

test('関連検索は共通語の多い本を上位に出し、自分自身は除く', () => {
  const books = [
    { id: 'a', title: '大人のための精神分析入門', author: 'X' },
    { id: 'b', title: 'トポロジー入門', author: 'Y' },
    { id: 'c', title: '精神分析とは何か', author: 'Z' },
  ];
  const idx = buildIndex(books, []);
  const r = idx.search({ text: '精神分析とは何か', excludeBookId: 'c' }, { type: 'book' });
  assert.equal(r[0].doc.id, 'a');
  assert.ok(r.every(x => x.doc.id !== 'c'));
});

import { relatedLinks, ndlThumbUrl } from '../js/books.js';

test('関連リンクは書名からシリーズ名を外し、ブクログはアイテムページを開く', () => {
  const links = relatedLinks({ title: '犯罪精神医学入門 人はなぜ人を殺せるのか (中公新書)', author: '福島章', isbn13: '9784121017963', itemId: '412101796X' });
  const yt = links.find(l => l.label === 'YouTubeで探す');
  assert.ok(decodeURIComponent(yt.url).includes('犯罪精神医学入門 福島章'));
  assert.ok(!decodeURIComponent(yt.url).includes('中公新書'));
  assert.equal(links.find(l => l.label === 'ブクログ').url, 'https://booklog.jp/item/1/412101796X');
  assert.equal(links.find(l => l.label.startsWith('近くの図書館')).url, 'https://calil.jp/book/412101796X');
});

test('NDLの書影URLはISBN13から作る', () => {
  assert.equal(ndlThumbUrl('9784121017963'), 'https://ndlsearch.ndl.go.jp/thumbnail/9784121017963.jpg');
  assert.equal(ndlThumbUrl(null), null);
});

import { coverCandidates, isbn13to10, amazonCoverUrl } from '../js/books.js';
test('書影の候補: NDL→Amazon(ISBN10/ASIN)', () => {
  assert.equal(isbn13to10('9784121017963'), '412101796X');
  assert.equal(isbn13to10('9791234567896'), null);
  assert.deepEqual(coverCandidates({ isbn13: '9784121017963', itemId: '412101796X' }), [
    'https://ndlsearch.ndl.go.jp/thumbnail/9784121017963.jpg',
    'https://m.media-amazon.com/images/P/412101796X.09.MZZZZZZZ.jpg',
  ]);
  assert.deepEqual(coverCandidates({ isbn13: null, itemId: 'B0ABCDEF12' }), ['https://m.media-amazon.com/images/P/B0ABCDEF12.09.MZZZZZZZ.jpg']);
  assert.equal(amazonCoverUrl('bad'), null);
});

import { ndcToCategory, DEFAULT_CATEGORIES, parseClassifyResult, parseCategories } from '../js/categories.js';
test('カテゴリ: NDCからの対応とAIの返答の読み取り', () => {
  assert.equal(ndcToCategory('913.6', DEFAULT_CATEGORIES), '小説・文学');
  assert.equal(ndcToCategory('914.6', DEFAULT_CATEGORIES), 'エッセイ・ノンフィクション');
  assert.equal(ndcToCategory('493.7', DEFAULT_CATEGORIES), '医学・健康');
  assert.equal(ndcToCategory('146.8', DEFAULT_CATEGORIES), '心理・精神医学');
  assert.equal(ndcToCategory('336', DEFAULT_CATEGORIES), 'ビジネス・経済');
  assert.equal(ndcToCategory('', DEFAULT_CATEGORIES), null);
  const books = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
  const m = parseClassifyResult('```json\n{"0":"歴史","1":"存在しない","2":"小説・文学"}\n```', books, DEFAULT_CATEGORIES);
  assert.deepEqual([...m], [['x', '歴史'], ['z', '小説・文学']]);
  assert.deepEqual(parseCategories('  A\nB\n\nA '), ['A', 'B']);
  assert.equal(parseCategories('').length, DEFAULT_CATEGORIES.length);
});

import { parseDiscoverResult, amazonSearchUrl, buildDiscoverPrompt } from '../js/discover.js';
test('関連する本: AIの返答の読み取りとAmazonリンク', () => {
  const shelf = [{ id: 'm1', title: '生物と無生物のあいだ (講談社現代新書)' }];
  const r = parseDiscoverResult('[{"lens":"far","title":"生物と無生物のあいだ","author":"福岡伸一","reason":"x"},{"lens":"near","title":"A","author":"B"},{"lens":"bad","title":"C"},{"lens":"near","title":"A"}]', shelf);
  assert.equal(r.length, 2);
  assert.equal(r[0].mineId, 'm1');
  assert.equal(parseDiscoverResult('not json').length, 0);
  assert.equal(amazonSearchUrl({ title: '三体', author: '劉慈欣' }), 'https://www.amazon.co.jp/s?k=%E4%B8%89%E4%BD%93%20%E5%8A%89%E6%85%88%E6%AC%A3&i=stripbooks');
  assert.match(buildDiscoverPrompt({ book: { title: 'T', author: 'A' }, recentTitles: ['X'] }), /遠いのに通じる/);
});
