/**
 * 学習進捗管理スプレッドシート用 Apps Script
 *
 * 経緯:
 *   当初はWebアプリ(HTTP経由でClaudeから直接書き込む方式)を試みたが、
 *   1) Claude Code実行環境のネットワークポリシーでscript.google.comへの通信がブロックされる
 *   2) 会社のGoogle Workspaceポリシーで「全員(匿名)アクセス」のデプロイができない
 *   の2つが重なり、外部からの直接呼び出しは実質不可能だった。
 *
 *   そこで方針を変更: スプレッドシートに直接メニューを追加し、Claudeが用意した
 *   内容を、シートの持ち主自身がメニューからワンクリックで書き込む方式にした。
 *   外部との通信が一切発生しないため、上記どちらの制限も受けない。
 *
 * 前提とするシート構造:
 *   - 1つのスプレッドシートの中に、企業ごとのシート(タブ)がある
 *   - 各シートの1行目(ヘッダー行)、B列以降に受講者名が入っている(A列は使わない想定)
 *   - 各受講者列に、相談記録が上から下に積み上がっている
 *
 * 使い方は同じフォルダの DEPLOY.md を参照。
 */

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
