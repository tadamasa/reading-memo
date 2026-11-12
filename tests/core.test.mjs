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
  const r = parseDiscoverResult('[{"lens":"far","title":"生物と無生物のあいだ","author":"福岡伸一","link":"x","gain":"g"},{"lens":"near","title":"A","author":"B"},{"lens":"bad","title":"C"},{"lens":"near","title":"A"}]', shelf);
  assert.equal(r.length, 2);
  assert.equal(r[0].mineId, 'm1');
  assert.equal(r[0].link, 'x'); assert.equal(r[0].gain, 'g');
  assert.equal(parseDiscoverResult('[{"lens":"near","title":"Z","reason":"old"}]')[0].link, 'old');
  assert.equal(parseDiscoverResult('not json').length, 0);
  assert.equal(amazonSearchUrl({ title: '三体', author: '劉慈欣' }), 'https://www.amazon.co.jp/s?k=%E4%B8%89%E4%BD%93%20%E5%8A%89%E6%85%88%E6%AC%A3&i=stripbooks');
  assert.match(buildDiscoverPrompt({ book: { title: 'T', author: 'A' }, recentTitles: ['X'] }), /遠いのに通じる/);
});

import { parseWantText } from '../js/wantimport.js';
test('読みたいの貼り付け: URL・ISBN・図書館とAmazonの一覧', () => {
  const r = parseWantText(`Amazon.co.jp: 動的平衡 : 福岡伸一: 本
https://www.amazon.co.jp/dp/4334037437?ref=xx
https://www.amazon.co.jp/%E4%B8%89%E4%BD%93/dp/B0BQ7F7Q5Z/ref=sr_1_1
ISBN978-4-15-209870-3
パターン・ランゲージ / クリストファー・アレグザンダー 著
予約日 2026/09/01
予約順位 3
都市はツリーではない
クリストファー・アレグザンダー (著)
￥2,200
https://amzn.asia/d/abc123`);
  assert.equal(r.length, 5);
  assert.deepEqual([r[0].title, r[0].author, r[0].asin], ['動的平衡', '福岡伸一', '4334037437']);
  assert.equal(r[1].asin, 'B0BQ7F7Q5Z');
  assert.equal(r[2].isbn, '9784152098703');
  assert.deepEqual([r[3].title, r[3].author], ['パターン・ランゲージ', 'クリストファー・アレグザンダー']);
  assert.deepEqual([r[4].title, r[4].author], ['都市はツリーではない', 'クリストファー・アレグザンダー']);
  assert.equal(r[4].short, true); // URLだけの短縮リンクは直前の書名に付く
});

test('読みたいの貼り付け: 縁泉などから来るISBN・ASIN・書名の一覧と、表計算ソフトのタブ区切り', () => {
  const r = parseWantText(['9784480064929', '4062748681 銀河英雄伝説', 'B00ABCDEFG', '利己的な遺伝子',
    '9784152098703\t三体\t劉慈欣', '\tB0BQ7F7Q5Z\t知の編集術 / 松岡正剛\t\t2024/01/02'].join('\n'));
  assert.equal(r.length, 6);
  assert.deepEqual([r[0].isbn, r[0].title], ['9784480064929', '']);
  assert.deepEqual([r[1].isbn, r[1].title], ['4062748681', '銀河英雄伝説']); // ISBN-10を書名に残さない
  assert.deepEqual([r[2].asin, r[2].title], ['B00ABCDEFG', '']);
  assert.equal(r[3].title, '利己的な遺伝子');
  assert.deepEqual([r[4].isbn, r[4].title, r[4].author], ['9784152098703', '三体', '劉慈欣']);
  assert.deepEqual([r[5].asin, r[5].title, r[5].author], ['B0BQ7F7Q5Z', '知の編集術', '松岡正剛']);
  // 見出し行は飛ばし、ハイフン付きのISBN-10も読む
  const h = parseWantText('ISBN\t書名\t著者\n4-06-274868-1\t銀河英雄伝説\t田中芳樹');
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].isbn, h[0].title, h[0].author], ['4062748681', '銀河英雄伝説', '田中芳樹']);
});

