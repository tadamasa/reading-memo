// 散らばった「読みたい」を貼り付けでまとめて取り込む。
// 図書館の予約一覧やAmazonのほしい物リストの画面を「全選択→コピー」した文字や、
// AmazonのURL・ISBNを並べたメモを、そのまま貼れるようにする。

const AMAZON = /amazon\.co\.jp\/(?:[^\s]*?\/)?(?:dp|gp\/product|o\/ASIN|gp\/aw\/d)\/([A-Z0-9]{10})/i;
const SHORT = /(?:amzn\.asia|amzn\.to|a\.co)\/[^\s]+/i;
const ISBN13 = /97[89][-\s]?(?:\d[-\s]?){9}\d/;
const ISBN10 = /(?<![\dA-Z])\d{9}[\dX](?![\dA-Z])/;

// 書名ではない行(価格、日付、状態、ボタンの文字など)
const NOISE = /^(?:[￥¥$]\s?[\d,]+|[\d,]+円|.*(?:予約日|受取期限|取置|予約順位|順位|貸出中|在庫|ポイント|カートに入れる|購入済|追加日|優先度|コメント|数量|中古品|新品|出品|配送|お届け|件中|ページ|ログイン|ログアウト|メニュー|検索結果|並び替え).*|\d+|[\d/:年月日\s.-]+|[★☆]+.*|(?:Kindle版|単行本|文庫|新書|ペーパーバック|オーディオブック)(?:\s*[(（].*[)）])?)$/;
const AUTHOR_LINE = /^(?:by\s+|著者[:：]\s*)?(.+?)\s*[(（](?:著|編|訳|著者|監修|編集)[)）].*$|^by\s+(.+)$/i;

function cleanTitle(s) {
  return s.replace(/^Amazon\.co\.jp[:：]\s*/i, '')
    .replace(/\s*[-–]\s*(?:Amazon|楽天).*$/, '')
    .trim();
}

// Amazonのページ名「Amazon.co.jp: 書名 : 著者: 本」から書名と著者を取り出す
function amazonTitle(s) {
  const m = s.match(/^(?:Amazon\.co\.jp[:：]\s*)?(.+?)\s+[:：]\s*([^:：]+?)\s*[:：]\s*(?:本|Kindleストア|Audible.*)$/i);
  return m ? { title: m[1].trim(), author: m[2].trim() } : null;
}

function splitAuthor(s) {
  // 「書名 / 著者 著」「書名 ／ 著者」
  const m = s.match(/^(.+?)\s*[／/]\s*(.+?)(?:\s*(?:著|編|訳|作|文|監修)(?:[;；,、].*)?)?$/);
  return m ? { title: m[1].trim(), author: m[2].replace(/\s*(?:著|編|訳)$/, '').trim() } : { title: s, author: '' };
}

export function parseWantText(text) {
  const out = [];
  let last = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const am = line.match(AMAZON);
    const isbn = (line.match(ISBN13) || [])[0];
    const isbn10 = !am && !isbn ? (line.match(ISBN10) || [])[0] : null;
    if (am || isbn || isbn10 || SHORT.test(line)) {
      const id = { asin: am ? am[1].toUpperCase() : null, isbn: isbn ? isbn.replace(/[-\s]/g, '') : isbn10, short: !am && SHORT.test(line) };
      const text = cleanTitle(line.replace(/https?:\/\/\S+/g, '').replace(ISBN13, '').replace(/ISBN[:：]?/i, '').trim());
      // URLだけの行は、直前の書名の行に付ける
      if (!text && last && !last.asin && !last.isbn) { Object.assign(last, id); continue; }
      last = { ...(amazonTitle(text) || splitAuthor(text)), ...id, raw: line };
      out.push(last);
      continue;
    }
    if (NOISE.test(line) || line.length < 2) continue;
    const au = line.match(AUTHOR_LINE);
    if (au && last && !last.author) { last.author = (au[1] || au[2]).trim(); continue; }
    last = { ...(amazonTitle(line) || splitAuthor(cleanTitle(line))), asin: null, isbn: null, short: false, raw: line };
    out.push(last);
  }
  return out.filter(c => c.title || c.asin || c.isbn);
}

export const WANT_SOURCES = [
  ['', '未定'],
  ['library', '図書館(予約中)'],
  ['library-ready', '図書館(受け取れる)'],
  ['amazon', 'Amazonのほしい物'],
  ['bought', '買った(積読)'],
  ['other', 'その他'],
];
