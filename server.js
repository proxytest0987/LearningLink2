// server.js（Bot対策強化版 v3）
const express = require('express');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const http = require('http');
const https = require('https');
require('dotenv').config();

const Unblocker = require('unblocker');

const app = express();

app.disable('x-powered-by');
app.use(compression());
app.use(morgan('tiny'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Keep-Alive エージェント ----
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: 64
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: 64,
  rejectUnauthorized: false // 証明書エラーを無視（一部サイト対策）
});

// ---- ランダムUA（毎回変わるのでBot認定されにくい） ----
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.86 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];
function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

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

  requestMiddleware: [
    (data) => {
      try {
        if (!data || !data.requestOptions) return;
        const ro = data.requestOptions;
        ro.headers = ro.headers || {};
        const h = ro.headers;

        // ランダムUAでBot判定を回避
        h['user-agent'] = randomUA();
        h['accept-language'] = 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7';
        h['accept-encoding'] = 'gzip, deflate, br';
        h['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
        h['connection'] = 'keep-alive';
        h['upgrade-insecure-requests'] = '1';
        h['sec-fetch-dest'] = 'document';
        h['sec-fetch-mode'] = 'navigate';
        h['sec-fetch-site'] = 'none';
        h['sec-fetch-user'] = '?1';
        h['dnt'] = '1';

        // プロキシ痕跡ヘッダを削除（重要！）
        delete h['x-forwarded-for'];
        delete h['x-real-ip'];
        delete h['via'];
        delete h['forwarded'];

        const isHttp =
          ro.protocol === 'http:' ||
          (data && data.protocol === 'http:');
        ro.agent = isHttp ? httpAgent : httpsAgent;
        if (!ro.timeout) ro.timeout = 30_000;
      } catch (e) {
        console.error('requestMiddleware error:', e && (e.code || e.message));
      }
    }
  ],

  responseMiddleware: [
    (data) => {
      try {
        if (data && data.headers) {
          // セキュリティ制限を全解除
          delete data.headers['content-security-policy'];
          delete data.headers['content-security-policy-report-only'];
          delete data.headers['x-frame-options'];
          delete data.headers['x-content-type-options'];
          delete data.headers['strict-transport-security'];
          delete data.headers['permissions-policy'];
          delete data.headers['cross-origin-embedder-policy'];
          delete data.headers['cross-origin-opener-policy'];
          delete data.headers['cross-origin-resource-policy'];
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

// トップページ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// URL/検索 → プロキシへ転送
app.post('/go', (req, res) => {
  const input = (req.body.q || '').trim();
  if (!input) return res.redirect('/');

  const isLikelyUrl = /^(https?:\/\/)/i.test(input) || (/\./.test(input) && !input.includes(' '));
  const target = isLikelyUrl
    ? (input.match(/^https?:\/\//i) ? input : `https://${input}`)
    : `https://www.google.com/search?q=${encodeURIComponent(input)}`;

  res.redirect(`${config.prefix}${target}`);
});

// 健康チェック（Koyeb/Render用）
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

// エラーハンドラ
app.use((err, req, res, next) => {
  console.error('proxy-error:', err && (err.code || err.message));
  if (res.headersSent) return next(err);
  const isNetErr = err && ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED','EHOSTUNREACH'].includes(err.code);
  res.status(isNetErr ? 502 : 500).send(`
    <!doctype html><html lang="ja"><head><meta charset="utf-8">
    <title>接続エラー</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
        background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);font-family:system-ui,sans-serif;color:#fff}
      .box{text-align:center;padding:40px;background:rgba(255,255,255,.07);border-radius:20px;
        border:1px solid rgba(255,255,255,.15);backdrop-filter:blur(10px);max-width:480px}
      h1{font-size:22px;margin:0 0 12px}
      code{background:rgba(255,255,255,.1);padding:3px 8px;border-radius:6px;font-size:13px}
      a{color:#a78bfa;text-decoration:none}a:hover{text-decoration:underline}
    </style></head><body>
    <div class="box">
      <div style="font-size:40px;margin-bottom:12px">📡</div>
      <h1>接続できませんでした</h1>
      <p>このサイトはプロキシをブロックしているか、一時的に落ちています。</p>
      <p><code>${(err && (err.code || err.message)) || 'unknown'}</code></p>
      <p><a href="javascript:history.back()">← 戻る</a> &nbsp;|&nbsp; <a href="/">🏠 ホーム</a></p>
    </div>
    </body></html>
  `);
});

// サーバ起動
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy running on http://localhost:${PORT}`);
});
server.keepAliveTimeout = 61_000;
server.headersTimeout   = 62_000;
server.requestTimeout   = 60_000;

process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
