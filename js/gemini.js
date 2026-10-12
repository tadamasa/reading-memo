// Gemini API を端末から直接呼ぶ。APIキーは端末内(IndexedDB)にだけ保存する。
// 無料枠では入力がGoogleの製品改善に使われうるため、呼ぶのはユーザーがボタンを押したときだけ。

export const DEFAULT_MODEL = 'gemini-3.8-flash';

const MODES = {
  socratic: {
    label: '問い返す',
    system: 'あなたは読書の対話相手です。答えや要約を与えず、読者が自分の考えを深めるための問いを返します。' +
      '読者のメモの前提・定義・具体例・反例・他分野との接点のいずれかを突く、短く鋭い問いを2つだけ日本語で出してください。' +
      '各問いは1文で、番号を付けます。前置きや称賛は不要です。',
  },
  devil: {
    label: '反論する',
    system: 'あなたは悪魔の代弁者です。読者のメモの主張に対して、最も強い反論を1つ、日本語で3文以内で示してください。' +
      '最後に、その反論に読者が答えるための問いを1つ添えます。人格攻撃や前置きは不要です。',
  },
  bridge: {
    label: '橋を架ける',
    system: 'あなたは分野横断の連想を助ける相手です。読者のメモと構造が似ている、まったく別の分野の概念や現象を1つ挙げ、' +
      'どこが似ていてどこが違うかを日本語で3文以内で説明してください。確信がない事実は「不確か」と明記します。',
  },
};

export function modes() {
  return Object.entries(MODES).map(([key, m]) => ({ key, label: m.label }));
}

export function buildPrompt({ book, note, related = [] }) {
  const lines = [];
  lines.push(`本: 『${book.title}』${book.author ? ` ${book.author}` : ''}`);
  if (note.quote) lines.push(`引用: 「${note.quote}」`);
  lines.push(`読者のメモ: ${note.text}`);
  if (related.length) {
    lines.push('参考: 読者が過去に書いた関連メモ');
    for (const r of related.slice(0, 3)) lines.push(`- 『${r.bookTitle}』: ${r.text.slice(0, 200)}`);
  }
  return lines.join('\n');
}

export async function ask({ apiKey, model = DEFAULT_MODEL, mode = 'socratic', book, note, related }) {
  if (!apiKey) throw new Error('設定でGemini APIキーを入れてください');
  const m = MODES[mode] || MODES.socratic;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: m.system }] },
      contents: [{ role: 'user', parts: [{ text: buildPrompt({ book, note, related }) }] }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error ? data.error.message : res.statusText;
    throw new Error(`Geminiの呼び出しに失敗しました: ${msg}`);
  }
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('').trim();
}

// 構造化した答え(JSON文字列)を返してもらう。分類など、メモ以外の用途に使う。
export async function generateJson({ apiKey, model = DEFAULT_MODEL, prompt }) {
  if (!apiKey) throw new Error('設定でGemini APIキーを入れてください');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Geminiの呼び出しに失敗しました: ${data.error ? data.error.message : res.statusText}`);
    e.status = res.status;
    throw e;
  }
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('').trim();
}
