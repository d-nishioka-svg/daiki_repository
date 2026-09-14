/**
 * 学習進捗管理スプレッドシート用 Apps Script
 *
 * 経緯:
 *   当初はWebアプリ(HTTP経由でClaudeから直接書き込む方式)を試みたが、
 *   1) Claude Code実行環境のネットワークポリシーでscript.google.comへの通信がブロックされる
 *   2) 会社のGoogle Workspaceポリシーで「全員(匿名)アクセス」のデプロイができない
 *   の2つが重なり、Claude側からの直接呼び出しは実質不可能だった。
 *
 *   そこでまず、スプレッドシートに直接メニューを追加し、Claudeが用意した記録文を
 *   シートの持ち主自身がメニューからワンクリックで書き込む方式(showAddEntryDialog)にした。
 *
 *   さらにその後、「VTTを投げるだけで要約〜書き込みまで自動化したい」という要望を受けて
 *   Webアプリ(doGet)を追加した。これは前述の2つの制約に抵触しない:
 *   - 呼び出す側がClaude(Code実行環境)ではなく、ユーザー自身のブラウザになるため、
 *     Claude Code実行環境のネットワークポリシーは関係ない
 *   - アクセスするのはこの組織のユーザー本人だけなので、デプロイ設定は
 *     「アクセスできるユーザー: 当社内の全員」で足りる(匿名アクセスは不要)
 *   要約自体は、GAS自身がGoogleのGemini APIを直接呼び出して生成する
 *   (UrlFetchAppはGoogle側のインフラで実行されるため、Claude Code実行環境の
 *   ネットワーク制限を受けない)。
 *
 * 前提とするシート構造:
 *   - 1つのスプレッドシートの中に、企業ごとのシート(タブ)がある
 *   - 各シートの1行目(ヘッダー行)、B列以降に受講者名が入っている(A列は使わない想定)
 *   - 各受講者列に、相談記録が上から下に積み上がっている
 *
 * さらにその後、「次回の相談会日程を一覧で見たい・他ツール(POODLE自動登録等)からも
 * 参照できるようにしたい」という要望を受けて、「次回日程一覧」管理シートと、
 * 記録追加時に次回日程を構造化入力できるフィールドを追加した。次回の日程は
 * 「【次回に向けて】」の自由記述の中に埋もれてしまい機械的に読み取れないため、
 * 自由記述とは別に「次回実施日／開始／終了」を明示的に入力してもらい、保存時に
 * 「次回日程一覧」シートへ自動反映(upsert)する。現時点では「1件ずつ」書き込み
 * モードのみ対応(複数VTT一括モードは対象外、書き込み後に個別に追記可能)。
 *
 * 使い方・導入手順は同じフォルダの DEPLOY.md を参照。
 */

// 集団相談用のグループ定義を保存する管理シートの名前。
// 企業(受講者)一覧には絶対に含めないこと(listStructure_側でも除外している)。
var GROUP_SHEET_NAME = 'グループ設定';

// 次回日程一覧を保存する管理シートの名前。
// 企業(受講者)一覧には絶対に含めないこと(listStructure_側でも除外している)。
var NEXT_SCHEDULE_SHEET_NAME = '次回日程一覧';

// 要約に使うGeminiのモデルID。
// GeminiRaytechはmodelIdを省略すると独自の既定モデルを使うが、それがこのプロジェクトで
// 有効化されているとは限らず、404 (Publisher model ... was not found) になる。実際に
// gemini-2.0-flash が使われて失敗したため、動作確認済みのモデルをコード側で明示する。
// 別のモデルに変えたい場合は、スクリプトプロパティ GEMINI_MODEL に設定すればそちらが優先される。
// 有効なモデルIDは https://cloud.google.com/vertex-ai/generative-ai/docs/models の
// 「Model ID」欄で確認すること。
var GEMINI_MODEL_DEFAULT = 'gemini-3.6-flash';

// ===== メニュー =====

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('学習進捗ログ')
    .addItem('記録を追加', 'showAddEntryDialog')
    .addToUi();
}

function showAddEntryDialog() {
  var html = HtmlService.createHtmlOutput(buildDialogHtml_())
    .setWidth(520)
    .setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, '学習進捗ログを追加');
}

// ダイアログ側のJavaScriptから呼ばれる。シート名・受講者名の一覧を返す。
function getStructureForDialog() {
  return listStructure_(SpreadsheetApp.getActiveSpreadsheet());
}

// ダイアログ側のJavaScriptから呼ばれる。entries: [{ sheetName, learner, text }, ...]
function submitEntries(entries) {
  return appendEntries_(SpreadsheetApp.getActiveSpreadsheet(), entries);
}

// ===== 構造の取得 =====

function listStructure_(ss) {
  var sheets = ss.getSheets();
  var out = [];
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    // グループ設定・次回日程一覧の管理シートは、企業(受講者)一覧には出さない
    if (sh.getName() === GROUP_SHEET_NAME || sh.getName() === NEXT_SCHEDULE_SHEET_NAME) continue;
    var lastCol = sh.getLastColumn();
    if (lastCol < 2) continue; // B列以降がないシートは対象外
    var headers = sh.getRange(1, 2, 1, lastCol - 1).getValues()[0];
    var learners = [];
    for (var c = 0; c < headers.length; c++) {
      var name = headers[c];
      if (name === '' || name === null) continue;
      learners.push({ learner: String(name) });
    }
    if (learners.length > 0) {
      out.push({ sheetName: sh.getName(), learners: learners });
    }
  }
  return out;
}

// ===== 企業・受講者の登録 =====

// Webアプリ側のJavaScriptから呼ばれる。新しい企業(シート)を作成する。
// 作成直後は受講者が0人のため、listStructure_の一覧にはまだ出てこない
// (呼び出し側で構造をローカルに補って表示する)。
function createCompany(companyName) {
  companyName = String(companyName || '').trim();
  if (!companyName) throw new Error('企業名を入力してください。');
  if (companyName === GROUP_SHEET_NAME || companyName === NEXT_SCHEDULE_SHEET_NAME) {
    throw new Error('この名前は管理用に予約されているため使用できません: ' + companyName);
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(companyName)) {
    throw new Error('同名のシートが既に存在します: ' + companyName);
  }
  ss.insertSheet(companyName);
  return { sheetName: companyName };
}

// Webアプリ側のJavaScriptから呼ばれる。受講者の有無に関わらず、全企業(シート)名を返す。
// (listStructure_は受講者0人のシートを一覧から除外するため、企業登録直後や受講者が
// まだ0人のシートを「受講者を登録」用のプルダウンに出すには、こちらを使う必要がある)
function getAllCompanyNames() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var names = [];
  for (var i = 0; i < sheets.length; i++) {
    var nm = sheets[i].getName();
    if (nm === GROUP_SHEET_NAME || nm === NEXT_SCHEDULE_SHEET_NAME) continue; // 管理シートは除外
    names.push(nm);
  }
  return names;
}

// Webアプリ側のJavaScriptから呼ばれる。既存の企業(シート)に受講者(列)を1人追加する。
function createLearner(sheetName, learnerName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  createLearnerOne_(ss, sheetName, learnerName);
  return listStructure_(ss);
}

// Webアプリ側のJavaScriptから呼ばれる。既存の企業(シート)に受講者(列)をまとめて追加する。
// 1人ずつ処理し、同名重複などで一部が失敗しても他の登録は続行する。
// learnerNames: string[]
function createLearners(sheetName, learnerNames) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var results = [];
  for (var i = 0; i < learnerNames.length; i++) {
    var name = String(learnerNames[i] || '').trim();
    if (!name) continue;
    try {
      createLearnerOne_(ss, sheetName, name);
      results.push({ learner: name, status: 'created' });
    } catch (err) {
      results.push({ learner: name, status: 'error', error: String((err && err.message) || err) });
    }
  }
  return { results: results, structure: listStructure_(ss) };
}

// createLearner / createLearners の共通処理。実際にシートへ列を1つ追加する。
function createLearnerOne_(ss, sheetName, learnerName) {
  learnerName = String(learnerName || '').trim();
  if (!learnerName) throw new Error('受講者名を入力してください。');
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('シートが見つかりません: ' + sheetName);
  if (findLearnerColumn_(sh, learnerName) !== -1) {
    throw new Error('同名の受講者が既に登録されています: ' + learnerName);
  }
  var lastCol = sh.getLastColumn();
  var targetCol = lastCol < 2 ? 2 : lastCol + 1; // A列は使わない想定なので最低でもB列から
  var cell = sh.getRange(1, targetCol);
  cell.setValue(learnerName);
  cell.setFontWeight('bold');
}

// ===== 書き込み =====

/**
 * entries: [{ sheetName, learner, text, nextDate, nextStart, nextEnd }, ...]
 * 集団相談の場合、ダイアログ側で同じ text を持つ行を複数追加して渡す。
 * nextDate/nextStart/nextEnd は任意(次回日程がまだ未確定の場合は空でよい)。
 * 指定があれば「次回日程一覧」シートにその受講者の次回予定としてupsertする。
 */
function appendEntries_(ss, entries) {
  var results = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    try {
      var sh = ss.getSheetByName(entry.sheetName);
      if (!sh) {
        results.push({ sheetName: entry.sheetName, learner: entry.learner, status: 'error', error: 'シートが見つかりません: ' + entry.sheetName });
        continue;
      }

      var colIndex = findLearnerColumn_(sh, entry.learner);
      if (colIndex === -1) {
        results.push({ sheetName: entry.sheetName, learner: entry.learner, status: 'error', error: '受講者列が見つかりません: ' + entry.learner });
        continue;
      }

      var lastRow = getLastUsedRow_(sh, colIndex);
      var targetRow = lastRow + 1;
      var cell = sh.getRange(targetRow, colIndex);
      cell.setValue(entry.text);
      cell.setWrap(true);
      cell.setVerticalAlignment('top');

      var result = {
        sheetName: entry.sheetName,
        learner: entry.learner,
        status: 'written',
        cell: cell.getA1Notation()
      };

      // 次回日程が入力されていれば「次回日程一覧」シートに反映する。
      // ここが失敗しても、本体の記録書き込み自体は成功しているので status は変えない。
      if (entry.nextDate) {
        try {
          var recordedDate = extractDate_(entry.text); // 本文冒頭の「📅 YYYY-MM-DD」を再利用
          upsertNextSchedule_(ss, entry.sheetName, entry.learner, entry.nextDate, entry.nextStart, entry.nextEnd, recordedDate);
          result.nextScheduleStatus = 'updated';
        } catch (nsErr) {
          result.nextScheduleStatus = 'error';
          result.nextScheduleError = String(nsErr);
        }
      }

      results.push(result);
    } catch (err) {
      results.push({ sheetName: entry.sheetName, learner: entry.learner, status: 'error', error: String(err) });
    }
  }
  return results;
}

function findLearnerColumn_(sheet, learnerName) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return -1; // 受講者が1人もいない(=列が無い)シートは対象外
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var c = 0; c < headers.length; c++) {
    if (String(headers[c]) === learnerName) return c + 1;
  }
  return -1;
}

function getLastUsedRow_(sheet, col) {
  var maxRows = sheet.getMaxRows();
  var values = sheet.getRange(1, col, maxRows, 1).getValues();
  var lastRow = 1; // ヘッダー行
  for (var r = 0; r < values.length; r++) {
    var v = values[r][0];
    if (v !== '' && v !== null) {
      lastRow = r + 1;
    }
  }
  return lastRow;
}

// ===== 次回日程一覧 =====
//
// 「次回日程一覧」という管理シートに、受講者1人につき1行(企業名+受講者名がキー)で
// 次回予定を保持する。同じ受講者について新しい次回予定が入力されたら、その行を
// 上書き(upsert)する。次回予定が確定していない状態に戻したい場合は、シートを
// 直接編集して行を削除するか、日付欄を空にする。
//
// 列: 企業名 / 受講者 / 次回日付 / 開始 / 終了 / 記録日(今回の相談日) / 更新日時

var NEXT_SCHEDULE_HEADERS = ['企業名', '受講者', '次回日付', '開始', '終了', '記録日(今回の相談日)', '更新日時'];

