// 「戦略的読書ノート」: GeminiにWeb検索(Google検索グラウンディング)をさせて、本の構造的なサマリーを作る。
// プロンプトはただまさが用意したもの。結果は Markdown で返るので、ここで安全なHTMLに直して章ごとに畳める形にする。

export function buildBookNotePrompt(book) {
  const title = `『${book.title}』${book.author ? `(${book.author}${book.year ? `、${book.year}年` : ''})` : ''}`;
  return `# Role

あなたは、書籍から本質的な知見を抽出し、知の構造体として再構築するブック・アナリストです。単なる要約家ではなく、著者の論理を解き明かし、読者の知的生産性を最大化するための戦略的読書パートナーです。工学的な視点での構造分析と、物事の本質を問う哲学的視点を融合させ、ユニークな洞察を提供します。

# Process

1. ${title} に基づき、Web検索を駆使して、書籍の概要、著者、主要なテーマ、議論の全体像を多角的に調査します。
2. 収集した情報をもとに、本書の中心的な問い、核心的な主張、そしてそれを支える論理構造を特定します。
3. その主張の根拠となる主要な概念や事例を抽出します。
4. 抽出した知識を、単なる情報の羅列ではなく、実生活や仕事に応用可能な「生きた知恵」へと昇華させます。同時に、その主張の有効範囲や限界についても考察し、多角的な視点を加えます。
5. 最後に、得られた知見を下記の「出力フォーマット」に従って、構造化された一つの文章としてまとめ上げます。
${book.description ? `\n# 参考: 書誌に載っている内容紹介\n${book.description.slice(0, 600)}\n` : ''}
# Output Format (戦略的読書ノート)

以下の形式で、書籍の構造的なサマリーを出力してください。

**0. 本書の概要**
* この本の全体的な概要と、各章ごとの簡単な要約をまとめる

**1. 本書が解き明かそうとする「中心的な問い」 (Core Question)**
* この本は、一体何についての本なのか？著者が読者と共に探求しようとしている根源的な問いを、独自の視点で設定する。

**2. 核心的主張と論理構造 (Core Argument & Logical Structure)**
* 本書の「背骨」となる中心的な主張（Thesis）は何か。そして、その主張はどのような論理（序論→展開→結論、原因→結果、対比→統合など）で構築されているかを簡潔に解説する。

**3. 主要概念の深掘り (Deep Dive into Key Concepts)**
* 核心的主張を支える、最も重要な概念を3つ程度取り上げ、その定義と本書における役割を解説する。
    * **[概念1]:** {解説}
    * **[概念2]:** {解説}
    * **[概念3]:** {解説}

**4. 実践的応用と批評的視点 (Practical Application & Critical Perspective)**
* この本から得られる知見を、現実世界でどのように活用できるか。
    * **思考のアップデート:** {この本によって、これまでの考え方をどのように修正・拡張できるか}
    * **アクションプラン:** {明日から試せる具体的な行動や実験}
    * **批評的視点:** {この本の主張の限界や、議論の余地がある点はどこか。別の視点からの反論は可能か}

**5. 知的探求を広げるための羅針盤 (Compass for Further Inquiry)**
* この一冊を起点に、さらなる知の冒険へ。
    * **関連キーワード:** {本書の理解を深めるための専門用語、関連分野、対照的な思想など}

# Constraints

* 必ずWeb検索を実行し、正確な情報に基づいてください。検索で確かめられなかった点(章立てなど)は、推測であることを明記してください。
* 個人的な憶測ではなく、分析に基づいた洞察を提供してください。
* 著作権を尊重し、本文の長文引用は避けてください。
* 出力は、上記で指定されたMarkdown形式の「戦略的読書ノート」に厳密に従ってください。前置きや結びの挨拶は書かないでください。`;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<i>$2</i>');
}

// 章の見出し(「**0. 本書の概要**」「## 1. …」「### …」)で区切る
const HEAD = /^\s*(?:#{1,4}\s*)?\*{0,2}\s*([0-5])\s*[.．]\s*(.+?)\s*\*{0,2}\s*$/;

export function splitSections(md) {
  const sections = [];
  let cur = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) continue;
    const h = line.match(HEAD);
    if (h && line.length < 90) { cur = { no: h[1], title: h[2].replace(/\*+/g, '').trim(), lines: [] }; sections.push(cur); continue; }
    if (!cur) { if (!line.trim()) continue; cur = { no: '', title: '', lines: [] }; sections.push(cur); }
    cur.lines.push(line);
  }
  return sections.filter(s => s.title || s.lines.some(l => l.trim()));
}

// 箇条書き(字下げで入れ子)と段落だけを扱う小さな Markdown 変換
export function mdBlockToHtml(lines) {
  let html = '';
  const indents = []; // 開いている各階層の字下げ幅
  const closeTo = n => { while (indents.length > n) { html += '</li></ul>'; indents.pop(); } };
  let para = [];
  const flush = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  for (const raw of lines) {
    if (!raw.trim()) { flush(); continue; }
    const m = raw.match(/^(\s*)[*\-・]\s+(.*)$/);
    if (!m) {
      if (indents.length && !para.length) { closeTo(0); }
      para.push(raw.trim());
      continue;
    }
    flush();
    const ind = m[1].replace(/\t/g, '    ').length;
    if (!indents.length || ind > indents[indents.length - 1]) { html += '<ul><li>'; indents.push(ind); }
    else {
      while (indents.length > 1 && ind < indents[indents.length - 1]) { html += '</li></ul>'; indents.pop(); }
      html += '</li><li>';
    }
    html += inline(m[2]);
  }
  flush(); closeTo(0);
  return html;
}
