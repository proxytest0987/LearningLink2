// server.js — Bot対策強化版 v3
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

// ── Keep-Alive エージェント ──
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

// ── Bot対策: 本物のChrome 124ヘッダーセット ──
// ブラウザが実際に送るヘッダーと完全に一致させることで
// 「これはブラウザからの普通のアクセスだ」と認識させる
const CHROME_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
  'accept-encoding': 'gzip, deflate, br',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'upgrade-insecure-requests': '1',
  'connection': 'keep-alive',
  'cache-control': 'max-age=0',
};

// ── Unblocker 設定 ──
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

        // ── 削除: プロキシがバレるヘッダー ──
        // これらが残っていると「プロキシ経由だ」とバレてブロックされる
        const badHeaders = [
          'x-forwarded-for',
          'x-forwarded-host',
          'x-forwarded-proto',
          'via',
          'forwarded',
          'proxy-connection',
          'x-real-ip',
        ];
        for (const h of badHeaders) {
          delete ro.headers[h];
          delete ro.headers[h.toLowerCase()];
        }

        // ── ブラウザ偽装ヘッダーを上書き適用 ──
        for (const [k, v] of Object.entries(CHROME_HEADERS)) {
          // すでにユーザーがセットしていても上書きする
          ro.headers[k] = v;
        }

        // ── Refererを自動付与（「直接検索から来た」感を出す） ──
        // refererがない場合、Googleから来たようにセット
        if (!ro.headers['referer']) {
          ro.headers['referer'] = 'https://www.google.com/';
        }

        // ── エージェント適用 ──
        const isHttp = ro.protocol === 'http:' || (data && data.protocol === 'http:');
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
          // ── ブロック系ヘッダーを削除 ──
          delete data.headers['content-security-policy'];
          delete data.headers['content-security-policy-report-only'];
          delete data.headers['x-frame-options'];
          // ── HSTS削除（プロキシ越しだとエラーになることがある） ──
          delete data.headers['strict-transport-security'];
          // ── 古いXSS保護（誤作動の元）を削除 ──
          delete data.headers['x-xss-protection'];
        }
        // ── 動画シーク対応 ──
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

// ── トップページ ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── URL/検索語 → プロキシへ ──
app.post('/go', (req, res) => {
  const input = (req.body.q || '').trim();
  if (!input) return res.redirect('/');

  const isLikelyUrl = /^(https?:\/\/)/i.test(input) || (/\./.test(input) && !input.includes(' '));
  const target = isLikelyUrl
    ? (input.match(/^https?:\/\//i) ? input : `https://${input}`)
    : `https://www.google.com/search?q=${encodeURIComponent(input)}`;

  res.redirect(`${config.prefix}${target}`);
});

// ── 死活監視 ──
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ── エラーハンドラ ──
app.use((err, req, res, next) => {
  console.error('proxy-error:', err && (err.code || err.message));
  if (res.headersSent) return next(err);
  const isNetErr = err && ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENOTFOUND'].includes(err.code);
  res.status(isNetErr ? 502 : 500).send(`
    <!doctype html><meta charset="utf-8">
    <title>接続エラー — ProxyWave</title>
    <style>
      body{font-family:system-ui,sans-serif;background:#0d0d14;color:#f0eeff;display:grid;place-items:center;min-height:100vh;margin:0}
      .card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.09);border-radius:20px;padding:32px;max-width:500px;width:90%;text-align:center}
      h1{font-size:18px;margin:0 0 12px;color:#a78bfa}
      p{color:#8b8ba7;line-height:1.6;margin:0 0 16px}
      code{background:rgba(167,139,250,0.1);padding:3px 8px;border-radius:6px;color:#a78bfa}
      a{color:#60a5fa}
    </style>
    <div class="card">
      <h1>🌊 一時的に接続できませんでした</h1>
      <p>対象サイトかネットワークの問題の可能性があります。<br>少し待ってから再試行してください。</p>
      <p>エラーコード: <code>${(err && (err.code || err.message)) || 'unknown'}</code></p>
      <a href="javascript:history.back()">← 戻る</a>
    </div>
  `);
});

// ── サーバ起動 ──
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌊 ProxyWave running on http://localhost:${PORT}`);
});
server.keepAliveTimeout = 61_000;
server.headersTimeout   = 62_000;
server.requestTimeout   = 60_000;

process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
