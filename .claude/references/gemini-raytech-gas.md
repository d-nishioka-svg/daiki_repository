# GAS から GeminiRaytech (Vertex AI) を呼ぶときの詰まりどころ

社内AI推進室のGASライブラリ **GeminiRaytech** 経由でVertex AIのGeminiを呼ぶときに、
実際に踏んだ問題と解決方法をまとめたもの。学習進捗ログのプロジェクトで丸1週間分ハマった内容。

## 基本情報

| 項目 | 値 |
|---|---|
| ライブラリ スクリプトID | `1SNn6G_ri9HwMu1jLLoA7ChZVVlS4Vk_LYwUNIWhvBvpYenikR1LrWKcW` |
| バージョン | 2 |
| 参照名(userSymbol) | `GeminiRaytech` |
| 主なメソッド | `generateText(prompt, modelId)` / `generateContent(requestBody, modelId)` |
| 動作確認済みモデルID | `gemini-3.6-flash` |

認証はライブラリ側が面倒を見るのでAPIキーの発行・保管は不要。ただし**呼び出し元スクリプトの
OAuthトークンに `https://www.googleapis.com/auth/cloud-platform` が乗っている必要がある**。
ここが全てのトラブルの根っこ。

---

## 最初にやること: スコープを推測せず実測する

`403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` は「トークンにスコープが乗っていない」としか言っておらず、
原因の候補が多すぎる。**推測で切り分けようとすると何往復もするので、まず実測する。**

以下をスクリプトに貼り、エディタから実行して実行ログを見る。

```javascript
/**
 * 権限調査用。エディタから実行し、実行ログを確認する。
 * アクセストークン自体はログに出さない(出力はスコープ名のみ)。
 */
function checkOAuthScopes() {
  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(ScriptApp.getOAuthToken()),
    { muteHttpExceptions: true }
  );
  var info = {};
  try {
    info = JSON.parse(res.getContentText()) || {};
  } catch (err) {
    Logger.log('tokeninfoの応答を解釈できませんでした (HTTP ' + res.getResponseCode() + '): ' + res.getContentText());
    return;
  }
  var scopes = String(info.scope || '').split(' ').filter(function (s) { return s; }).sort();
  Logger.log('===== このスクリプトのトークンが持つスコープ (' + scopes.length + '件) =====');
  for (var i = 0; i < scopes.length; i++) Logger.log('  ' + scopes[i]);
  Logger.log('cloud-platform を含むか: ' +
    (scopes.indexOf('https://www.googleapis.com/auth/cloud-platform') !== -1 ? 'はい' : 'いいえ'));
  Logger.log('アカウント: ' + (info.email || '(userinfo.emailスコープが無いため取得できず)'));
}
```

これで `cloud-platform: いいえ` と出れば、Vertex AI側ではなく**承認側の問題**だと即断できる。
逆に `はい` なのに403なら、組織側の利用許可(IAM)の問題。

> 関数名の末尾に `_` を付けると**エディタの実行関数プルダウンに出てこない**ので付けないこと。

---

## 症状別の対処

### 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT` — 承認が使い回されている ★最有力

**これが一番厄介で、一番よく起きる。**

Apps Scriptは一度承認した内容を保存して再利用する。**あとから `appsscript.json` に
`cloud-platform` を足しても、保存済みの承認がそのまま使われて再承認が走らない。**
結果、マニフェストには書いてあるのにトークンには乗らない、という状態になる。

見分け方: **実行しても承認ポップアップが出ず、1秒で403になる。**

対処: **まだ一度も承認していないスコープを1つ足して、再承認を強制する。**

```json
"oauthScopes": [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/script.container.ui",
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email"   ← これを足すと必ず再承認になる
]
```

保存 → **エディタをリロード** → 関数を実行 → 承認画面が出るので**全チェックをONにして承認**。
このとき `cloud-platform` も一緒に付与される。

`userinfo.email` は害が無く、`checkOAuthScopes` でアカウント名が出るようになるので入れっぱなしでよい。

別の手として https://myaccount.google.com/connections から該当アプリのアクセスを削除しても
再承認できるが、アプリ名で探しにくいことがあるので上の方法のほうが確実。

### 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT` — 組織側の利用許可が未了

`checkOAuthScopes` で `cloud-platform: はい` なのに403が出る場合はこちら。

**AI推進室(AIチーム)への利用申請**が必要。一般的な情報システム部の窓口に投げると、
「GeminiRaytechの利用権限(AI推進室が管理する `aiplatform.googleapis.com` へのアクセス)」だと
明示しないと別件の権限を再付与されて解決しないことがある。
エラー文言の `reason: ACCESS_TOKEN_SCOPE_INSUFFICIENT` をそのまま伝えるとよい。