test('読みたいの貼り付け: 縁泉ホームのCSV(itemId, isbn13, title, status)', () => {
  const r = parseWantText(`\ufeffitemId,isbn13,title,status
4062748681,9784062748681,"銀河英雄伝説 1, 黎明篇",open
B000JABQI6,,造形と科学の新しい風景,open
B000PTYQZ6,4959241712345,デジャヴ,open
4334037437,9784334037437,動的平衡,試した
`);
  assert.equal(r.length, 3); // JANコードの映像ソフトは除く
  assert.deepEqual([r[0].asin, r[0].isbn, r[0].title], ['4062748681', '9784062748681', '銀河英雄伝説 1, 黎明篇']);
  assert.deepEqual([r[1].asin, r[1].isbn, r[1].title], ['B000JABQI6', null, '造形と科学の新しい風景']);
  assert.equal(r[2].title, '動的平衡');
});

import { summarize } from '../js/calil.js';
test('カーリルの結果を一言にまとめる', () => {
  assert.equal(summarize({ status: 'OK', libkey: { 中央: '貸出中', 千里山: '貸出可' } }).status, '貸出可');
  assert.equal(summarize({ status: 'OK', libkey: { 中央: '貸出中' } }).status, '貸出中');
  assert.equal(summarize({ status: 'OK', libkey: {} }).status, '蔵書なし');
  assert.equal(summarize({ status: 'Error' }).status, '確認できず');
});

import { splitSections, mdBlockToHtml, buildBookNotePrompt } from '../js/booknote.js';
test('読書ノートを章に分けて安全なHTMLにする', () => {
  const md = '前置き\n**0. 本書の概要**\n* 全体\n    * **第1章:** 甲\n    * **第2章:** 乙\n---\n## 1. 中心的な問い (Core Question)\n* 問い<script>\n';
  const s = splitSections(md);
  assert.deepEqual(s.map(x => x.no), ['', '0', '1']);
  assert.equal(s[1].title, '本書の概要');
  assert.equal(mdBlockToHtml(s[1].lines), '<ul><li>全体<ul><li><b>第1章:</b> 甲</li><li><b>第2章:</b> 乙</li></ul></li></ul>');
  assert.ok(mdBlockToHtml(s[2].lines).includes('&lt;script&gt;'));
  assert.ok(buildBookNotePrompt({ title: '動的平衡', author: '福岡伸一', year: '2009' }).includes('『動的平衡』(福岡伸一、2009年)'));
});

import { loadHub } from './gas-mock.mjs';
test('読書ハブ: 新しい方を残し、差分だけ返し、ページを分ける', () => {
  const hub = loadHub();
  assert.equal(hub.post({ token: 'x' }).error, 'unauthorized');
  const t = hub.token;
  let r = hub.post({ token: t, since: 0, books: [{ id: 'b1', mtime: 10, data: { id: 'b1', title: '動的平衡', status: 'done' } }], notes: [{ id: 'n1', mtime: 11, data: { id: 'n1', bookId: 'b1', text: '流れ', createdAt: '2026-10-29T09:00:00' } }] });
  assert.equal(r.books.length, 1); assert.equal(r.notes.length, 1); assert.equal(r.rev, 2);
  // 表は他のApps Scriptから読める形
  assert.equal(hub.sheets.get('notes').rows[1][6], '動的平衡');
  assert.deepEqual(hub.readingNotesOn('2026-10-29').map(n => n.text), ['流れ']);
  // 古い書き込みは無視される
  r = hub.post({ token: t, since: 2, books: [{ id: 'b1', mtime: 5, data: { id: 'b1', title: '古い' } }] });
  assert.equal(r.books.length, 0);
  // 新しい書き込みは反映され、別の端末は差分だけ受け取る
  hub.post({ token: t, since: 2, books: [{ id: 'b1', mtime: 20, data: { id: 'b1', title: '動的平衡2' } }] });
  r = hub.post({ token: t, since: 2 });
  assert.deepEqual(r.books.map(b => b.data.title), ['動的平衡2']);
  // 削除
  hub.post({ token: t, since: 0, notes: [{ id: 'n1', mtime: 30, deleted: true }] });
  r = hub.post({ token: t, since: 3 });
  assert.equal(r.notes[0].deleted, true);
  // 1000行を超えても書け、400件ずつ返る
  const many = Array.from({ length: 1100 }, (_, i) => ({ id: `m${i}`, mtime: 1, data: { id: `m${i}`, title: `本${i}` } }));
  hub.post({ token: t, since: 0, books: many });
  let since = 0, got = 0, pages = 0, more = true;
  while (more) { r = hub.post({ token: t, since }); got += r.books.length + r.notes.length; since = r.rev; more = r.more; pages++; }
  assert.equal(got, 1102); assert.equal(pages, 3);
});

