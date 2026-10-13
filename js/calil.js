// カーリル図書館API(無料のアプリケーションキーが必要)で、地元の図書館の蔵書と貸出状況を調べる。
// CORSは公式に書かれていないので、JSONP(scriptタグ)で呼ぶ。結果がそろうまで2秒以上あけて問い合わせ直す。
// https://calil.jp/doc/api_ref.html

let seq = 0;
function jsonp(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const name = `__calil${Date.now()}${seq++}`;
    const s = document.createElement('script');
    const done = () => { delete window[name]; s.remove(); clearTimeout(t); };
    const t = setTimeout(() => { done(); reject(new Error('カーリルの応答がありません')); }, timeout);
    window[name] = data => { done(); resolve(data); };
    s.onerror = () => { done(); reject(new Error('カーリルに接続できません')); };
    s.src = `${url}&callback=${name}`;
    document.head.appendChild(s);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 戻り値: Map(isbn -> { status, reserveurl, libs: {館名: 状態} })
export async function checkLibrary({ appkey, systemid, isbns }) {
  if (!appkey) throw new Error('設定でカーリルのアプリケーションキーを入れてください');
  const out = new Map();
  for (let i = 0; i < isbns.length; i += 20) {
    const chunk = isbns.slice(i, i + 20);
    let data = await jsonp(`https://api.calil.jp/check?appkey=${encodeURIComponent(appkey)}&isbn=${chunk.join(',')}&systemid=${encodeURIComponent(systemid)}&format=json`);
    for (let n = 0; data.continue === 1 && n < 15; n++) {
      await sleep(2000);
      data = await jsonp(`https://api.calil.jp/check?appkey=${encodeURIComponent(appkey)}&session=${encodeURIComponent(data.session)}&format=json`);
    }
    for (const isbn of chunk) {
      const r = ((data.books || {})[isbn] || {})[systemid];
      if (r) out.set(isbn, summarize(r));
    }
  }
  return out;
}

// 館ごとの状態を一言にまとめる
export function summarize(r) {
  const libs = r.libkey || {};
  const states = Object.values(libs);
  let status;
  if (r.status === 'Error') status = '確認できず';
  else if (!states.length) status = '蔵書なし';
  else if (states.some(s => s === '貸出可' || s === '蔵書あり' || s === '館内のみ')) status = '貸出可';
  else if (states.some(s => s === '貸出中' || s === '予約中')) status = '貸出中';
  else status = states[0];
  return { status, reserveurl: r.reserveurl || '', libs, at: new Date().toISOString() };
}
