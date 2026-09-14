// 初回のみ手動実行するスクリプト。
// ブラウザを起動して手動でGoogleアカウントによるSSOログインを行い、
// ログイン後のセッション(storageState)をファイルに保存する。
// 以降のバッチ実行 (npm run report) はこのファイルを再利用する。
//
// 使い方:
//   npm run login
//   → ブラウザが開くので https://poodle.race.co.jp でログインボタンを押し、
//     Googleアカウントで認証を完了させたのち、ターミナルでEnterを押す。
//
// 保存先 (secrets/poodle-storage-state.json) は .gitignore 済みだが、
// セッション情報を含む機密ファイルなので取り扱いに注意すること。

import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";

async function main() {
  const config = loadConfig();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.poodle.baseUrl);

  console.log(
    "ブラウザでPOODLEのログインボタンを押し、Googleアカウントでのログインを完了してください。",
  );
  console.log("完了したら、このターミナルでEnterキーを押してください。");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("");
  rl.close();

  await mkdir(dirname(config.poodle.storageStatePath), { recursive: true });
  await context.storageState({ path: config.poodle.storageStatePath });
  console.log(`セッションを保存しました: ${config.poodle.storageStatePath}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
