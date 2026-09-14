import { google } from "googleapis";
import type { AppConfig } from "./config.js";

/**
 * POODLEのZOOM発行機能により自動生成される予定件名のパターン:
 *   ✉️【定例相談会】{企業名} {担当者名}様
 *   ✉️【定例相談会】{企業名} {担当者名1}様, {担当者名2}様, ...
 *     (集団相談の場合、受講者が複数カンマ区切りで並ぶ)
 *
 * 実データ確認済み: 企業名には内部スペースを含まない
 * （例: "株式会社類設計室", "中國工業株式会社", "株式会社日産サティオ高知"）。
 * そのため「件名の先頭の空白区切りトークン＝企業名、残りはカンマ区切りの
 * 受講者名リスト」という単純な分割で安定して取れる。
 */
const TITLE_PREFIX = "✉️【定例相談会】";

export interface ConsultationEvent {
  eventId: string;
  companyNameRaw: string;
  /** 集団相談の場合は複数名になる */
  attendeeNames: string[];
  /**
   * カレンダー予定の説明欄に含まれる「企業情報」リンク(tsr.race.co.jp/pdf.php?id=NNN)
   * から抽出したID。
   *
   * ⚠️ 実画面で確認した結果、これは tsr.race.co.jp というページの内部ID
   * （DBの行番号的なもの）であり、POODLE案件一覧の「TSRコード」列の値
   * （例: 570514894）とは別物と判明した。そのままではPOODLE側のTSRコード検索
   * には使えない。
   * （tsr.race.co.jp/pdf.php?id=X のページ内「企業コード」欄をスクレイピングすれば
   * 真のTSRコードは取得できるが、認証要否や安定性が未確認のため現時点では未使用。
   * 企業名の完全一致検索で十分なことが確認できたため、当面このフィールドは
   * 使わない。将来的な参考情報として保持のみ。）
   */
  tsrPageId: string | null;
  startTime: Date;
  endTime: Date;
  rawSummary: string;
}

export function parseConsultationEventTitle(
  summary: string,
): { companyNameRaw: string; attendeeNames: string[] } | null {
  const trimmed = summary.trim();
  if (!trimmed.startsWith(TITLE_PREFIX)) return null;

  const rest = trimmed.slice(TITLE_PREFIX.length).trim();
  const firstSpaceIdx = rest.search(/\s/u);
  if (firstSpaceIdx === -1) return null; // 企業名しかない不正な件名は無視

  const companyNameRaw = rest.slice(0, firstSpaceIdx).trim();
  const namesPart = rest.slice(firstSpaceIdx + 1).trim();

  const attendeeNames = namesPart
    .split(",")
    .map((n) => n.trim().replace(/様$/u, "").trim())
    .filter((n) => n.length > 0);

  if (!companyNameRaw || attendeeNames.length === 0) return null;

  return { companyNameRaw, attendeeNames };
}

const TSR_PAGE_ID_RE = /tsr\.race\.co\.jp\/pdf\.php\?id=(\d+)/u;

/** tsr.race.co.jp のページ内部IDを抽出する（POODLEのTSRコードとは別物。上記コメント参照） */
export function extractTsrPageId(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = TSR_PAGE_ID_RE.exec(description);
  return match ? match[1] : null;
}

export interface FetchOptions {
  /** この日時以降に開始・終了した予定のみを対象にする（例: 「終わった相談会」だけ拾う） */
  timeMin: Date;
  timeMax: Date;
}

export async function fetchConsultationEvents(
  config: AppConfig,
  options: FetchOptions,
): Promise<ConsultationEvent[]> {
  const oauth2Client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
  );
  oauth2Client.setCredentials({ refresh_token: config.google.refreshToken });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const res = await calendar.events.list({
    calendarId: config.google.calendarId,
    timeMin: options.timeMin.toISOString(),
    timeMax: options.timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 2500,
  });

  const events = res.data.items ?? [];
  const results: ConsultationEvent[] = [];

  for (const event of events) {
    if (!event.summary || !event.start?.dateTime || !event.end?.dateTime) {
      continue;
    }
    const parsed = parseConsultationEventTitle(event.summary);
    if (!parsed) continue;

    results.push({
      eventId: event.id ?? "",
      companyNameRaw: parsed.companyNameRaw,
      attendeeNames: parsed.attendeeNames,
      tsrPageId: extractTsrPageId(event.description),
      startTime: new Date(event.start.dateTime),
      endTime: new Date(event.end.dateTime),
      rawSummary: event.summary,
    });
  }

  return results;
}
