# ホームアプリ構成ガイド(読書メモ方式)

iPhoneのホーム画面から開く自分専用のアプリを、費用0円で作るための構成。読書メモ(このリポジトリ)で実際に動かした形をまとめたもので、別のアプリを作るときの出発点として使う。

- 対象: 自分(と自分の端末)だけが使うアプリ。iPhone中心、iPad・パソコンでも開ける。
- 前提: ただまさのGoogleアカウント、GitHubアカウント、(使うなら)Gemini APIキー。
- 実例: このリポジトリ全体。下の表の「実装」列はこのリポジトリのファイル。

## 1. 全体像

```
 iPhone / iPad(ホーム画面のアイコン)
 ┌──────────────────────────────────────────────┐
 │ 静的ファイル(HTML / CSS / ES Modules)       │ ← GitHub Pages から配信
 │   Service Worker … アプリ本体をキャッシュ     │
 │   IndexedDB …… データの正本(端末ごと)       │
 │   カメラ・共有シート・音声入力(キーボード)   │
 └──┬──────────────┬───────────────┬────────────┘
    │ fetch        │ fetch(text/plain)│ 共有シート
    ▼              ▼               ▼
 外部API         自分のスプレッドシート     iCloud Drive
 (Gemini を      + Apps Script Webアプリ    (JSONバックアップ)
  自分のキーで    =「ハブ」。差分同期。
  直接、書誌APIなど) 他のApps Scriptアプリ
                 (日記・縁泉)はシートを読む
```

要点は「端末の中が正本、サーバーは持たない、Googleは自分の持ち物だけ使う」の3つ。

| 層 | 選んだもの | 実装 |
|---|---|---|
| 配信 | GitHub Pages(main ブランチの root) | リポジトリ直下がそのままサイト |
| 画面 | ビルドなしの ES Modules、ハッシュでのルーティング | `index.html`, `js/app.js` |
| 見た目 | Apple HIG に寄せたCSSトークンと部品(ライト/ダーク) | `css/hig-tokens.css`, `css/hig-components.css` |
| ホーム画面化 | Web App Manifest + apple-touch-icon + standalone 判定 | `manifest.webmanifest`, `icons/` |
| オフライン | Service Worker(同一オリジンだけ、ネット優先→キャッシュ) | `sw.js` |
| データ | IndexedDB の薄いラッパー(ライブラリなし) | `js/db.js` |
| 消えない工夫 | `navigator.storage.persist()`、Safariタブで開いたときの警告 | `js/db.js`, `index.html` |
| バックアップ | JSONを共有シートへ(→「ファイル」→iCloud Drive)、キーは除外 | `js/backup.js` |
| 端末間同期 | 自分のスプレッドシート + Apps Script Webアプリ(ハブ) | `js/sync.js`, `hub/Code.gs`, `hub/README.md` |
| AI | Gemini API を端末から自分のキーで直接。押したときだけ送信 | `js/gemini.js` |
| カメラ | `getUserMedia` + BarcodeDetector、なければ同梱ZXing、だめなら写真 | `js/scanner.js`, `vendor/zxing.min.js` |
| CORSのない外部API | JSONP(scriptタグ) | `js/calil.js` |
| テスト | `node --test`、Apps Script は vm で模擬して動かす | `tests/core.test.mjs`, `tests/gas-mock.mjs` |

## 2. なぜこの構成か

決めた条件は「運用費0円」「自分専用で公開しない」「iPhoneで数秒で書ける」「圏外でも開ける」(2026-10-12)。

| 候補 | 退けた理由 |
|---|---|
| Apps Script の HtmlService だけで作る(縁泉_改の方式) | 開くたびにサーバー実行を待つ。iframeの中で動くので Service Worker が使えず、圏外で開けない。ホーム画面に置いても実体はSafariのページ。 |
| Firebase / Supabase などのBaaS | 無料枠はあるが、課金アカウントや認証の設定が増える。自分専用なら持て余す。 |
| Cloud Run など | 請求先アカウントが前提になる。 |
| Googleドライブ(appDataFolder)へ直接同期 | OAuth のクライアント登録と同意画面の管理が要る。自分専用には重い。 |
| ネイティブアプリ(Swift) | 自分の端末に入れ続けるには有料の開発者登録か、7日ごとの再署名が要る。 |

この構成の性格を一言で言うと、ローカルファースト(Kleppmann ほか "Local-first software", Ink & Switch, 2019)を、無料のGoogleとGitHubの部品だけで組んだもの。サーバーは「同期の中継」と「他のアプリへの窓口」に限り、なくても動く。

