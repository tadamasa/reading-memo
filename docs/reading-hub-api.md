# 読書ハブ API 仕様書(外部のAI・ツール向け)

版: 1.0(2026-11-12) ・ 実装: [hub/Code.gs](../hub/Code.gs) の `apiAddBook_` / `apiSetKindlePlus_`

読書メモアプリ(https://tadamasa.github.io/reading-memo/)の本棚に、外部から **本を追加する** ことと、本の **Kindle+(Kindle Unlimited 読み放題)対象かどうかの記録を切り替える** ことができます。読書ハブ(Googleスプレッドシート + Apps Script)の表に書き込み、アプリは次に開いたときの同期で取り込みます。

この API でできるのはこの2つだけです。本やメモの読み取り、削除、メモの追加はできません。

---

## 1. 接続

| 項目 | 値 |
|---|---|
| エンドポイント | 読書ハブのウェブアプリURL(`https://script.google.com/macros/s/…/exec`)。持ち主から受け取る |
| 認証 | API用合言葉を **URLクエリ `token`** に付ける: `{エンドポイント}?token=<API用合言葉>` |
| メソッド | `POST` |
| Content-Type | `text/plain;charset=utf-8`(本文はJSON文字列。`application/json` でも動くが、ブラウザから送るときは事前確認が要らない `text/plain` を使う) |
| リダイレクト | Apps Script は 302 で別のURLへ転送して結果を返す。**リダイレクトを追う設定にする**(curl なら `-L`) |
| 文字コード | UTF-8 |

### 合言葉の扱い

- API用合言葉は同期用の合言葉とは別物です。**同期用の合言葉をURLに付けても、この API としては動きません**。また、API用合言葉を本文の `token` に入れても通りません。
- 合言葉は保管庫などに保存し、会話やログに書き出さないでください。漏れても、できるのは本の追加と Kindle+ の切り替えに限られます。
- 持ち主がスクリプト プロパティの `API_TOKEN` を消すと、すぐに使えなくなります。

---

## 2. 共通の決まり

- 本文は JSON オブジェクトで、**キーは `addBook` か `setKindlePlus` のどちらか1つだけ**。ほかのキーが混ざると `unauthorized` になります。
- 応答は常に HTTP 200 の JSON です。成功・失敗は `ok` で見分けます。

```json
{ "ok": true, ... }
{ "ok": false, "error": "<エラーコード>" }
```

### Kindle+ の状態の値

| 送る値(どちらでも可) | 意味 | 表とアプリでの表示 |
|---|---|---|
| `"対象"` / `"yes"` | 読み放題の対象だった | 対象 |
| `"対象外"` / `"no"` | Kindle版はあるが読み放題ではない | 対象外 |
| `"Kindle版なし"` / `"none"` | Kindle版がない | Kindle版なし |
| `"調べる"` / `"check"` | これから確かめる印 | 調べる |
| `""` または `null` | 記録を消す(未確認に戻す) | (空) |

応答の `kindlePlus` は日本語の表示(上の右の列)で返ります。記録した日時は自動で残ります。

---

## 3. addBook — 本を追加する

### リクエスト

```json
{
  "addBook": {
    "title": "動的平衡",
    "author": "福岡伸一",
    "isbn13": "9784334037437",
    "itemId": null,
    "status": "want",
    "wantReason": "さくらのおすすめ。生命を流れとして見る視点",
    "kindlePlus": "調べる",
    "publisher": "木楽舎",
    "year": "2009",
    "source": "sakura"
  }
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `title` | string | ○ | 書名 |
| `author` | string | | 著者。複数なら「、」区切り |
| `isbn13` | string | | ISBN。13桁でも10桁でもよく、ハイフン可。10桁は13桁に直す。チェックディジットが合わなければ無視(ISBNなしとして扱う) |
| `isbn` | string | | `isbn13` の別名 |
| `itemId` | string | | Amazon の ASIN(Kindle版なら `B` で始まる10文字)。`B` で始まると媒体が電子書籍になる |
| `asin` | string | | `itemId` の別名 |
| `status` | string | | `want`(読みたい、既定)/ `reading`(読書中)/ `done`(読了。読了日は今日)/ `stopped`(中断)。ほかの値は `want` |
| `wantReason` | string | | 読みたい理由・きっかけ。本の詳細に「きっかけ」として出る |
| `kindlePlus` | string | | 上の「Kindle+ の状態の値」 |
| `publisher` | string | | 出版社 |
| `year` | string | | 刊行年 |
| `source` | string | | 送り手の名前(既定 `api`)。記録用 |

書影・概要・件名はアプリが表示するときに ISBN などから自動で探すので、送る必要はありません。**ISBN を付けると書影や図書館の確認が効く**ので、分かるなら付けてください。

### 重複の扱い

すでに同じ本があれば追加しません。判定は次の順です(削除済みの本は数えない)。

1. `isbn13` が同じ
2. `itemId` が同じ(大文字小文字は無視)
3. `isbn13` も `itemId` も送らなかったときだけ、書名が同じ(空白・全角半角・大文字小文字を無視)

重複していて `kindlePlus` を送った場合は、その本の Kindle+ だけを切り替えます。

### 応答

```json
{ "ok": true, "id": "mh3k2x9abc12", "title": "動的平衡", "existed": false, "kindlePlus": "調べる" }
```

| フィールド | 説明 |
|---|---|
| `id` | 本の id。`setKindlePlus` で使える |
| `existed` | `true` なら既にあった本(新しくは作っていない) |
| `kindlePlus` | 記録後の状態(日本語)。未記録なら `""` |

---

## 4. setKindlePlus — Kindle+ の記録を切り替える

### リクエスト

```json
{ "setKindlePlus": { "isbn13": "9784334037437", "status": "対象" } }
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `status` | string \| null | ○ | 上の「Kindle+ の状態の値」。`kindlePlus` という名前でも可 |
| `id` | string | どれか1つ以上 | 本の id(`addBook` の応答の `id`) |
| `isbn13` / `isbn` | string | 〃 | ISBN(10桁可) |
| `itemId` / `asin` | string | 〃 | ASIN |
| `title` | string | 〃 | 書名(空白・全角半角・大文字小文字を無視した完全一致) |

本は **`id` → `isbn13` → `itemId` → `title`** の順に探し、最初に見つかった条件の結果を使います。確実に1冊を指すため、分かるなら `id` か `isbn13` を使ってください。

### 応答

```json
{ "ok": true, "id": "mh3k2x9abc12", "title": "動的平衡", "kindlePlus": "対象" }
```

同じ書名が2冊以上あるとき:

```json
{ "ok": false, "error": "ambiguous", "candidates": [ { "id": "…", "title": "同名", "author": "…" }, … ] }
```

候補(最大10件)から選んで、`id` を付けて送り直してください。

---

## 5. エラーコード

| `error` | 起きるとき | 直し方 |
|---|---|---|
| `unauthorized` | 合言葉が違う・URLに付いていない・API用合言葉が止められている・本文に `addBook` / `setKindlePlus` 以外のキーがある(本文の `token` を含む) | 合言葉とURLを確かめ、本文はキー1つにする |
| `bad json` | 本文がJSONオブジェクトでない | JSONを直す |
| `bad request` | `addBook` / `setKindlePlus` の中身がオブジェクトでない | オブジェクトにする |
| `title required` | `addBook` に `title` がない | 書名を入れる |
| `bad kindlePlus` | `addBook` の `kindlePlus` が知らない値 | 上の表の値にする |
| `bad status` | `setKindlePlus` の `status` が知らない値 | 上の表の値にする |
| `not found` | 条件に合う本がない | 書名の表記を変えるか、`addBook` で先に追加する |
| `ambiguous` | 書名が同じ本が2冊以上 | `candidates` の `id` で送り直す |

応答が JSON でなく HTML が返るときは、URL が `/exec` で終わっていないか、デプロイの「アクセスできるユーザー」が「全員」になっていません(持ち主に伝えてください)。

---

## 6. 例

### curl

```sh
HUB='https://script.google.com/macros/s/XXXX/exec'
KEY='<API用合言葉>'

# 本を「読みたい」に追加し、Kindle+ は「調べる」にしておく(ISBNが分からなければ書名と著者だけでよい)
curl -sL -H 'Content-Type: text/plain;charset=utf-8' "$HUB?token=$KEY" \
  -d '{"addBook":{"title":"時砂の王","author":"小川一水","kindlePlus":"調べる"}}'

# 確かめた結果を記録する
curl -sL -H 'Content-Type: text/plain;charset=utf-8' "$HUB?token=$KEY" \
  -d '{"setKindlePlus":{"title":"時砂の王","status":"対象"}}'
```

### JavaScript(fetch)

```js
async function readingHub(body) {
  const res = await fetch(`${HUB}?token=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data;
}
await readingHub({ addBook: { title: '動的平衡', author: '福岡伸一', isbn13: '9784334037437' } });
await readingHub({ setKindlePlus: { title: '動的平衡', status: 'no' } });
```

### Python(requests)

```python
import json, requests
r = requests.post(f"{HUB}?token={KEY}",
                  data=json.dumps({"setKindlePlus": {"isbn13": "9784334037437", "status": "check"}}, ensure_ascii=False).encode("utf-8"),
                  headers={"Content-Type": "text/plain;charset=utf-8"})  # requests はリダイレクトを追う