function getNextScheduleSheet_(ss, createIfMissing) {
  var sh = ss.getSheetByName(NEXT_SCHEDULE_SHEET_NAME);
  if (!sh && createIfMissing) {
    sh = ss.insertSheet(NEXT_SCHEDULE_SHEET_NAME);
    sh.getRange(1, 1, 1, NEXT_SCHEDULE_HEADERS.length).setValues([NEXT_SCHEDULE_HEADERS]);
    sh.getRange(1, 1, 1, NEXT_SCHEDULE_HEADERS.length).setFontWeight('bold');
  }
  return sh;
}

function findNextScheduleRow_(sh, sheetName, learner) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  var values = sh.getRange(2, 1, lastRow - 1, 2).getValues();
  for (var r = 0; r < values.length; r++) {
    if (String(values[r][0]) === sheetName && String(values[r][1]) === learner) {
      return r + 2; // シート上の実際の行番号(ヘッダー行+1オフセット)
    }
  }
  return -1;
}

/**
 * 次回日程を1件分upsertする(企業名+受講者名がキー)。
 * nextDate は 'YYYY-MM-DD' 形式の文字列を想定。
 */
function upsertNextSchedule_(ss, sheetName, learner, nextDate, nextStart, nextEnd, recordedDate) {
  var sh = getNextScheduleSheet_(ss, true);
  var rowIndex = findNextScheduleRow_(sh, sheetName, learner);
  var rowValues = [
    sheetName,
    learner,
    nextDate,
    nextStart || '',
    nextEnd || '',
    recordedDate || '',
    Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm')
  ];
  if (rowIndex === -1) {
    sh.getRange(sh.getLastRow() + 1, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sh.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
  }
}

// Webアプリ側のJavaScriptから呼ばれる。次回日程が登録されている受講者を、
// 次回日付の昇順で一覧にして返す(他ツールからスプレッドシート経由で参照する場合は
// 「次回日程一覧」シートを直接読めばよく、この関数はWebアプリ表示専用)。
function getNextScheduleList() {
  return getNextScheduleList_(SpreadsheetApp.getActiveSpreadsheet());
}

function getNextScheduleList_(ss) {
  var sh = getNextScheduleSheet_(ss, false);
  if (!sh) return [];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var values = sh.getRange(2, 1, lastRow - 1, NEXT_SCHEDULE_HEADERS.length).getValues();
  var tz = ss.getSpreadsheetTimeZone();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (!row[0] || !row[2]) continue; // 企業名または次回日付が空の行は無視
    out.push({
      sheetName: String(row[0]),
      learner: String(row[1]),
      nextDate: formatScheduleValue_(row[2], tz, 'yyyy-MM-dd'),
      nextStart: formatScheduleValue_(row[3], tz, 'HH:mm'),
      nextEnd: formatScheduleValue_(row[4], tz, 'HH:mm'),
      recordedDate: formatScheduleValue_(row[5], tz, 'yyyy-MM-dd'),
      updatedAt: formatScheduleValue_(row[6], tz, 'yyyy-MM-dd HH:mm')
    });
  }
  out.sort(function (a, b) {
    if (a.nextDate === b.nextDate) return 0;
    return a.nextDate < b.nextDate ? -1 : 1;
  });
  return out;
}

/**
 * 日付/時刻セルの値をシンプルな文字列に揃える。
 *
 * 'YYYY-MM-DD' や 'HH:mm' の文字列をsetValuesで書き込むとスプレッドシート側が日付/時刻値に
 * 自動変換するため、読み戻すとDate型になる。時刻セルは1899-12-30が基準日として付いてくるので、
 * 列ごとに出したい書式(pattern)を指定して整形する。
 *
 * タイムゾーンはスクリプト側ではなくスプレッドシートのものを使う。スクリプトのタイムゾーンを
 * 取るサービスを呼ぶと必要スコープが変わり、権限の再承認が必要になる場合があるため
 * (Webアプリからは承認ポップアップを出せないので「エディタでは動くがアプリでは落ちる」
 * 状態になる)。スプレッドシートのスコープは元々使っているので追加の承認が要らない。
 */
function formatScheduleValue_(v, tz, pattern) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, tz, pattern);
  }
  return v ? String(v) : '';
}

// ===== 進捗確認(閲覧) =====

// Webアプリ側のJavaScriptから呼ばれる。指定シートの各受講者の直近の記録を一覧で返す。
function getCompanyOverview(sheetName) {
  return getCompanyOverview_(SpreadsheetApp.getActiveSpreadsheet(), sheetName);
}

function getCompanyOverview_(ss, sheetName) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('シートが見つかりません: ' + sheetName);
  var lastCol = sh.getLastColumn();
  if (lastCol < 2) return [];
  var headers = sh.getRange(1, 2, 1, lastCol - 1).getValues()[0];
  var out = [];
  for (var c = 0; c < headers.length; c++) {
    var name = headers[c];
    if (name === '' || name === null) continue;
    var col = c + 2; // B列基準なので+2
    var lastRow = getLastUsedRow_(sh, col);
    var recordCount = Math.max(0, lastRow - 1); // ヘッダー行を除く件数
    var lastText = recordCount > 0 ? String(sh.getRange(lastRow, col).getValue()) : '';
    out.push({
      learner: String(name),
      recordCount: recordCount,
      lastDate: extractDate_(lastText),
      lastText: lastText
    });
  }
  return out;
}

// Webアプリ側のJavaScriptから呼ばれる。指定受講者の全記録を新しい順に返す。
function getLearnerHistory(sheetName, learner) {
  return getLearnerHistory_(SpreadsheetApp.getActiveSpreadsheet(), sheetName, learner);
}

function getLearnerHistory_(ss, sheetName, learner) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('シートが見つかりません: ' + sheetName);
  var col = findLearnerColumn_(sh, learner);
  if (col === -1) throw new Error('受講者列が見つかりません: ' + learner);
  var lastRow = getLastUsedRow_(sh, col);
  var records = [];
  for (var r = 2; r <= lastRow; r++) {
    var v = sh.getRange(r, col).getValue();
    if (v === '' || v === null) continue;
    records.push({ row: r, date: extractDate_(String(v)), text: String(v) });
  }
  records.reverse(); // 新しい記録を先頭に
  return records;
}

// 記録文の先頭にある「📅 YYYY-MM-DD」から日付だけ取り出す(見つからなければ空文字)
function extractDate_(text) {
  var m = /📅\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(text || '');
  return m ? m[1] : '';
}

// Webアプリ側のJavaScriptから呼ばれる。企業(シート)内の全受講者を横並びにした表形式データを返す。
// 行 = 各受講者にとっての「何回目の記録か」、列 = 受講者(スプレッドシートの列並びと同じ順)。
// 実際の日付を揃えるのではなく、各受講者ごとの記録の積み上がり順(1回目・2回目...)で揃える。
function getCompanyMatrix(sheetName) {
  return getCompanyMatrix_(SpreadsheetApp.getActiveSpreadsheet(), sheetName);
}

function getCompanyMatrix_(ss, sheetName) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('シートが見つかりません: ' + sheetName);
  var lastCol = sh.getLastColumn();
  if (lastCol < 2) return { learners: [], rows: [] };
  var headers = sh.getRange(1, 2, 1, lastCol - 1).getValues()[0];

  var learners = [];
  var perLearnerRecords = [];
  for (var c = 0; c < headers.length; c++) {
    var name = headers[c];
    if (name === '' || name === null) continue;
    var col = c + 2; // B列基準なので+2
    learners.push(String(name));

    var lastRow = getLastUsedRow_(sh, col);
    var records = [];
    if (lastRow >= 2) {
      var vals = sh.getRange(2, col, lastRow - 1, 1).getValues();
      for (var r = 0; r < vals.length; r++) {
        var v = vals[r][0];
        if (v !== '' && v !== null) records.push(String(v));
      }
    }
    perLearnerRecords.push(records);
  }

  var maxCount = 0;
  for (var i = 0; i < perLearnerRecords.length; i++) {
    if (perLearnerRecords[i].length > maxCount) maxCount = perLearnerRecords[i].length;
  }

  var rows = [];
  for (var n = 0; n < maxCount; n++) {
    var cells = perLearnerRecords.map(function (recs) {
      return n < recs.length ? recs[n] : null;
    });
    rows.push({ index: n + 1, cells: cells });
  }
  return { learners: learners, rows: rows };
}

// ===== グループ管理(集団相談用) =====
//
// 「グループ設定」という管理シートに、1グループ1行ではなく1メンバー1行の形式で保存する。
// 例:
//   グループ名          | 企業(シート)         | 受講者
//   合同研修グループA    | サンプル商事株式会社  | 鈴木花子
//   合同研修グループA    | テスト工業株式会社    | 佐藤次郎
// 同じグループ名の行をまとめると、そのグループのメンバー一覧になる。

function getGroupSheet_(ss, createIfMissing) {
  var sh = ss.getSheetByName(GROUP_SHEET_NAME);
  if (!sh && createIfMissing) {
    sh = ss.insertSheet(GROUP_SHEET_NAME);
    sh.getRange(1, 1, 1, 3).setValues([['グループ名', '企業(シート)', '受講者']]);
    sh.getRange(1, 1, 1, 3).setFontWeight('bold');
  }
  return sh;
}

function listGroups_(ss) {
  var sh = getGroupSheet_(ss, false);
  if (!sh) return [];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  var values = sh.getRange(2, 1, lastRow - 1, 3).getValues();
  var order = [];
  var map = {};
  values.forEach(function (row) {
    var name = String(row[0] || '').trim();
    var sheetName = String(row[1] || '').trim();
    var learner = String(row[2] || '').trim();
    if (!name || !sheetName || !learner) return;
    if (!map[name]) {
      map[name] = [];
      order.push(name);
    }
    map[name].push({ sheetName: sheetName, learner: learner });
  });
  return order.map(function (name) {
    return { name: name, members: map[name] };
  });
}

// Webアプリ側のJavaScriptから呼ばれる。保存済みグループの一覧を返す。
function getGroups() {
  return listGroups_(SpreadsheetApp.getActiveSpreadsheet());
}

