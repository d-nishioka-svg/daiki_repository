import { google } from "googleapis";
import type { AppConfig } from "./config.js";

/**
 * POODLEのZOOM発行機能により自動生成される予定件名のパターン:
 *   ✉️【定例相談会】{企業名} {担当者名}様
 *
 * 【要確認】企業名の表記ゆれ（略称・株式会社の有無等）がPOODLE側の正式名称と
 * 一致するかは実物で確認が必要。一致しない場合は company-mapping.json のような
 * 手動マッピング表、またはあいまい検索での補完を検討する。
 */
const TEIKI_SOUDANKAI_TITLE_RE =
  /^✉️【定例相談会】(?<company>.+?)\s*(?<contact>\S+?)様\s*$/u;

export interface ConsultationEvent {
  eventId: string;
  companyNameRaw: string;
  contactName: string;
  startTime: Date;
  endTime: Date;
  rawSummary: string;
}

export function parseConsultationEventTitle(
  summary: string,
): { companyNameRaw: string; contactName: string } | null {
  const match = TEIKI_SOUDANKAI_TITLE_RE.exec(summary.trim());
  if (!match?.groups) return null;
  return {
    companyNameRaw: match.groups.company.trim(),
    contactName: match.groups.contact.trim(),
  };
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
      contactName: parsed.contactName,
      startTime: new Date(event.start.dateTime),
      endTime: new Date(event.end.dateTime),
      rawSummary: event.summary,
    });
  }

  return results;
}
