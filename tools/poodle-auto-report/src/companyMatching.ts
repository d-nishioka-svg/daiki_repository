import { readFile } from "node:fs/promises";

/**
 * カレンダー件名から抽出した企業名（表記ゆれあり得る）を
 * POODLE側の正式企業名に変換する。
 *
 * 【要確認】実際に表記ゆれが発生するかどうか、発生する場合どの程度か。
 * ひとまず以下の方針:
 *   1. 手動マッピング表 (company-mapping.json) に完全一致するキーがあれば使う
 *   2. なければ生の企業名をそのまま返し、POODLE側の検索に委ねる
 *      （検索でヒットしない場合は PoodleCompanyNotFoundError を投げてログに残す）
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
