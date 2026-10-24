// 読書スタイルのダッシュボード。グラフはすべて手書きのSVG/HTMLで、外部ライブラリを使わない(オフラインでも動く)。
// 色は役割で決める: 1系列=--viz-1、媒体の内訳=--viz-1..3(固定順)、月ごとの冊数=青の単色ランプ。

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FORMATS = [['paper', '紙'], ['ebook', '電子'], ['audio', 'オーディオ']];

export function scoreOf(b) {
  if (b.score) return b.score;
  return b.rating ? b.rating * 2 : null; // ブクログの5段階を10点に換算
}

const yearOf = s => { const m = String(s || '').match(/^(\d{4})/); return m ? Number(m[1]) : null; };
const median = xs => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const fmt1 = n => (Math.round(n * 10) / 10).toLocaleString('ja-JP');
const authorKey = a => (a || '').split(/[,、/／]/)[0].replace(/\s+/g, '').trim();

// ---------- 集計 ----------
export function computeStats(books, range, now = new Date()) {
  const thisYear = now.getFullYear();
  const from = range === 'all' ? -Infinity : range === 'year' ? thisYear : thisYear - Number(range) + 1;
  const read = books.filter(b => b.status === 'done' && yearOf(b.finishedAt) && yearOf(b.finishedAt) >= from);
  if (!read.length) return { read };

  const years = read.map(b => yearOf(b.finishedAt));
  const y0 = Math.min(...years), y1 = Math.max(thisYear, Math.max(...years));
  const yearList = [];
  for (let y = y0; y <= y1; y++) yearList.push(y);

  const byYear = new Map(yearList.map(y => [y, 0]));
  const heat = new Map(); // "2024-03" -> 冊数
  for (const b of read) {
    const y = yearOf(b.finishedAt);
    byYear.set(y, byYear.get(y) + 1);
    const m = Number(String(b.finishedAt).slice(5, 7));
    if (m) heat.set(`${y}-${m}`, (heat.get(`${y}-${m}`) || 0) + 1);
  }

  // 刊行から読了までの年数
  const gaps = read.map(b => { const p = yearOf(b.year); return p ? yearOf(b.finishedAt) - p : null; }).filter(g => g !== null && g >= 0);
  const GAP_BINS = [['同じ年', 0, 0], ['1年', 1, 1], ['2–4年', 2, 4], ['5–9年', 5, 9], ['10–19年', 10, 19], ['20–49年', 20, 49], ['50年〜', 50, Infinity]];
  const gapHist = GAP_BINS.map(([label, lo, hi]) => ({ label, value: gaps.filter(g => g >= lo && g <= hi).length }));
  const gapByYear = yearList.map(y => {
    const g = read.filter(b => yearOf(b.finishedAt) === y).map(b => { const p = yearOf(b.year); return p ? y - p : null; }).filter(x => x !== null && x >= 0);
    return { label: String(y), value: g.length >= 3 ? median(g) : null, n: g.length };
  });

  // ページ数
  const pages = read.map(b => Number(b.pages)).filter(p => p > 0);
  const PAGE_BINS = [['〜149', 0, 149], ['150–249', 150, 249], ['250–349', 250, 349], ['350–499', 350, 499], ['500〜', 500, Infinity]];
  const pageHist = PAGE_BINS.map(([label, lo, hi]) => ({ label, value: pages.filter(p => p >= lo && p <= hi).length }));
  const pagesByYear = yearList.map(y => {
    const p = read.filter(b => yearOf(b.finishedAt) === y).map(b => Number(b.pages)).filter(x => x > 0);
    return { label: String(y), value: p.length >= 3 ? p.reduce((s, x) => s + x, 0) / p.length : null, n: p.length };
  });

  // 媒体の内訳
  const formatByYear = yearList.map(y => {
    const r = read.filter(b => yearOf(b.finishedAt) === y);
    return { label: String(y), parts: FORMATS.map(([k]) => r.filter(b => (b.format || 'paper') === k).length) };
  });

  // 著者
  const authors = new Map();
  for (const b of read) {
    const k = authorKey(b.author);
    if (k) authors.set(k, (authors.get(k) || 0) + 1);
  }
  const topAuthors = [...authors].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, value]) => ({ label, value }));

  // 評価
  const scores = read.map(scoreOf).filter(Boolean);
  const scoreHist = Array.from({ length: 10 }, (_, i) => ({ label: String(i + 1), value: scores.filter(s => s === i + 1).length }));

  // 登録(積読)から読了までの日数。同じ日に登録して読了した本は除く
  const waits = read.map(b => (Date.parse(b.finishedAt) - Date.parse(b.createdAt)) / 864e5).filter(d => d >= 1);

  const startMonth = new Date(y0, read.reduce((m, b) => yearOf(b.finishedAt) === y0 ? Math.min(m, Number(String(b.finishedAt).slice(5, 7)) || 1) : m, 12) - 1, 1);
  const months = Math.max(1, (now.getFullYear() - startMonth.getFullYear()) * 12 + now.getMonth() - startMonth.getMonth() + 1);

  return {
    read, yearList, byYear, heat, gaps, gapHist, gapByYear, pages, pageHist, pagesByYear, formatByYear,
    topAuthors, scores, scoreHist, waits,
    tiles: {
      count: read.length,
      perMonth: read.length / months,
      avgPages: pages.length ? pages.reduce((s, x) => s + x, 0) / pages.length : null,
      medianGap: median(gaps),
      avgScore: scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : null,
      medianWait: waits.length >= 5 ? median(waits) : null,
    },
  };
}