test('読書ハブ: さくら用合言葉は追加・更新でき、削除はできず、URLパラメータでも通る', () => {
  const hub = loadHub();
  hub.setupSakura();
  const s = hub.sakuraToken();
  assert.ok(s);
  // 本文の token で本を追加できる
  let r = hub.post({ token: s, since: 0, books: [{ id: 's1', mtime: 10, data: { id: 's1', title: 'さくら登録', status: 'want' } }] });
  assert.equal(r.ok, true); assert.equal(r.books.length, 1);
  // URLパラメータ(?token=)でも通る(本文に token がなくてよい)
  r = hub.postQ({ since: 0, books: [{ id: 's2', mtime: 10, data: { id: 's2', title: 'パラメータ経由', status: 'want' } }] }, { token: s });
  assert.equal(r.ok, true);
  // さくら用では削除を受け付けない(端末用では従来どおり削除できる)
  hub.post({ token: s, since: 0, books: [{ id: 's1', mtime: 99, deleted: true }] });
  r = hub.post({ token: s, since: 0 });
  assert.equal(r.books.find(b => b.id === 's1').deleted, false);
  // 端末用の合言葉は従来どおり(本文・パラメータの両方)
  assert.equal(hub.post({ token: hub.token, since: 0 }).ok, true);
  assert.equal(hub.postQ({ since: 0 }, { token: hub.token }).ok, true);
  assert.equal(hub.postQ({ since: 0 }, { token: 'x' }).error, 'unauthorized');
});

import { isIsbnBarcode } from '../js/scanner.js';
test('ISBNのバーコードだけを受け付ける', () => {
  assert.equal(isIsbnBarcode('9784334037437'), true);
  assert.equal(isIsbnBarcode('9784334037438'), false); // 検査数字違い
  assert.equal(isIsbnBarcode('1920036008001'), false); // 2段目の価格コード
});

import { kindlePlusUrl, kindleEditionUrl, kindlePlusState, KINDLE_PLUS_NODE } from '../js/books.js';
test('Kindle+: 読み放題の棚だけを書名と著者で探し、確認から30日で古いとみなす', () => {
  const book = { title: '犯罪精神医学入門 人はなぜ人を殺せるのか (中公新書)', author: '福島章', isbn13: '9784121017963' };
  const u = new URL(kindlePlusUrl(book));
  assert.equal(u.searchParams.get('rh'), `n:${KINDLE_PLUS_NODE}`);
  assert.equal(u.searchParams.get('k'), '犯罪精神医学入門 福島章');
  assert.equal(new URL(kindleEditionUrl(book)).searchParams.get('i'), 'digital-text');
  assert.equal(kindlePlusState(null).label, '未確認');
  const now = Date.parse('2026-11-12T00:00:00Z');
  assert.deepEqual(kindlePlusState({ status: 'yes', at: '2026-11-01T00:00:00Z' }, now), { status: 'yes', label: '対象', days: 11, stale: false });
  assert.equal(kindlePlusState({ status: 'no', at: '2026-10-01T00:00:00Z' }, now).stale, true);
});

test('読書ハブ: Kindle+ の列が表に出て、古い表には見出しを足して埋める', () => {
  const hub = loadHub();
  const t = hub.token;
  hub.post({ token: t, since: 0, books: [{ id: 'k1', mtime: 10, data: { id: 'k1', title: '天冥の標', status: 'want', ku: { status: 'check', at: '2026-11-12T01:00:00Z' } } }] });
  const sh = hub.sheets.get('books');
  const head = sh.rows[0];
  assert.deepEqual(head.slice(-3), ['json', 'kindlePlus', 'kindlePlusAt']);
  assert.equal(sh.rows[1][head.indexOf('kindlePlus')], '調べる');
  assert.equal(sh.rows[1][head.indexOf('kindlePlusAt')], '2026-11-12');
  // json の後ろに列が増えても、アプリは json を受け取れる
  assert.equal(hub.post({ token: t, since: 0 }).books[0].data.ku.status, 'check');
  // 古い表(見出しが json まで)を模して、開いたときに列が足され埋まるか
  sh.rows.forEach(r => r.splice(head.indexOf('kindlePlus')));
  hub.post({ token: t, since: 0 });
  assert.equal(sh.rows[0][head.indexOf('kindlePlus')], 'kindlePlus');
  assert.equal(sh.rows[1][head.indexOf('kindlePlus')], '調べる');
});

