// server.js（安定化パッチ v2）
const express = require('express');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const http = require('http');
const https = require('https');
require('dotenv').config();

const Unblocker = require('unblocker');

const app = express();

// 基本ミドルウェア
app.disable('x-powered-by');
app.use(compression());
app.use(morgan('tiny'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- アウトバウンドHTTP/HTTPS: Keep-Alive有効化 ----
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: 64
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: 64
});

// ---- Unblocker 設定 ----
const config = {
  prefix: '/proxy/',
  processContentTypes: [
    'text/html',
    'application/xml+xhtml',
    'application/xhtml+xml',
    'text/css'
  ],
  standardMiddleware: true,

  // 上流へ出す直前の調整（ガード付き）
  requestMiddleware: [
    (data) => {
      try {
        if (!data || !data.requestOptions) return; // ガード
        const ro = data.requestOptions;

        // ヘッダを必ずオブジェクト化
        ro.headers = ro.headers || {};
        const h = ro.headers;

        // ブラウザらしいUA/言語/圧縮
        if (!h['user-agent']) {
          h['user-agent'] =
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
        }
        if (!h['accept-language']) {
          h['accept-language'] = 'ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6';
        }
        // 一部環境でbrが不安定な場合があるためまずはgzip/deflate
        h['accept-encoding'] = 'gzip, deflate';
        h['connection'] = 'keep-alive';

        // プロトコル判定（無ければhttps扱い）
        const isHttp =
          ro.protocol === 'http:' ||
          (data && data.protocol === 'http:');

        // Keep-Aliveエージェント適用
        ro.agent = isHttp ? httpAgent : httpsAgent;

        // 過度なハングを防ぐタイムアウト
        if (!ro.timeout) ro.timeout = 30_000;
      } catch (e) {
        console.error('requestMiddleware error:', e && (e.code || e.message));
      }
    }
  ],

  // レスポンス側の調整（CSP/Frame制限の緩和、動画シーク安定化）
  responseMiddleware: [
    (data) => {
      try {
        if (data && data.headers) {
          delete data.headers['content-security-policy'];
          delete data.headers['x-frame-options'];
        }
        if (data && data.clientRequest && data.clientRequest.headers) {
          const range = data.clientRequest.headers['range'];
          if (range && data.headers) data.headers['accept-ranges'] = 'bytes';
        }
      } catch (e) {
        console.error('responseMiddleware error:', e && (e.code || e.message));
      }
    }
  ]
};

app.use(new Unblocker(config));

// トップページ（フォーム）
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 入力ハンドラ: URL か 検索語 → 常に /proxy/ へ
app.post('/go', (req, res) => {
  const input = (req.body.q || '').trim();
  if (!input) return res.redirect('/');

  const isLikelyUrl = /^(https?:\/\/)/i.test(input) || /\./.test(input);
  const target = isLikelyUrl
    ? (input.match(/^https?:\/\//i) ? input : `https://${input}`)
    : `https://www.google.com/search?q=${encodeURIComponent(input)}`;

  res.redirect(`${config.prefix}${target}`);
});

// 健康チェック
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---- エラーハンドラ（ECONNRESET等をキャッチしやすく） ----
app.use((err, req, res, next) => {
  console.error('proxy-error:', err && (err.code || err.message), err && err.stack ? `\n${err.stack}` : '');
  if (res.headersSent) return next(err);
  const isNetErr = err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN');
  res.status(isNetErr ? 502 : 500).send(`
    <!doctype html><meta charset="utf-8">
    <title>一時的に接続できません</title>
    <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:32px;line-height:1.7;color:#223}
    .card{max-width:720px;border:1px solid #e7ebf3;border-radius:14px;padding:20px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.06)}
    h1{font-size:18px;margin:0 0 10px}code{background:#f3f6fb;padding:2px 6px;border-radius:6px}</style>
    <div class="card">
      <h1>一時的に接続できませんでした。</h1>
      <div>しばらく待って再読み込みしてください。対象サイトやネットワークの状況により、まれに発生します。</div>
      <div style="margin-top:10px;color:#667">
        エラー: <code>${(err && (err.code || err.message)) || 'unknown'}</code>
      </div>
      <div style="margin-top:14px"><a href="javascript:history.back()">← 前のページに戻る</a></div>
    </div>
  `);
});

// ---- サーバ起動（外向き待受 & タイムアウト調整） ----
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy running on http://localhost:${PORT}`);
});
server.keepAliveTimeout = 61_000;
server.headersTimeout   = 62_000;
server.requestTimeout   = 60_000;

// 予期せぬ例外もログ
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
