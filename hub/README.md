# 読書ハブ(スプレッドシートとの同期)

読書メモアプリの本とメモを、自分のGoogleスプレッドシートに置いて、iPadなど他の端末や、日記アプリなど他のApps Scriptと共有するための受け口です。費用はかかりません。

- アプリのデータは今まで通り各端末の中にあり、開いたときと、書いてから数秒後に、変わった分だけをやり取りします。
- 同じ本やメモを二つの端末で直したときは、後から直したほうが残ります。削除も伝わります。

## 準備(最初の1回、パソコンで行うのが楽です)

1. Googleドライブで新しいスプレッドシートを作ります(名前の例: 読書ハブ)。
2. メニューの「拡張機能」→「Apps Script」を開きます。
3. 最初からある `コード.gs` の中身を全部消して、[Code.gs](https://raw.githubusercontent.com/tadamasa/reading-memo/main/hub/Code.gs) の中身を貼り、保存します。
4. 上の関数の選択欄で `setup` を選び、「実行」を押します。
   - 権限の確認が出たら、自分のアカウントを選び、「詳細」→「(安全ではないページ)に移動」→「許可」と進みます。自分で作ったスクリプトなので問題ありません。
   - 下の実行ログに「合言葉: …」が出ます。これを控えます。
5. 右上の「デプロイ」→「新しいデプロイ」を開き、種類の歯車から「ウェブアプリ」を選びます。
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
   - 「デプロイ」を押し、出てきた「ウェブアプリのURL」(`…/exec` で終わるもの)をコピーします。
6. 読書メモアプリの「設定」→「読書ハブ(同期)」に、URLと合言葉を入れて「接続して同期する」を押します。最初の1回は全部の本を送るので少し時間がかかります。
7. iPadでは、同じアプリ(https://tadamasa.github.io/reading-memo/)をホーム画面に追加し、同じURLと合言葉で接続します。本棚がそのまま届きます。

URLと合言葉を知っている人は読み書きできるので、他の人には教えないでください。

## さくら(Muse)用の合言葉

さくらが外から本を登録するための、端末用とは別の合言葉です。

1. Apps Script の関数の選択欄で `setupSakura` を選び、「実行」を押します。実行ログに「さくら用合言葉: …」が出ます(シートの準備も一緒に済みます)。
2. その合言葉を、さくらの保管庫に登録します(チャットなどには貼らないでください)。ウェブアプリのURLは今のものをそのまま使います。
3. 合言葉は、送信データの `token` でも、URLのパラメータ(`?token=…`)でも渡せます。
4. さくら用の合言葉では、本やメモの追加・更新はできますが、**削除はできません**。
5. さくらのアクセスを止めたいときは、Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」から `SAKURA_TOKEN` を削除します。端末の同期には影響しません。

## 外部から本を追加し、Kindle+ を切り替える(API用合言葉)

ほかのAIやiOSショートカットから、**本の追加** と **Kindle+(読み放題)の切り替え** だけをするための、同期用とは別の合言葉です。アイデアハブの投稿用合言葉と同じ考え方で、URLに付けたときだけ通ります。

1. 新しい Code.gs を貼って保存し、関数の選択欄で `setupApi` を選んで「実行」します。実行ログに「API用合言葉: …」が出ます。
2. 「デプロイを管理」→ 鉛筆 → バージョン「新バージョン」→「デプロイ」。URLは変わりません。
3. 送り方(本文は次のどちらか一つだけ):

```
POST {ハブのURL}?token=<API用合言葉>
Content-Type: text/plain;charset=utf-8

{"addBook": {"title": "動的平衡", "author": "福岡伸一", "isbn13": "9784334037437", "kindlePlus": "調べる", "wantReason": "さくらのおすすめ"}}
{"setKindlePlus": {"isbn13": "9784334037437", "status": "対象"}}
```

- `addBook`: `title` は必須。`author`、`isbn13`(ISBN-10 も可)、`itemId`(ASIN)、`status`(`want` 既定 / `reading` / `done` / `stopped`)、`wantReason`、`kindlePlus` は任意。同じISBN・ASIN(どちらもなければ同じ書名)の本があれば足さずに `{"ok": true, "existed": true, "id": …}` を返します(`kindlePlus` があればそれだけ切り替えます)。
- `setKindlePlus`: 本は `id` → `isbn13` → `itemId` → `title`(空白・全角半角を無視した完全一致)の順で探します。`status` は `対象` / `対象外` / `Kindle版なし` / `調べる`(`yes` / `no` / `none` / `check` でも可)、空文字で記録を消します。見つからなければ `not found`、同じ書名が2冊以上なら `ambiguous` と候補を返します。
- 表に書くだけなので、アプリには次に開いたときの同期で入ります。
- できないこと: 本・メモの読み取り(同期)、削除、メモの追加。本文に `token` を入れても、ほかの項目を混ぜても `unauthorized` です。同期用の合言葉をURLに付けても、この使い方にはなりません。
- 止める・作り直すときは、「スクリプト プロパティ」で `API_TOKEN` を消します(作り直すならそのあと `setupApi`)。同期とさくらには影響しません。

## スクリプトを新しくするとき

Code.gs を貼り替えて保存したら、「デプロイ」→「デプロイを管理」→ 鉛筆の印 → バージョン「新バージョン」→「デプロイ」。URLは変わりません。

## 他のApps Script(日記アプリなど)から読む

スプレッドシートには `books` と `notes` の二つのシートがあり、普通の表として読めます。

| シート | 主な列 |
|---|---|
| books | id, title(書名), author, status(読みたい/読書中/読了/中断), category, score(10点満点), finishedAt(読了日) |
| notes | id, date(書いた日 yyyy-mm-dd), bookId, bookTitle(書名), kind, text(メモ), quote(引用) |

- `deleted` が `true` の行は削除済みです。読むときは飛ばしてください。
- 最後の `json` 列がアプリの元データです。表を手で書き換えても、アプリには反映されません。

例: ある日の読書メモを日記アプリで取り出す

```js
function readingNotesOn(date) { // date: '2026-10-29'
  const sh = SpreadsheetApp.openById('読書ハブのスプレッドシートID').getSheetByName('notes');
  const rows = sh.getDataRange().getValues();
  const head = rows.shift();
  const col = name => head.indexOf(name);
  return rows
    .filter(r => r[col('date')] === date && String(r[col('deleted')]) !== 'true')
    .map(r => ({ book: r[col('bookTitle')], text: r[col('text')], quote: r[col('quote')] }));
}
```

スプレッドシートIDは、スプレッドシートのURLの `/d/` と `/edit` の間の文字列です。

## ほかのアプリが読んでいる列(変えるときは相手側も直す)

2026-11 から、次の2つが読書ハブを読んでいます。どちらも読むだけで、書き込みはしません。

| 読んでいる相手 | いつ | 読むもの |
|---|---|---|
| 縁泉GAS(縁泉_改) | 毎晩 | `books` から読了本を拾い、縁泉の「作品」として追記する |
| 日記と縁泉の共通ライブラリ(「その日」の読み取り) | 開いたとき | `books` と `notes` から、その日に読み終えた本と書いたメモを出す |

### 約束になっている列

`books`(この並び): `id, rev, mtime, deleted, title, author, status, category, score, finishedAt, json, kindlePlus, kindlePlusAt`

`kindlePlus`(`対象` / `対象外` / `Kindle版なし` / `調べる`、未確認は空)と `kindlePlusAt`(確かめた日 `yyyy-mm-dd`)は 2026-11 に `json` の後ろへ足した列です。古い表は、新しい Code.gs が最初に動いたときに見出しを足し、今ある本の分も埋めます。`json` が最後の列ではなくなったので、`json` も見出しの名前で探してください。

| 列 | 中身 | 読んでいる相手 |
|---|---|---|
| `status` | `読みたい` / `読書中` / `読了` / `中断` の日本語 | 縁泉GAS(`読了` の行だけ拾う) |
| `finishedAt` | 読了日 `yyyy-mm-dd`。読了でない本や、ブクログで日付がなかった本は空 | 縁泉GAS、共通ライブラリ |
| `deleted` | 文字の `true` / `false`。`true` の行は飛ばす | 縁泉GAS、共通ライブラリ |
| `title`, `author`, `category` | 書名、著者、分類 | 共通ライブラリ |
| `json` の `isbn13` | 13桁のISBN。Kindle本などは `null` | 縁泉GAS(作品の重複を見分ける) |
| `json` の `itemId` | ブクログの商品ID(ISBN-10 か Kindle の ASIN)。アプリで追加した本は `null` のことがある | 縁泉GAS(`isbn13` がないときの見分け) |
| `json` の `cover` | 書影のURL。まだ探していなければ `null`、見つからなかった本は文字の `none` | 共通ライブラリ(`none` は画像なしとして扱う) |

`notes`(この並び): `id, rev, mtime, deleted, date, bookId, bookTitle, kind, text, quote, json`

| 列 | 中身 | 読んでいる相手 |
|---|---|---|
| `bookId` | `books` の `id` | 共通ライブラリ |
| `text` | メモの本文 | 共通ライブラリ |
| `date`, `deleted` | 書いた日 `yyyy-mm-dd`、削除済みかどうか | 共通ライブラリ(その日のメモを選ぶ) |

読むときに気をつけること:

- **列は見出しの名前で探してください**(上の `readingNotesOn` の例のように `head.indexOf('text')`)。列の番号で読むと、列が増えたときに壊れます。
- 表の `status` は日本語ですが、`json` の中の `status` はアプリの内部の値(`want` / `reading` / `done` / `stopped`)です。読了を見分けるときは表の `status` 列を使います。
- 削除済みの行は `json` が空です。`deleted` を先に見てください。
- 表はすべて書式なしテキストなので、日付は `Date` ではなく文字列で返ります。

### 読書メモ側で変えるときの決まり

次のどれかを変えるときは、縁泉GAS と共通ライブラリも同じ変更に合わせて直します(縁泉_改プロジェクトの作業)。

- 上の列の名前、並び、列の追加・削除(`Code.gs` の `BOOK_COLS` / `NOTE_COLS`)
- `status` の日本語(`Code.gs` の `STATUS`。とくに `読了`)
- `finishedAt` と `date` の書き方(`yyyy-mm-dd`)
- `json` の `isbn13`、`itemId`、`cover` の名前と意味
- シートの名前 `books` / `notes`

列を後ろに足すだけなら、見出しの名前で読んでいる相手は壊れませんが、`json` が最後の列でなくなるので、`Code.gs` の `last` の扱いも合わせて確かめてください。
