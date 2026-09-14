import { chromium, type Browser, type BrowserContext } from "playwright";
import type { AppConfig } from "./config.js";
import type { ConsultationEvent } from "./googleCalendar.js";

/**
 * POODLE (https://poodle.race.co.jp) の「定例相談会」モーダルを操作して
 * 実施報告を登録するクラス。
 *
 * ⚠️ 未実装: 下記メソッド内のセレクタ・操作手順はすべてプレースホルダー。
 * Playwright codegen (`npx playwright codegen https://poodle.race.co.jp`) で
 * 実際の画面を操作しながらセレクタを確定させること。
 *   npm install
 *   npx playwright install chromium
 *   npx playwright codegen --save-storage=secrets/poodle-storage-state.json https://poodle.race.co.jp
 */

export interface RegistrationInput {
  event: ConsultationEvent;
  /** マッチング済みのPOODLE側企業名（表記ゆれ解消後） */
  poodleCompanyName: string;
  trainerName: string;
}

export class PoodleAlreadyRegisteredError extends Error {}
export class PoodleCompanyNotFoundError extends Error {}
export class PoodleModalElementNotFoundError extends Error {}

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
   * 企業名でPOODLEの案件を検索し、リスキリング契約詳細ページへ遷移する。
   * 【要確認】TSRコード検索 vs 企業名検索のどちらを使うか、検索結果が複数
   * ヒットした場合の絞り込み方法。
   */
  private async navigateToCompanyDetail(companyName: string): Promise<void> {
    if (!this.context) throw new Error("open() を先に呼び出してください");
    const page = await this.context.newPage();
    await page.goto(this.config.poodle.baseUrl);

    // TODO(要確認): 実際の案件検索UIのセレクタに置き換える
    // await page.fill('[data-testid="company-search-input"]', companyName);
    // await page.click('[data-testid="company-search-submit"]');
    // const resultLink = page.getByRole("link", { name: companyName });
    // await resultLink.click();

    throw new PoodleModalElementNotFoundError(
      `未実装: navigateToCompanyDetail("${companyName}") のセレクタが未確定です。` +
        " Playwright codegen で実画面を確認してから実装してください。",
    );
  }

  /** 「定例相談会」モーダルを開く */
  private async openConsultationModal(): Promise<void> {
    // TODO(要確認): モーダルを開くボタンのセレクタ
    // await page.click('[data-testid="open-teikirei-soudankai-modal"]');
    throw new PoodleModalElementNotFoundError(
      "未実装: openConsultationModal() のセレクタが未確定です。",
    );
  }

  /**
   * すでに同じ相談会が「実施済み」で登録されているかを判定する。
   * 【要確認】判定に使う実際のDOM（一覧の実施状況列 or モーダル内の既存値）。
   */
  private async isAlreadyRegistered(_event: ConsultationEvent): Promise<boolean> {
    return false;
  }

  /**
   * フェーズ1 MVP: 日付・開始/終了時刻・実施状況（実施済み）・対応トレーナーを入力して保存する。
   * 出席者・同席者は自動入力しない（手動確認のまま）。
   */
  async registerConsultation(input: RegistrationInput): Promise<void> {
    await this.navigateToCompanyDetail(input.poodleCompanyName);
    await this.openConsultationModal();

    if (await this.isAlreadyRegistered(input.event)) {
      throw new PoodleAlreadyRegisteredError(
        `${input.poodleCompanyName} の ${input.event.startTime.toISOString()} は既に登録済みのためスキップします。`,
      );
    }

    // TODO(要確認): 以下、実際のフォーム要素セレクタに置き換える
    // await page.fill('[data-testid="date-input"]', formatDate(input.event.startTime));
    // await page.fill('[data-testid="start-time-input"]', formatTime(input.event.startTime));
    // await page.fill('[data-testid="end-time-input"]', formatTime(input.event.endTime));
    // await page.selectOption('[data-testid="trainer-select"]', { label: input.trainerName });
    // await page.check('[data-testid="status-implemented-radio"]');
    // await page.click('[data-testid="save-button"]');

    throw new PoodleModalElementNotFoundError(
      "未実装: registerConsultation() のフォーム入力・保存処理が未確定です。",
    );
  }
}
