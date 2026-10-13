// この本から広がる「関連する本」をGeminiに挙げてもらう。
// 同じ分野ばかりにならないよう、三つのレンズで出す:
//   近い = 同じ問いを別の角度から / 遠いのに通じる = 分野は離れているが構造が通じる / 反対側から = 異なる立場・批判
// 送るのはこの本の書誌と、この本へのメモ、最近読んだ本の書名だけ。

export const LENSES = [
  ['near', '近い', '同じ問いを別の角度から扱う本'],
  ['far', '遠いのに通じる', '分野はまったく違うが、考え方の構造が通じる本'],
  ['counter', '反対側から', '異なる立場や批判的な視点から同じ主題を扱う本'],
  ['unknown', 'まだ触れていない領域', 'この読者がほとんど読んでいない分野から、この本を入口にして踏み込める本'],
];

export function buildDiscoverPrompt({ book, notes = [], recentTitles = [], rareFields = [] }) {
  return [
    'あなたは読書の相談相手です。次の本を読んだ人に、次に読む本を提案してください。',
    'この読者の読書の狙いは、自分がまだ触れていない考え方・知識・経験に出会うことです。仕事や今の関心に寄せる必要はありません。',
    `本: 『${book.title}』${book.author ? ` ${book.author}` : ''}${book.year ? `(${book.year})` : ''}`,
    book.category ? `カテゴリ: ${book.category}` : '',
    book.description ? `概要: ${book.description.slice(0, 400)}` : '',
    ...notes.slice(0, 5).map(n => `読者のメモ: ${[n.quote, n.text].filter(Boolean).join(' / ').slice(0, 200)}`),
    recentTitles.length ? `読者が最近読んだ本(これらは除く): ${recentTitles.join('、')}` : '',
    rareFields.length ? `読者がほとんど読んでいない分野: ${rareFields.join('、')}` : '',
    '',
    '次の四つの観点で、それぞれ3冊ずつ、実在する本だけを挙げてください。存在が確かでない本は挙げないでください。日本語で読める本を優先します。',
    ...LENSES.map(([key, label, desc]) => `- ${key}(${label}): ${desc}`),
    '「遠いのに通じる」は、元の本と分野が離れているほど良い提案です。',
    '出力は次の形のJSON配列だけにしてください。reason は、元の本のどこと何が通じるのかを40字以内で具体的に書きます。',
    '[{"lens":"near|far|counter|unknown","title":"書名","author":"著者","year":"刊行年","reason":"理由"}]',
  ].filter(Boolean).join('\n');
}

const key = s => (s || '').normalize('NFKC').replace(/[\s(（:：「」『』].*$/, '').toLowerCase();

export function parseDiscoverResult(text, shelf = []) {
  let arr;
  try { arr = JSON.parse(String(text).replace(/^```(?:json)?|```$/gm, '').trim()); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const lenses = new Set(LENSES.map(([k]) => k));
  const seen = new Set();
  return arr.filter(x => x && x.title && lenses.has(x.lens)).map(x => {
    const mine = shelf.find(b => key(b.title) === key(x.title));
    return { lens: x.lens, title: String(x.title).trim(), author: String(x.author || '').trim(), year: String(x.year || '').trim(), reason: String(x.reason || '').trim(), mineId: mine ? mine.id : null };
  }).filter(x => { const k = key(x.title); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ASINが分からないので、Amazonの本の検索結果を開く
export function amazonSearchUrl({ title, author }) {
  return `https://www.amazon.co.jp/s?k=${encodeURIComponent([title, author].filter(Boolean).join(' '))}&i=stripbooks`;
}