## 3. 各部の作り方と決まりごと

### 3.1 配信とファイル構成

- リポジトリは公開にする(無料アカウントで GitHub Pages を使うため)。データはリポジトリに置かないので中身は空っぽのアプリだけが公開される。
- Pages の有効化は、GitHub の Settings → Pages で「main / (root)」を選ぶ。最初の1回は本人の操作が要る(Claudeのセッションからは設定できなかった)。
- URLは `https://<user>.github.io/<repo>/`。サブパスなので、パスはすべて相対(`./`, `js/app.js`)で書く。`/js/app.js` のような先頭スラッシュは使わない。
- ビルドしない。`<script type="module" src="js/app.js">` から `import` でつなぐ。ライブラリが要るときは `vendor/` に固定版を置き、必要になった時だけ読み込む(`js/scanner.js` の `loadZxing`)。
- 開発: `python3 -m http.server 8765` で開き、`node --test` でテスト(`package.json`)。

### 3.2 ホーム画面アプリにする

`index.html` の head に置くもの:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="アプリ名">
<meta name="theme-color" content="#F2F2F7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/icon-180.png">
```

- manifest は `start_url: "./#最初の画面"`, `scope: "./"`, `display: "standalone"`。アイコンは 180(iOS用)/192/512(maskable も)。
- `viewport-fit=cover` にしたら、上下の帯は `env(safe-area-inset-*)` で避ける(`css/hig-components.css`)。
- ホーム画面から開いたかは `matchMedia('(display-mode: standalone)').matches || navigator.standalone` で判定し、Safariのタブで開いているときは警告を出す(理由は落とし穴1)。

### 3.3 画面

- ルーティングは `location.hash`(`#shelf`, `#book/<id>`)と `hashchange`。サーバー側の設定が要らず、Pages のサブパスでも壊れない。
- 描画は文字列テンプレートで `innerHTML`。外から来た文字は必ず `esc()` を通す(`js/app.js`)。
- 見た目は Apple HIG の近似トークン(色・余白8pt・角丸・44ptのタップ領域・Liquid Glass風のぼかし)。ライト/ダークは `color-scheme: light dark` と `prefers-color-scheme`。グラフもライブラリを使わず手書きSVG(`js/stats.js`)。

### 3.4 データ(IndexedDB)

- ストアは用途ごと(`books`, `notes`)と、設定・キー・状態を入れる `meta`(key/value)。スキーマ変更は `DB_VERSION` を上げて `onupgradeneeded` で足す。
- id は端末で作る(`Date.now().toString(36) + 乱数`)。サーバーで採番しないので、圏外でも書ける。
- 同期するストアに書くたびに `mtime`(ミリ秒)を付け、変更を `onChange` で同期係に知らせる。同期で受け取った書き込みは `{ silent: true }` にして送り返さない。
- APIキーは `meta` にだけ置き、バックアップと同期から外す(`js/backup.js` の `SECRET_KEYS`)。

### 3.5 オフライン(Service Worker)

`sw.js` の決まり:

1. `SHELL` にアプリ本体のファイルを全部並べる。新しいJSファイルを足したら、ここにも足す。
2. 変更を出すたびに `VERSION` を上げる。古いキャッシュは activate で消す。
3. fetch は同一オリジンのGETだけを扱い、「ネット優先、失敗したらキャッシュ」。外部API(AI・書誌)はキャッシュしない。
4. `skipWaiting()` と `clients.claim()` で、新しい版をすぐ効かせる。

ネット優先にしたのは、自分専用で更新を頻繁に出すため。キャッシュ優先にすると、更新が一度アプリを開き直すまで反映されず、「直したのに直っていない」が起きる。

### 3.6 バックアップ

- 全データをJSONにし、`navigator.share({ files: [file] })` で共有シートを出す。「"ファイル"に保存」→ iCloud Drive。共有できない環境ではダウンロードにする。
- 読み込みは id ごとに新しい方を残す(上書きで消さない)。

### 3.7 端末間・アプリ間の同期(ハブ)

自分のスプレッドシートに Apps Script を付け、Webアプリとして公開したものを「ハブ」にする。手順書は `hub/README.md`、受け口は `hub/Code.gs`、端末側は `js/sync.js`。

