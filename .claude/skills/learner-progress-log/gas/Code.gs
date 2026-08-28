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
 * 事前に「プロジェクトの設定」→「スクリプト プロパティ」で GEMINI_API_KEY を設定しておくこと。
 * GEMINI_MODEL は省略可(未設定時は gemini-2.0-flash を使用)。
 */
function callGemini_(prompt) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEYが設定されていません。Apps Scriptエディタの' +
      '「プロジェクトの設定」→「スクリプト プロパティ」で設定してください。'
    );
  }
  var model = props.getProperty('GEMINI_MODEL') || 'gemini-2.0-flash';
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body;
  try {
    body = JSON.parse(resp.getContentText());
  } catch (e) {
    throw new Error('Gemini APIの応答を解析できませんでした: ' + resp.getContentText());
  }
  if (code !== 200) {
    var msg = body && body.error && body.error.message ? body.error.message : resp.getContentText();
    throw new Error('Gemini APIエラー(' + code + '): ' + msg);
  }
  var candidate = body.candidates && body.candidates[0];
  var text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;
  if (!text) {
    var reason = candidate && candidate.finishReason ? candidate.finishReason : '不明';
    throw new Error('Gemini APIから要約テキストを取得できませんでした(finishReason: ' + reason + ')');
  }
  return text.trim();
}

function buildWebAppHtml_() {
  return '<!DOCTYPE html><html><head><base target="_top">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' +
    'body{font-family:Arial,sans-serif;font-size:14px;padding:16px;max-width:640px;margin:0 auto;}' +
    'h2{margin-top:0;}' +
    '.field{margin-bottom:14px;}' +
    'label{display:block;font-weight:bold;margin-bottom:4px;}' +
    'input[type=file],input[type=date],select,textarea{width:100%;box-sizing:border-box;font-family:inherit;font-size:14px;}' +
    '.row{border:1px solid #ccc;border-radius:6px;padding:10px;margin-bottom:10px;position:relative;}' +
    '.row textarea{height:160px;margin-top:6px;}' +
    '.remove{position:absolute;top:8px;right:10px;color:#c00;cursor:pointer;font-size:12px;}' +
    'button{padding:8px 14px;margin:4px 8px 4px 0;border-radius:4px;border:1px solid #ccc;background:#f5f5f5;cursor:pointer;}' +
    '.primary{background:#1a73e8;color:#fff;border:none;}' +
    '#status{margin-top:14px;white-space:pre-wrap;font-size:13px;color:#333;}' +
    '.hint{font-size:12px;color:#666;margin-top:2px;}' +
    '</style></head><body>' +
    '<h2>学習進捗ログ: VTTから自動作成</h2>' +
    '<p class="hint">Zoomの文字起こし(.vtt)をアップロードして「AIで要約を作成」を押すと、下の記録内容欄に' +
    '下書きが自動で入ります。内容を確認・必要なら修正してから「この内容で書き込む」を押してください。</p>' +

    '<div class="field"><label>VTTファイル</label><input type="file" id="vttFile" accept=".vtt"></div>' +
    '<div class="field"><label>実施日</label><input type="date" id="sessionDate"></div>' +

    '<div id="rows"></div>' +
    '<button onclick="addRow()">+ 対象者を追加(集団相談の場合)</button>' +
    '<br>' +
    '<button class="primary" onclick="generateAll()">AIで要約を作成</button>' +
    '<button class="primary" onclick="submitAll()">この内容で書き込む</button>' +
    '<div id="status"></div>' +

    '<script>' +
    'let structure=[];let rowCount=0;let vttText="";' +
    'google.script.run.withSuccessHandler(function(data){structure=data;addRow();})' +
    '.withFailureHandler(function(err){setStatus("読み込みエラー: "+err.message);})' +
    '.getStructureForDialog();' +

    'document.getElementById("vttFile").addEventListener("change",function(ev){' +
    'const f=ev.target.files[0];if(!f)return;' +
    'const reader=new FileReader();' +
    'reader.onload=function(e){vttText=e.target.result;setStatus("VTT読み込み完了: "+f.name);};' +
    'reader.readAsText(f);});' +

    'function esc(s){return String(s).replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c];});}' +

    'function addRow(){rowCount++;const id=rowCount;const div=document.createElement("div");div.className="row";div.id="row-"+id;' +
    'const opts=structure.map(function(s){return "<option value=\\""+esc(s.sheetName)+"\\">"+esc(s.sheetName)+"</option>";}).join("");' +
    'div.innerHTML="<span class=\\"remove\\" onclick=\\"removeRow("+id+")\\">✕ 削除</span>"+' +
    '"<label>企業(シート)</label><select onchange=\\"updateLearners("+id+")\\" id=\\"sheet-"+id+"\\">"+opts+"</select>"+' +
    '"<label>受講者</label><select id=\\"learner-"+id+"\\"></select>"+' +
    '"<label>記録内容</label><textarea id=\\"text-"+id+"\\" placeholder=\\"「AIで要約を作成」を押すとここに下書きが入ります\\"></textarea>";' +
    'document.getElementById("rows").appendChild(div);updateLearners(id);}' +

    'function updateLearners(id){const sheetName=document.getElementById("sheet-"+id).value;' +
    'const sheet=structure.find(function(s){return s.sheetName===sheetName;});' +
    'const sel=document.getElementById("learner-"+id);' +
    'sel.innerHTML=(sheet?sheet.learners:[]).map(function(l){return "<option value=\\""+esc(l.learner)+"\\">"+esc(l.learner)+"</option>";}).join("");}' +

    'function removeRow(id){const el=document.getElementById("row-"+id);if(el)el.remove();}' +

    'function setStatus(msg){document.getElementById("status").textContent=msg;}' +

    'function generateAll(){' +
    'if(!vttText){setStatus("先にVTTファイルを選択してください。");return;}' +
    'const date=document.getElementById("sessionDate").value;' +
    'if(!date){setStatus("実施日を入力してください。");return;}' +
    'const rows=document.querySelectorAll(".row");' +
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

    'function submitAll(){const rows=document.querySelectorAll(".row");const entries=[];' +
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
    '</script></body></html>';
}
