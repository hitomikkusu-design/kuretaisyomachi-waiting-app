/**
 * 瞳秘書 LINE Bot (Google Apps Script)
 * ─────────────────────────────────────
 * 【スクリプトプロパティに設定する環境変数】
 *   LINE_CHANNEL_ACCESS_TOKEN  … LINE Messaging API のチャンネルアクセストークン
 *   ANTHROPIC_API_KEY          … Claude API キー
 *
 * 【デプロイ手順】
 *   1. GASエディタ上部 → 「デプロイ」→「新しいデプロイ」
 *   2. 種類: ウェブアプリ
 *   3. 実行ユーザー: 自分
 *   4. アクセス: 全員（匿名ユーザーも含む）
 *   5. デプロイ → 表示されるURLをLINE DevelopersのWebhook URLに貼る
 *   6. LINE Developersで「検証」ボタンを押して 200 OK が返ればOK
 */

// ─────────────────────────────────
//  定数 & 設定取得
// ─────────────────────────────────
var LINE_TOKEN = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '';
var CLAUDE_KEY = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') || '';
var CLAUDE_MODEL = 'claude-sonnet-4-6'; // 利用モデル

// ─────────────────────────────────
//  doPost(e) ── LINE Webhookのメインエントリ
// ─────────────────────────────────
function doPost(e) {
  // LINE は必ず HTTP 200 を返さないと再送してくるので最初に返す
  var replyToken = null;

  try {
    // ── 1. リクエストボディの存在確認 ──
    if (!e || !e.postData || !e.postData.contents) {
      console.error('[doPost] e.postData.contents が未定義です。LINEからのリクエストではない可能性があります。');
      return ContentService.createTextOutput('OK');
    }

    // ── 2. JSONパース ──
    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      console.error('[doPost] JSONパース失敗:', parseErr.message);
      console.error('[doPost] 受け取ったbody文字列:', e.postData.contents.substring(0, 300));
      return ContentService.createTextOutput('OK');
    }

    // ── 3. events 配列の確認 ──
    if (!body.events || !Array.isArray(body.events) || body.events.length === 0) {
      // Webhook疎通確認時は events が空配列で来る。正常なので静かに終了
      console.log('[doPost] eventsが空またはなし（疎通確認かも）');
      return ContentService.createTextOutput('OK');
    }

    var event = body.events[0];
    console.log('[doPost] eventType=' + event.type + ' / source=' + JSON.stringify(event.source || {}));

    // ── 4. replyToken を先に取得（後でエラー返信にも使う） ──
    replyToken = (event.replyToken && event.replyToken !== '00000000000000000000000000000000')
      ? event.replyToken
      : null;

    // ── 5. message イベント以外はスキップ ──
    if (event.type !== 'message') {
      console.log('[doPost] message以外のイベント(' + event.type + ')はスキップします');
      return ContentService.createTextOutput('OK');
    }

    // ── 6. message.type が text 以外はスキップ ──
    if (!event.message || event.message.type !== 'text') {
      var msgType = (event.message && event.message.type) || '不明';
      console.log('[doPost] テキスト以外のメッセージ(' + msgType + ')はスキップします');
      if (replyToken) {
        replyMessage(replyToken, '文字でメッセージを送ってやー！スタンプや画像はまだ対応しちょらんき🙏');
      }
      return ContentService.createTextOutput('OK');
    }

    // ── 7. テキスト取得 ──
    var userMessage = (event.message.text || '').trim();
    if (!userMessage) {
      console.log('[doPost] テキストが空でした');
      return ContentService.createTextOutput('OK');
    }

    console.log('[doPost] userMessage: ' + userMessage);

    // ── 8. Claude でメッセージ処理 ──
    var replyText = processWithClaude(userMessage);
    console.log('[doPost] replyText: ' + replyText.substring(0, 100));

    // ── 9. LINE に返信 ──
    if (replyToken) {
      replyMessage(replyToken, replyText);
    } else {
      console.log('[doPost] replyTokenがないため返信できません（疎通確認または既に期限切れ）');
    }

  } catch (err) {
    // ── 予期しない例外はここで全部受け止め ──
    console.error('[doPost] 予期しないエラーが発生:', err.message);
    console.error('[doPost] スタック:', err.stack || 'スタック情報なし');

    // ユーザーへ最低限のエラー返信
    if (replyToken) {
      try {
        replyMessage(replyToken, 'ごめんやき、エラーが発生したで！もう一回試してみてや〜');
      } catch (replyErr) {
        console.error('[doPost] エラー返信も失敗しました:', replyErr.message);
      }
    }
  }

  return ContentService.createTextOutput('OK');
}

// ─────────────────────────────────
//  processWithClaude() ── Claude でメッセージを処理
// ─────────────────────────────────
function processWithClaude(userMessage) {
  var prompt = [
    'あなたは「瞳秘書」という名前の、土佐弁で話す親切なLINE秘書Botです。',
    'ユーザーのメッセージを読んで、以下のJSON形式のみで返答してください。',
    '',
    '返答形式（必ずこのJSONのみ。前後に説明や```は不要）:',
    '{',
    '  "action": "アクション名",',
    '  "reply": "ユーザーへの返信テキスト（土佐弁で親しみやすく）"',
    '}',
    '',
    'actionの種類:',
    '  greeting   … あいさつ（おはよう、こんにちはなど）',
    '  task_query … タスクやTo-Doの質問',
    '  weather    … 天気の質問',
    '  unknown    … その他・わからないもの',
    '',
    'ユーザーのメッセージ:',
    userMessage
  ].join('\n');

  // Claude API を呼び出す
  var claudeRaw = callClaude(prompt);

  if (!claudeRaw) {
    console.error('[processWithClaude] callClaude が空を返しました');
    return 'ちょっとうまく考えられんかったき、もう一回送ってみてや〜';
  }

  // JSON をパース（失敗してもフォールバック）
  var result = parseClaudeJson(claudeRaw);
  if (!result) {
    // JSON パース失敗 → Claude の生テキストをそのまま返す（最低限の動作保証）
    console.log('[processWithClaude] JSONパース失敗。生テキストをそのまま返します: ' + claudeRaw.substring(0, 200));
    return claudeRaw.trim() || 'うまく返答できんかったき、ごめんやき〜';
  }

  console.log('[processWithClaude] action=' + result.action);
  return result.reply || 'うまく返答できんかったき、ごめんやき〜';
}