// ---------- 部品 ----------
const W = 340; // viewBox の幅。width:100% で画面に合わせる
const tip = (value, label) => `data-tip-v="${esc(value)}" data-tip-l="${esc(label)}" tabindex="0"`;

function niceMax(v) {
  if (v <= 4) return Math.max(1, v);
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v);
}

// 上だけ4pxの角丸、根元は四角
function barPath(x, y, w, h) {
  if (h <= 0) return '';
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function axisLabels(items, every) {
  return (i, n) => i % every === 0 || i === n - 1;
}

function columns(data, { unit = '冊', height = 150, labelEvery = 1, color = 'var(--viz-1)' } = {}) {
  const top = 16, bottom = 22, left = 26, right = 6;
  const ph = height - top - bottom;
  const max = niceMax(Math.max(...data.map(d => d.value), 0));
  const slot = (W - left - right) / data.length;
  const bw = Math.min(24, Math.max(2, slot - 2));
  const showLabel = axisLabels(data, labelEvery);
  const peak = data.reduce((m, d, i) => d.value > data[m].value ? i : m, 0);
  const grid = [0, max / 2, max].map(v => {
    const y = top + ph - (v / max) * ph;
    return `<line x1="${left}" x2="${W - right}" y1="${y}" y2="${y}" class="viz-grid"/><text x="${left - 4}" y="${y + 3}" class="viz-tick" text-anchor="end">${fmt1(v)}</text>`;
  }).join('');
  const bars = data.map((d, i) => {
    const h = (d.value / max) * ph;
    const x = left + i * slot + (slot - bw) / 2;
    const y = top + ph - h;
    return `<g class="viz-hit" ${tip(`${fmt1(d.value)}${unit}`, d.label)}><rect x="${left + i * slot}" y="${top}" width="${slot}" height="${ph}" fill="transparent"/>
      <path d="${barPath(x, y, bw, h)}" fill="${color}"/>
      ${i === peak && d.value ? `<text x="${x + bw / 2}" y="${y - 4}" class="viz-val" text-anchor="middle">${fmt1(d.value)}</text>` : ''}</g>
      ${showLabel(i, data.length) ? `<text x="${left + i * slot + slot / 2}" y="${height - 6}" class="viz-tick" text-anchor="middle">${esc(d.label)}</text>` : ''}`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${height}" class="viz-svg" role="img">${grid}${bars}</svg>`;
}

function line(data, { unit = '', height = 150, labelEvery = 1 } = {}) {
  const pts = data.map((d, i) => ({ ...d, i })).filter(d => d.value !== null);
  if (pts.length < 2) return `<p class="viz-empty">年に3冊以上の記録が2年分そろうと表示します。</p>`;
  const top = 16, bottom = 22, left = 26, right = 30;
  const ph = height - top - bottom;
  const max = niceMax(Math.max(...pts.map(d => d.value)));
  const slot = (W - left - right) / data.length;
  const X = i => left + i * slot + slot / 2;
  const Y = v => top + ph - (v / max) * ph;
  const showLabel = axisLabels(data, labelEvery);
  const grid = [0, max / 2, max].map(v => `<line x1="${left}" x2="${W - right}" y1="${Y(v)}" y2="${Y(v)}" class="viz-grid"/><text x="${left - 4}" y="${Y(v) + 3}" class="viz-tick" text-anchor="end">${fmt1(v)}</text>`).join('');
  // 3冊未満の年は線を切る
  let d = '';
  pts.forEach((p, k) => { d += `${k && pts[k - 1].i === p.i - 1 ? 'L' : 'M'}${X(p.i)},${Y(p.value)}`; });
  const last = pts[pts.length - 1];
  const hits = data.map((p, i) => `<rect x="${left + i * slot}" y="${top}" width="${slot}" height="${ph}" fill="transparent" class="viz-hit" ${tip(p.value === null ? '記録が少ない年' : `${unit === 'ページ' ? Math.round(p.value) : fmt1(p.value)}${unit}`, `${p.label}年(${p.n}冊)`)}/>`).join('');
  const labels = data.map((p, i) => showLabel(i, data.length) ? `<text x="${X(i)}" y="${height - 6}" class="viz-tick" text-anchor="middle">${esc(p.label)}</text>` : '').join('');
  return `<svg viewBox="0 0 ${W} ${height}" class="viz-svg" role="img">${grid}
    <path d="${d}" fill="none" stroke="var(--viz-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.filter((p, k) => !(k && pts[k - 1].i === p.i - 1) && !(pts[k + 1] && pts[k + 1].i === p.i + 1)).map(p => `<circle cx="${X(p.i)}" cy="${Y(p.value)}" r="3" fill="var(--viz-1)"/>`).join('')}
    <circle cx="${X(last.i)}" cy="${Y(last.value)}" r="4" fill="var(--viz-1)" stroke="var(--viz-surface)" stroke-width="2"/>
    <text x="${X(last.i) + 7}" y="${Y(last.value) + 4}" class="viz-val">${unit === 'ページ' ? Math.round(last.value) : fmt1(last.value)}</text>
    ${labels}${hits}</svg>`;
}

function stacked(data, { height = 160, labelEvery = 1 } = {}) {
  const top = 10, bottom = 22, left = 26, right = 6;
  const ph = height - top - bottom;
  const max = niceMax(Math.max(...data.map(d => d.parts.reduce((s, x) => s + x, 0)), 0));
  const slot = (W - left - right) / data.length;
  const bw = Math.min(24, Math.max(2, slot - 2));
  const showLabel = axisLabels(data, labelEvery);
  const grid = [0, max / 2, max].map(v => {
    const y = top + ph - (v / max) * ph;
    return `<line x1="${left}" x2="${W - right}" y1="${y}" y2="${y}" class="viz-grid"/><text x="${left - 4}" y="${y + 3}" class="viz-tick" text-anchor="end">${fmt1(v)}</text>`;
  }).join('');
  const cols = data.map((d, i) => {
    const x = left + i * slot + (slot - bw) / 2;
    let y = top + ph;
    const nonzero = d.parts.map((v, k) => [v, k]).filter(([v]) => v > 0);
    const segs = nonzero.map(([v, k], j) => {
      const h = (v / max) * ph;
      const gap = j < nonzero.length - 1 ? 2 : 0; // 区切りは面の色の隙間で
      y -= h;
      const isTop = j === nonzero.length - 1;
      const shape = isTop ? `<path d="${barPath(x, y, bw, h)}" fill="var(--viz-${k + 1})"/>` : `<rect x="${x}" y="${y + gap}" width="${bw}" height="${Math.max(0, h - gap)}" fill="var(--viz-${k + 1})"/>`;
      return shape;
    }).join('');
    const total = d.parts.reduce((s, x) => s + x, 0);
    const label = FORMATS.map(([, l], k) => `${l}${d.parts[k]}`).join('・');
    return `<g class="viz-hit" ${tip(`${total}冊`, `${d.label}年 ${label}`)}><rect x="${left + i * slot}" y="${top}" width="${slot}" height="${ph}" fill="transparent"/>${segs}</g>
      ${showLabel(i, data.length) ? `<text x="${left + i * slot + slot / 2}" y="${height - 6}" class="viz-tick" text-anchor="middle">${esc(d.label)}</text>` : ''}`;
  }).join('');
  const legend = `<div class="viz-legend">${FORMATS.map(([, l], k) => `<span><i style="background:var(--viz-${k + 1})"></i>${l}</span>`).join('')}</div>`;
  return legend + `<svg viewBox="0 0 ${W} ${height}" class="viz-svg" role="img">${grid}${cols}</svg>`;
}

function heatmap(s) {
  const max = Math.max(1, ...s.heat.values());
  const step = v => v === 0 ? 0 : Math.min(5, Math.ceil((v / max) * 5));
  const rows = [...s.yearList].reverse().map(y => `<div class="heat__row"><span class="heat__y">${y}</span>${Array.from({ length: 12 }, (_, m) => {
    const v = s.heat.get(`${y}-${m + 1}`) || 0;
    return `<span class="heat__cell" data-s="${step(v)}" ${tip(`${v}冊`, `${y}年${m + 1}月`)}></span>`;
  }).join('')}</div>`).join('');
  const head = `<div class="heat__row heat__head"><span class="heat__y"></span>${Array.from({ length: 12 }, (_, m) => `<span>${m + 1}</span>`).join('')}</div>`;
  const legend = `<div class="heat__legend"><span>少</span>${[1, 2, 3, 4, 5].map(k => `<span class="heat__cell" data-s="${k}"></span>`).join('')}<span>多(最多${max}冊)</span></div>`;
  return `<div class="heat">${head}${rows}</div>${legend}`;
}

function hbars(data, unit = '冊') {
  const max = Math.max(...data.map(d => d.value), 1);
  return `<div class="hbars">${data.map(d => `<div class="hbars__row" ${tip(`${d.value}${unit}`, d.label)}>
    <span class="hbars__label">${esc(d.label)}</span>
    <span class="hbars__track"><span class="hbars__bar" style="width:${(d.value / max) * 100}%"></span><span class="hbars__val">${d.value}</span></span></div>`).join('')}</div>`;
}

function table(head, rows) {
  return `<details class="viz-table"><summary>表で見る</summary><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

function card(title, note, body, tbl = '') {
  return `<section class="list-section"><h2 class="list-section__header">${esc(title)}</h2>
    <div class="card viz-card">${body}${tbl}</div>${note ? `<p class="list-section__footer">${note}</p>` : ''}</section>`;
}

function tile(label, value, sub = '') {
  return `<div class="tile"><span class="tile__label">${esc(label)}</span><span class="tile__value">${value}</span>${sub ? `<span class="tile__sub">${esc(sub)}</span>` : ''}</div>`;
}

// ---------- 画面 ----------
export const RANGES = [['all', '全期間'], ['10', '10年'], ['5', '5年'], ['year', '今年']];
// 縦に長くならないよう、グラフを見る観点ごとに分けて出す
export const STATS_VIEWS = [['overview', '冊数'], ['age', '古さ・厚さ'], ['field', '分野・著者']];

export function statsHtml(books, range, { categories = [], category = '', view = 'overview' } = {}) {
  const scoped = category ? books.filter(b => (category === '-' ? !b.category : b.category === category)) : books;
  const s = computeStats(scoped, range);
  const cats = categoryStats(computeStats(books, range).read, categories);
  const hasCats = books.some(b => b.category);
  const filter = `<div class="segmented-wrap"><div class="segmented" role="tablist">${RANGES.map(([k, l]) => `<button class="segmented__item ${k === range ? 'is-active' : ''}" role="tab" aria-selected="${k === range}" data-range="${k}">${l}</button>`).join('')}</div></div>
    <div class="segmented-wrap"><div class="segmented segmented--wide" role="tablist">${STATS_VIEWS.map(([k, l]) => `<button class="segmented__item ${k === view ? 'is-active' : ''}" role="tab" aria-selected="${k === view}" data-sview="${k}">${l}</button>`).join('')}</div></div>
    ${hasCats ? `<div class="sort-bar" style="padding-top:0"><label for="stats-cat">カテゴリ</label><select id="stats-cat"><option value="">すべて</option>${categories.map(c => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="-" ${category === '-' ? 'selected' : ''}>未分類</option></select></div>` : ''}`;
  if (!s.read.length) return filter + `<div class="empty"><p class="empty__message">この期間に読了日のある本はありません。</p></div>`;
  const t = s.tiles;
  const n = s.yearList.length;
  const every = n > 12 ? Math.ceil(n / 6) : n > 7 ? 2 : 1;
  const yearData = s.yearList.map(y => ({ label: String(y), value: s.byYear.get(y) }));
  const shortYear = d => ({ ...d, label: n > 7 ? `'${d.label.slice(2)}` : d.label });

  return filter + `
    <div class="hero"><span class="hero__value">${t.count.toLocaleString('ja-JP')}<small>冊</small></span><span class="hero__label">読了した本</span></div>
    <div class="tiles">
      ${tile('月あたり', `${fmt1(t.perMonth)}冊`)}
      ${tile('平均ページ数', t.avgPages ? `${Math.round(t.avgPages)}` : '—', `${s.pages.length}冊の平均`)}
      ${tile('刊行から読了まで', t.medianGap !== null ? `${fmt1(t.medianGap)}年` : '—', '中央値')}
      ${tile('平均評価', t.avgScore ? `${fmt1(t.avgScore)}` : '—', t.avgScore ? `10点満点・${s.scores.length}冊` : '評価はまだありません')}
      ${t.medianWait !== null ? tile('登録から読了まで', `${Math.round(t.medianWait)}日`, `中央値・${s.waits.length}冊`) : ''}
    </div>
    <div ${view === 'overview' ? '' : 'hidden'}>
    ${card('年ごとの読了冊数', '', columns(yearData.map(shortYear), { labelEvery: every }),
      table(['年', '冊数'], yearData.map(d => [d.label, d.value])))}
    ${card('月ごとの読了冊数', '色がはっきりしているほど多く読んだ月です。', heatmap(s))}
    </div><div ${view === 'age' ? '' : 'hidden'}>
    ${card('刊行から読了までの年数', `新刊を追う読書か、古い本に遡る読書かが分かります。刊行年の分かる${s.gaps.length}冊。`,
      columns(s.gapHist, { height: 140 }), table(['年数', '冊数'], s.gapHist.map(d => [d.label, d.value])))}
    ${card('読んだ本の「古さ」の推移', '各年に読んだ本の、刊行から読了までの年数(中央値)。3冊未満の年は除きます。',
      line(s.gapByYear.map(shortYear), { unit: '年', labelEvery: every }),
      table(['年', '中央値(年)', '冊数'], s.gapByYear.map(d => [d.label, d.value === null ? '—' : fmt1(d.value), d.n])))}
    ${card('ページ数の分布', `ページ数の分かる${s.pages.length}冊。`, columns(s.pageHist, { height: 140 }),
      table(['ページ数', '冊数'], s.pageHist.map(d => [d.label, d.value])))}
    ${card('平均ページ数の推移', '3冊未満の年は除きます。', line(s.pagesByYear.map(shortYear), { unit: 'ページ', labelEvery: every }),
      table(['年', '平均ページ', '冊数'], s.pagesByYear.map(d => [d.label, d.value === null ? '—' : Math.round(d.value), d.n])))}
    </div><div ${view === 'field' ? '' : 'hidden'}>
    ${card('媒体の内訳', '', stacked(s.formatByYear.map(shortYear), { labelEvery: every }),
      table(['年', ...FORMATS.map(([, l]) => l)], s.formatByYear.map(d => [d.label, ...d.parts])))}
    ${category ? '' : categorySection(cats, hasCats)}
    ${s.topAuthors.length ? card('よく読む著者', '2冊以上読んだ著者の上位10人。', hbars(s.topAuthors)) : ''}
    ${s.scores.length ? card('評価の分布', 'ブクログの5段階評価は2倍して10点に換算しています。', columns(s.scoreHist, { height: 130 }),
      table(['点', '冊数'], s.scoreHist.map(d => [d.label, d.value]))) : ''}
    </div>`;
}

// ---------- カテゴリ ----------
export function categoryStats(read, categories) {
  const groups = new Map();
  for (const b of read) {
    const c = b.category || '';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(b);
  }
  const order = c => { const i = categories.indexOf(c); return i < 0 ? 999 : i; };
  const rows = [...groups].filter(([c]) => c).map(([c, bs]) => {
    const pages = bs.map(b => Number(b.pages)).filter(p => p > 0);
    const gaps = bs.map(b => { const p = yearOf(b.year); return p ? yearOf(b.finishedAt) - p : null; }).filter(g => g !== null && g >= 0);
    const scores = bs.map(scoreOf).filter(Boolean);
    return {
      label: c, value: bs.length, books: bs,
      avgPages: pages.length ? pages.reduce((x, y) => x + y, 0) / pages.length : null,
      medianGap: median(gaps),
      avgScore: scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null,
    };
  }).sort((a, b) => b.value - a.value || order(a.label) - order(b.label));
  const years = [...new Set(read.map(b => yearOf(b.finishedAt)))].sort();
  const totals = new Map(years.map(y => [y, read.filter(b => yearOf(b.finishedAt) === y).length]));
  return { rows, years, totals, uncategorized: (groups.get('') || []).length };
}

function categoryHeat(c) {
  const rows = c.rows.slice(0, 12);
  const share = (r, y) => { const n = r.books.filter(b => yearOf(b.finishedAt) === y).length; return [n, c.totals.get(y) ? n / c.totals.get(y) : 0]; };
  const maxShare = Math.max(0.01, ...rows.flatMap(r => c.years.map(y => share(r, y)[1])));
  const cols = c.years.length;
  const step = v => v === 0 ? 0 : Math.min(5, Math.ceil((v / maxShare) * 5));
  const every = cols > 12 ? Math.ceil(cols / 6) : cols > 7 ? 2 : 1;
  const style = `grid-template-columns: 8.5em repeat(${cols}, 1fr)`;
  const head = `<div class="heat__row heat__head" style="${style}"><span></span>${c.years.map((y, i) => `<span>${i % every === 0 || i === cols - 1 ? `'${String(y).slice(2)}` : ''}</span>`).join('')}</div>`;
  const body = rows.map(r => `<div class="heat__row" style="${style}"><span class="heat__y cat-label">${esc(r.label)}</span>${c.years.map(y => {
    const [n, sh] = share(r, y);
    return `<span class="heat__cell heat__cell--sq" data-s="${step(sh)}" ${tip(`${n}冊(${Math.round(sh * 100)}%)`, `${y}年・${r.label}`)}></span>`;
  }).join('')}</div>`).join('');
  return `<div class="heat">${head}${body}</div>
    <div class="heat__legend"><span>その年に占める割合 低</span>${[1, 2, 3, 4, 5].map(k => `<span class="heat__cell" data-s="${k}"></span>`).join('')}<span>高</span></div>`;
}

function categorySection(c, hasCats) {
  if (!hasCats) {
    return card('カテゴリ', '', `<p class="viz-empty">まだカテゴリの付いた本がありません。設定の「未分類の本をまとめて分類」で一度に付けられます。</p>`);
  }
  if (!c.rows.length) return '';
  const note = c.uncategorized ? `未分類の${c.uncategorized}冊は含みません。` : '';
  const fmtOr = (v, f) => v === null ? '—' : f(v);
  const tableRows = c.rows.map(r => [r.label, r.value, fmtOr(r.avgScore, fmt1), fmtOr(r.avgPages, Math.round), fmtOr(r.medianGap, fmt1)]);
  return card('カテゴリ別の冊数', note, hbars(c.rows.map(r => ({ label: r.label, value: r.value }))))
    + (c.years.length >= 2 ? card('カテゴリの移り変わり', 'その年に読んだ本のうち、各カテゴリが占める割合です(冊数の多い12カテゴリ)。', categoryHeat(c)) : '')
    + card('カテゴリごとの読み方', '刊行→読了は「刊行から読了までの年数」の中央値です。評価は評価済みの本だけの平均。',
      `<div class="viz-scroll"><table class="cat-table"><thead><tr><th>カテゴリ</th><th>冊数</th><th>評価</th><th>ページ</th><th>刊行→読了</th></tr></thead>
        <tbody>${tableRows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
}

// ツールチップは1つだけ。値を先に太く、項目名を後に。
export function attachTooltips(root) {
  let el = document.getElementById('viz-tip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'viz-tip';
    el.className = 'viz-tip';
    el.hidden = true;
    el.innerHTML = '<strong></strong><span></span>';
    document.body.appendChild(el);
  }
  const show = (target, x, y) => {
    el.querySelector('strong').textContent = target.dataset.tipV;
    el.querySelector('span').textContent = target.dataset.tipL;
    el.hidden = false;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, x - r.width / 2))}px`;
    el.style.top = `${Math.max(8, y - r.height - 12)}px`;
  };
  const find = e => e.target.closest && e.target.closest('[data-tip-v]');
  root.addEventListener('pointermove', e => { const t = find(e); if (t) show(t, e.clientX, e.clientY); else el.hidden = true; });
  root.addEventListener('pointerdown', e => { const t = find(e); if (t) show(t, e.clientX, e.clientY); });
  root.addEventListener('pointerleave', () => { el.hidden = true; });
  root.addEventListener('focusin', e => { const t = find(e); if (t) { const r = t.getBoundingClientRect(); show(t, r.left + r.width / 2, r.top); } });
  root.addEventListener('focusout', () => { el.hidden = true; });
  addEventListener('scroll', () => { el.hidden = true; }, { passive: true });
}