// Webアプリ側のJavaScriptから呼ばれる。members: [{ sheetName, learner }, ...]
// 同名のグループが既にあれば置き換える(削除してから追加し直す)。
function saveGroup(name, members) {
  name = String(name || '').trim();
  if (!name) throw new Error('グループ名を入力してください。');
  if (!members || members.length === 0) throw new Error('メンバーを1人以上指定してください。');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getGroupSheet_(ss, true);
  deleteGroupRows_(sh, name);

  var rows = members.map(function (m) {
    return [name, m.sheetName, m.learner];
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  return listGroups_(ss);
}

// Webアプリ側のJavaScriptから呼ばれる。指定した名前のグループを削除する。
function deleteGroup(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getGroupSheet_(ss, false);
  if (sh) deleteGroupRows_(sh, name);
  return listGroups_(ss);
}

function deleteGroupRows_(sh, name) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  var values = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  // 行番号がズレないよう、後ろの行から削除する
  for (var r = values.length - 1; r >= 0; r--) {
    if (String(values[r][0] || '').trim() === name) {
      sh.deleteRow(r + 2);
    }
  }
}

// Webアプリ側のJavaScriptから呼ばれる。指定グループの全メンバー(企業をまたいでもよい)について、
// 直近の記録・記録件数を返す(進捗確認タブの「グループで見る」用)。
function getGroupOverview(groupName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var group = listGroups_(ss).filter(function (g) { return g.name === groupName; })[0];
  if (!group) throw new Error('グループが見つかりません: ' + groupName);

  return group.members.map(function (m) {
    var sh = ss.getSheetByName(m.sheetName);
    if (!sh) {
      return { sheetName: m.sheetName, learner: m.learner, recordCount: 0, lastDate: '', lastText: '', error: 'シートが見つかりません' };
    }
    var col = findLearnerColumn_(sh, m.learner);
    if (col === -1) {
      return { sheetName: m.sheetName, learner: m.learner, recordCount: 0, lastDate: '', lastText: '', error: '受講者列が見つかりません' };
    }
    var lastRow = getLastUsedRow_(sh, col);
    var recordCount = Math.max(0, lastRow - 1);
    var lastText = recordCount > 0 ? String(sh.getRange(lastRow, col).getValue()) : '';
    return {
      sheetName: m.sheetName,
      learner: m.learner,
      recordCount: recordCount,
      lastDate: extractDate_(lastText),
      lastText: lastText
    };
  });
}

// ===== ダイアログのHTML =====

function buildDialogHtml_() {
  return '<!DOCTYPE html><html><head><base target="_top">' +
    '<style>' +
    'body{font-family:Arial,sans-serif;font-size:13px;padding:8px;}' +
    '.row{border:1px solid #ccc;border-radius:6px;padding:8px;margin-bottom:8px;position:relative;}' +
    'label{display:block;margin-top:6px;font-weight:bold;}' +
    'select,textarea{width:100%;box-sizing:border-box;margin-top:2px;font-family:inherit;}' +
    'textarea{height:110px;}' +
    'button{margin-top:8px;padding:6px 12px;}' +
    '#status{margin-top:10px;white-space:pre-wrap;font-size:12px;color:#333;}' +
    '.remove{position:absolute;top:6px;right:8px;color:#c00;cursor:pointer;font-size:12px;}' +
    '</style></head><body>' +
    '<p style="font-size:12px;color:#555;">Claudeが作成した記録テキストを、対象の企業・受講者ごとに貼り付けてください。' +
    '集団相談の場合は「対象者を追加」で人数分の行を増やし、同じ文章を貼り付けてください。</p>' +
    '<div id="rows"></div>' +
    '<button onclick="addRow()">+ 対象者を追加(集団相談の場合)</button><br>' +
    '<button onclick="submitAll()" style="background:#1a73e8;color:#fff;border:none;border-radius:4px;">この内容で書き込む</button>' +
    '<div id="status"></div>' +
    '<script>' +
    'let structure=[];let rowCount=0;' +
    'google.script.run.withSuccessHandler(function(data){structure=data;addRow();})' +
    '.withFailureHandler(function(err){document.getElementById("status").textContent="読み込みエラー: "+err.message;})' +
    '.getStructureForDialog();' +
    'function esc(s){return String(s).replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c];});}' +
    'function addRow(){rowCount++;const id=rowCount;const div=document.createElement("div");div.className="row";div.id="row-"+id;' +
    'const opts=structure.map(function(s){return "<option value=\\""+esc(s.sheetName)+"\\">"+esc(s.sheetName)+"</option>";}).join("");' +
    'div.innerHTML="<span class=\\"remove\\" onclick=\\"removeRow("+id+")\\">✕ 削除</span>"+' +
    '"<label>企業(シート)</label><select onchange=\\"updateLearners("+id+")\\" id=\\"sheet-"+id+"\\">"+opts+"</select>"+' +
    '"<label>受講者</label><select id=\\"learner-"+id+"\\"></select>"+' +
    '"<label>記録内容</label><textarea id=\\"text-"+id+"\\" placeholder=\\"ここに貼り付け\\"></textarea>";' +
    'document.getElementById("rows").appendChild(div);updateLearners(id);}' +
    'function updateLearners(id){const sheetName=document.getElementById("sheet-"+id).value;' +
    'const sheet=structure.find(function(s){return s.sheetName===sheetName;});' +
    'const sel=document.getElementById("learner-"+id);' +
    'sel.innerHTML=(sheet?sheet.learners:[]).map(function(l){return "<option value=\\""+esc(l.learner)+"\\">"+esc(l.learner)+"</option>";}).join("");}' +
    'function removeRow(id){const el=document.getElementById("row-"+id);if(el)el.remove();}' +
    'function submitAll(){const rows=document.querySelectorAll(".row");const entries=[];' +
    'rows.forEach(function(row){const id=row.id.split("-")[1];' +
    'const sheetName=document.getElementById("sheet-"+id).value;' +
    'const learner=document.getElementById("learner-"+id).value;' +
    'const text=document.getElementById("text-"+id).value;' +
    'if(text.trim())entries.push({sheetName:sheetName,learner:learner,text:text});});' +
    'if(entries.length===0){document.getElementById("status").textContent="記録内容が入力されていません。";return;}' +
    'document.getElementById("status").textContent="書き込み中...";' +
    'google.script.run.withSuccessHandler(function(results){' +
    'document.getElementById("status").textContent=results.map(function(r){' +
    'return (r.status==="written"?"✅ ":"❌ ")+r.sheetName+" / "+r.learner+" / "+(r.status==="written"?r.cell:r.error);' +
    '}).join("\\n");' +
    '}).withFailureHandler(function(err){document.getElementById("status").textContent="エラー: "+err.message;})' +
    '.submitEntries(entries);}' +
    '</script></body></html>';
}

// ===== Webアプリ(VTTアップロード → AI要約 → 書き込み) =====

/**
 * Webアプリとしてデプロイした場合のエントリーポイント。
 * デプロイ設定:「次のユーザーとして実行: 自分」「アクセスできるユーザー: 当社内の全員」でよい
 * (匿名アクセスは不要。ユーザー本人がブラウザから直接開く想定のため)。
 * 手順の詳細は DEPLOY.md を参照。
 */
function doGet(e) {
  return HtmlService.createHtmlOutput(buildWebAppHtml_())
    .setTitle('学習進捗ログ 自動作成・書き込み')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Webアプリ側のJavaScriptから呼ばれる。VTTの内容とフォーム入力からGeminiに要約させる。
 * payload: { vttText, date, isGroup, participants: ["企業名:受講者名", ...] }
 */
function generateSummary(payload) {
  var prompt = buildSummaryPrompt_(
    payload.vttText,
    payload.date,
    payload.isGroup,
    payload.participants || []
  );
  return callGemini_(prompt);
}

function buildSummaryPrompt_(vttText, date, isGroup, participants) {
  var kind = isGroup ? '集団' : '個別';
  var remarksLine = isGroup
    ? '[参加者一覧をそのまま記載: ' + participants.join('、') + ']'
    : '(個別相談のため省略してよい)';

  return [
    'あなたは、企業向けITスキル研修(リスキリング支援サービス)の運営担当者です。',
    '以下はZoom定例相談会(月2回実施、受講者のITスキル学習の進捗確認・視聴状況確認・質問対応・',
    '社内改善業務のお手伝いなど)のZoom文字起こし(VTT形式)です。',
    '',
    'この内容を要約し、次のテンプレートに厳密に従って、プレーンテキストのみで出力してください。',
    '(見出し行の絵文字や【】はそのまま使うこと。テンプレートの前後に説明文・前置き・Markdown装飾を',
    '一切付けないこと。該当する話題が全く出ていない項目は「特になし」とすること。)',
    '',
    '--- テンプレート ---',
    '📅 ' + date + '（' + kind + '相談）',
    '【視聴状況】',
    '[動画サービスの視聴進捗について話した内容の要約]',
    '【質問・不明点】',
    '[受講者から出た質問・不明点と、それに対する回答の要約]',
    '【社内改善業務サポート】',
    '[社内改善業務の相談・お手伝いをした内容の要約。話題に出ていなければ「特になし」]',
    '【次回に向けて】',
    '[次回までの宿題・注意点・フォローすべき点]',
    '【備考】',
    remarksLine,
    '--- テンプレートここまで ---',
    '',
    '--- 以下がVTT文字起こし ---',
    vttText
  ].join('\n');
}

/**
 * Webアプリ側のJavaScriptから呼ばれる。複数のVTTについて、それぞれが「どの企業のどの受講者との
 * 相談会か」をまとめてGeminiに推定させる(個別相談のVTTを一括登録するとき用)。
 *
 * VTT全文ではなく、Zoomの話者表示名と冒頭の抜粋だけを送る(全文を件数分送ると時間もトークンも
 * かかりすぎるため)。またWebアプリ側で先に登録済み受講者名との単純な文字列照合をしているので、
 * ここに渡ってくるのは基本的に照合できなかったファイルだけになる。
 *
 * 推定はあくまで下書きで、書き込む前にユーザーが画面のプルダウンで確認・修正する前提。
 * 誤書き込みを防ぐため、候補リストに無い組み合わせをモデルが返してきた場合は採用しない。
 *
 * payload: { files: [{ id, name, speakers: [...], excerpt }], candidates: [{ sheetName, learner }] }
 * 戻り値: [{ id, sheetName, learner }] (判断できなかったファイルは含まれない)
 */
function estimateTargets(payload) {
  var files = (payload && payload.files) || [];
  var candidates = (payload && payload.candidates) || [];
  if (files.length === 0 || candidates.length === 0) return [];

  var parsed = parseJsonArray_(callGemini_(buildEstimatePrompt_(files, candidates)));

  var valid = {};
  for (var i = 0; i < candidates.length; i++) {
    valid[candidates[i].sheetName + '\u0000' + candidates[i].learner] = true;
  }

  var out = [];
  for (var j = 0; j < parsed.length; j++) {
    var item = parsed[j] || {};
    var no = Number(item.file);
    if (!(no >= 1 && no <= files.length)) continue; // ファイル番号が不正なものは捨てる
    var sheetName = String(item.company || '');
    var learner = String(item.learner || '');
    if (!valid[sheetName + '\u0000' + learner]) continue; // 候補に無い組み合わせは採用しない
    out.push({ id: files[no - 1].id, sheetName: sheetName, learner: learner });
  }
  return out;
}

function buildEstimatePrompt_(files, candidates) {
  var lines = [
    'あなたは、企業向けITスキル研修(リスキリング支援サービス)の運営担当者です。',
    'Zoom個別相談会の文字起こし(VTT)が複数あります。それぞれが「どの企業のどの受講者との',
    '相談会か」を、下の候補リストの中から選んでください。',
    '',
    '# 候補リスト(この中の組み合わせからのみ選ぶこと)'
  ];
  for (var i = 0; i < candidates.length; i++) {
    lines.push('- 企業: ' + candidates[i].sheetName + ' / 受講者: ' + candidates[i].learner);
  }
  lines.push('');
  lines.push('# 判定対象のファイル');
  for (var j = 0; j < files.length; j++) {
    var f = files[j] || {};
    var speakers = f.speakers || [];
    lines.push('[' + (j + 1) + '] ファイル名: ' + String(f.name || ''));
    lines.push('    Zoomの話者表示名: ' + (speakers.length ? speakers.join('、') : '(取得できず)'));
    lines.push('    冒頭の抜粋: ' + String(f.excerpt || '').replace(/\n/g, ' / '));
  }
  lines.push('');
  lines.push('# 出力形式');
  lines.push('次の形式のJSON配列だけを出力してください。前置き・説明文・Markdownのコードブロックは');
  lines.push('一切付けないこと。');
  lines.push('[{"file":1,"company":"候補リストの企業名","learner":"候補リストの受講者名"}]');
  lines.push('');
  lines.push('- file は上の [] 内の番号。');
  lines.push('- company と learner は、必ず候補リストにある組み合わせを、そのままの表記で書くこと。');
  lines.push('- 話者表示名がローマ字・ニックネーム・端末名などで候補と一致しない場合は、');
  lines.push('  会話の内容(自己紹介・呼びかけ・所属企業の話題など)から判断すること。');
  lines.push('- 相談会の進行役(運営担当者)は受講者ではないので選ばないこと。');
  lines.push('- どの候補か判断できないファイルは、配列に含めないこと(推測で埋めないこと)。');
  return lines.join('\n');
}

/**
 * モデルの応答からJSON配列を取り出す。「JSONだけを出力せよ」と指示しても、前置きや
 * Markdownのコードブロックが付いてくることがあるため、最初の[から最後の]までを切り出す。
 * 取り出せなかった場合は空配列を返す(推定は必須機能ではなく、失敗しても手動で選べばよい)。
 */
function parseJsonArray_(text) {
  var s = String(text || '');
  var start = s.indexOf('[');
  var end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    var v = JSON.parse(s.slice(start, end + 1));
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
  } catch (err) {
    return [];
  }
}

/**
 * Gemini APIを呼び出して要約テキストを取得する。
 *
 * 個人のGemini APIキーを直接使う方式(旧実装)は廃止した。社内のAI推進室が用意した
 * GASライブラリ「GeminiRaytech」経由でVertex AIのGeminiを呼び出す(社内のGemini Gateway
 * 移行方針に沿った、GAS向けの正式な接続方法)。認証は全てライブラリ側(サービスアカウント)
 * が行うため、APIキーの発行・保管は一切不要。
 *
 * 導入手順(初回のみ)は gas/DEPLOY.md を参照:
 *   1. Apps Scriptエディタの「ライブラリ」→スクリプトID
 *      1SNn6G_ri9HwMu1jLLoA7ChZVVlS4Vk_LYwUNIWhvBvpYenikR1LrWKcW を追加(バージョン2)
 *   2. AI推進室(AIチーム)に利用権限の付与を依頼
 *   3. testGeminiRaytech_() をエディタから一度手動実行し、権限承認ポップアップで
 *      全てのチェックボックスにチェックを入れて許可する(Webアプリ経由の初回実行では
 *      承認ポップアップが出せないため、必ずエディタから先に一度実行しておくこと)
 */
function callGemini_(prompt) {
  var model = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || GEMINI_MODEL_DEFAULT;
  var text;
  try {
    text = GeminiRaytech.generateText(prompt, model);
  } catch (err) {
    throw new Error(
      'GeminiRaytech呼び出しエラー: ' + err + ' ' +
      '(権限未承認、またはAI推進室への利用申請が未了の可能性があります。gas/DEPLOY.mdを確認してください)'
    );
  }
  if (!text) {
    throw new Error('GeminiRaytechから要約テキストを取得できませんでした。');
  }
  return String(text).trim();
}

/**
 * GeminiRaytech利用の初回権限承認用。Apps Scriptエディタから手動で一度実行し、
 * 表示される権限確認ポップアップで全てのチェックボックスにチェックを入れて許可すること。
 * (詳細は gas/DEPLOY.md 「初回実行時の注意点」を参照)
 */
function testGeminiRaytech_() {
  var text = GeminiRaytech.generateText('こんにちは', GEMINI_MODEL_DEFAULT);
  Logger.log(text);
}

function buildWebAppHtml_() {
  return '<!DOCTYPE html><html><head><base target="_top">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700&family=Noto+Sans+JP:wght@400;500;700&display=swap">' +
    '<style>' +
    ':root{--sf-accent:#c8364a;--sf-accent-dark:#9f1239;--sf-navy:#0f1e3d;--sf-text:#0f1e3d;' +
    '--sf-muted:#64748b;--sf-border:#e2e8f0;--sf-bg:#f8fafc;--sf-danger:#9f1239;--sf-input-border:#e2e8f0;' +
    '--sf-header-grad:linear-gradient(90deg,#0f1e3d,#172a4a);' +
    '--sf-primary-grad:linear-gradient(135deg,#dc2626,#9f1239);' +
    '--sf-primary-grad-hover:linear-gradient(135deg,#b91c1c,#881337);' +
    '--sf-num-font:"Outfit","Noto Sans JP",sans-serif;}' +
    '*{box-sizing:border-box;}' +
    'body{margin:0;background:var(--sf-bg);color:var(--sf-text);' +
    'font-family:"Noto Sans JP","Hiragino Sans",sans-serif;font-size:15px;}' +
    '.sf-header{background:var(--sf-header-grad);color:#fff;padding:16px 24px;font-size:17px;font-weight:700;' +
    'display:flex;align-items:center;gap:8px;}' +
    '.sf-dot{width:9px;height:9px;border-radius:50%;background:var(--sf-accent);display:inline-block;flex:none;}' +
'.sf-container{max-width:1360px;margin:24px auto;padding:0 20px 48px;}' +
    '.sf-card{background:#fff;border:1px solid var(--sf-border);border-radius:8px;' +
    'box-shadow:0 1px 3px rgba(15,30,61,.08);padding:28px 32px 32px;}' +
    '.field-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:4px 24px;max-width:900px;}' +
    '.field-grid .field{margin-bottom:18px;}' +
    '.field-narrow{max-width:640px;}' +
    '.dropzone{border:2px dashed var(--sf-input-border);border-radius:8px;padding:20px;' +
    'text-align:center;background:var(--sf-bg);transition:.15s;}' +
    '.dropzone.dragover{border-color:var(--sf-accent);background:#fff1f2;}' +
    '.dropzone input[type=file]{display:block;margin:0 auto 8px;max-width:360px;}' +
    '.dropzone-hint{font-size:12.5px;color:var(--sf-muted);}' +
    '.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-top:14px;}' +
    '.card-grid .card{margin-bottom:0;}' +
    '.bulk-file{font-weight:700;color:var(--sf-navy);font-size:14px;margin-bottom:14px;' +
    'padding-right:76px;word-break:break-all;}' +
    '.bulk-cardstatus{margin-top:10px;font-size:12.5px;color:var(--sf-muted);white-space:pre-wrap;}' +
    '#bulkStatus{margin-top:16px;white-space:pre-wrap;font-size:13.5px;color:var(--sf-text);}' +
    '.view-toolbar{display:flex;align-items:flex-end;gap:24px;flex-wrap:wrap;margin-bottom:16px;}' +
    '.view-toolbar .field{margin-bottom:0;min-width:280px;}' +
    '.viewmode{display:inline-flex;border:1px solid var(--sf-border);border-radius:6px;overflow:hidden;}' +
    '#writeModeWrap{margin:6px 0 22px;}' +
    '.modebtn{margin:0;border:none;border-radius:0;background:#fff;color:var(--sf-muted);padding:9px 18px;}' +
    '.modebtn:hover{background:var(--sf-bg);}' +
    '.modebtn.active,.modebtn.active:hover{background:var(--sf-accent);color:#fff;}' +
    '.panes{display:grid;grid-template-columns:320px 1fr;gap:20px;align-items:start;}' +
    '.pane-list{border:1px solid var(--sf-border);border-radius:8px;background:#fff;overflow:hidden;}' +
    '.member{padding:12px 14px;border-bottom:1px solid var(--sf-border);cursor:pointer;transition:.1s;}' +
    '.member:last-child{border-bottom:none;}' +
    '.member:hover{background:var(--sf-bg);}' +
    '.member.active{background:#fff1f2;box-shadow:inset 3px 0 0 var(--sf-accent);}' +
    '.member-name{font-weight:700;color:var(--sf-navy);font-size:14px;}' +
    '.member-sub{font-size:11.5px;color:var(--sf-muted);margin-top:2px;}' +
    '.member-meta{font-size:12px;color:var(--sf-muted);margin-top:3px;' +
    'font-family:var(--sf-num-font);font-variant-numeric:tabular-nums;}' +
    '.pane-empty{padding:16px;color:var(--sf-muted);font-size:13px;}' +
    '.detail-head{font-weight:700;color:var(--sf-navy);font-size:16px;margin-bottom:12px;}' +
    '.detail-head .badge{margin-left:8px;}' +
    '@media(max-width:900px){.panes{grid-template-columns:1fr;}}' +
    'h2{margin:0 0 4px;font-size:19px;font-weight:700;color:var(--sf-navy);}' +
    'h3{margin:0 0 4px;font-size:15.5px;font-weight:700;color:var(--sf-navy);}' +
    '.hint{font-size:13px;color:var(--sf-muted);line-height:1.6;margin:0 0 18px;}' +
    '.field{margin-bottom:18px;}' +
    'label{display:block;font-weight:600;font-size:13.5px;color:var(--sf-text);margin-bottom:6px;}' +
    'input[type=file],input[type=date],input[type=text],select,textarea{width:100%;font-family:inherit;font-size:15px;' +
    'color:var(--sf-text);border:1px solid var(--sf-input-border);border-radius:6px;padding:9px 12px;background:#fff;}' +
    'input[type=file]{padding:6px;}' +
    'select:focus,input:focus,textarea:focus{outline:none;border-color:var(--sf-accent);box-shadow:0 0 0 1px var(--sf-accent);}' +
    '.row{border:1px solid var(--sf-border);background:var(--sf-bg);border-radius:8px;padding:16px;margin-bottom:16px;position:relative;}' +
    '.row textarea{height:160px;margin-top:0;}' +
    '.remove{position:absolute;top:14px;right:16px;color:var(--sf-danger);cursor:pointer;font-size:12.5px;font-weight:600;}' +
    '.remove:hover{text-decoration:underline;}' +
    'button{font-family:inherit;padding:9px 18px;margin:0 8px 8px 0;border-radius:6px;' +
    'border:1px solid var(--sf-input-border);background:#fff;color:var(--sf-accent);font-size:13.5px;font-weight:600;cursor:pointer;}' +
    'button:hover{background:var(--sf-bg);}' +
    '.primary{background:var(--sf-primary-grad);border-color:var(--sf-accent-dark);color:#fff;}' +
    '.primary:hover{background:var(--sf-primary-grad-hover);border-color:var(--sf-accent-dark);}' +
    '#status{margin-top:16px;white-space:pre-wrap;font-size:13.5px;color:var(--sf-text);}' +
    '.tabs{display:flex;gap:4px;border-bottom:1px solid var(--sf-border);margin-bottom:24px;}' +
    '.tabbtn{background:none;border:none;border-bottom:3px solid transparent;border-radius:0;' +
    'padding:11px 16px;margin:0;font-size:14.5px;font-weight:600;color:var(--sf-muted);cursor:pointer;}' +
    '.tabbtn:hover{color:var(--sf-accent);background:none;}' +
    '.tabbtn.active{border-bottom-color:var(--sf-accent);color:var(--sf-accent-dark);}' +
    '.card{border:1px solid var(--sf-border);border-radius:8px;padding:16px;margin-bottom:12px;background:#fff;}' +
    '.card b{color:var(--sf-navy);font-size:14.5px;}' +
    '.badge{display:inline-block;background:#f1f5f9;color:#475569;border-radius:10px;' +
    'padding:3px 11px;font-size:12px;font-weight:600;margin-left:6px;' +
    'font-family:var(--sf-num-font);font-variant-numeric:tabular-nums;}' +
    '.badge-muted{background:var(--sf-bg);color:var(--sf-muted);}' +
    '.badge-ai{background:#fff1f2;color:var(--sf-accent-dark);}' +
    '.badge-alert{background:var(--sf-danger);color:#fff;}' +
    '.cardtext{white-space:pre-wrap;margin-top:10px;font-size:13.5px;color:var(--sf-text);line-height:1.6;' +
    'background:var(--sf-bg);border:1px solid #eef2f6;border-radius:6px;padding:12px;}' +
    '#companyMatrix{margin-top:14px;}' +
    'hr{border:none;border-top:1px solid var(--sf-border);margin:26px 0;}' +
    '.matrix-wrap{overflow-x:auto;border:1px solid var(--sf-border);border-radius:8px;}' +
    'table.matrix{border-collapse:collapse;width:100%;}' +
    '.matrix th,.matrix td{border:1px solid var(--sf-border);padding:11px 14px;font-size:13px;' +
    'vertical-align:top;white-space:pre-wrap;min-width:220px;}' +
    '.matrix thead th{background:var(--sf-navy);color:#fff;font-weight:600;white-space:nowrap;}' +
    '.matrix tbody th{background:#fff;color:var(--sf-navy);font-weight:700;text-align:center;' +
    'white-space:nowrap;min-width:auto;font-family:var(--sf-num-font);font-variant-numeric:tabular-nums;}' +
    '.matrix thead th:first-child,.matrix tbody th{position:sticky;left:0;}' +
    '.matrix tbody tr:nth-child(even) td,.matrix tbody tr:nth-child(even) th{background:var(--sf-bg);}' +
    '</style></head><body>' +

    '<div class="sf-header"><span class="sf-dot"></span>学習進捗ログ</div>' +
    '<div class="sf-container" id="sfContainer"><div class="sf-card">' +

    '<div class="tabs">' +
    '<button type="button" class="tabbtn active" id="tabbtn-write" onclick="showTab(\'write\')">記録を追加</button>' +
    '<button type="button" class="tabbtn" id="tabbtn-view" onclick="showTab(\'view\')">進捗を確認</button>' +
    '<button type="button" class="tabbtn" id="tabbtn-manage" onclick="showTab(\'manage\')">登録・管理</button>' +
    '</div>' +

    '<div id="writeTab">' +
    '<h2>VTTから自動作成</h2>' +
    '<div class="viewmode" id="writeModeWrap">' +
    '<button type="button" class="modebtn active" id="wmode-single" onclick="setWriteMode(\'single\')">1件ずつ(個別・集団相談)</button>' +
    '<button type="button" class="modebtn" id="wmode-bulk" onclick="setWriteMode(\'bulk\')">複数VTTを一括(個別相談)</button>' +
    '</div>' +

    '<div id="singleWrite">' +
    '<p class="hint">Zoomの文字起こし(.vtt)をアップロードして「AIで要約を作成」を押すと、下の記録内容欄に' +
    '下書きが自動で入ります。内容を確認・必要なら修正してから「この内容で書き込む」を押してください。</p>' +

    '<div class="field field-narrow"><label>グループから対象者を読み込む(任意・集団相談の場合)</label>' +
    '<select id="groupSelect"></select></div>' +
    '<button onclick="loadGroupIntoWriteTab()">このグループを対象者欄に読み込む</button>' +
    '<hr>' +

    '<div class="field field-narrow"><label>VTTファイル</label>' +
    '<div class="dropzone" id="vttDropzone">' +
    '<input type="file" id="vttFile" accept=".vtt">' +
    '<div class="dropzone-hint">クリックして選択、またはここにファイルをドラッグ&ドロップ</div>' +
    '</div></div>' +
    '<div class="field field-narrow"><label>実施日</label><input type="date" id="sessionDate">' +
    '<div class="hint" id="dateGuessHint" style="margin:6px 0 0"></div></div>' +

    '<div id="rows"></div>' +
    '<button onclick="addRow()">+ 対象者を追加(集団相談の場合)</button>' +
    '<br>' +
    '<button class="primary" onclick="generateAll()">AIで要約を作成</button>' +
    '<button class="primary" onclick="submitAll()">この内容で書き込む</button>' +
    '<div id="status"></div>' +
    '</div>' +

    '<div id="bulkWrite" style="display:none">' +
    '<p class="hint">個別相談のVTTをまとめてアップロードすると、ファイル1つにつき1枚のカードが並びます。' +
    '実施日はファイル名から、対象者はZoomの話者名(一致しない場合はAIによる推定)から自動で入るので、' +
    '合っているかを確認・修正してから「AIで要約をまとめて作成」→「この内容でまとめて書き込む」を押してください。' +
    '<b>対象者の自動選択はあくまで下書きです。書き込む前に必ず目視で確認してください。</b></p>' +

    '<div class="field field-narrow"><label>VTTファイル(複数選択できます)</label>' +
    '<div class="dropzone" id="bulkDropzone">' +
    '<input type="file" id="bulkVttFiles" accept=".vtt" multiple>' +
    '<div class="dropzone-hint">クリックしてまとめて選択、またはここに複数のファイルをドラッグ&ドロップ</div>' +
    '</div></div>' +

    '<div id="bulkList"></div>' +
    '<button onclick="estimateBulkTargets(false)">AIで対象者を推定し直す</button>' +
    '<button onclick="clearBulk()">読み込んだファイルを全て消す</button>' +
    '<br>' +
    '<button class="primary" onclick="generateBulkSummaries()">AIで要約をまとめて作成</button>' +
    '<button class="primary" onclick="submitBulk()">この内容でまとめて書き込む</button>' +
    '<div id="bulkStatus"></div>' +
    '</div>' +

    '</div>' +

    '<div id="viewTab" style="display:none">' +
    '<h2>進捗を確認</h2>' +
    '<p class="hint">上のプルダウンで企業(または集団相談のグループ)を選ぶと、その場で左に受講者一覧が出ます。' +
    '左の受講者をクリックすると、右にその人の全記録が新しい順で表示されます。' +
    '「表」に切り替えると、回数を縦・受講者を横並びにした一覧表で見られます(PC画面向け)。</p>' +
    '<div class="view-toolbar">' +
    '<div class="field"><label>表示対象</label>' +
    '<select id="viewTarget" onchange="onViewTargetChange()"></select></div>' +
    '<div class="viewmode" id="viewModeWrap">' +
    '<button type="button" class="modebtn active" id="modebtn-cards" onclick="setViewMode(\'cards\')">一覧</button>' +
    '<button type="button" class="modebtn" id="modebtn-table" onclick="setViewMode(\'table\')">表</button>' +
    '</div></div>' +
    '<div id="viewStatus" class="hint"></div>' +
    '<div id="viewPanes" class="panes">' +
    '<div class="pane-list" id="memberList"></div>' +
    '<div class="pane-detail" id="memberDetail"></div>' +
    '</div>' +
    '<div id="companyMatrix"></div>' +
    '<hr>' +
    '<h3>次回日程一覧</h3>' +
    '<p class="hint">「記録を追加」タブで次回相談予定日を入力した受講者について、全社横断で次回日付が早い順に一覧できます。</p>' +
    '<button onclick="loadNextScheduleList()">次回日程一覧を見る(全社)</button>' +
    '<div id="nextScheduleList"></div>' +
    '</div>' +

    '<div id="manageTab" style="display:none">' +
    '<h2>企業・受講者の登録</h2>' +
    '<p class="hint">新しい企業(シート)や受講者を追加できます。企業を登録した直後は受講者が0人なので、' +
    'このあと続けて受講者を最低1人登録してください(受講者が0人の間は他の画面のプルダウンにまだ出てきません)。</p>' +

    '<div class="field field-narrow"><label>新しい企業名</label><input type="text" id="newCompanyName" placeholder="例: サンプル商事株式会社"></div>' +
    '<button class="primary" onclick="createCompanyClick()">企業を登録</button>' +
    '<div id="companyCreateStatus" class="hint"></div>' +

    '<hr>' +

    '<div class="field field-narrow"><label>企業(シート)</label><select id="learnerCompanySelect"></select></div>' +
    '<div class="field field-narrow"><label>新しい受講者名(複数人まとめて登録する場合は1行に1人ずつ)</label>' +
    '<textarea id="newLearnerNames" rows="4" placeholder="例:\n山田太郎\n鈴木花子"></textarea></div>' +
    '<button class="primary" onclick="createLearnerClick()">受講者を登録</button>' +
    '<div id="learnerCreateStatus" class="hint"></div>' +

    '<hr>' +

    '<h2>グループ管理(集団相談用)</h2>' +
    '<p class="hint">よく行う集団相談の組み合わせを「グループ」として保存しておくと、' +
    '「記録を追加」タブで対象者欄をまとめて呼び出せます(複数企業にまたがってもよい)。</p>' +
    '<div id="groupList" class="card-grid"></div>' +
    '<div id="groupRows"></div>' +
    '<button onclick="addGroupRow()">+ メンバーを追加</button>' +
    '<br>' +
    '<div class="field field-narrow"><label>グループ名</label><input type="text" id="newGroupName" placeholder="例: サンプル商事+テスト工業 合同研修"></div>' +
    '<button class="primary" onclick="saveGroupClick()">このメンバーでグループを保存</button>' +
    '<div id="groupSaveStatus" class="hint"></div>' +
    '</div>' +

    '</div></div>' +

    '<script>' +
    'let structure=[];let allCompanyNames=[];let rowCount=0;let groupRowCount=0;let vttText="";' +
    'let groupsCache=[];let firstRowPrefillDone=false;let viewMode="cards";let viewLoaded=false;' +
    'let writeMode="single";let bulkFiles=[];let bulkCount=0;' +
    'google.script.run.withSuccessHandler(function(data){' +
    'structure=data;addRow();populateViewTarget();addGroupRow();})' +
    '.withFailureHandler(function(err){setStatus("読み込みエラー: "+err.message);})' +
    '.getStructureForDialog();' +
    'google.script.run.withSuccessHandler(function(names){allCompanyNames=names||[];populateLearnerCompanySelect();})' +
    '.withFailureHandler(function(err){document.getElementById("learnerCreateStatus").textContent="読み込みエラー: "+err.message;})' +
    '.getAllCompanyNames();' +
    'google.script.run.withSuccessHandler(renderGroupList)' +
    '.withFailureHandler(function(err){document.getElementById("groupList").textContent="読み込みエラー: "+err.message;})' +
    '.getGroups();' +

    'function handleVttFile(f){if(!f)return;' +
    'const reader=new FileReader();' +
    'reader.onload=function(e){' +
    'vttText=e.target.result;' +
    'const guessed=guessDateFromFilename(f.name);' +
    'const hintEl=document.getElementById("dateGuessHint");' +
    'if(guessed){document.getElementById("sessionDate").value=guessed;' +
    'hintEl.textContent="ファイル名から実施日を "+guessed+" と推測しました。違う場合は修正してください。";' +
    '}else{hintEl.textContent="";}' +
    'setStatus("VTT読み込み完了: "+f.name);};' +
    'reader.readAsText(f);}' +

    'function guessDateFromFilename(name){' +
    'let m=/GMT(\\d{4})(\\d{2})(\\d{2})/.exec(name);' +
    'if(m)return m[1]+"-"+m[2]+"-"+m[3];' +
    'm=/(\\d{4})-(\\d{2})-(\\d{2})/.exec(name);' +
    'if(m)return m[1]+"-"+m[2]+"-"+m[3];' +
    'm=/(\\d{4})(\\d{2})(\\d{2})/.exec(name);' +
    'if(m){const mo=+m[2],d=+m[3];if(mo>=1&&mo<=12&&d>=1&&d<=31)return m[1]+"-"+m[2]+"-"+m[3];}' +
    'return null;}' +

    'document.getElementById("vttFile").addEventListener("change",function(ev){handleVttFile(ev.target.files[0]);});' +
    '(function(){const dz=document.getElementById("vttDropzone");' +
    'dz.addEventListener("dragover",function(ev){ev.preventDefault();dz.classList.add("dragover");});' +
    'dz.addEventListener("dragleave",function(){dz.classList.remove("dragover");});' +
    'dz.addEventListener("drop",function(ev){ev.preventDefault();dz.classList.remove("dragover");' +
    'const fs=ev.dataTransfer.files;if(!fs||!fs.length)return;' +
    'if(fs.length>1){setWriteMode("bulk");handleBulkFiles(fs);return;}' +
    'try{document.getElementById("vttFile").files=fs;}catch(e){}' +
    'handleVttFile(fs[0]);});})();' +

    'function setWriteMode(m){writeMode=m;' +
    'document.getElementById("singleWrite").style.display=(m==="single")?"":"none";' +
    'document.getElementById("bulkWrite").style.display=(m==="bulk")?"":"none";' +
    'document.getElementById("wmode-single").classList.toggle("active",m==="single");' +
    'document.getElementById("wmode-bulk").classList.toggle("active",m==="bulk");}' +

    'function setBulkStatus(msg){document.getElementById("bulkStatus").textContent=msg||"";}' +
    'function setBulkCardStatus(id,msg){const el=document.getElementById("bstatus-"+id);if(el)el.textContent=msg||"";}' +
    'function setBulkBadge(id,text,cls){const el=document.getElementById("bulkbadge-"+id);if(!el)return;' +
    'if(!text){el.style.display="none";el.textContent="";return;}' +
    'el.style.display="";el.className="badge"+(cls?" "+cls:"");el.textContent=text;}' +

    'function bulkSheetOptionsHtml(){return "<option value=\\"\\">(選択してください)</option>"+sheetOptionsHtml();}' +
    'function bulkLearnerOptionsHtml(s){return "<option value=\\"\\">(選択してください)</option>"+learnerOptionsHtml(s);}' +
    'function updateBulkLearners(id){' +
    'document.getElementById("blearner-"+id).innerHTML=bulkLearnerOptionsHtml(document.getElementById("bsheet-"+id).value);}' +
    'function onBulkManualChange(id){setBulkBadge(id,"手動で選択","");}' +
    'function removeBulk(id){const el=document.getElementById("bulk-"+id);if(el)el.remove();' +
    'bulkFiles=bulkFiles.filter(function(r){return r.id!==id;});}' +
    'function clearBulk(){document.getElementById("bulkList").innerHTML="";bulkFiles=[];' +
    'try{document.getElementById("bulkVttFiles").value="";}catch(e){}setBulkStatus("");}' +

    'function parseVtt(text){' +
    'const lines=String(text||"").split(/\\r?\\n/);' +
    'const counts=Object.create(null);const order=[];let excerpt="";' +
    'for(let i=0;i<lines.length;i++){' +
    'let ln=lines[i].trim();' +
    'if(!ln)continue;' +
    'if(/^WEBVTT/i.test(ln))continue;' +
    'if(ln.indexOf("--\\u003e")!==-1)continue;' +
    'if(/^\\d+$/.test(ln))continue;' +
    'if(/^(NOTE|STYLE|REGION)\\b/.test(ln))continue;' +
    'let speaker=null;' +
    'let m=/^<v\\s+([^>]+)>/.exec(ln);' +
    'if(m){speaker=m[1].trim();ln=ln.replace(/^<v\\s+[^>]+>/,"").replace(/<\\/v>$/,"").trim();}' +
    'else{m=/^([^:：]{1,30})[:：]\\s*(.*)$/.exec(ln);if(m){speaker=m[1].trim();ln=m[2].trim();}}' +
    'if(speaker){if(counts[speaker]===undefined){counts[speaker]=0;order.push(speaker);}counts[speaker]++;}' +
    'if(excerpt.length<1200)excerpt+=(speaker?speaker+": ":"")+ln+"\\n";}' +
    'order.sort(function(a,b){return counts[b]-counts[a];});' +
    'return {speakers:order.slice(0,12),excerpt:excerpt.slice(0,1200)};}' +

    'function normName(s){return String(s||"").replace(/[（(][^）)]*[）)]/g,"")' +
    '.replace(/[\\s\\u3000・,，.．]/g,"").toLowerCase();}' +

    'function learnerCandidates(){const out=[];' +
    'structure.forEach(function(s){s.learners.forEach(function(l){' +
    'out.push({sheetName:s.sheetName,learner:l.learner});});});return out;}' +

    'function localGuess(speakers){' +
    'const cands=learnerCandidates().map(function(c){' +
    'return {sheetName:c.sheetName,learner:c.learner,norm:normName(c.learner)};});' +
    'const sp=(speakers||[]).map(normName).filter(function(x){return x;});' +
    'if(!sp.length)return null;' +
    'const exact=cands.filter(function(c){return c.norm&&sp.indexOf(c.norm)!==-1;});' +
    'if(exact.length)return exact.length===1?exact[0]:null;' +
    'const partial=cands.filter(function(c){' +
    'if(c.norm.length<2)return false;' +
    'return sp.some(function(x){' +
    'return x.length>=2&&(x.indexOf(c.norm)!==-1||c.norm.indexOf(x)!==-1);});});' +
    'return partial.length===1?partial[0]:null;}' +

    'function addBulkCard(name){bulkCount++;const id=bulkCount;' +
    'const rec={id:id,name:name,text:"",speakers:[],excerpt:""};bulkFiles.push(rec);' +
    'const div=document.createElement("div");div.className="row";div.id="bulk-"+id;' +
    'div.innerHTML="<span class=\\"remove\\" onclick=\\"removeBulk("+id+")\\">✕ 削除</span>"+' +
    '"<div class=\\"bulk-file\\">"+esc(name)+" <span class=\\"badge\\" id=\\"bulkbadge-"+id+"\\"></span></div>"+' +
    '"<div class=\\"field-grid\\">"+' +
    '"<div class=\\"field\\"><label>実施日</label><input type=\\"date\\" id=\\"bdate-"+id+"\\"></div>"+' +
    '"<div class=\\"field\\"><label>企業(シート)</label>"+' +
    '"<select id=\\"bsheet-"+id+"\\" onchange=\\"updateBulkLearners("+id+");onBulkManualChange("+id+")\\">"+' +
    'bulkSheetOptionsHtml()+"</select></div>"+' +
    '"<div class=\\"field\\"><label>受講者</label>"+' +
    '"<select id=\\"blearner-"+id+"\\" onchange=\\"onBulkManualChange("+id+")\\"></select></div>"+' +
    '"</div>"+' +
    '"<label>記録内容</label><textarea id=\\"btext-"+id+"\\" ' +
    'placeholder=\\"「AIで要約をまとめて作成」を押すとここに下書きが入ります\\"></textarea>"+' +
    '"<div class=\\"bulk-cardstatus\\" id=\\"bstatus-"+id+"\\"></div>";' +
    'document.getElementById("bulkList").appendChild(div);' +
    'updateBulkLearners(id);' +
    'setBulkBadge(id,"対象者を選んでください","badge-alert");' +
    'const guessed=guessDateFromFilename(name);' +
    'if(guessed)document.getElementById("bdate-"+id).value=guessed;' +
    'else setBulkCardStatus(id,"ファイル名から実施日を判定できませんでした。手動で入力してください。");' +
    'return rec;}' +

    'function handleBulkFiles(list){' +
    'const files=Array.prototype.slice.call(list||[]);' +
    'if(!files.length)return;' +
    'let remaining=files.length;' +
    'setBulkStatus("VTTを読み込み中...("+files.length+"件)");' +
    'files.forEach(function(f){' +
    'const rec=addBulkCard(f.name);' +
    'const reader=new FileReader();' +
    'reader.onload=function(e){rec.text=String(e.target.result||"");' +
    'const parsed=parseVtt(rec.text);rec.speakers=parsed.speakers;rec.excerpt=parsed.excerpt;' +
    'applyLocalGuess(rec);' +
    'if(--remaining===0)afterBulkLoad();};' +
    'reader.onerror=function(){setBulkCardStatus(rec.id,"❌ ファイルを読み込めませんでした。");' +
    'if(--remaining===0)afterBulkLoad();};' +
    'reader.readAsText(f);});}' +

    'function applyLocalGuess(rec){' +
    'const g=localGuess(rec.speakers);if(!g)return;' +
    'document.getElementById("bsheet-"+rec.id).value=g.sheetName;' +
    'updateBulkLearners(rec.id);' +
    'document.getElementById("blearner-"+rec.id).value=g.learner;' +
    'setBulkBadge(rec.id,"話者名から自動選択","");}' +

    'function unresolvedBulk(){return bulkFiles.filter(function(r){' +
    'const el=document.getElementById("blearner-"+r.id);return r.text&&el&&!el.value;});}' +

    'function afterBulkLoad(){' +
    'if(!unresolvedBulk().length){' +
    'setBulkStatus("読み込みが終わりました。対象者はZoomの話者名から自動で選んでいます。' +
    '合っているか確認してから要約を作成してください。");return;}' +
    'estimateBulkTargets(true);}' +

    'function estimateBulkTargets(onlyUnresolved){' +
    'const targets=(onlyUnresolved?unresolvedBulk():bulkFiles).filter(function(r){return r.text;});' +
    'if(!targets.length){setBulkStatus("先にVTTファイルを選択してください。");return;}' +
    'const candidates=learnerCandidates();' +
    'if(!candidates.length){' +
    'setBulkStatus("受講者がまだ登録されていないため推定できません。「登録・管理」タブで登録してください。");return;}' +
    'setBulkStatus("AIが対象者を推定中です...("+targets.length+"件・数十秒かかることがあります)");' +
    'google.script.run.withSuccessHandler(function(res){' +
    'let n=0;' +
    '(res||[]).forEach(function(g){' +
    'const rec=bulkFiles.find(function(r){return r.id===g.id;});if(!rec)return;' +
    'const sheetEl=document.getElementById("bsheet-"+rec.id);' +
    'const learnerEl=document.getElementById("blearner-"+rec.id);' +
    'if(!sheetEl||!learnerEl)return;' +
    'const prevSheet=sheetEl.value,prevLearner=learnerEl.value;' +
    'sheetEl.value=g.sheetName;updateBulkLearners(rec.id);learnerEl.value=g.learner;' +
    'if(learnerEl.value===g.learner){setBulkBadge(rec.id,"AIが推定","badge-ai");n++;return;}' +
    'sheetEl.value=prevSheet;updateBulkLearners(rec.id);learnerEl.value=prevLearner;});' +
    'const left=unresolvedBulk().length;' +
    'setBulkStatus("AIが"+n+"件の対象者を推定しました。推定は下書きなので、書き込む前に必ず確認してください。"' +
    '+(left?("　判断できなかった"+left+"件は手動で選んでください。"):""));' +
    '}).withFailureHandler(function(err){' +
    'setBulkStatus("対象者の推定でエラーが発生しました: "+err.message+"\\n対象者は手動で選んでください。");})' +
    '.estimateTargets({files:targets.map(function(r){' +
    'return {id:r.id,name:r.name,speakers:r.speakers,excerpt:r.excerpt};}),candidates:candidates});}' +

    'function generateBulkSummaries(){' +
    'const list=bulkFiles.filter(function(r){return r.text;});' +
    'if(!list.length){setBulkStatus("先にVTTファイルを選択してください。");return;}' +
    'let i=0,ok=0,ng=0;' +
    'function next(){' +
    'if(i>=list.length){' +
    'setBulkStatus("要約の作成が終わりました(成功 "+ok+"件 / 失敗・スキップ "+ng+"件)。"' +
    '+"内容を確認・修正してから「この内容でまとめて書き込む」を押してください。");return;}' +
    'const rec=list[i];i++;' +
    'const date=document.getElementById("bdate-"+rec.id).value;' +
    'if(!date){setBulkCardStatus(rec.id,"⏭ 実施日が未入力のためスキップしました。");ng++;next();return;}' +
    'const sheetName=document.getElementById("bsheet-"+rec.id).value;' +
    'const learner=document.getElementById("blearner-"+rec.id).value;' +
    'setBulkStatus("AIが要約を作成中です... ("+i+"/"+list.length+") "+rec.name);' +
    'setBulkCardStatus(rec.id,"要約を作成中...");' +
    'google.script.run.withSuccessHandler(function(text){' +
    'document.getElementById("btext-"+rec.id).value=text;' +
    'setBulkCardStatus(rec.id,"✅ 要約の下書きを作成しました。内容を確認してください。");ok++;next();})' +
    '.withFailureHandler(function(err){' +
    'setBulkCardStatus(rec.id,"❌ 要約エラー: "+err.message);ng++;next();})' +
    '.generateSummary({vttText:rec.text,date:date,isGroup:false,participants:[sheetName+":"+learner]});}' +
    'next();}' +

    'function submitBulk(){' +
    'const entries=[];const skipped=[];' +
    'bulkFiles.forEach(function(r){' +
    'const sheetEl=document.getElementById("bsheet-"+r.id);if(!sheetEl)return;' +
    'const sheetName=sheetEl.value;' +
    'const learner=document.getElementById("blearner-"+r.id).value;' +
    'const text=document.getElementById("btext-"+r.id).value;' +
    'if(!text.trim()){skipped.push(r.name+"(記録内容が空)");return;}' +
    'if(!sheetName||!learner){skipped.push(r.name+"(対象者が未選択)");return;}' +
    'entries.push({sheetName:sheetName,learner:learner,text:text});});' +
    'if(!entries.length){setBulkStatus(["書き込める行がありません。"].concat(' +
    'skipped.map(function(s){return "⏭ "+s;})).join("\\n"));return;}' +
    'setBulkStatus("書き込み中...("+entries.length+"件)");' +
    'google.script.run.withSuccessHandler(function(results){' +
    'const lines=results.map(function(r){' +
    'return (r.status==="written"?"✅ ":"❌ ")+r.sheetName+" / "+r.learner+" / "' +
    '+(r.status==="written"?r.cell:r.error);});' +
    'skipped.forEach(function(s){lines.push("⏭ スキップ: "+s);});' +
    'setBulkStatus(lines.join("\\n"));})' +
    '.withFailureHandler(function(err){setBulkStatus("書き込みエラー: "+err.message);})' +
    '.submitEntries(entries);}' +

    'document.getElementById("bulkVttFiles").addEventListener("change",function(ev){' +
    'handleBulkFiles(ev.target.files);try{ev.target.value="";}catch(e){}});' +
    '(function(){const dz=document.getElementById("bulkDropzone");' +
    'dz.addEventListener("dragover",function(ev){ev.preventDefault();dz.classList.add("dragover");});' +
    'dz.addEventListener("dragleave",function(){dz.classList.remove("dragover");});' +
    'dz.addEventListener("drop",function(ev){ev.preventDefault();dz.classList.remove("dragover");' +
    'handleBulkFiles(ev.dataTransfer.files);});})();' +

    'function saveLastParticipant_(sheetName,learner){' +
    'try{localStorage.setItem("learnerProgressLog.lastParticipant",JSON.stringify({sheetName:sheetName,learner:learner}));}catch(e){}}' +
    'function loadLastParticipant_(){' +
    'try{const v=localStorage.getItem("learnerProgressLog.lastParticipant");return v?JSON.parse(v):null;}catch(e){return null;}}' +
    'function applyLastParticipant_(id){' +
    'const last=loadLastParticipant_();if(!last)return;' +
    'const sheetEl=document.getElementById("sheet-"+id);if(!sheetEl)return;' +
    'const hasSheet=Array.prototype.some.call(sheetEl.options,function(o){return o.value===last.sheetName;});' +
    'if(!hasSheet)return;' +
    'sheetEl.value=last.sheetName;updateLearners(id);' +
    'const learnerEl=document.getElementById("learner-"+id);' +
    'const hasLearner=Array.prototype.some.call(learnerEl.options,function(o){return o.value===last.learner;});' +
    'if(hasLearner)learnerEl.value=last.learner;}' +

    'function esc(s){return String(s).replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c];});}' +

    'function sheetOptionsHtml(){return structure.map(function(s){return "<option value=\\""+esc(s.sheetName)+"\\">"+esc(s.sheetName)+"</option>";}).join("");}' +
    'function learnerOptionsHtml(sheetName){const sheet=structure.find(function(s){return s.sheetName===sheetName;});' +
    'return (sheet?sheet.learners:[]).map(function(l){return "<option value=\\""+esc(l.learner)+"\\">"+esc(l.learner)+"</option>";}).join("");}' +

    'function showTab(name){' +
    'document.getElementById("writeTab").style.display=(name==="write")?"":"none";' +
    'document.getElementById("viewTab").style.display=(name==="view")?"":"none";' +
    'document.getElementById("manageTab").style.display=(name==="manage")?"":"none";' +
    'document.getElementById("tabbtn-write").classList.toggle("active",name==="write");' +
    'document.getElementById("tabbtn-view").classList.toggle("active",name==="view");' +
    'document.getElementById("tabbtn-manage").classList.toggle("active",name==="manage");' +
    'if(name==="view")ensureViewLoaded();}' +

    'function addRow(){rowCount++;const id=rowCount;const div=document.createElement("div");div.className="row";div.id="row-"+id;' +
    'div.innerHTML="<span class=\\"remove\\" onclick=\\"removeRow("+id+")\\">✕ 削除</span>"+' +
    '"<div class=\\"field-grid\\">"+' +
    '"<div class=\\"field\\"><label>企業(シート)</label><select onchange=\\"updateLearners("+id+")\\" id=\\"sheet-"+id+"\\">"+sheetOptionsHtml()+"</select></div>"+' +
    '"<div class=\\"field\\"><label>受講者</label><select id=\\"learner-"+id+"\\"></select></div>"+' +
    '"</div>"+' +
    '"<label>記録内容</label><textarea id=\\"text-"+id+"\\" placeholder=\\"「AIで要約を作成」を押すとここに下書きが入ります\\"></textarea>"+' +
    '"<label>次回相談予定日(任意・まだ未確定なら空のままでよい)</label>"+' +
    '"<div class=\\"field-grid\\">"+' +
    '"<div class=\\"field\\"><input type=\\"date\\" id=\\"nextdate-"+id+"\\"></div>"+' +
    '"<div class=\\"field\\"><input type=\\"time\\" id=\\"nextstart-"+id+"\\" placeholder=\\"開始\\"></div>"+' +
    '"<div class=\\"field\\"><input type=\\"time\\" id=\\"nextend-"+id+"\\" placeholder=\\"終了\\"></div>"+' +
    '"</div>";' +
    'document.getElementById("rows").appendChild(div);updateLearners(id);' +
    'if(!firstRowPrefillDone){firstRowPrefillDone=true;applyLastParticipant_(id);}}' +

    'function updateLearners(id){' +
    'document.getElementById("learner-"+id).innerHTML=learnerOptionsHtml(document.getElementById("sheet-"+id).value);}' +

    'function removeRow(id){const el=document.getElementById("row-"+id);if(el)el.remove();}' +

    'function setStatus(msg){document.getElementById("status").textContent=msg;}' +

    'function generateAll(){' +
    'if(!vttText){setStatus("先にVTTファイルを選択してください。");return;}' +
    'const date=document.getElementById("sessionDate").value;' +
    'if(!date){setStatus("実施日を入力してください。");return;}' +
    'const rows=document.querySelectorAll("#rows .row");' +
    'if(rows.length===0){setStatus("対象者を1人以上選択してください。");return;}' +
    'const isGroup=rows.length>1;' +
    'const participants=[];' +
    'rows.forEach(function(row){const id=row.id.split("-")[1];' +
    'const sheetName=document.getElementById("sheet-"+id).value;' +
    'const learner=document.getElementById("learner-"+id).value;' +
    'participants.push(sheetName+":"+learner);});' +
    'setStatus("AIが要約を作成中です...(数十秒かかることがあります)");' +
    'google.script.run.withSuccessHandler(function(text){' +
    'rows.forEach(function(row){const id=row.id.split("-")[1];document.getElementById("text-"+id).value=text;});' +
    'setStatus("要約案を作成しました。内容を確認・修正してから書き込んでください。");' +
    '}).withFailureHandler(function(err){setStatus("要約エラー: "+err.message);})' +
    '.generateSummary({vttText:vttText,date:date,isGroup:isGroup,participants:participants});}' +

    'function submitAll(){const rows=document.querySelectorAll("#rows .row");const entries=[];' +
    'rows.forEach(function(row){const id=row.id.split("-")[1];' +
    'const sheetName=document.getElementById("sheet-"+id).value;' +
    'const learner=document.getElementById("learner-"+id).value;' +
    'const text=document.getElementById("text-"+id).value;' +
    'const nextDate=document.getElementById("nextdate-"+id).value;' +
    'const nextStart=document.getElementById("nextstart-"+id).value;' +
    'const nextEnd=document.getElementById("nextend-"+id).value;' +
    'if(text.trim())entries.push({sheetName:sheetName,learner:learner,text:text,nextDate:nextDate,nextStart:nextStart,nextEnd:nextEnd});});' +
    'if(entries.length===0){setStatus("記録内容が入力されていません。先に「AIで要約を作成」を押すか、直接入力してください。");return;}' +
    'setStatus("書き込み中...");' +
    'google.script.run.withSuccessHandler(function(results){' +
    'setStatus(results.map(function(r){' +
    'let line=(r.status==="written"?"✅ ":"❌ ")+r.sheetName+" / "+r.learner+" / "+(r.status==="written"?r.cell:r.error);' +
    'if(r.nextScheduleStatus==="updated")line+="(次回日程も反映)";' +
    'if(r.nextScheduleStatus==="error")line+="(次回日程の反映に失敗: "+r.nextScheduleError+")";' +
    'return line;' +
    '}).join("\\n"));' +
    'if(entries.length===1&&results[0]&&results[0].status==="written"){' +
    'saveLastParticipant_(entries[0].sheetName,entries[0].learner);}' +
    '}).withFailureHandler(function(err){setStatus("書き込みエラー: "+err.message);})' +
    '.submitEntries(entries);}' +

    'function populateViewTarget(){' +
    'const sel=document.getElementById("viewTarget");const prev=sel.value;let html="";' +
    'if(structure.length){html+="<optgroup label=\\"企業\\">"+structure.map(function(s){' +
    'return "<option value=\\"c:"+esc(s.sheetName)+"\\">"+esc(s.sheetName)+"</option>";}).join("")+"</optgroup>";}' +
    'if(groupsCache.length){html+="<optgroup label=\\"グループ(集団相談)\\">"+groupsCache.map(function(g){' +
    'return "<option value=\\"g:"+esc(g.name)+"\\">"+esc(g.name)+"</option>";}).join("")+"</optgroup>";}' +
    'sel.innerHTML=html;' +
    'if(prev)sel.value=prev;' +
    'if(!sel.value&&sel.options.length)sel.selectedIndex=0;' +
    'if(document.getElementById("viewTab").style.display!=="none")ensureViewLoaded();}' +

    'function ensureViewLoaded(){' +
    'if(viewLoaded)return;' +
    'const sel=document.getElementById("viewTarget");' +
    'if(!sel||!sel.options.length)return;' +
    'viewLoaded=true;onViewTargetChange();}' +

    'function setViewStatus(msg){document.getElementById("viewStatus").textContent=msg||"";}' +

    'function loadNextScheduleList(){' +
    'const el=document.getElementById("nextScheduleList");el.textContent="読み込み中...";' +
    'google.script.run.withSuccessHandler(renderNextScheduleList)' +
    '.withFailureHandler(function(err){el.textContent="エラー: "+err.message;})' +
    '.getNextScheduleList();}' +

    'function renderNextScheduleList(list){' +
    'const el=document.getElementById("nextScheduleList");el.innerHTML="";' +
    'if(!list||list.length===0){el.textContent="次回日程が登録されている受講者はいません。";return;}' +
    'const todayStr=new Date().toISOString().slice(0,10);' +
    'list.forEach(function(item){' +
    'const card=document.createElement("div");card.className="card";' +
    'const isPast=item.nextDate<todayStr;' +
    'card.innerHTML="<b>"+esc(item.sheetName)+" / "+esc(item.learner)+"</b>"' +
    '+"<span class=\\""+(isPast?"badge badge-alert":"badge")+"\\">"+esc(item.nextDate)' +
    '+(item.nextStart?" "+esc(item.nextStart):"")+(item.nextEnd?"〜"+esc(item.nextEnd):"")+"</span>"' +
    '+(isPast?"<span class=\\"badge badge-muted\\">日付経過(未更新の可能性)</span>":"");' +
    'el.appendChild(card);});}' +

    'function setViewMode(m){viewMode=m;' +
    'document.getElementById("modebtn-cards").classList.toggle("active",m==="cards");' +
    'document.getElementById("modebtn-table").classList.toggle("active",m==="table");' +
    'onViewTargetChange();}' +

    'function onViewTargetChange(){' +
    'const v=document.getElementById("viewTarget").value;' +
    'const panes=document.getElementById("viewPanes");' +
    'const matrix=document.getElementById("companyMatrix");' +
    'const modeWrap=document.getElementById("viewModeWrap");' +
    'matrix.innerHTML="";' +
    'if(!v){panes.style.display="none";setViewStatus("表示できる企業がまだありません。「登録・管理」タブで企業と受講者を登録してください。");return;}' +
    'const kind=v.slice(0,2),name=v.slice(2);' +
    'if(kind==="g:"){' +
    'modeWrap.style.display="none";panes.style.display="";' +
    'loadGroupMembers(name);return;}' +
    'modeWrap.style.display="";' +
    'if(viewMode==="table"){panes.style.display="none";loadCompanyMatrix(name);}' +
    'else{panes.style.display="";loadCompanyMembers(name);}}' +

    'function loadCompanyMembers(sheetName){' +
    'setViewStatus("読み込み中...");' +
    'google.script.run.withSuccessHandler(function(list){setViewStatus("");' +
    'renderMemberList((list||[]).map(function(it){' +
    'return {sheetName:sheetName,learner:it.learner,recordCount:it.recordCount,lastDate:it.lastDate};}));})' +
    '.withFailureHandler(function(err){setViewStatus("エラー: "+err.message);})' +
    '.getCompanyOverview(sheetName);}' +

    'function loadGroupMembers(groupName){' +
    'setViewStatus("読み込み中...");' +
    'google.script.run.withSuccessHandler(function(list){setViewStatus("");' +
    'renderMemberList((list||[]).map(function(it){' +
    'return {sheetName:it.sheetName,learner:it.learner,recordCount:it.recordCount,' +
    'lastDate:it.lastDate,error:it.error,showCompany:true};}));})' +
    '.withFailureHandler(function(err){setViewStatus("エラー: "+err.message);})' +
    '.getGroupOverview(groupName);}' +

    'function renderMemberList(items){' +
    'const el=document.getElementById("memberList");el.innerHTML="";' +
    'const detail=document.getElementById("memberDetail");detail.innerHTML="";' +
    'if(!items.length){el.innerHTML="<div class=\\"pane-empty\\">受講者がいません。</div>";return;}' +
    'let firstSelectable=null;' +
    'items.forEach(function(it){' +
    'const row=document.createElement("div");row.className="member";' +
    'row.innerHTML="<div class=\\"member-name\\">"+esc(it.learner)+"</div>"' +
    '+(it.showCompany?"<div class=\\"member-sub\\">"+esc(it.sheetName)+"</div>":"")' +
    '+"<div class=\\"member-meta\\">"+(it.error?esc(it.error):' +
    '("記録"+it.recordCount+"件"+(it.lastDate?"　直近 "+esc(it.lastDate):"")))+"</div>";' +
    'row.addEventListener("click",function(){selectMember(it,row);});' +
    'el.appendChild(row);' +
    'if(!it.error&&!firstSelectable)firstSelectable={item:it,row:row};});' +
    'if(firstSelectable)selectMember(firstSelectable.item,firstSelectable.row);' +
    'else detail.innerHTML="<div class=\\"pane-empty\\">表示できる記録がありません。</div>";}' +

    'function selectMember(item,row){' +
    'const rows=document.querySelectorAll("#memberList .member");' +
    'Array.prototype.forEach.call(rows,function(r){r.classList.remove("active");});' +
    'row.classList.add("active");' +
    'const detail=document.getElementById("memberDetail");' +
    'if(item.error){detail.innerHTML="<div class=\\"pane-empty\\">"+esc(item.error)+"</div>";return;}' +
    'detail.innerHTML="<div class=\\"pane-empty\\">読み込み中...</div>";' +
    'google.script.run.withSuccessHandler(function(records){renderMemberDetail(item,records);})' +
    '.withFailureHandler(function(err){detail.innerHTML="<div class=\\"pane-empty\\">エラー: "+esc(err.message)+"</div>";})' +
    '.getLearnerHistory(item.sheetName,item.learner);}' +

    'function renderMemberDetail(item,records){' +
    'const el=document.getElementById("memberDetail");el.innerHTML="";' +
    'const head=document.createElement("div");head.className="detail-head";' +
    'head.innerHTML=esc(item.sheetName)+" / "+esc(item.learner)' +
    '+"<span class=\\"badge\\">記録"+records.length+"件</span>";' +
    'el.appendChild(head);' +
    'if(!records.length){' +
    'const empty=document.createElement("div");empty.className="pane-empty";' +
    'empty.textContent="まだ記録がありません。";el.appendChild(empty);return;}' +
    'records.forEach(function(r){' +
    'const card=document.createElement("div");card.className="card";' +
    'card.innerHTML=(r.date?"<span class=\\"badge\\">"+esc(r.date)+"</span>":"")' +
    '+"<div class=\\"cardtext\\">"+esc(r.text)+"</div>";' +
    'el.appendChild(card);});}' +

    'function loadCompanyMatrix(sheetName){' +
    'const el=document.getElementById("companyMatrix");el.textContent="読み込み中...";' +
    'google.script.run.withSuccessHandler(renderCompanyMatrix)' +
    '.withFailureHandler(function(err){el.textContent="エラー: "+err.message;})' +
    '.getCompanyMatrix(sheetName);}' +

    'function renderCompanyMatrix(data){' +
    'const el=document.getElementById("companyMatrix");el.innerHTML="";' +
    'if(!data.learners||data.learners.length===0){el.textContent="受講者が見つかりません。";return;}' +
    'if(data.rows.length===0){el.textContent="まだ記録がありません。";return;}' +
    'let html="<div class=\\"matrix-wrap\\"><table class=\\"matrix\\"><thead><tr><th>回数</th>";' +
    'data.learners.forEach(function(l){html+="<th>"+esc(l)+"</th>";});' +
    'html+="</tr></thead><tbody>";' +
    'data.rows.forEach(function(row){' +
    'html+="<tr><th>"+row.index+"回目</th>";' +
    'row.cells.forEach(function(c){html+="<td>"+(c?esc(c):"")+"</td>";});' +
    'html+="</tr>";});' +
    'html+="</tbody></table></div>";' +
    'el.innerHTML=html;}' +

    'function allCompanyOptionsHtml(){return allCompanyNames.map(function(n){' +
    'return "<option value=\\""+esc(n)+"\\">"+esc(n)+"</option>";}).join("");}' +

    'function populateLearnerCompanySelect(){' +
    'document.getElementById("learnerCompanySelect").innerHTML=allCompanyOptionsHtml();}' +

    'function createCompanyClick(){' +
    'const input=document.getElementById("newCompanyName");const name=input.value.trim();' +
    'const statusEl=document.getElementById("companyCreateStatus");' +
    'if(!name){statusEl.textContent="企業名を入力してください。";return;}' +
    'statusEl.textContent="登録中...";' +
    'google.script.run.withSuccessHandler(function(){' +
    'if(allCompanyNames.indexOf(name)===-1)allCompanyNames.push(name);' +
    'populateLearnerCompanySelect();' +
    'input.value="";' +
    'statusEl.textContent="✅ 登録しました: "+name+"(続けて受講者を登録してください)";' +
    '}).withFailureHandler(function(err){statusEl.textContent="❌ "+err.message;})' +
    '.createCompany(name);}' +

    'function createLearnerClick(){' +
    'const sheetName=document.getElementById("learnerCompanySelect").value;' +
    'const input=document.getElementById("newLearnerNames");' +
    'const names=input.value.split("\\n").map(function(s){return s.trim();}).filter(function(s){return s;});' +
    'const statusEl=document.getElementById("learnerCreateStatus");' +
    'if(!sheetName){statusEl.textContent="企業(シート)を選択してください。";return;}' +
    'if(names.length===0){statusEl.textContent="受講者名を1人以上入力してください。";return;}' +
    'statusEl.textContent="登録中...";' +
    'google.script.run.withSuccessHandler(function(data){' +
    'structure=data.structure;populateViewTarget();' +
    'const lines=data.results.map(function(r){' +
    'return (r.status==="created"?"✅ ":"❌ ")+r.learner+(r.status==="error"?"("+r.error+")":"");});' +
    'if(data.results.some(function(r){return r.status==="created";}))input.value="";' +
    'statusEl.textContent=lines.join("\\n");' +
    '}).withFailureHandler(function(err){statusEl.textContent="❌ "+err.message;})' +
    '.createLearners(sheetName,names);}' +

    'function addGroupRow(){groupRowCount++;const id=groupRowCount;const div=document.createElement("div");div.className="row";div.id="grouprow-"+id;' +
    'div.innerHTML="<span class=\\"remove\\" onclick=\\"removeGroupRow("+id+")\\">✕ 削除</span>"+' +
    '"<div class=\\"field-grid\\">"+' +
    '"<div class=\\"field\\"><label>企業(シート)</label><select onchange=\\"updateGroupLearners("+id+")\\" id=\\"gsheet-"+id+"\\">"+sheetOptionsHtml()+"</select></div>"+' +
    '"<div class=\\"field\\"><label>受講者</label><select id=\\"glearner-"+id+"\\"></select></div>"+' +
    '"</div>";' +
    'document.getElementById("groupRows").appendChild(div);updateGroupLearners(id);}' +

    'function updateGroupLearners(id){' +
    'document.getElementById("glearner-"+id).innerHTML=learnerOptionsHtml(document.getElementById("gsheet-"+id).value);}' +

    'function removeGroupRow(id){const el=document.getElementById("grouprow-"+id);if(el)el.remove();}' +

    'function saveGroupClick(){' +
    'const name=document.getElementById("newGroupName").value.trim();' +
    'const rows=document.querySelectorAll("#groupRows .row");const members=[];' +
    'rows.forEach(function(row){const id=row.id.split("-")[1];' +
    'members.push({sheetName:document.getElementById("gsheet-"+id).value,learner:document.getElementById("glearner-"+id).value});});' +
    'const statusEl=document.getElementById("groupSaveStatus");' +
    'if(!name){statusEl.textContent="グループ名を入力してください。";return;}' +
    'if(members.length===0){statusEl.textContent="メンバーを1人以上追加してください。";return;}' +
    'statusEl.textContent="保存中...";' +
    'google.script.run.withSuccessHandler(function(groups){' +
    'renderGroupList(groups);' +
    'document.getElementById("newGroupName").value="";' +
    'document.getElementById("groupRows").innerHTML="";groupRowCount=0;addGroupRow();' +
    'statusEl.textContent="✅ 保存しました: "+name;' +
    '}).withFailureHandler(function(err){statusEl.textContent="❌ "+err.message;})' +
    '.saveGroup(name,members);}' +

    'function renderGroupList(groups){' +
    'groupsCache=groups||[];populateGroupSelects();' +
    'const el=document.getElementById("groupList");el.innerHTML="";' +
    'if(!groups||groups.length===0){el.textContent="保存されているグループはまだありません。";return;}' +
    'groups.forEach(function(g){' +
    'const card=document.createElement("div");card.className="card";' +
    'const memberText=g.members.map(function(m){return esc(m.sheetName)+":"+esc(m.learner);}).join("、");' +
    'card.innerHTML="<b>"+esc(g.name)+"</b><div class=\\"cardtext\\">"+memberText+"</div>";' +
    'const useBtn=document.createElement("button");useBtn.className="primary";useBtn.textContent="記録追加に使う";' +
    'useBtn.addEventListener("click",function(){applyGroupToWriteTab(g);});' +
    'const delBtn=document.createElement("button");delBtn.textContent="削除";' +
    'delBtn.addEventListener("click",function(){deleteGroupClick(g.name);});' +
    'card.appendChild(useBtn);card.appendChild(delBtn);el.appendChild(card);});}' +

    'function deleteGroupClick(name){' +
    'google.script.run.withSuccessHandler(renderGroupList)' +
    '.withFailureHandler(function(err){document.getElementById("groupList").textContent="エラー: "+err.message;})' +
    '.deleteGroup(name);}' +

    'function applyGroupToWriteTab(g){' +
    'showTab("write");' +
    'document.getElementById("rows").innerHTML="";' +
    'g.members.forEach(function(m){' +
    'addRow();' +
    'const all=document.querySelectorAll("#rows .row");const row=all[all.length-1];' +
    'const id=row.id.split("-")[1];' +
    'document.getElementById("sheet-"+id).value=m.sheetName;' +
    'updateLearners(id);' +
    'document.getElementById("learner-"+id).value=m.learner;});' +
    'setStatus("グループ「"+g.name+"」のメンバーを対象者欄に反映しました。VTTを選ぶか、直接記録内容を入力してください。");}' +

    'function populateGroupSelects(){' +
    'const opts="<option value=\\"\\">(グループを選択)</option>"+groupsCache.map(function(g){' +
    'return "<option value=\\""+esc(g.name)+"\\">"+esc(g.name)+"</option>";}).join("");' +
    'const writeSel=document.getElementById("groupSelect");if(writeSel)writeSel.innerHTML=opts;' +
    'populateViewTarget();}' +

    'function loadGroupIntoWriteTab(){' +
    'const name=document.getElementById("groupSelect").value;' +
    'if(!name){setStatus("グループを選択してください。");return;}' +
    'const g=groupsCache.find(function(x){return x.name===name;});' +
    'if(!g){setStatus("グループが見つかりません: "+name);return;}' +
    'applyGroupToWriteTab(g);}' +

    '</script></body></html>';
}

// GeminiRaytechの疎通確認用(モデル名の動作確認・権限承認の再トリガーに使う一時的なテスト関数)。
// 末尾が"_"で終わらない名前なので、エディタの実行関数プルダウンに表示される。
function testGemini() {
  var text = GeminiRaytech.generateText('こんにちは', GEMINI_MODEL_DEFAULT);
  Logger.log(text);
}

/**
 * 権限調査用。エディタから実行し、実行ログの内容をそのまま共有すること。
 *
 * `ACCESS_TOKEN_SCOPE_INSUFFICIENT` (403) が出たときに、原因が
 *   (A) このスクリプトのトークンに cloud-platform スコープが乗っていない
 *   (B) スコープは乗っているが、組織側でVertex AIの利用が許可されていない
 * のどちらなのかを切り分けるための関数。エラー文言だけでは区別がつかないため、
 * Googleのtokeninfoエンドポイントに実際のトークンを問い合わせて、付与されている
 * スコープ一覧を表示する。
 *
 * cloud-platform が「いいえ」なら(A)で、appsscript.jsonにoauthScopesを明示するか
 * 承認をやり直す話になる。「はい」なら(B)で、AI推進室/情報システム部への確認が必要。
 *
 * 注意: アクセストークン自体はログに出さないこと(出力するのはスコープ名のみ)。
 */
function checkOAuthScopes() {
  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(ScriptApp.getOAuthToken()),
    { muteHttpExceptions: true }
  );
  var info = {};
  try {
    info = JSON.parse(res.getContentText()) || {};
  } catch (err) {
    Logger.log('tokeninfoの応答を解釈できませんでした (HTTP ' + res.getResponseCode() + '): ' + res.getContentText());
    return;
  }

  var scopes = String(info.scope || '').split(' ').filter(function (s) { return s; }).sort();
  Logger.log('===== このスクリプトのトークンが持つスコープ (' + scopes.length + '件) =====');
  for (var i = 0; i < scopes.length; i++) {
    Logger.log('  ' + scopes[i]);
  }
  Logger.log('===== 判定 =====');
  Logger.log('cloud-platform を含むか: ' +
    (scopes.indexOf('https://www.googleapis.com/auth/cloud-platform') !== -1 ? 'はい' : 'いいえ'));
  Logger.log('アカウント: ' + (info.email || '(userinfo.emailスコープが無いため取得できず)'));
}
