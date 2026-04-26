// server.js — Railway 用 逆プロキシ（軽量 HTML 書換付き）
// 注意: reCAPTCHA/厳格保護/ログイン必須サイトは動かない場合があります
const express = require('express');
const path = require('path');
const { Readable } = require('stream');

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 静的ファイル（トップUI）
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

const SEARCH_ENGINES = {
  ddg:     (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  brave:   (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  bing:    (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  startpg: (q) => `https://www.startpage.com/do/search?q=${encodeURIComponent(q)}`,
  mojeek:  (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`,
  google:  (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`
};
const DEFAULT_ENGINE = 'ddg';

function isLikelyUrl(v){
  return /^(https?:\/\/)/i.test(v) || (v.includes('.') && !v.includes(' '));
}
function proxify(origin, abs, base){
  const u = typeof abs === 'string' ? new URL(abs, origin) : abs;
  const next = new URL('/p', base);
  next.searchParams.set('u', u.href);
  return next.href;
}
function removeCookieDomain(v){
  let out = v.replace(/;?\s*Domain=[^;]*/ig, '');
  if (!/;\s*Path=/i.test(out)) out += '; Path=/';
  return out;
}
function injectRewriter(body, target, base){
  const abs = (s) => new URL(s, target).href;
  const rewriteAttr = (src, tag, attr) => {
    const rgx = new RegExp(`(<${tag}[^>]*?\\s${attr}=["'])([^"']+)(["'])`, 'ig');
    return src.replace(rgx, (_m, p1, url, p3) => {
      if (!url || url.startsWith('javascript:') || url.startsWith('data:')) return `${p1}${url}${p3}`;
      const to = proxify(target, abs(url), base);
      return `${p1}${to}${p3}`;
    });
  };
  let out = body;
  out = rewriteAttr(out, 'a', 'href');
  out = rewriteAttr(out, 'img', 'src');
  out = rewriteAttr(out, 'script', 'src');
  out = rewriteAttr(out, 'link', 'href');
  out = out.replace(/(<form[^>]*?\saction=["'])([^"']+)(["'])/ig, (_m, p1, url, p3) => {
    const to = proxify(target, abs(url), base);
    return `${p1}${to}${p3}`;
  });
  const headMeta = `<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"><meta name="referrer" content="no-referrer">`;
  if (out.includes('</head>')) out = out.replace('</head>', `${headMeta}</head>`);
  else out = headMeta + out;
  return out;
}

// トップ
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 健康診断
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// 上流到達診断
app.get('/diag', async (req, res) => {
  const raw = (req.query.url || '').toString();
  if (!raw) return res.status(400).json({ error: 'missing url' });
  const started = Date.now();
  try {
    const r = await fetch(raw, { method: 'HEAD' });
    res.json({ url: raw, status: r.status, headers: Object.fromEntries(r.headers), time_ms: Date.now()-started });
  } catch (e) {
    res.status(502).json({ url: raw, error: String(e), time_ms: Date.now()-started });
  }
});

// URL/検索語 → /p?u=...
app.post('/go', (req, res) => {
  const q = (req.body.q || '').trim();
  const eng = ((req.body.engine || DEFAULT_ENGINE) + '').toLowerCase();
  if (!q) return res.redirect('/');

  let target = '';
  if (isLikelyUrl(q)) target = /^https?:\/\//i.test(q) ? q : `https://${q}`;
  else target = (SEARCH_ENGINES[eng] || SEARCH_ENGINES[DEFAULT_ENGINE])(q);

  const p = new URL('/p', `${req.protocol}://${req.get('host')}`);
  p.searchParams.set('u', target);
  res.redirect(p.href);
});

// 逆プロキシ
app.all('/p', async (req, res) => {
  const targetStr = (req.query.u || '').toString();
  if (!targetStr) return res.status(400).send('missing u');

  let target;
  try { target = new URL(targetStr); }
  catch { return res.status(400).send('bad url'); }

  // 中継ヘッダ最小化＋UA/Lang 整備
  const hop = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host') continue;
    if (k === 'connection') continue;
    if (k.startsWith('cf-') || k === 'x-forwarded-for' || k === 'via') continue;
    if (Array.isArray(v)) hop.set(k, v.join(', ')); else if (v) hop.set(k, v);
  }
  if (!hop.get('user-agent')) {
    hop.set('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36');
  }
  hop.set('accept-language', 'ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6');
  const range = req.headers['range'];
  if (range) hop.set('range', range);

  const init = {
    method: req.method,
    headers: hop,
    body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req.body && typeof req.body === 'string' ? req.body : undefined,
    redirect: 'manual'
  };

  const up = await fetch(target, init);

  // リダイレクトの Location を /p?u=... へ
  const loc = up.headers.get('location');
  if (up.status >= 300 && up.status < 400 && loc) {
    const abs = new URL(loc, target).href;
    const prox = new URL('/p', `${req.protocol}://${req.get('host')}`); prox.searchParams.set('u', abs);
    for (const [k, v] of up.headers) res.setHeader(k, v);
    res.setHeader('location', prox.href);
    return res.status(up.status).end();
  }

  // Set-Cookie の Domain 除去
  const rawSet = up.headers.get('set-cookie');
  if (rawSet) {
    res.removeHeader('set-cookie');
    for (const sc of rawSet.split(/,(?=[^ ;]+=)/)) {
      res.append('set-cookie', removeCookieDomain(sc.trim()));
    }
  }

  // CSP/Frame 制限を弱める（互換性目的）
  res.removeHeader('content-security-policy');
  res.removeHeader('x-frame-options');

  const ct = up.headers.get('content-type') || '';
  for (const [k, v] of up.headers) {
    if (k.toLowerCase() === 'content-security-policy') continue;
    if (k.toLowerCase() === 'x-frame-options') continue;
    if (k.toLowerCase() === 'set-cookie') continue;
    res.setHeader(k, v);
  }

  if (ct.includes('text/html')) {
    const text = await up.text();
    const rewritten = injectRewriter(text, target, `${req.protocol}://${req.get('host')}`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.status(up.status).send(rewritten);
  }

  if (up.body) {
    return Readable.fromWeb(up.body).pipe(res.status(up.status));
  }
  return res.status(up.status).end();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('listening on :' + PORT);
});