// ─────────────────────────────────
//  callClaude() ── Anthropic API を叩く
// ─────────────────────────────────
function callClaude(prompt) {
  if (!CLAUDE_KEY) {
    console.error('[callClaude] ANTHROPIC_API_KEY が設定されていません');
    return '';
  }

  var payload = {
    model: CLAUDE_MODEL,
    max_tokens: 512,
    messages: [
      { role: 'user', content: prompt }
    ]
  };

  var options = {
    method: 'POST',
    contentType: 'application/json',
    headers: {
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true  // ← これがないと HTTP エラーで例外が飛ぶ
  };

  var response;
  try {
    response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  } catch (fetchErr) {
    console.error('[callClaude] UrlFetchApp.fetch に失敗:', fetchErr.message);
    return '';
  }

  var statusCode = response.getResponseCode();
  var responseText = response.getContentText();

  if (statusCode !== 200) {
    console.error('[callClaude] APIエラー status=' + statusCode + ' body=' + responseText.substring(0, 500));
    return '';
  }

  // レスポンスJSON をパース
  var responseJson;
  try {
    responseJson = JSON.parse(responseText);
  } catch (parseErr) {
    console.error('[callClaude] レスポンスのJSONパース失敗:', parseErr.message);
    console.error('[callClaude] responseText:', responseText.substring(0, 300));
    return '';
  }

  // content[0].text を取り出す
  if (!responseJson.content || !responseJson.content[0] || !responseJson.content[0].text) {
    console.error('[callClaude] レスポンス構造が期待と異なります:', JSON.stringify(responseJson).substring(0, 300));
    return '';
  }

  var text = responseJson.content[0].text;
  console.log('[callClaude] Claude生レスポンス: ' + text.substring(0, 200));
  return text;
}

// ─────────────────────────────────
//  parseClaudeJson() ── Claude返答からJSONを安全に抽出
// ─────────────────────────────────
function parseClaudeJson(raw) {
  if (!raw) return null;

  // 1. マークダウンのコードブロックを除去（```json ... ``` や ``` ... ```）
  var cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // 2. そのままパースを試みる
  try {
    var parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}

  // 3. テキスト中にある { ... } を探して取り出す
  var match = cleaned.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      var extracted = JSON.parse(match[0]);
      if (extracted && typeof extracted === 'object') return extracted;
    } catch (_) {}
  }

  // 4. どうしても取れなかった場合は null を返す（呼び出し元でフォールバック）
  console.log('[parseClaudeJson] JSON抽出に失敗。raw=' + raw.substring(0, 200));
  return null;
}

// ─────────────────────────────────
//  replyMessage() ── LINE に返信
// ─────────────────────────────────
function replyMessage(replyToken, text) {
  if (!LINE_TOKEN) {
    console.error('[replyMessage] LINE_CHANNEL_ACCESS_TOKEN が設定されていません');
    return;
  }
  if (!replyToken) {
    console.error('[replyMessage] replyToken が空です');
    return;
  }
  if (!text) {
    console.error('[replyMessage] 返信テキストが空です');
    return;
  }

  // 5000文字を超えるとLINEエラーになるので切り詰め
  var safeText = text.length > 4999 ? text.substring(0, 4996) + '…' : text;

  var payload = {
    replyToken: replyToken,
    messages: [{ type: 'text', text: safeText }]
  };

  var options = {
    method: 'POST',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + LINE_TOKEN
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response;
  try {
    response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', options);
  } catch (fetchErr) {
    console.error('[replyMessage] UrlFetchApp.fetch に失敗:', fetchErr.message);
    return;
  }

  var statusCode = response.getResponseCode();
  if (statusCode !== 200) {
    console.error('[replyMessage] LINEエラー status=' + statusCode + ' body=' + response.getContentText().substring(0, 300));
  } else {
    console.log('[replyMessage] 返信成功 replyToken=' + replyToken.substring(0, 8) + '...');
  }
}

// ─────────────────────────────────
//  テスト用関数（GASエディタから手動実行可）
// ─────────────────────────────────
function testClaude() {
  var result = processWithClaude('おはよう！');
  console.log('テスト結果:', result);
}

function testWebhookFormat() {
  // LINE疎通確認フォーマットで doPost をテスト
  var fakeEvent = {
    postData: {
      contents: JSON.stringify({
        destination: 'U000000000000000',
        events: []
      })
    }
  };
  doPost(fakeEvent);
  console.log('疎通確認テスト完了（ログにエラーがなければOK）');
}

function testMessageEvent() {
  // 実際のメッセージイベントをシミュレート
  var fakeEvent = {
    postData: {
      contents: JSON.stringify({
        destination: 'U000000000000000',
        events: [
          {
            type: 'message',
            replyToken: 'test-reply-token-00000000',
            source: { type: 'user', userId: 'U000000000000000' },
            message: {
              type: 'text',
              id: '1234567890',
              text: '今日のタスク残り教えて'
            }
          }
        ]
      })
    }
  };
  // replyMessage は実際には飛ばないが、Claude呼び出しまでのログを確認できる
  doPost(fakeEvent);
}
