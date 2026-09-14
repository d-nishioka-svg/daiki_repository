import { loadConfig } from "./config.js";
import { fetchConsultationEvents } from "./googleCalendar.js";
import { loadCompanyMapping, resolvePoodleCompanyName } from "./companyMatching.js";
import {
  PoodleAutomation,
  PoodleAlreadyRegisteredError,
  PoodleCompanyNotFoundError,
  PoodleModalElementNotFoundError,
} from "./poodleAutomation.js";
import { logEvent } from "./logger.js";

/**
 * フェーズ1 MVP のエントリポイント。
 *
 * 実行例:
 *   npm run report -- --dry-run   # 書き込みなし、ログのみ
 *   npm run report                # 実際にPOODLEへ登録
 *
 * 対象期間はデフォルトで「過去7日間に終了した予定」。必要に応じて調整する。
 */

const args = process.argv.slice(2);
const cliDryRun = args.includes("--dry-run");

async function main() {
  const config = loadConfig();
  const dryRun = config.dryRun || cliDryRun;

  const now = new Date();
  const timeMin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const timeMax = now;

  await logEvent(
    `実行開始 (dryRun=${dryRun}) 対象期間: ${timeMin.toISOString()} 〜 ${timeMax.toISOString()}`,
  );

  const events = await fetchConsultationEvents(config, { timeMin, timeMax });
  await logEvent(`カレンダーから ${events.length} 件の定例相談会予定を検出`);

  const companyMapping = await loadCompanyMapping();

  const automation = dryRun ? null : new PoodleAutomation(config);
  if (automation) await automation.open();

  try {
    for (const event of events) {
      const poodleCompanyName = resolvePoodleCompanyName(
        event.companyNameRaw,
        companyMapping,
      );

      if (dryRun) {
        await logEvent(
          `[DRY-RUN] 登録予定: 企業="${poodleCompanyName}" ` +
            `日付=${event.startTime.toISOString().slice(0, 10)} ` +
            `開始=${event.startTime.toTimeString().slice(0, 5)} ` +
            `終了=${event.endTime.toTimeString().slice(0, 5)} ` +
            `対応トレーナー="${config.trainerName}" 実施状況=実施済み`,
        );
        continue;
      }

      try {
        await automation!.registerConsultation({
          event,
          poodleCompanyName,
          trainerName: config.trainerName,
        });
        await logEvent(
          `登録完了: 企業="${poodleCompanyName}" 日付=${event.startTime.toISOString().slice(0, 10)}`,
        );
      } catch (err) {
        if (err instanceof PoodleAlreadyRegisteredError) {
          await logEvent(`スキップ（登録済み）: 企業="${poodleCompanyName}" - ${err.message}`);
          continue;
        }
        if (err instanceof PoodleCompanyNotFoundError) {
          await logEvent(
            `エラー（企業未検出、処理停止）: 企業="${poodleCompanyName}" - ${err.message}`,
          );
          throw err;
        }
        if (err instanceof PoodleModalElementNotFoundError) {
          await logEvent(
            `エラー（画面要素未検出、処理停止）: 企業="${poodleCompanyName}" - ${err.message}`,
          );
          throw err;
        }
        throw err;
      }
    }
  } finally {
    if (automation) await automation.close();
  }

  await logEvent("実行終了");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
