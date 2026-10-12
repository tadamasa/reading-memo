// 本のカテゴリ。一覧は設定で書き換えられる(1行に1つ)。
// 付け方: 本ごとに手で選ぶ / NDC(日本十進分類)が分かる本は自動 / 残りはGeminiでまとめて分類。

export const DEFAULT_CATEGORIES = [
  '小説・文学', 'エッセイ・ノンフィクション', 'ビジネス・経済', '自己啓発', '社会・政治', '歴史',
  '哲学・思想', '心理・精神医学', '医学・健康', '科学・技術', '教育', '芸術・デザイン', '趣味・実用', 'コミック', 'その他',
];

// NDCの先頭の数字から大まかに決める(一覧にない名前なら使わない)
export function ndcToCategory(ndc, categories) {
  const n = String(ndc || '').replace(/[^\d.]/g, '');
  if (!n) return null;
  const rules = [
    [/^14/, '心理・精神医学'], [/^49/, '医学・健康'], [/^33|^67|^336/, 'ビジネス・経済'], [/^159/, '自己啓発'],
    [/^37/, '教育'], [/^9[0-9][45]/, 'エッセイ・ノンフィクション'], [/^78|^59|^79/, '趣味・実用'], [/^726/, 'コミック'],
    [/^1/, '哲学・思想'], [/^2/, '歴史'], [/^3/, '社会・政治'], [/^4|^5/, '科学・技術'], [/^6/, 'ビジネス・経済'],
    [/^7/, '芸術・デザイン'], [/^9/, '小説・文学'],
  ];
  const hit = rules.find(([re]) => re.test(n));
  return hit && categories.includes(hit[1]) ? hit[1] : null;
}

export function parseCategories(text) {
  const list = [...new Set(String(text || '').split(/\n/).map(s => s.trim()).filter(Boolean))];
  return list.length ? list : DEFAULT_CATEGORIES;
}

// Geminiに書名と著者だけを送り、{番号: カテゴリ} のJSONで返してもらう
export function buildClassifyPrompt(books, categories) {
  return [
    `次の本を、それぞれ下のカテゴリのどれか1つに分類してください。どれにも当てはまらなければ「${categories.includes('その他') ? 'その他' : categories[categories.length - 1]}」にします。`,
    `カテゴリ: ${categories.join(' / ')}`,
    '出力は {"番号": "カテゴリ名"} の形のJSONだけにしてください。',
    '',
    ...books.map((b, i) => `${i}: 『${b.title}』${b.author ? ` ${b.author}` : ''}`),
  ].join('\n');
}

export function parseClassifyResult(text, books, categories) {
  let obj;
  try { obj = JSON.parse(String(text).replace(/^```(?:json)?|```$/gm, '').trim()); } catch { return new Map(); }
  const out = new Map();
  for (const [k, v] of Object.entries(obj || {})) {
    const b = books[Number(k)];
    const c = String(v).trim();
    if (b && categories.includes(c)) out.set(b.id, c);
  }
  return out;
}
