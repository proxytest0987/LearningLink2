// server.js（学習用プロキシ｜安定化 v4）
// 変更点: br許可 / Client Hints優先転送 / X-Forwarded-For 付与 / DNSキャッシュ / Keep-Alive
const express = require('express');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const http = require('http');
const https = require('https');
require('dotenv').config();

const createUnblocker = require('unblocker');          // ← 関数として使う
const CacheableLookup = require('cacheable-lookup');   // DNS キャッシュで体感改善

const app = express();
app.set('trust proxy', true); // Render 等のリバプロ越しでのURL/プロトコル判定を安定化

// --- 任意: ベーシック認証（.env に BASIC_AUTH_USER / BASIC_AUTH_PASS を設定した場合のみ有効） ---
if (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Basic ') ? hdr.slice(6) : '';
    const [u, p] = Buffer.from(token, 'base64').toString('utf8').split(':');
    if (u === process.env.BASIC_AUTH_USER && p === process.env.BASIC_AUTH_PASS) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
    return res.status(401).send('Authentication required.');
  });
}

// --- 基本ミドルウェア ---
app.disable('x-powered-by');
app.use(compression());
app.use(morgan('tiny'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- アウトバウンド HTTP/HTTPS: DNS キャッシュ + Keep-Alive ---
const dnsCache = new CacheableLookup();
dnsCache.install(http.globalAgent);
dnsCache.install(https.globalAgent);

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

// --- Unblocker 設定 ---
const config = {
  prefix: '/proxy/',
  processContentTypes: [
    'text/html',
    'application/xhtml+xml',
    'text/css'
  ],
  standardMiddleware: true,

  // 上流へ出す直前の調整（“できるだけ素通し寄り”＋安全ガード）
  requestMiddleware: [
    (data) => {
      try {
        if (!data || !data.requestOptions) return;
        const ro = data.requestOptions;

        // クライアントのヘッダをベースに（固定UAの不自然さを避ける）
        const clientH = (data.clientRequest && data.clientRequest.headers) || {};
        ro.headers = Object.assign({}, clientH, ro.headers || {});

        // hop-by-hop系は上流で再計算
        delete ro.headers['host'];
        delete ro.headers['content-length'];

        // Client Hints（Sec-CH-UA* など）を優先転送
        const chKeys = Object.keys(clientH).filter(k => k.toLowerCase().startsWith('sec-ch-'));
        for (const k of chKeys) ro.headers[k] = clientH[k];

        // 圧縮: br も許可（相性悪ければ 'gzip, deflate' に戻す）
        if (!ro.headers['accept-encoding']) ro.headers['accept-encoding'] = 'gzip, deflate, br';
        ro.headers['connection'] = 'keep-alive';

        // 言語: 既定値（未指定時）
        if (!ro.headers['accept-language']) {
          ro.headers['accept-language'] = 'ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6';
        }

        // 一般的なプロキシ慣行として X-Forwarded-For を付与（元IPを末尾に連結）
        const xff = ro.headers['x-forwarded-for'];
        const headerIp =
          clientH['cf-connecting-ip'] ||
          clientH['x-real-ip'] ||
          (clientH['x-forwarded-for'] ? String(clientH['x-forwarded-for']).split(',')[0].trim() : '');
        if (headerIp) {
          ro.headers['x-forwarded-for'] = xff ? `${xff}, ${headerIp}` : headerIp;
        }

        // プロトコル別の Keep-Alive エージェント
        const isHttp = ro.protocol === 'http:' || (data && data.protocol === 'http:');
        ro.agent = isHttp ? httpAgent : httpsAgent;

        // ハング防止のタイムアウト
        if (!ro.timeout) ro.timeout = 30_000;
      } catch (e) {
        console.error('requestMiddleware error:', e && (e.code || e.message));
      }
    }
  ],

  // レスポンス側（CSP/Frame制限の緩和、動画シーク安定化）
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

// Unblocker を“関数呼び出し”でミドルウェア化
const unblocker = createUnblocker(config);
app.use(unblocker);

// --- ルーティング ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 入力ハンドラ: URL か 検索語 → 常に /proxy/ へ（POST）
app.post('/go', (req, res) => {
  const input = (req.body.q || '').trim();
  if (!input) return res.redirect('/');

  const isLikelyUrl = /^(https?:\/\/)/i.test(input) || /\./.test(input);
  const target = isLikelyUrl
    ? (input.match(/^https?:\/\//i) ? input : `https://${input}`)
    : `https://www.google.com/search?hl=ja&gl=JP&q=${encodeURIComponent(input)}`;

  res.redirect(`${config.prefix}${target}`);
});

// 直リンク/ブックマーク用（GET 版 /go）
app.get('/go', (req, res) => {
  const input = (req.query.q || '').trim();
  if (!input) return res.redirect('/');

  const isLikelyUrl = /^(https?:\/\/)/i.test(input) || /\./.test(input);
  const target = isLikelyUrl
    ? (input.match(/^https?:\/\//i) ? input : `https://${input}`)
    : `https://www.google.com/search?hl=ja&gl=JP&q=${encodeURIComponent(input)}`;

  res.redirect(`${config.prefix}${target}`);
});

// 健康チェック
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// --- エラーハンドラ（ECONNRESET 等を丁寧に表示） ---
app.use((err, req, res, next) => {
  console.error(
    'proxy-error:',
    err && (err.code || err.message),
    err && err.stack ? `\n${err.stack}` : ''
  );
  if (res.headersSent) return next(err);
  const isNetErr = err && (['ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(err.code));
  res
    .status(isNetErr ? 502 : 500)
    .send(`<!doctype html><meta charset="utf-8">
<title>一時的に接続できません</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:32px;line-height:1.7;color:#223}
.card{max-width:720px;border:1px solid #e7ebf3;border-radius:14px;padding:20px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.06)}</style>
<div class="card"><h1>一時的に接続できませんでした。</h1>
<div>しばらく待って再読み込みしてください。</div>
<div style="margin-top:10px;color:#667">エラー: <code>${(err && (err.code || err.message)) || 'unknown'}</code></div></div>`);
});

// --- サーバ起動（外向き待受 & タイムアウト調整） ---
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
