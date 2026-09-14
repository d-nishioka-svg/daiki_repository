import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./config.js";
import type { ConsultationEvent } from "./googleCalendar.js";

/**
 * POODLE (https://poodle.race.co.jp) の「定例相談会」実施報告を、ダッシュボードの
 * 「相談会(未報告)」一覧経由で登録するクラス。
 *
 * 実際の手作業フロー（ユーザーが毎回行っている操作）を踏襲する:
 *   1. `/home` → ダッシュボードの「相談会(未報告)」タブを開く
 *   2. 未報告一覧（列: 状況／実施日／TSRコード／企業名／対応者／参加者）から、
 *      対象のカレンダー予定に対応する行を「企業名＋実施日＋開始/終了時刻」で探す
 *   3. 見つかった行から「定例相談会」編集モーダルを開き、日付・開始・終了・
 *      対応トレーナー・相談会実施状況（実施済み）を入力して保存する
 *
 * 重要: POODLE側のレコード単位は「1回のセッション(日時)＝1レコード」であり、
 * 出席者が複数人（集団相談）でも同じレコード内でチェックボックス管理される
 * （受講者ごとに別レコードにはならない、実画面で確認済み）。よってカレンダー
 * イベント1件に対して行う登録処理も1回で良い（出席者チェックはフェーズ1では
 * 触らない＝既存の状態のまま）。
 *
 * 「未報告」一覧に該当行が見つからない場合は、過去に終了した相談会のみを対象と
 * している前提上、「既に報告済みでこの一覧から消えた」とみなしてスキップする
 * （= 重複登録防止の仕組みを兼ねる）。
 *
 * ⚠️ 未実装: 下記メソッド内のセレクタ・操作手順はすべてプレースホルダー。
 * Playwright codegen で実際の画面を操作しながらセレクタを確定させること。
 *   npm install
 *   npx playwright install chromium
 *   npx playwright codegen --save-storage=secrets/poodle-storage-state.json https://poodle.race.co.jp/home
 */

export interface RegistrationInput {
  event: ConsultationEvent;
  /** マッチング済みのPOODLE側企業名（表記ゆれ解消後） */
  poodleCompanyName: string;
  trainerName: string;
}

/** 「未報告」一覧から対象イベントに該当する行が見つからなかった（＝既に報告済みとみなしスキップ） */
export class PoodleAlreadyRegisteredError extends Error {}
export class PoodleCompanyNotFoundError extends Error {}
export class PoodleModalElementNotFoundError extends Error {}

function formatDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export class PoodleAutomation {
  private browser?: Browser;
  private context?: BrowserContext;

  constructor(private readonly config: AppConfig) {}

  async open(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      storageState: this.config.poodle.storageStatePath,
    });
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }

  /**
   * ダッシュボードの「相談会(未報告)」タブを開く。
   *
   * 実画面確認済み: `/home` のダッシュボードに
   * KOM(未設定)／KOM(未報告)／報告会(未設定)／報告会(未報告)／
   * 相談会(未設定)／**相談会(未報告)** のタブがある。
   *
   * 【要確認・未確定】タブ・一覧テーブルの実際のセレクタ。
   */
  private async openUnreportedConsultationsTab(): Promise<Page> {
    if (!this.context) throw new Error("open() を先に呼び出してください");
    const page = await this.context.newPage();
    await page.goto(`${this.config.poodle.baseUrl}/home`);

    // TODO(要確認): 「相談会(未報告)」タブの実際のセレクタに置き換える
    // await page.click('text=相談会(未報告)');

    return page;
  }

  /**
   * 「相談会(未報告)」一覧から、対象イベント(企業名＋実施日＋開始/終了時刻)に
   * 一致する行を探し、その行から編集モーダルを開く。
   *
   * マッチングキー: 企業名（完全一致） × 実施日（一致） × 開始/終了時刻（一致、
   * 同一企業が同日に複数セッションを持つケースがあるため必須）。
   *
   * 【要確認・未確定】
   *   - 一覧の各行の実際のセレクタ（テーブル行の識別方法）
   *   - 行から編集モーダルを開く方法（企業名リンク／行クリック／専用ボタン等）
   *   - 集団相談の場合、一覧の1行がどう表示されるか（未確認、README参照）
   *
   * @returns 該当行が見つかりモーダルを開けた場合 true、見つからなかった場合 false
   */
  private async openMatchingModal(page: Page, input: RegistrationInput): Promise<boolean> {
    const { event, poodleCompanyName } = input;

    // TODO(要確認): 一覧のパースと行マッチングの実装。イメージ:
    // const rows = await page.locator('table >> tr').all();
    // for (const row of rows) {
    //   const rowCompany = await row.locator('.company-name').innerText();
    //   const rowDate = await row.locator('.date').innerText(); // 例: "2026-09-10"
    //   if (rowCompany.trim() !== poodleCompanyName) continue;
    //   if (rowDate.trim() !== toIsoDate(event.startTime)) continue;
    //   await row.click(); // or row.locator('a').click()
    //   return true;
    // }
    // return false;

    throw new PoodleModalElementNotFoundError(
      `未実装: openMatchingModal("${poodleCompanyName}", ${event.startTime.toISOString()}) の` +
        " 一覧パース・行マッチング処理が未確定です。",
    );
  }

  /**
   * フェーズ1 MVP: 日付・開始/終了時刻・実施状況（実施済み）・対応トレーナーを入力して保存する。
   * 出席者（複数人の場合も含め既存のチェック状態）・同席者・開催形式・Zoom情報・
   * 備考は自動入力しない（手動確認のまま）。
   *
   * 「次回予定」セクションは恒久的に対象外（このツールでは自動化不可能）。
   * カレンダー予定はPOODLE登録時にPOODLEのZoom発行機能が自動生成するもので、
   * 逆方向（カレンダーから次回日程を読み取ってPOODLEに書く）は成立しない
   * ため。次回日程はトレーナー本人がその場で判断・入力する。
   */
  async registerConsultation(input: RegistrationInput): Promise<void> {
    const page = await this.openUnreportedConsultationsTab();

    const found = await this.openMatchingModal(page, input);
    if (!found) {
      throw new PoodleAlreadyRegisteredError(
        `${input.poodleCompanyName} の ${input.event.startTime.toISOString()} は` +
          " 「相談会(未報告)」一覧に見つからなかったため、既に報告済みとみなしスキップします。",
      );
    }

    // TODO(要確認): 以下、実際のフォーム要素セレクタに置き換える。
    // ラベルテキストは実画面で確認済みなので getByLabel が使える可能性が高いが、
    // 「次回予定」セクションに同名ラベルが重複して存在するため、スコープの
    // 絞り込み（例: 「次回予定」見出しより前の要素のみを対象にする）が必要。
    // await page.fill('input[type="date"]', formatDate(input.event.startTime));          // 日付
    // await page.fill('input[type="time"] >> nth=0', formatTime(input.event.startTime));  // 開始
    // await page.fill('input[type="time"] >> nth=1', formatTime(input.event.endTime));    // 終了
    // await page.selectOption('select', { label: input.trainerName });                    // 対応トレーナー
    // await page.getByLabel("実施済み", { exact: true }).check();                          // 相談会実施状況
    // await page.click('button:has-text("保存")');  // 保存ボタン(文言未確認)

    throw new PoodleModalElementNotFoundError(
      "未実装: registerConsultation() のフォーム入力・保存処理が未確定です。",
    );
  }
}
