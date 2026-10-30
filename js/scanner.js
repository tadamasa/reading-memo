// 裏表紙のバーコード(ISBN)をカメラで読む。
// Safariに BarcodeDetector があればそれを使い、なければ同梱の ZXing を初めて使うときだけ読み込む。
// カメラが使えないときは、写真を撮って読む方法に切り替える。

const ZXING_SRC = 'vendor/zxing.min.js';
let zxingPromise = null;

function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (!zxingPromise) zxingPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = ZXING_SRC;
    s.onload = () => resolve(window.ZXing);
    s.onerror = () => { zxingPromise = null; reject(new Error('読み取りの部品を読み込めませんでした')); };
    document.head.appendChild(s);
  });
  return zxingPromise;
}

// 978/979で始まり、検査数字が合う13桁だけを本のISBNとみなす(192で始まる2段目の価格コードは無視)
export function isIsbnBarcode(code) {
  if (!/^97[89]\d{10}$/.test(code)) return false;
  const sum = [...code.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

async function makeDecoder() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('ean_13')) {
        const det = new window.BarcodeDetector({ formats: ['ean_13'] });
        return async canvas => (await det.detect(canvas)).map(b => b.rawValue);
      }
    } catch { /* ZXingへ */ }
  }
  const ZX = await loadZxing();
  const hints = new Map([[ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.EAN_13]], [ZX.DecodeHintType.TRY_HARDER, true]]);
  const reader = new ZX.MultiFormatReader();
  reader.setHints(hints);
  return async canvas => {
    try {
      const bmp = new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.HTMLCanvasElementLuminanceSource(canvas)));
      return [reader.decode(bmp).getText()];
    } catch { return []; }
  };
}

// 画面いっぱいの読み取り画面を出し、読めたISBNを返す。やめたら null。
export function scanIsbn() {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'scanner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'バーコードを読み取る');
    el.innerHTML = `
      <video class="scanner__video" playsinline muted autoplay></video>
      <div class="scanner__frame" aria-hidden="true"><span></span></div>
      <p class="scanner__hint" aria-live="polite">裏表紙の上のバーコード(978で始まる方)を枠に合わせてください</p>
      <div class="scanner__bar">
        <label class="btn btn--tinted scanner__photo">写真で読む<input type="file" accept="image/*" capture="environment" hidden></label>
        <button class="btn btn--prominent scanner__close">やめる</button>
      </div>`;
    document.body.appendChild(el);
    const video = el.querySelector('video');
    const hint = el.querySelector('.scanner__hint');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stream = null;
    let done = false;
    let decode = null;
    let last = '';

    const finish = code => {
      if (done) return;
      done = true;
      if (stream) stream.getTracks().forEach(t => t.stop());
      el.remove();
      resolve(code);
    };
    el.querySelector('.scanner__close').addEventListener('click', () => finish(null));

    const check = codes => {
      const isbn = codes.find(isIsbnBarcode);
      if (!isbn) return false;
      // 読み違いを避けるため、同じ番号が2回続いたら確定する
      if (isbn === last) { finish(isbn); return true; }
      last = isbn;
      return false;
    };

    const tick = async () => {
      if (done) return;
      if (video.readyState >= 2 && decode) {
        // 枠のあたり(横長の帯)だけを切り出して読む
        const w = video.videoWidth, h = video.videoHeight;
        const cw = Math.round(w * 0.9), ch = Math.round(h * 0.35);
        canvas.width = cw; canvas.height = ch;
        ctx.drawImage(video, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, cw, ch);
        if (check(await decode(canvas))) return;
      }
      setTimeout(tick, 120);
    };

    // 写真から読む(カメラが使えないとき、映像でうまく読めないとき)
    el.querySelector('input[type=file]').addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      hint.textContent = '写真を読んでいます…';
      try {
        decode = decode || await makeDecoder();
        const img = await createImageBitmap(f);
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const isbn = (await decode(canvas)).find(isIsbnBarcode);
        if (isbn) finish(isbn);
        else hint.textContent = '写真からISBNのバーコードを読めませんでした。バーコードが大きく、ぶれずに写るように撮り直してください。';
      } catch (err) { hint.textContent = err.message; }
      e.target.value = '';
    });

    (async () => {
      try { decode = await makeDecoder(); } catch (err) { hint.textContent = err.message; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        hint.textContent = 'この画面ではカメラを使えません。「写真で読む」から撮ってください。';
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (done) { stream.getTracks().forEach(t => t.stop()); return; }
        video.srcObject = stream;
        await video.play().catch(() => {});
        tick();
      } catch (err) {
        hint.textContent = err.name === 'NotAllowedError'
          ? 'カメラの使用が許可されていません。iPhoneの「設定」→「Safari」→「カメラ」で許可するか、「写真で読む」を使ってください。'
          : 'カメラを開けませんでした。「写真で読む」から撮ってください。';
      }
    })();
  });
}
