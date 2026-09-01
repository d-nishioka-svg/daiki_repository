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
    ':root{--sf-blue:#0176d3;--sf-blue-dark:#014486;--sf-navy:#16325c;--sf-text:#3e3e3c;' +
    '--sf-muted:#706e6b;--sf-border:#dddbda;--sf-bg:#f3f2f2;--sf-danger:#ba0517;--sf-input-border:#c9c7c5;}' +
    '*{box-sizing:border-box;}' +
    'body{margin:0;background:var(--sf-bg);color:var(--sf-text);' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:14px;}' +
    '.sf-header{background:var(--sf-navy);color:#fff;padding:14px 20px;font-size:16px;font-weight:700;' +
    'display:flex;align-items:center;gap:8px;}' +
    '.sf-dot{width:9px;height:9px;border-radius:50%;background:var(--sf-blue);display:inline-block;flex:none;}' +
    '.sf-container{max-width:680px;margin:20px auto;padding:0 16px 40px;}' +
    '.sf-card{background:#fff;border:1px solid var(--sf-border);border-radius:8px;' +
    'box-shadow:0 1px 3px rgba(0,0,0,.08);padding:20px 20px 24px;}' +
    'h2{margin:0 0 4px;font-size:17px;font-weight:700;color:var(--sf-navy);}' +
    '.hint{font-size:12.5px;color:var(--sf-muted);line-height:1.5;margin:0 0 18px;}' +
    '.field{margin-bottom:16px;}' +
    'label{display:block;font-weight:600;font-size:13px;color:var(--sf-text);margin-bottom:5px;}' +
    'input[type=file],input[type=date],select,textarea{width:100%;font-family:inherit;font-size:14px;' +
    'color:var(--sf-text);border:1px solid var(--sf-input-border);border-radius:4px;padding:8px 10px;background:#fff;}' +
    'input[type=file]{padding:6px;}' +
    'select:focus,input:focus,textarea:focus{outline:none;border-color:var(--sf-blue);box-shadow:0 0 0 1px var(--sf-blue);}' +
    '.row{border:1px solid var(--sf-border);background:#fafaf9;border-radius:8px;padding:14px;margin-bottom:14px;position:relative;}' +
    '.row textarea{height:150px;margin-top:0;}' +
    '.remove{position:absolute;top:12px;right:14px;color:var(--sf-danger);cursor:pointer;font-size:12px;font-weight:600;}' +
    '.remove:hover{text-decoration:underline;}' +
    'button{font-family:inherit;padding:8px 16px;margin:0 8px 8px 0;border-radius:4px;' +
    'border:1px solid var(--sf-input-border);background:#fff;color:var(--sf-blue);font-size:13px;font-weight:600;cursor:pointer;}' +
    'button:hover{background:var(--sf-bg);}' +
    '.primary{background:var(--sf-blue);border-color:var(--sf-blue);color:#fff;}' +
    '.primary:hover{background:var(--sf-blue-dark);border-color:var(--sf-blue-dark);}' +
    '#status{margin-top:16px;white-space:pre-wrap;font-size:13px;color:var(--sf-text);}' +
    '.tabs{display:flex;gap:4px;border-bottom:1px solid var(--sf-border);margin-bottom:20px;}' +
    '.tabbtn{background:none;border:none;border-bottom:3px solid transparent;border-radius:0;' +
    'padding:10px 14px;margin:0;font-size:14px;font-weight:600;color:var(--sf-muted);cursor:pointer;}' +
    '.tabbtn:hover{color:var(--sf-blue);background:none;}' +
    '.tabbtn.active{border-bottom-color:var(--sf-blue);color:var(--sf-blue);}' +
    '.card{border:1px solid var(--sf-border);border-radius:8px;padding:14px;margin-bottom:10px;background:#fff;}' +
    '.card b{color:var(--sf-navy);font-size:14px;}' +
    '.badge{display:inline-block;background:#eaf5fe;color:var(--sf-blue-dark);border-radius:10px;' +
    'padding:2px 10px;font-size:11.5px;font-weight:600;margin-left:6px;}' +
    '.badge-muted{background:var(--sf-bg);color:var(--sf-muted);}' +
    '.cardtext{white-space:pre-wrap;margin-top:8px;font-size:13px;color:var(--sf-text);line-height:1.55;' +
    'background:#faf9f8;border:1px solid #f0efed;border-radius:6px;padding:10px;}' +
    '#companyOverview,#learnerHistory{margin-top:14px;}' +
    'hr{border:none;border-top:1px solid var(--sf-border);margin:22px 0;}' +
    '</style></head><body>' +

    '<div class="sf-header"><span class="sf-dot"></span>学習進捗ログ</div>' +
    '<div class="sf-container"><div class="sf-card">' +

    '<div class="tabs">' +
    '<button type="button" class="tabbtn active" id="tabbtn-write" onclick="showTab(\'write\')">記録を追加</button>' +
    '<button type="button" class="tabbtn" id="tabbtn-view" onclick="showTab(\'view\')">進捗を確認</button>' +
    '</div>' +

    '<div id="writeTab">' +
    '<h2>VTTから自動作成</h2>' +
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
    '</div>' +

    '<div id="viewTab" style="display:none">' +
    '<h2>進捗を確認</h2>' +
    '<p class="hint">企業を選ぶと、その企業の全受講者について直近の記録を一覧できます。' +
    '受講者を選んで「全記録を見る」を押すと、その人の全期間の記録を新しい順に確認できます。</p>' +
    '<div class="field"><label>企業(シート)</label><select id="viewSheet" onchange="onViewSheetChange()"></select></div>' +
    '<button onclick="loadCompanyOverview()">この企業の最新状況を一覧</button>' +
    '<div id="companyOverview"></div>' +
    '<hr>' +
    '<div class="field"><label>受講者</label><select id="viewLearner"></select></div>' +
    '<button onclick="loadLearnerHistory()">この受講者の全記録を見る</button>' +
    '<div id="learnerHistory"></div>' +
    '</div>' +

    '</div></div>' +

    '<script>' +
    'let structure=[];let rowCount=0;let vttText="";' +
    'google.script.run.withSuccessHandler(function(data){structure=data;addRow();populateViewSheet();})' +
    '.withFailureHandler(function(err){setStatus("読み込みエラー: "+err.message);})' +
    '.getStructureForDialog();' +

    'document.getElementById("vttFile").addEventListener("change",function(ev){' +
    'const f=ev.target.files[0];if(!f)return;' +
    'const reader=new FileReader();' +
    'reader.onload=function(e){vttText=e.target.result;setStatus("VTT読み込み完了: "+f.name);};' +
    'reader.readAsText(f);});' +

    'function esc(s){return String(s).replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c];});}' +

    'function showTab(name){' +
    'document.getElementById("writeTab").style.display=(name==="write")?"":"none";' +
    'document.getElementById("viewTab").style.display=(name==="view")?"":"none";' +
    'document.getElementById("tabbtn-write").classList.toggle("active",name==="write");' +
    'document.getElementById("tabbtn-view").classList.toggle("active",name==="view");}' +

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

    'function populateViewSheet(){' +
    'const sel=document.getElementById("viewSheet");' +
    'sel.innerHTML=structure.map(function(s){return "<option value=\\""+esc(s.sheetName)+"\\">"+esc(s.sheetName)+"</option>";}).join("");' +
    'onViewSheetChange();}' +

    'function onViewSheetChange(){' +
    'const sheetName=document.getElementById("viewSheet").value;' +
    'const sheet=structure.find(function(s){return s.sheetName===sheetName;});' +
    'const sel=document.getElementById("viewLearner");' +
    'sel.innerHTML=(sheet?sheet.learners:[]).map(function(l){return "<option value=\\""+esc(l.learner)+"\\">"+esc(l.learner)+"</option>";}).join("");}' +

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
    '</script></body></html>';
}
