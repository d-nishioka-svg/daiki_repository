/**
 * 学習進捗管理スプレッドシート用 Web App (GAS)
 *
 * 目的:
 *   Claude(チャット/Claude Code)からHTTP経由で「どの企業シートの、どの受講者列に、
 *   どんな記録を追記するか」だけを受け取り、実際のセル書き込みをこのスクリプト側で
 *   行う。スプレッドシートの実体をまるごとやり取りしないため、ファイルサイズや
 *   転写(文字コードの変換)の問題が起きない。
 *
 * 前提とするシート構造:
 *   - 1つのスプレッドシートの中に、企業ごとのシート(タブ)がある
 *   - 各シートの1行目(ヘッダー行)、B列以降に受講者名が入っている(A列は使わない想定)
 *   - 各受講者列に、相談記録が上から下に積み上がっている
 *
 * デプロイ方法は同じフォルダの DEPLOY.md を参照。
 */

// ===== エントリーポイント =====

function doPost(e) {
  var lock = LockService.getScriptLock();
  var gotLock = lock.tryLock(30000);
  if (!gotLock) {
    return jsonResponse_({ success: false, error: 'ロックの取得に失敗しました。少し待ってから再試行してください。' });
  }

  try {
    var body = JSON.parse(e.postData.contents);

    var props = PropertiesService.getScriptProperties();
    var expectedSecret = props.getProperty('SECRET');
    if (!expectedSecret || body.secret !== expectedSecret) {
      return jsonResponse_({ success: false, error: 'unauthorized' });
    }

    var sheetId = props.getProperty('SHEET_ID');
    if (!sheetId) {
      return jsonResponse_({ success: false, error: 'SHEET_ID がスクリプト プロパティに設定されていません' });
    }
    var ss = SpreadsheetApp.openById(sheetId);

    if (body.action === 'listStructure') {
      return jsonResponse_({ success: true, structure: listStructure_(ss) });
    } else if (body.action === 'appendEntries') {
      var results = appendEntries_(ss, body.entries || []);
      var allOk = results.every(function (r) { return r.status === 'written'; });
      return jsonResponse_({ success: allOk, results: results });
    } else {
      return jsonResponse_({ success: false, error: 'unknown action: ' + body.action });
    }
  } catch (err) {
    return jsonResponse_({ success: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// 動作確認用(ブラウザでURLを直接開いたとき用)。書き込みは行わない。
function doGet(e) {
  return jsonResponse_({ success: true, message: 'learner-progress-log Web App is running. POST を使ってください。' });
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 構造の取得 =====

/**
 * 全シートについて、シート名と「受講者名(見出し)ごとの最終使用行」の一覧を返す。
 * Claude側はこれを見て、企業名・受講者名の表記ゆれを判断してから
 * appendEntries を呼び出す想定。
 */
function listStructure_(ss) {
  var sheets = ss.getSheets();
  var out = [];
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    var lastCol = sh.getLastColumn();
    if (lastCol < 2) continue; // B列以降がないシートは対象外
    var headers = sh.getRange(1, 2, 1, lastCol - 1).getValues()[0];
    var learners = [];
    for (var c = 0; c < headers.length; c++) {
      var name = headers[c];
      if (name === '' || name === null) continue;
      var colIndex = c + 2; // B=2
      learners.push({
        learner: String(name),
        columnA1: columnToLetter_(colIndex),
        lastUsedRow: getLastUsedRow_(sh, colIndex)
      });
    }
    out.push({ sheetName: sh.getName(), learners: learners });
  }
  return out;
}

// ===== 書き込み =====

/**
 * entries: [{ sheetName, learner, text }, ...]
 * 集団相談の場合、Claude側が同じ text を持つ entry を複数件並べて渡す。
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

function columnToLetter_(col) {
  var letter = '';
  while (col > 0) {
    var rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}
