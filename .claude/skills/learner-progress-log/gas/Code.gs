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
 * 使い方・導入手順は同じフォルダの DEPLOY.md を参照。
 */

// 集団相談用のグループ定義を保存する管理シートの名前。
// 企業(受講者)一覧には絶対に含めないこと(listStructure_側でも除外している)。
var GROUP_SHEET_NAME = 'グループ設定';

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
    if (sh.getName() === GROUP_SHEET_NAME) continue; // グループ設定用の管理シートは除外
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
  if (companyName === GROUP_SHEET_NAME) {
    throw new Error('この名前は管理用に予約されているため使用できません: ' + companyName);
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(companyName)) {
    throw new Error('同名のシートが既に存在します: ' + companyName);
  }
  ss.insertSheet(companyName);
  return { sheetName: companyName };
}

// Webアプリ側のJavaScriptから呼ばれる。既存の企業(シート)に受講者(列)を追加する。
function createLearner(sheetName, learnerName) {
  learnerName = String(learnerName || '').trim();
  if (!learnerName) throw new Error('受講者名を入力してください。');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
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
  return listStructure_(ss);
}

// ===== 書き込み =====

/**
 * entries: [{ sheetName, learner, text }, ...]
 * 集団相談の場合、ダイアログ側で同じ text を持つ行を複数追加して渡す。
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

      results.push({
        sheetName: entry.sheetName,
        learner: entry.learner,
        status: 'written',
        cell: cell.getA1Notation()
      });
    } catch (err) {
      results.push({ sheetName: entry.sheetName, learner: entry.learner, status: 'error', error: String(err) });
    }
  }
  return results;
}

function findLearnerColumn_(sheet, learnerName) {
  var lastCol = sheet.getLastColumn();
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
  var model = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || undefined; // 未設定ならライブラリの既定(gemini-2.5-flash)
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
  var text = GeminiRaytech.generateText('こんにちは');
  Logger.log(text);
}

function buildWebAppHtml_() {
  return '<!DOCTYPE html><html><head><base target="_top">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' +
    ':root{--sf-blue:#0176d3;--sf-blue-dark:#014486;--sf-navy:#16325c;--sf-text:#3e3e3c;' +
    '--sf-muted:#706e6b;--sf-border:#dddbda;--sf-bg:#f3f2f2;--sf-danger:#ba0517;--sf-input-border:#c9c7c5;}' +
    '*{box-sizing:border-box;}' +
    'body{margin:0;background:var(--sf-bg);color:var(--sf-text);' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:15px;}' +
    '.sf-header{background:var(--sf-navy);color:#fff;padding:16px 24px;font-size:17px;font-weight:700;' +
    'display:flex;align-items:center;gap:8px;}' +
    '.sf-dot{width:9px;height:9px;border-radius:50%;background:var(--sf-blue);display:inline-block;flex:none;}' +
    '.sf-container{max-width:860px;margin:24px auto;padding:0 20px 48px;transition:max-width .15s;}' +
    '.sf-container.wide{max-width:1360px;}' +
    '.sf-card{background:#fff;border:1px solid var(--sf-border);border-radius:8px;' +
    'box-shadow:0 1px 3px rgba(0,0,0,.08);padding:28px 32px 32px;}' +
    'h2{margin:0 0 4px;font-size:19px;font-weight:700;color:var(--sf-navy);}' +
    'h3{margin:0 0 4px;font-size:15.5px;font-weight:700;color:var(--sf-navy);}' +
    '.hint{font-size:13px;color:var(--sf-muted);line-height:1.6;margin:0 0 18px;}' +
    '.field{margin-bottom:18px;}' +
    'label{display:block;font-weight:600;font-size:13.5px;color:var(--sf-text);margin-bottom:6px;}' +
    'input[type=file],input[type=date],input[type=text],select,textarea{width:100%;font-family:inherit;font-size:15px;' +
    'color:var(--sf-text);border:1px solid var(--sf-input-border);border-radius:4px;padding:9px 12px;background:#fff;}' +
    'input[type=file]{padding:6px;}' +
    'select:focus,input:focus,textarea:focus{outline:none;border-color:var(--sf-blue);box-shadow:0 0 0 1px var(--sf-blue);}' +
    '.row{border:1px solid var(--sf-border);background:#fafaf9;border-radius:8px;padding:16px;margin-bottom:16px;position:relative;}' +
    '.row textarea{height:160px;margin-top:0;}' +
    '.remove{position:absolute;top:14px;right:16px;color:var(--sf-danger);cursor:pointer;font-size:12.5px;font-weight:600;}' +
    '.remove:hover{text-decoration:underline;}' +
    'button{font-family:inherit;padding:9px 18px;margin:0 8px 8px 0;border-radius:4px;' +
    'border:1px solid var(--sf-input-border);background:#fff;color:var(--sf-blue);font-size:13.5px;font-weight:600;cursor:pointer;}' +
    'button:hover{background:var(--sf-bg);}' +
    '.primary{background:var(--sf-blue);border-color:var(--sf-blue);color:#fff;}' +
    '.primary:hover{background:var(--sf-blue-dark);border-color:var(--sf-blue-dark);}' +
    '#status{margin-top:16px;white-space:pre-wrap;font-size:13.5px;color:var(--sf-text);}' +
    '.tabs{display:flex;gap:4px;border-bottom:1px solid var(--sf-border);margin-bottom:24px;}' +
    '.tabbtn{background:none;border:none;border-bottom:3px solid transparent;border-radius:0;' +
    'padding:11px 16px;margin:0;font-size:14.5px;font-weight:600;color:var(--sf-muted);cursor:pointer;}' +
    '.tabbtn:hover{color:var(--sf-blue);background:none;}' +
    '.tabbtn.active{border-bottom-color:var(--sf-blue);color:var(--sf-blue);}' +
    '.card{border:1px solid var(--sf-border);border-radius:8px;padding:16px;margin-bottom:12px;background:#fff;}' +
    '.card b{color:var(--sf-navy);font-size:14.5px;}' +
    '.badge{display:inline-block;background:#eaf5fe;color:var(--sf-blue-dark);border-radius:10px;' +
    'padding:3px 11px;font-size:12px;font-weight:600;margin-left:6px;}' +
    '.badge-muted{background:var(--sf-bg);color:var(--sf-muted);}' +
    '.cardtext{white-space:pre-wrap;margin-top:10px;font-size:13.5px;color:var(--sf-text);line-height:1.6;' +
    'background:#faf9f8;border:1px solid #f0efed;border-radius:6px;padding:12px;}' +
    '#companyOverview,#learnerHistory,#companyMatrix,#groupOverview{margin-top:14px;}' +
    'hr{border:none;border-top:1px solid var(--sf-border);margin:26px 0;}' +
    '.matrix-wrap{overflow-x:auto;border:1px solid var(--sf-border);border-radius:8px;}' +
    'table.matrix{border-collapse:collapse;width:100%;}' +
    '.matrix th,.matrix td{border:1px solid var(--sf-border);padding:11px 14px;font-size:13px;' +
    'vertical-align:top;white-space:pre-wrap;min-width:220px;}' +
    '.matrix thead th{background:var(--sf-navy);color:#fff;font-weight:600;white-space:nowrap;}' +
    '.matrix tbody th{background:#fff;color:var(--sf-navy);font-weight:700;text-align:center;' +
    'white-space:nowrap;min-width:auto;}' +
    '.matrix thead th:first-child,.matrix tbody th{position:sticky;left:0;}' +
    '.matrix tbody tr:nth-child(even) td,.matrix tbody tr:nth-child(even) th{background:#faf9f8;}' +
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
    '<p class="hint">Zoomの文字起こし(.vtt)をアップロードして「AIで要約を作成」を押すと、下の記録内容欄に' +
    '下書きが自動で入ります。内容を確認・必要なら修正してから「この内容で書き込む」を押してください。</p>' +

    '<div class="field"><label>グループから対象者を読み込む(任意・集団相談の場合)</label>' +
    '<select id="groupSelect"></select></div>' +
    '<button onclick="loadGroupIntoWriteTab()">このグループを対象者欄に読み込む</button>' +
    '<hr>' +

    '<div class="field"><label>VTTファイル</label><input type="file" id="vttFile" accept=".vtt"></div>' +
    '<div class="field"><label>実施日</label><input type="date" id="sessionDate"></div>' +

    '<div id="rows"></div>' +
    '<button onclick="addRow()">+ 対象者を追加(集団相談の場合)</button>' +
    '<br>' +
    '<button class="primary" onclick="generateAll()">AIで要約を作成</button>' +
    '<button class="primary" onclick="submitAll()">この内容で書き込む</button>' +
    '<div id="status"></div>' +
    '</div>' +

    '<div id="viewTab" style="display:none">' +
    '<h2>進捗を確認</h2>' +
    '<p class="hint">企業を選ぶと、その企業の全受講者について直近の記録を一覧できます。' +
    '受講者を選んで「全記録を見る」を押すと、その人の全期間の記録を新しい順に確認できます。' +
    '「表でまとめて見る」では、回数を縦・受講者を横並びにした一覧表で見られます(PC画面向け)。</p>' +
    '<div class="field"><label>企業(シート)</label><select id="viewSheet" onchange="onViewSheetChange()"></select></div>' +
    '<button onclick="loadCompanyOverview()">この企業の最新状況を一覧</button>' +
    '<button onclick="loadCompanyMatrix()">表でまとめて見る(PC向け)</button>' +
    '<div id="companyOverview"></div>' +
    '<div id="companyMatrix"></div>' +
    '<hr>' +
    '<div class="field"><label>受講者</label><select id="viewLearner"></select></div>' +
    '<button onclick="loadLearnerHistory()">この受講者の全記録を見る</button>' +
    '<div id="learnerHistory"></div>' +

    '<hr>' +
    '<h3>グループで見る</h3>' +
    '<p class="hint">集団相談のグループ単位で、メンバー全員(企業をまたいでもよい)の直近の記録をまとめて確認できます。</p>' +
    '<div class="field"><label>グループ</label><select id="viewGroupSelect"></select></div>' +
    '<button onclick="loadGroupOverview()">このグループの状況を一覧</button>' +
    '<div id="groupOverview"></div>' +
    '</div>' +

    '<div id="manageTab" style="display:none">' +
    '<h2>企業・受講者の登録</h2>' +
    '<p class="hint">新しい企業(シート)や受講者を追加できます。企業を登録した直後は受講者が0人なので、' +
    'このあと続けて受講者を最低1人登録してください(受講者が0人の間は他の画面のプルダウンにまだ出てきません)。</p>' +

    '<div class="field"><label>新しい企業名</label><input type="text" id="newCompanyName" placeholder="例: サンプル商事株式会社"></div>' +
    '<button class="primary" onclick="createCompanyClick()">企業を登録</button>' +
    '<div id="companyCreateStatus" class="hint"></div>' +

    '<hr>' +

    '<div class="field"><label>企業(シート)</label><select id="learnerCompanySelect"></select></div>' +
    '<div class="field"><label>新しい受講者名</label><input type="text" id="newLearnerName" placeholder="例: 山田太郎"></div>' +
    '<button class="primary" onclick="createLearnerClick()">受講者を登録</button>' +
    '<div id="learnerCreateStatus" class="hint"></div>' +

    '<hr>' +

    '<h2>グループ管理(集団相談用)</h2>' +
    '<p class="hint">よく行う集団相談の組み合わせを「グループ」として保存しておくと、' +
    '「記録を追加」タブで対象者欄をまとめて呼び出せます(複数企業にまたがってもよい)。</p>' +
    '<div id="groupList"></div>' +
    '<div id="groupRows"></div>' +
    '<button onclick="addGroupRow()">+ メンバーを追加</button>' +
    '<br>' +
    '<div class="field"><label>グループ名</label><input type="text" id="newGroupName" placeholder="例: サンプル商事+テスト工業 合同研修"></div>' +
    '<button class="primary" onclick="saveGroupClick()">このメンバーでグループを保存</button>' +
    '<div id="groupSaveStatus" class="hint"></div>' +
    '</div>' +

    '</div></div>' +

    '<script>' +
    'let structure=[];let rowCount=0;let groupRowCount=0;let vttText="";let groupsCache=[];' +
    'google.script.run.withSuccessHandler(function(data){' +
    'structure=data;addRow();populateViewSheet();populateLearnerCompanySelect();addGroupRow();})' +
    '.withFailureHandler(function(err){setStatus("読み込みエラー: "+err.message);})' +
    '.getStructureForDialog();' +
    'google.script.run.withSuccessHandler(renderGroupList)' +
    '.withFailureHandler(function(err){document.getElementById("groupList").textContent="読み込みエラー: "+err.message;})' +
    '.getGroups();' +

    'document.getElementById("vttFile").addEventListener("change",function(ev){' +
    'const f=ev.target.files[0];if(!f)return;' +
    'const reader=new FileReader();' +
    'reader.onload=function(e){vttText=e.target.result;setStatus("VTT読み込み完了: "+f.name);};' +
    'reader.readAsText(f);});' +

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
    'document.getElementById("sfContainer").classList.toggle("wide",name==="view");}' +

    'function addRow(){rowCount++;const id=rowCount;const div=document.createElement("div");div.className="row";div.id="row-"+id;' +
    'div.innerHTML="<span class=\\"remove\\" onclick=\\"removeRow("+id+")\\">✕ 削除</span>"+' +
    '"<label>企業(シート)</label><select onchange=\\"updateLearners("+id+")\\" id=\\"sheet-"+id+"\\">"+sheetOptionsHtml()+"</select>"+' +
    '"<label>受講者</label><select id=\\"learner-"+id+"\\"></select>"+' +
    '"<label>記録内容</label><textarea id=\\"text-"+id+"\\" placeholder=\\"「AIで要約を作成」を押すとここに下書きが入ります\\"></textarea>";' +
    'document.getElementById("rows").appendChild(div);updateLearners(id);}' +

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
    'if(text.trim())entries.push({sheetName:sheetName,learner:learner,text:text});});' +
    'if(entries.length===0){setStatus("記録内容が入力されていません。先に「AIで要約を作成」を押すか、直接入力してください。");return;}' +
    'setStatus("書き込み中...");' +
    'google.script.run.withSuccessHandler(function(results){' +
    'setStatus(results.map(function(r){' +
    'return (r.status==="written"?"✅ ":"❌ ")+r.sheetName+" / "+r.learner+" / "+(r.status==="written"?r.cell:r.error);' +
    '}).join("\\n"));' +
    '}).withFailureHandler(function(err){setStatus("書き込みエラー: "+err.message);})' +
    '.submitEntries(entries);}' +

    'function populateViewSheet(){' +
    'document.getElementById("viewSheet").innerHTML=sheetOptionsHtml();' +
    'onViewSheetChange();}' +

    'function onViewSheetChange(){' +
    'document.getElementById("viewLearner").innerHTML=learnerOptionsHtml(document.getElementById("viewSheet").value);}' +

    'function loadCompanyOverview(){' +
    'const sheetName=document.getElementById("viewSheet").value;' +
    'const el=document.getElementById("companyOverview");el.textContent="読み込み中...";' +
    'google.script.run.withSuccessHandler(renderCompanyOverview)' +
    '.withFailureHandler(function(err){el.textContent="エラー: "+err.message;})' +
    '.getCompanyOverview(sheetName);}' +

    'function renderCompanyOverview(list){' +
    'const el=document.getElementById("companyOverview");el.innerHTML="";' +
    'if(list.length===0){el.textContent="受講者が見つかりません。";return;}' +
    'list.forEach(function(item){' +
    'const card=document.createElement("div");card.className="card";' +
    'card.innerHTML="<b>"+esc(item.learner)+"</b>"' +
    '+"<span class=\\"badge\\">記録"+item.recordCount+"件</span>"' +
    '+(item.lastDate?"<span class=\\"badge badge-muted\\">直近 "+esc(item.lastDate)+"</span>":"")' +
    '+"<div class=\\"cardtext\\">"+esc(item.lastText||"(記録なし)")+"</div>";' +
    'const btn=document.createElement("button");btn.textContent="全履歴を見る";' +
    'btn.addEventListener("click",function(){selectLearnerAndLoad(item.learner);});' +
    'card.appendChild(btn);el.appendChild(card);});}' +

    'function loadCompanyMatrix(){' +
    'const sheetName=document.getElementById("viewSheet").value;' +
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

    'function selectLearnerAndLoad(learner){' +
    'document.getElementById("viewLearner").value=learner;' +
    'loadLearnerHistory();}' +

    'function loadLearnerHistory(){' +
    'const sheetName=document.getElementById("viewSheet").value;' +
    'const learner=document.getElementById("viewLearner").value;' +
    'const el=document.getElementById("learnerHistory");el.textContent="読み込み中...";' +
    'google.script.run.withSuccessHandler(renderLearnerHistory)' +
    '.withFailureHandler(function(err){el.textContent="エラー: "+err.message;})' +
    '.getLearnerHistory(sheetName,learner);}' +

    'function renderLearnerHistory(records){' +
    'const el=document.getElementById("learnerHistory");el.innerHTML="";' +
    'if(records.length===0){el.textContent="記録がありません。";return;}' +
    'records.forEach(function(r){' +
    'const card=document.createElement("div");card.className="card";' +
    'card.innerHTML=(r.date?"<span class=\\"badge\\">"+esc(r.date)+"</span>":"")' +
    '+"<div class=\\"cardtext\\">"+esc(r.text)+"</div>";' +
    'el.appendChild(card);});}' +

    'function populateLearnerCompanySelect(){' +
    'document.getElementById("learnerCompanySelect").innerHTML=sheetOptionsHtml();}' +

    'function createCompanyClick(){' +
    'const input=document.getElementById("newCompanyName");const name=input.value.trim();' +
    'const statusEl=document.getElementById("companyCreateStatus");' +
    'if(!name){statusEl.textContent="企業名を入力してください。";return;}' +
    'statusEl.textContent="登録中...";' +
    'google.script.run.withSuccessHandler(function(){' +
    'structure.push({sheetName:name,learners:[]});' +
    'populateViewSheet();populateLearnerCompanySelect();' +
    'input.value="";' +
    'statusEl.textContent="✅ 登録しました: "+name+"(続けて受講者を登録してください)";' +
    '}).withFailureHandler(function(err){statusEl.textContent="❌ "+err.message;})' +
    '.createCompany(name);}' +

    'function createLearnerClick(){' +
    'const sheetName=document.getElementById("learnerCompanySelect").value;' +
    'const input=document.getElementById("newLearnerName");const name=input.value.trim();' +
    'const statusEl=document.getElementById("learnerCreateStatus");' +
    'if(!name){statusEl.textContent="受講者名を入力してください。";return;}' +
    'statusEl.textContent="登録中...";' +
    'google.script.run.withSuccessHandler(function(data){' +
    'structure=data;populateViewSheet();populateLearnerCompanySelect();' +
    'input.value="";' +
    'statusEl.textContent="✅ 登録しました: "+sheetName+" / "+name;' +
    '}).withFailureHandler(function(err){statusEl.textContent="❌ "+err.message;})' +
    '.createLearner(sheetName,name);}' +

    'function addGroupRow(){groupRowCount++;const id=groupRowCount;const div=document.createElement("div");div.className="row";div.id="grouprow-"+id;' +
    'div.innerHTML="<span class=\\"remove\\" onclick=\\"removeGroupRow("+id+")\\">✕ 削除</span>"+' +
    '"<label>企業(シート)</label><select onchange=\\"updateGroupLearners("+id+")\\" id=\\"gsheet-"+id+"\\">"+sheetOptionsHtml()+"</select>"+' +
    '"<label>受講者</label><select id=\\"glearner-"+id+"\\"></select>";' +
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
    'const viewSel=document.getElementById("viewGroupSelect");if(viewSel)viewSel.innerHTML=opts;}' +

    'function loadGroupIntoWriteTab(){' +
    'const name=document.getElementById("groupSelect").value;' +
    'if(!name){setStatus("グループを選択してください。");return;}' +
    'const g=groupsCache.find(function(x){return x.name===name;});' +
    'if(!g){setStatus("グループが見つかりません: "+name);return;}' +
    'applyGroupToWriteTab(g);}' +

    'function loadGroupOverview(){' +
    'const name=document.getElementById("viewGroupSelect").value;' +
    'const el=document.getElementById("groupOverview");' +
    'if(!name){el.textContent="グループを選択してください。";return;}' +
    'el.textContent="読み込み中...";' +
    'google.script.run.withSuccessHandler(renderGroupOverview)' +
    '.withFailureHandler(function(err){el.textContent="エラー: "+err.message;})' +
    '.getGroupOverview(name);}' +

    'function renderGroupOverview(list){' +
    'const el=document.getElementById("groupOverview");el.innerHTML="";' +
    'if(!list||list.length===0){el.textContent="メンバーが見つかりません。";return;}' +
    'list.forEach(function(item){' +
    'const card=document.createElement("div");card.className="card";' +
    'const header="<b>"+esc(item.sheetName)+" / "+esc(item.learner)+"</b>";' +
    'if(item.error){' +
    'card.innerHTML=header+"<span class=\\"badge badge-muted\\">"+esc(item.error)+"</span>";' +
    '}else{' +
    'card.innerHTML=header' +
    '+"<span class=\\"badge\\">記録"+item.recordCount+"件</span>"' +
    '+(item.lastDate?"<span class=\\"badge badge-muted\\">直近 "+esc(item.lastDate)+"</span>":"")' +
    '+"<div class=\\"cardtext\\">"+esc(item.lastText||"(記録なし)")+"</div>";' +
    '}' +
    'el.appendChild(card);});}' +
    '</script></body></html>';
}
