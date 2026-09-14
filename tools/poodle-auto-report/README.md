# POODLE 定例相談会 自動登録ツール（フェーズ1 MVP）

Googleカレンダーの「リスキリング定例相談会」予定をもとに、社内システム POODLE
(`https://poodle.race.co.jp`) の「定例相談会」実施報告を自動入力するツール。

> ⚠️ このディレクトリはレイスグループ社内の営業機密（POODLE・社内ポータルの
> 仕様）を含む可能性があります。社外と共有しないでください。

## 現在のステータス：スケルトンのみ・未実装

このツールはまだ**動作しません**。POODLEの「定例相談会」モーダルの実際のDOM構造
（要素セレクタ）が未確認のため、`src/poodleAutomation.ts` の要素操作部分は
プレースホルダーになっています。着手にあたり、下記「要確認事項」を実物を見ながら
一緒に詰める必要があります。

## スコープ（フェーズ1 MVP）

自動入力する項目:
- 日付
- 開始時刻／終了時刻
- 相談会実施状況 → 「実施済み」固定
- 対応トレーナー → 固定値（本人1名のみのため、プルダウンで固定選択）

自動化しない項目（フェーズ2以降）:
- 出席者（受講者ごとの出欠チェック）— 別途「受講者管理アプリ」との連携調査が必要
- 同席者（任意項目のため手動のままでよい）

## 要確認事項（実装前に実物で確認する）

1. **カレンダー件名と企業名の突合**
   - Googleカレンダーの予定件名 `✉️【定例相談会】{企業名} {担当者名}様` から
     抽出した企業名が、POODLE側（TSRコード紐づけの正式企業名）と完全一致するか。
   - 一致しない場合、あいまい検索 or 手動マッピング表（`config/company-mapping.json`
     のようなファイルを想定）のどちらで対応するか。
2. **POODLEログインとセッション再利用**
   - 社内GoogleアカウントのSSOログイン後の storage state (Cookie/セッション) を
     Playwright の `storageState` として保存し、以降のバッチ実行で再利用する方式で
     問題ないか。初回のみ手動ログインが必要。
3. **定例相談会モーダルの実際のDOM構造**
   - 案件検索 → リスキリング契約詳細ページ → 「定例相談会」モーダルを開き、
     Playwright codegen (`npx playwright codegen https://poodle.race.co.jp`) で
     実際のセレクタ（日付入力、開始/終了時刻、対応トレーナーのプルダウン、
     実施状況のラジオボタン、保存ボタン等）を記録する。
4. **重複登録防止の判定方法**
   - 「すでに実施済みとして登録済みか」をPOODLE側のどの表示（一覧の実施状況列、
     モーダルを開いた時の既存値など）で判定するか。
5. **受講者管理アプリ（フェーズ2）**
   - 実体（Webアプリ／スプレッドシート／GAS等）、データ構造、API/エクスポート手段の
     ヒアリングが必要。

## セットアップ（予定）

```bash
cd tools/poodle-auto-report
npm install
npx playwright install chromium
cp .env.example .env   # 値を埋める。.env はコミットしないこと
```

### 環境変数（`.env`、コミット禁止）

| 変数名 | 内容 |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google Calendar API 用 OAuthクライアント（個人カレンダーのためサービスアカウントではなくOAuth） |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | 初回認可後に取得したリフレッシュトークン |
| `GOOGLE_CALENDAR_ID` | 対象カレンダーID（通常は `primary`） |
| `POODLE_BASE_URL` | `https://poodle.race.co.jp` |
| `POODLE_STORAGE_STATE_PATH` | Playwright storageState の保存先（例: `./secrets/poodle-storage-state.json`、要 .gitignore） |
| `TRAINER_NAME` | 対応トレーナーとして選択する固定値（自分の氏名） |

初回のみ以下のような手動ログイン用スクリプトを別途用意し、Googleアカウントで
SSOログインした状態の storageState を保存する想定（未実装）。

```bash
npm run login   # ブラウザが開くので手動でGoogleログイン → storageState を保存
```

### 実行（ドライラン必須）

```bash
npm run report -- --dry-run   # 初回は必ずドライラン
npm run report                # 実際にPOODLEへ書き込む
```

ドライランでは、実際にPOODLEを操作する直前の「どの予定を／どの企業の／どの値で
登録しようとしているか」をコンソールとログファイルに出力し、書き込みは行わない。

## ログと機密情報の扱い

- ログ (`logs/`) には日時・対象企業名・登録した日付/時刻のみを記録し、受講者の
  個人情報や契約金額等の機密情報は書き込まない方針とする。
- `logs/` と `secrets/`（storageStateやトークンの保存先）は `.gitignore` 済み。

## 今後の進め方

1. 上記「要確認事項」を実物を見ながら確定する。
2. `src/googleCalendar.ts` の実装を確定仕様に合わせて完成させる。
3. `src/poodleAutomation.ts` を Playwright codegen で得たセレクタで実装する。
4. ドライランで動作確認 → 実運用（Windowsタスクスケジューラ等でスケジュール実行）。
5. フェーズ2（受講者管理アプリ連携による出席者自動チェック）に着手する。