test('読書ハブ: API用合言葉はURLでだけ通り、本の追加とKindle+の切り替えしかできない', () => {
  const hub = loadHub();
  hub.setupApi();
  const a = hub.apiToken();
  assert.ok(a && a !== hub.token);
  // 本の追加(ISBN-10 は 13 桁に直る)
  let r = hub.postQ({ addBook: { title: '動的平衡', author: '福岡伸一', isbn: '4334037437', kindlePlus: '調べる', wantReason: 'さくらのおすすめ' } }, { token: a });
  assert.equal(r.ok, true); assert.equal(r.existed, false); assert.equal(r.kindlePlus, '調べる');
  const id = r.id;
  let book = hub.post({ token: hub.token, since: 0 }).books.find(b => b.id === id).data;
  assert.equal(book.isbn13, '9784334037437'); assert.equal(book.status, 'want'); assert.equal(book.ku.status, 'check'); assert.equal(book.wantReason, 'さくらのおすすめ');
  // 同じISBNは足さない
  r = hub.postQ({ addBook: { title: '動的平衡(新版)', isbn13: '9784334037437' } }, { token: a });
  assert.equal(r.existed, true); assert.equal(r.id, id);
  // Kindle+ の切り替え(ISBN・書名・日本語/英語のどちらでも)
  r = hub.postQ({ setKindlePlus: { isbn13: '9784334037437', status: '対象' } }, { token: a });
  assert.equal(r.ok, true); assert.equal(r.kindlePlus, '対象');
  r = hub.postQ({ setKindlePlus: { title: '動的 平衡', status: 'no' } }, { token: a });
  assert.equal(r.kindlePlus, '対象外');
  book = hub.post({ token: hub.token, since: 0 }).books.find(b => b.id === id).data;
  assert.equal(book.ku.status, 'no');
  assert.equal(hub.sheets.get('books').rows[1][hub.sheets.get('books').rows[0].indexOf('kindlePlus')], '対象外');
  // 記録を消す
  assert.equal(hub.postQ({ setKindlePlus: { id, status: '' } }, { token: a }).kindlePlus, '');
  // 見つからない・あいまい・知らない値
  assert.equal(hub.postQ({ setKindlePlus: { title: 'ない本', status: '対象' } }, { token: a }).error, 'not found');
  hub.postQ({ addBook: { title: '同名' } }, { token: a });
  hub.post({ token: hub.token, books: [{ id: 'd2', mtime: Date.now(), data: { id: 'd2', title: '同名', status: 'want' } }] });
  assert.equal(hub.postQ({ setKindlePlus: { title: '同名', status: '対象' } }, { token: a }).error, 'ambiguous');
  assert.equal(hub.postQ({ setKindlePlus: { id, status: 'たぶん' } }, { token: a }).error, 'bad status');
  // できないこと: 同期(読み取り)、本文の token、ほかの命令を混ぜる
  assert.equal(hub.postQ({ since: 0 }, { token: a }).error, 'unauthorized');
  assert.equal(hub.post({ token: a, since: 0 }).error, 'unauthorized');
  assert.equal(hub.post({ token: a, addBook: { title: 'x' } }).error, 'unauthorized');
  assert.equal(hub.postQ({ addBook: { title: 'x' }, books: [{ id: 'z', deleted: true }] }, { token: a }).error, 'unauthorized');
  // API用合言葉を消せば止まる
  delete hub.props.API_TOKEN;
  assert.equal(hub.postQ({ addBook: { title: 'y' } }, { token: a }).error, 'unauthorized');
});

test('Kindle+: 「調べる」は日が経っても古いとは言わない', () => {
  const now = Date.parse('2026-12-31T00:00:00Z');
  assert.deepEqual(kindlePlusState({ status: 'check', at: '2026-10-01T00:00:00Z' }, now).stale, false);
  assert.equal(kindlePlusState({ status: 'check', at: '2026-10-01T00:00:00Z' }, now).label, '調べる');
});
