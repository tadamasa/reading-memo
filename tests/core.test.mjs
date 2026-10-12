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
