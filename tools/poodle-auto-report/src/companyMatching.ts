import { readFile } from "node:fs/promises";

/**
 * カレンダー件名から抽出した企業名を、POODLE案件一覧の「企業名」検索欄に
 * そのまま投げる企業名に変換する。
 *
 * 実画面確認済み: POODLE案件一覧の「企業名」列の表記（例: "三進金属工業株式会社"
 * "中國工業株式会社" "株式会社トムズ" "株式会社日産サティオ高知"
 * "株式会社類設計室"）は、カレンダー件名から抽出した企業名と完全一致していた
 * （6件サンプルで確認、表記ゆれなし）。そのため基本方針は「企業名の完全一致検索」
 * とし、以下のように運用する:
 *   1. 手動マッピング表 (company-mapping.json) に完全一致するキーがあれば使う
 *      （表記ゆれが実運用で見つかった場合のみ追加するフォールバック）
 *   2. なければ生の企業名をそのままPOODLEの「企業名」検索欄に投げる
 *      （検索でヒットしない場合は PoodleCompanyNotFoundError を投げてログに残す）
 *
 * ※ カレンダー予定descriptionから取れる tsr.race.co.jp のページIDは、POODLEの
 * TSRコードとは別物と判明したため、企業の突合には使用しない
 * （src/googleCalendar.ts の tsrPageId のコメント参照）。
 */

export type CompanyMapping = Record<string, string>;

export async function loadCompanyMapping(
  path = "./config/company-mapping.json",
): Promise<CompanyMapping> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as CompanyMapping;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export function resolvePoodleCompanyName(
  companyNameRaw: string,
  mapping: CompanyMapping,
): string {
  return mapping[companyNameRaw] ?? companyNameRaw;
}