### 404 `Publisher model ... was not found`

権限ではなくモデルの問題。`generateText` / `generateContent` で **modelId を省略すると
ライブラリ既定のモデル**が使われるが、それが有効化されているとは限らない。

- 実測での既定モデルは `gemini-2.0-flash`(社内ドキュメント記載の `gemini-2.5-flash` とは違った)
- このモデルは有効化されておらず、必ず404になる

**modelIdは必ず明示的に渡すこと。** コード先頭で定数にしておくとよい:

```javascript
var GEMINI_MODEL_DEFAULT = 'gemini-3.6-flash';
```

有効なモデル名は https://cloud.google.com/vertex-ai/generative-ai/docs/models の
「Model ID」欄を直接確認する。**Google検索のAI概要は実在しないモデル名を出すことがあるので信用しない**
(実際に「Gemini 3.7 Flash」という存在しない名前を出された)。

### 「エディタでは動くのにWebアプリでは落ちる」

Webアプリ(`google.script.run`)からは**承認ポップアップを出せない**ので、権限が足りないと
黙って失敗する。エディタで先に一度実行して承認を済ませておくこと。

このパターンは以下のときに必ず起きるので注意:

- 新しいGoogleサービスをコードに足した(必要スコープが変わる)
- `appsscript.json` の `oauthScopes` を変えた

**新しいサービスを使う前に、既に使っているサービスで代用できないか考える。**
例: タイムゾーンは `Session.getScriptTimeZone()` ではなく `ss.getSpreadsheetTimeZone()` で取れる
(`SpreadsheetApp` のスコープは既に承認済みなので追加承認が要らない)。

### 関数が実行プルダウンに出てこない

**名前の末尾が `_` の関数はエディタの実行対象に出ない**(GASの仕様)。
手動実行したいテスト関数には `_` を付けないこと。

---

## デプロイまわりの罠

### `clasp push` だけでは本番に反映されない

`clasp push` が更新するのは **HEAD だけ**。`/exec` のWebアプリはバージョン固定のデプロイを
見ているので、別途デプロイし直す必要がある。

```bash
clasp push --force
clasp deployments                       # デプロイIDを確認
clasp deploy -i <deploymentId> -d "説明"  # ここまでやって初めて本番に反映
clasp deployments                       # @N が上がったことを確認
```

エディタからやる場合は「デプロイを管理」→ 鉛筆 → バージョンを「新バージョン」→「デプロイ」。
URLは変わらない。

### `clasp push` は `appsscript.json` も上書きする

**ローカルの `appsscript.json` が古いと、本番の `oauthScopes` やライブラリ設定を消してしまう。**
push前に必ず `clasp pull` して現状を確認すること。特に複数プロジェクトを扱っているときは危険。

### プロジェクトを取り違えていないか

複数のGASプロジェクトがあると、**コードだけコピーして別プロジェクトで動かしている**ことがある。
利用許可も権限承認も**プロジェクト単位**なので、動いているプロジェクトからコードをコピーしても403になる。

見分け方: **エラーログのスタックトレースの行番号**。

```
testGemini @ コード.gs:1653   ← この行番号が手元のファイルと一致するか確認する
```

行番号が合わなければ、別のコードを実行している。`clasp pull` して実際の中身を突き合わせる。

スクリプトIDはエディタURLの `/projects/<ここ>/edit`、または ⚙️ プロジェクトの設定 で確認できる。
どのスプレッドシートに紐付いているかは Apps Script API の `projects.get` の `parentId` でわかる。

---

## 切り分けフローまとめ

```
403 ACCESS_TOKEN_SCOPE_INSUFFICIENT が出た
  │
  ├─ まず checkOAuthScopes を実行して実測する
  │
  ├─ cloud-platform: いいえ
  │    │
  │    ├─ 実行時に承認ポップアップが出ない
  │    │    → 承認の使い回し。未承認スコープ(userinfo.email)を足して再承認を強制
  │    │
  │    └─ 承認ポップアップが出る
  │         → 全チェックONで承認するだけ
  │
  └─ cloud-platform: はい
       → 組織側の利用許可の問題。AI推進室へ申請
```

**推測で設定をいじる前に、必ず `checkOAuthScopes` で実測すること。**
今回は「oauthScopesの書き方が悪い」「GCPプロジェクトの紐付けが違う」と2回見立てを外し、
最終的に効いたのは「未承認スコープを1つ足して再承認を強制する」だった。
2つのプロジェクトで結果を比較できたのが決定打になったので、**動く環境が1つあるなら必ず比較する。**