print(r.json())
```

---

## 7. AI が使うときの指針

- **Kindle+ の判定を推測で「対象」にしないでください。** 対象かどうかは時期で入れ替わり、Amazon には無料で調べる公開APIがありません。確かめていない本は `"調べる"` にしておくと、持ち主がアプリの一覧で「Kindle+ 調べる」に絞って、まとめて確かめられます。
- 本を勧めて追加するときは、`wantReason` に「なぜ勧めたか」を一文で入れてください。持ち主があとで読む理由を思い出せます。
- ISBN が分からないときは書名と著者だけで構いません。ISBN を推測で作らないでください(誤った ISBN は別の本の書影を出します)。
- 1回の呼び出しで本は1冊です。何冊も追加するときは、1冊ずつ順に送ってください(同時に送っても順番に処理されますが、1回あたり数秒かかります)。
- 反映は、持ち主がアプリを次に開いたときの同期です。追加直後にアプリに出ていなくても失敗ではありません。

---

## 8. 表への書き込み(参考)

追加・切り替えた本は、スプレッドシートの `books` シートに1行で入ります。`kindlePlus` 列(対象 / 対象外 / Kindle版なし / 調べる)と `kindlePlusAt` 列(記録した日 `yyyy-mm-dd`)で、ほかの Apps Script からも Kindle+ の状態を読めます。列の約束は [hub/README.md](../hub/README.md) の「ほかのアプリが読んでいる列」を見てください。
