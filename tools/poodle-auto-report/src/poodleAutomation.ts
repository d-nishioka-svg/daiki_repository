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
   * 企業名でPOODLEの案件一覧を検索し、リスキリング契約詳細ページへ遷移する。
   *
   * 実画面確認済み: `/home` からデフォルトで表示される「案件一覧」画面に、
   * 契約開始日(範囲)・契約終了日(範囲)・TSRコード・**企業名**（テキスト入力）・
   * 契約状況（プルダウン）・DR（プルダウン）のフィルタと「検索」ボタンがある。
   * 検索結果テーブルの「企業名」列がリンクになっており、クリックすると
   * リスキリング契約詳細ページに遷移する。
   *
   * 企業名は完全一致で問題ない（company-mapping解決後の名前をそのまま入力する
   * 想定。src/companyMatching.ts の実データ検証コメント参照）。
   *
   * 【要確認・未確定】各入力欄・ボタン・結果リンクの実際のセレクタ
   * （data-testid の有無、id/class名など）。Playwright codegen で記録すること:
   *   npx playwright codegen --save-storage=secrets/poodle-storage-state.json \
   *     https://poodle.race.co.jp/home
   */
  private async navigateToCompanyDetail(companyName: string): Promise<void> {
    if (!this.context) throw new Error("open() を先に呼び出してください");
    const page = await this.context.newPage();
    await page.goto(`${this.config.poodle.baseUrl}/home`);

    // TODO(要確認): 実際の「企業名」入力欄・検索ボタン・結果リンクのセレクタに置き換える
    // await page.fill('input[name="companyName"]', companyName); // 案件一覧の「企業名」欄
    // await page.click('button:has-text("検索")');
    // const resultLink = page.getByRole("link", { name: companyName, exact: true });
    // if ((await resultLink.count()) === 0) {
    //   throw new PoodleCompanyNotFoundError(`企業名 "${companyName}" がPOODLE案件一覧でヒットしませんでした。`);
    // }
    // await resultLink.first().click();

    throw new PoodleModalElementNotFoundError(
      `未実装: navigateToCompanyDetail("${companyName}") のセレクタが未確定です。` +
        " Playwright codegen で実画面を確認してから実装してください。",
    );
  }

  /**
   * 「定例相談会」モーダルを開く。
   *
   * 実画面確認済み: モーダル内の構成は以下の通り（上から）。
   *   - 企業名（表示のみ、編集不可）
   *   - 日付 [必須]（date input）
   *   - 開始／終了 [必須]（time input）
   *   - 出席者 [必須]（氏名・テックタウンID・案件番号・契約期間・チェックボックス
   *     の一覧テーブル。フェーズ1では自動入力しない）
   *   - 対応トレーナー [必須]（プルダウン）
   *   - 同席者 [任意]（プルダウン＋「＋追加」リンク）
   *   - 相談会実施状況 [必須]（ラジオ: 未実施／実施済み。デフォルトは未実施）
   *   - 開催形式 [必須]（ラジオ: Zoom／対面）、採番ID／ミーティングURL／ID／
   *     パスコード（既存のZoom情報が入っている想定、フェーズ1では触らない）
   *   - 備考／顧客の声 [任意]（textarea、フェーズ1では触らない）
   *   - 「次回予定」セクション（次回の日付/開始/終了/開催形式等の事前登録用。
   *     上記と同じラベルが重複して存在するため、Playwright実装では
   *     「次回予定」セクションの手前までにスコープを絞って要素を取得すること）
   *
   * 【要確認・未確定】
   *   - このモーダルをどう開くか（契約詳細ページ上のボタン/リンクのセレクタ、
   *     および「今回対象にしたい特定の日時の相談会」をどう指定して開くか。
   *     複数回分の実施履歴がある場合、一覧から該当行を選ぶ方式なのか等）。
   */
  private async openConsultationModal(_event: ConsultationEvent): Promise<void> {
    // TODO(要確認): モーダルを開くボタン/リンクのセレクタ、対象行の指定方法
    // await page.click('[data-testid="open-teikirei-soudankai-modal"]');
    throw new PoodleModalElementNotFoundError(
      "未実装: openConsultationModal() のセレクタ・対象特定方法が未確定です。",
    );
  }

  /**
   * すでに同じ相談会が「実施済み」で登録されているかを判定する。
   *
   * 実画面確認済み: モーダル内「相談会実施状況」ラジオの現在値がそのまま
   * 登録済み判定に使えそうである（開いた時点で既に「実施済み」が選択されて
   * いれば、その回はすでに報告登録済みとみなせる）。
   *
   * 【要確認・未確定】上記の openConsultationModal() で「対象の日時の相談会」を
   * 正しく開けることが前提。複数回分の履歴がある場合にどの回を見ているかが
   * 確定していないと、この判定も誤る可能性がある。
   */
  private async isAlreadyRegistered(_event: ConsultationEvent): Promise<boolean> {
    // TODO(要確認): 実際のラジオボタンのセレクタに置き換える
    // const implementedRadio = page.getByLabel("実施済み", { exact: true });
    // return await implementedRadio.isChecked();
    return false;
  }

  /**
   * フェーズ1 MVP: 日付・開始/終了時刻・実施状況（実施済み）・対応トレーナーを入力して保存する。
   * 出席者・同席者・開催形式・Zoom情報・備考・次回予定は自動入力しない（手動確認のまま）。
   */
  async registerConsultation(input: RegistrationInput): Promise<void> {
    await this.navigateToCompanyDetail(input.poodleCompanyName);
    await this.openConsultationModal(input.event);

    if (await this.isAlreadyRegistered(input.event)) {
      throw new PoodleAlreadyRegisteredError(
        `${input.poodleCompanyName} の ${input.event.startTime.toISOString()} は既に登録済みのためスキップします。`,
      );
    }

    // TODO(要確認): 以下、実際のフォーム要素セレクタに置き換える。
    // ラベルテキストは実画面で確認済みなので getByLabel が使える可能性が高いが、
    // 「次回予定」セクションに同名ラベルが重複して存在するため、スコープの
    // 絞り込み（例: 「次回予定」見出しより前の要素のみを対象にする）が必要。
    // await page.fill('input[type="date"]', formatDate(input.event.startTime));       // 日付
    // await page.fill('input[type="time"] >> nth=0', formatTime(input.event.startTime)); // 開始
    // await page.fill('input[type="time"] >> nth=1', formatTime(input.event.endTime));   // 終了
    // await page.selectOption('select', { label: input.trainerName });                  // 対応トレーナー
    // await page.getByLabel("実施済み", { exact: true }).check();                        // 相談会実施状況
    // await page.click('button:has-text("保存")');  // 保存ボタン(文言未確認)

    throw new PoodleModalElementNotFoundError(
      "未実装: registerConsultation() のフォーム入力・保存処理が未確定です。",
    );
  }
}