- 公開設定: 「次のユーザーとして実行: 自分」「アクセスできるユーザー: 全員」。認証は `setup()` が作る合言葉(Script Properties の `TOKEN`)で、リクエスト本文に入れて送る。
- 送る: `POST` で `Content-Type: text/plain;charset=utf-8`、本文はJSON。`{ token, since, books:[{id,mtime,deleted,data}], notes:[...] }`
- 返す: `{ ok, rev, more, books:[...], notes:[...] }`。ハブは書き込みごとに連番 `rev` を振り、`since` より新しい行だけを返す(端末は最後の `rev` を `syncCursor` に持つ)。多いときは400件ずつ、`more` を立てて続きを取らせる。
- 衝突は「`mtime` が新しい方を残す」(last-writer-wins)。削除は行を消さず `deleted=true` を残す(墓標)。同じ時刻同士は同じものとみなす。
- 端末側は、開いたとき・アプリに戻ったとき(`visibilitychange`)・書いてから4秒後にまとめて送る。未送信の一覧は `meta.syncDirty` に保存して、途中で閉じても失わない。
- 受け取って画面を作り直すとき、入力中なら作り直さない。
- シートは人と他のアプリが読む表として作る: 先頭に読みやすい列(書名・日付・本文など)、最後に `json` 列(アプリの元データ)。表を手で直してもアプリには戻らない(`json` が正)。
- 他のApps Script(日記・縁泉)は `SpreadsheetApp.openById(ハブのID)` でシートを読むだけにする。HTTPでハブを呼ぶ必要はない。

### 3.8 AI(Gemini)

- 端末から `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` を直接呼ぶ。キーはヘッダ `x-goog-api-key`。モデル名は設定で変えられるようにする(既定は `js/gemini.js` の `DEFAULT_MODEL`)。
- 3つの呼び方を用意している: 普通の文章、JSONで返させる(`responseMimeType: 'application/json'`, `temperature: 0`)、Google検索で裏づけ(`tools: [{ google_search: {} }]`、使えずに400なら検索なしで呼び直す)。
- 送るのはボタンを押したときだけ。送る中身(書名と著者だけ、など)を画面に書く。

### 3.9 カメラ

- `getUserMedia({ video: { facingMode: { ideal: 'environment' } } })`、`<video playsinline muted autoplay>`。
- 読み取りは `BarcodeDetector` があれば使い、なければ同梱の ZXing を初めて使うときだけ読み込む。
- カメラが使えない・許可されないときのために、`<input type="file" accept="image/*" capture="environment">` で写真から読む道を必ず残す。
- 読み違い対策に、同じ値が2回続いたら確定する。終わったら `track.stop()` でカメラを止める。

### 3.10 外部API

- CORSで読めないAPIは、JSONP(`<script>` に callback)で呼ぶ(カーリル)。
- 画像だけ欲しいときは、APIを叩かず `<img>` に候補URLを順に入れ、読めた最初のものを使う(書影)。CORSもキーも要らない。
- 共有の無料上限がある「キーなし呼び出し」に頼らない。任意で自分のキーを入れる欄と、設定画面に「接続を確かめる」を置く。

### 3.11 テスト

- 画面以外の処理(読み込み・変換・計算・プロンプトの組み立てと返答の読み取り)は、DOMに触れない関数に分けて `node --test` で試す。
- Apps Script は `tests/gas-mock.mjs` のように `SpreadsheetApp` などを最小限まねて、`vm` で `Code.gs` をそのまま動かす。行数の上限超え、古い書き込みの無視、ページ分けまで手元で確かめられる。

## 4. 落とし穴(試して分かったこと)

