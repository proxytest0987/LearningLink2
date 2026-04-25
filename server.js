// server.js（Unblocker 最適化版・丸ごと置き換え）
const express = require('express');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const http = require('http');
const https = require('https');
require('dotenv').config();

const createUnblocker = require('unblocker');
const CacheableLookup = require('cacheable-lookup');
// 任意: ベーシック認証（公開トンネル時の悪用防止。使わないなら環境変数を未設定でOK）
let basicAuth = null;
try { basicAuth = require('express-basic-auth'); } catch(e) {}

const app = express();
app.set('trust proxy', true); // リバースプロキシ越しのURL/プロトコル判定を安定化

// 基本ミドルウェア
app.disable('x-powered-by');
app.use(compression());
app.use(morgan('tiny'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 任意: BASIC_AUTH_USER/BASIC_AUTH_PASS があれば有効化
if (basicAuth && process.env.BASIC_AUTH_USER) {
  app.use(basicAuth({
    users: { [process.env.BASIC_AUTH_USER]: process.env.BASIC_AUTH_PASS || '' },
    challenge: true
  }));
}

// DNSキャッシュで解決を高速化
const dnsCache = new CacheableLookup();
dnsCache.install(http.globalAgent);
dnsCache.install(https.globalAgent);

// アウトバウンドHTTP/HTTPS: Keep-Alive & 并行数
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 96 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 96 });

// Unblocker 設定（“関数”呼び出しでミドルウェア生成）
const config = {
  prefix: '/proxy/',
  processContentTypes: [
    'text/html',
    'application/xhtml+xml',
    'text/css'
  ],
  standardMiddleware: true,

  // クライアントのヘッダーをできるだけ素通し寄りに（人間らしさUP）
  requestMiddleware: [
    (reqData) => {
      try {
        if (!reqData || !reqData.requestOptions) return;
        const ro = reqData.requestOptions;

        const clientH = (reqData.clientRequest && reqData.clientRequest.headers) || {};
        ro.headers = Object.assign({}, clientH, ro.headers || {});

        // hop-by-hop系は上流で再計算
        delete ro.headers['host'];
        delete ro.headers['content-length'];

        // 圧縮はbrまで許可（不安定な場合は 'gzip, deflate' に戻す）
        if (!ro.headers['accept-encoding']) ro.headers['accept-encoding'] = 'gzip, deflate, br';
        ro.headers['connection'] = 'keep-alive';

        if (!ro.headers['accept-language']) {
          ro.headers['accept-language'] = 'ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6';
        }

        const isHttp = ro.protocol === 'http:' || (reqData && reqData.protocol === 'http:');
        ro.agent = isHttp ? httpAgent : httpsAgent;

        if (!ro.timeout) ro.timeout = 30_000;
      } catch (e) {
        console.error('requestMiddleware error:', e && (e.code || e.message));
      }
    }
  ],

  // 一部サイトのCSP/Frame制限を緩め、Range系の安定化
  responseMiddleware: [
    (resData) => {
      try {
        if (resData && resData.headers) {
          delete resData.headers['content-security-policy'];
          delete resData.headers['x-frame-options'];
        }
        if (resData && resData.clientRequest && resData.clientRequest.headers) {
          const range = resData.clientRequest.headers['range'];
          if (range && resData.headers) resData.headers['accept-ranges'] = 'bytes';
        }
      } catch (e) {
        console.error('responseMiddleware error:', e && (e.code || e.message));
      }
    }
  ]
};

const unblocker = createUnblocker(config);
app.use(unblocker);

// ホーム（フォーム）
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 入力→常に /proxy/ へ（POST）
app.post('/go', (req, res) => {
  const input = (req.body.q || '').trim();
  if (!input) return res.redirect('/');
  const isUrl = /^(https?:\/\/)/i.test(input) || /\./.test(input);
  const target = isUrl
    ? (input.match(/^https?:\/\//i) ? input : `https://${input}`)
    : `https://www.google.com/search?hl=ja&gl=JP&q=${encodeURIComponent(input)}`;
  res.redirect(`${config.prefix}${target}`);
});

// 入力→常に /proxy/ へ（GET：ブックマーク/アプリ連携用）
app.get('/go', (req, res) => {
  const input = (req.query.q || '').trim();
  if (!input) return res.redirect('/');
  const isUrl = /^(https?:\/\/)/i.test(input) || /\./.test(input);
  const target = isUrl
    ? (input.match(/^https?:\/\//i) ? input : `https://${input}`)
    : `https://www.google.com/search?hl=ja&gl=JP&q=${encodeURIComponent(input)}`;
  res.redirect(`${config.prefix}${target}`);
});

// 健康チェック
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// エラーハンドラ
app.use((err, req, res, next) => {
  console.error('proxy-error:', err && (err.code || err.message), err && err.stack ? `\n${err.stack}` : '');
  if (res.headersSent) return next(err);
  const isNetErr = err && (['ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(err.code));
  res.status(isNetErr ? 502 : 500).send(`<!doctype html><meta charset="utf-8">
  <title>一時的に接続できません</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:32px;line-height:1.7;color:#223}
  .card{max-width:720px;border:1px solid #e7ebf3;border-radius:14px;padding:20px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.06)}</style>
  <div class="card"><h1>一時的に接続できませんでした。</h1>
  <div>しばらく待って再読み込みしてください。</div>
  <div style="margin-top:10px;color:#667">エラー: <code>${(err && (err.code || err.message)) || 'unknown'}</code></div></div>`);
});

// 起動
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy running on http://localhost:${PORT}`);
});
server.keepAliveTimeout = 61_000;
server.headersTimeout   = 62_000;
server.requestTimeout   = 60_000;

process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
