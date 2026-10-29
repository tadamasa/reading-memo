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