| # | 起きたこと | 対処 |
|---|---|---|
| 1 | Safariのタブで開いたページとホーム画面のアプリは保存場所が別。タブ側はしばらく開かないと消える。 | ホーム画面から開かせる。タブで開いていれば警告を出す。`storage.persist()` を呼ぶ。JSONバックアップを用意する。(出典: "Full Third-Party Cookie Blocking and More", WebKit Blog, 2020-03-24。スクリプトが書いた保存領域は、Safariを7日使う間にそのサイトを開かないと消える。ホーム画面のWebアプリは数え方が別で、アプリ自体を使った日で数える) |
| 2 | Apps Script に `application/json` で POST すると、事前確認(OPTIONS)が飛び、Apps Script は応えられない。 | `text/plain;charset=utf-8` で送り、サーバーで `JSON.parse`。`redirect: 'follow'`(応答は script.googleusercontent.com への転送を経由する)。 |
| 3 | Apps Script のURLや公開範囲が違うと、JSONではなくGoogleのログインHTMLが返り、`res.json()` が失敗する。 | 読めないときは「URLとアクセス設定(全員)を確かめて」と言い換えて出す(`js/sync.js` の `post`)。 |
| 4 | Code.gs を直しても、Webアプリは古いまま動く。 | 「デプロイを管理」→ 鉛筆 →「新バージョン」で出し直す。新しいデプロイを作るとURLが変わるので作らない。 |
| 5 | 新しいシートは1000行しかなく、`getRange` で超えるとエラー。 | 足りない分を `insertRowsAfter` してから書く。 |
| 6 | シートに日付や数字の文字を書くと勝手に変換される。 | 列全体を書式なしテキスト(`setNumberFormat('@')`)にしておく。 |
| 7 | 1セルは5万字まで。AIの長文を含むJSONが入らない。 | 長い項目を削って入れる(`hub/Code.gs` の `cell_`)。 |
| 8 | Google Books のキーなし呼び出しは全利用者で1日の上限を共有していて、よく429で止まる。 | 自分のキーを任意で入れられるようにし、国立国会図書館サーチなど別の出どころに逃がす。 |
| 9 | openBD は登録があっても内容紹介が空のことが多い(3冊試して全部空)。 | 概要は複数の出どころを順に試す。 |
| 10 | Amazon の商品画像URLは、画像がないと1×1のGIFを返す(エラーにならない)。 | 読めた画像の大きさを見て、極小なら失敗扱い。 |
| 11 | Gemini の検索グラウンディングは、モデルやキーによって400になる。 | 400なら検索なしで呼び直し、そのことを画面に出す。 |
| 12 | Gemini の無料枠では、送った内容がGoogleの製品改善に使われうる(Gemini API 追加利用規約の「無償サービス」の項)。 | 送るのは押したときだけ、送る範囲を絞る。私的な文章を大量に送るなら有料枠を検討する。 |
| 13 | Service Worker の `SHELL` に新しいファイルを足し忘れると、圏外でそのファイルだけ読めない。 | ファイルを足すたびに `SHELL` と `VERSION` を直す(コミット前の確認項目にする)。 |
| 14 | iOS の Safari には BarcodeDetector がない場合がある。 | ZXing を同梱し、必要なときだけ読み込む。 |
| 15 | 同期で受け取ったデータを書くと、それがまた「変更」になって送り返され、往復が止まらない。 | 受け取った書き込みは `silent` にして変更通知を出さない。 |
| 16 | Claude の作業環境(クラウド)からは、Googleや多くの外部APIに届かないことがある。 | 外部APIは模擬応答(Playwrightのルート差し替え、Apps Scriptはvmの模擬)で確かめ、本物での確認は本人に頼む。何を本物で確かめていないかを必ず書き残す。 |

まだ本物で確かめていないこと(2026-10-30時点): ハブ(`hub/Code.gs`)を本物のGoogle上で動かすこと、iPhone実機のホーム画面アプリでのカメラ読み取り。

## 5. 新しいアプリを作るときの手順

1. GitHubに公開リポジトリを作り、このリポジトリから次をコピーする: `index.html`(中身を差し替え)、`manifest.webmanifest`、`sw.js`、`css/hig-tokens.css`、`css/hig-components.css`、`js/db.js`、必要なら `js/backup.js`・`js/sync.js`・`js/gemini.js`・`js/scanner.js`、`package.json`、`tests/gas-mock.mjs`。
2. 名前を変える: manifest の `name`/`short_name`、`apple-mobile-web-app-title`、`<title>`、`db.js` の `DB_NAME`、`sw.js` のキャッシュ名、`backup.js` の `app`。DB名とキャッシュ名が同じだと、同じドメイン(`<user>.github.io`)の別アプリとデータが混ざる。
3. アイコンを作る(180 / 192 / 512px のPNG)。
4. ストアを決め、同期するストアを `db.js` の `SYNCED` と `sync.js` に、受け口の列を `Code.gs` の `*_COLS` に書く。
5. Settings → Pages で main / (root) を選んで公開。iPhoneのSafariで開き「ホーム画面に追加」。
6. 同期が要るなら、`hub/README.md` の手順で新しいスプレッドシートにハブを作る(アプリごとに別のスプレッドシートにすると、壊れても互いに巻き込まない)。

### この方式が向かないとき

- 複数人で同じデータを同時に編集する(last-writer-wins では誰かの変更が消える)。
- 公開して他人に使ってもらう(Apps Script の実行上限、合言葉の配布、利用規約の問題が出る)。
- 端末に置けない大きさのデータ、またはサーバー側で定期的に動く処理が主役のもの(その部分は Apps Script の時間主導トリガーに任せ、アプリはシートを読む)。
- 通知(Web Push)が主役のもの。iOSでもホーム画面アプリなら使えるが、配信元のサーバーが要り、0円構成から外れる。
