// main.ts — Deno Deploy “Bubble Surf” プロキシ（HTML内蔵版）
// 注意: 大手サイトのDRM/高度なボット対策/ログイン保護は通りません。合法の範囲での“自然化”のみ対応します。

const PREFIX = "/proxy/";

// 元URLを /proxy/https://example.com/path?... から復元
function currentOriginFromPath(pathname: string): URL | null {
  if (!pathname.startsWith(PREFIX)) return null;
  try {
    return new URL(pathname.slice(PREFIX.length));
  } catch {
    return null;
  }
}

function buildUpstreamFromPath(pathname: string): string | null {
  const u = currentOriginFromPath(pathname);
  return u ? u.toString() : null;
}

function pickHeaders(req: Request): Headers {
  const out = new Headers();
  for (const [k, v] of req.headers) {
    const lk = k.toLowerCase();
    if (["host","connection","content-length","transfer-encoding","upgrade"].includes(lk)) continue;
    out.set(k, v);
  }
  if (!out.has("accept-language")) out.set("accept-language", "ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6");
  if (!out.has("accept-encoding")) out.set("accept-encoding", "gzip, deflate, br");
  return out;
}

function injectRewriterScript(html: string, baseUrl: URL): string {
  const injector = `
<script>
(function(){
  const PREFIX = '${PREFIX}';
  const base = new URL(${JSON.stringify(baseUrl.toString())});
  function proxify(u){ try{ return PREFIX + new URL(u, base).toString(); }catch(e){ return null; } }
  function patch(){
    // a[href]
    document.querySelectorAll('a[href]').forEach(a=>{
      const href = a.getAttribute('href'); if(!href) return;
      if (href.startsWith('javascript:') || href.startsWith('#') || href.startsWith(PREFIX)) return;
      const p = proxify(href); if(p) a.setAttribute('href', p);
    });
    // link rel=stylesheet
    document.querySelectorAll('link[rel="stylesheet"][href]').forEach(l=>{
      const href = l.getAttribute('href'); if(!href || href.startsWith(PREFIX)) return;
      const p = proxify(href); if(p) l.setAttribute('href', p);
    });
    // img/script/video/audio/source[src], poster
    document.querySelectorAll('[src]').forEach(el=>{
      const s = el.getAttribute('src'); if(!s || s.startsWith(PREFIX)) return;
      const p = proxify(s); if(p) el.setAttribute('src', p);
    });
    document.querySelectorAll('[poster]').forEach(el=>{
      const s = el.getAttribute('poster'); if(!s || s.startsWith(PREFIX)) return;
      const p = proxify(s); if(p) el.setAttribute('poster', p);
    });
    // form[action]
    document.querySelectorAll('form').forEach(f=>{
      const act = f.getAttribute('action') || base.toString();
      const p = proxify(act); if(p) f.setAttribute('action', p);
      // target=_blank の submit も維持
    });
  }
  const mo = new MutationObserver(patch);
  mo.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['href','src','poster','action']});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', patch);
  patch();
})();
</script>`;
  // </head> の直前か </body> 直前に注入
  if (html.includes("</head>")) return html.replace("</head>", injector + "</head>");
  if (html.includes("</body>")) return html.replace("</body>", injector + "</body>");
  return html + injector;
}

async function handleProxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const upstream = buildUpstreamFromPath(url.pathname);
  if (!upstream) return new Response("Bad target URL", { status: 400 });

  const headers = pickHeaders(req);
  const method = req.method;
  const body = ["GET","HEAD"].includes(method) ? undefined : await req.arrayBuffer();

  const res = await fetch(upstream, { method, headers, body, redirect: "manual" });

  const rh = new Headers(res.headers);
  const loc = rh.get("location");
  if (loc) { // 3xx リダイレクトを /proxy/ に保持
    try {
      const abs = new URL(loc, upstream).toString();
      rh.set("location", PREFIX + abs);
    } catch {}
  }

  // iframe等の最低限の緩和
  rh.delete("content-security-policy");
  rh.delete("x-frame-options");
  rh.set("access-control-expose-headers", "*");

  const ct = rh.get("content-type") || "";
  if (ct.includes("text/html")) {
    // HTMLはリンクを書き換えるスクリプトを注入
    const base = new URL(upstream);
    const text = await res.text();
    const patched = injectRewriterScript(text, base);
    rh.set("content-length", String(new TextEncoder().encode(patched).length));
    return new Response(patched, { status: res.status, headers: rh });
  }
  return new Response(res.body, { status: res.status, headers: rh });
}

function htmlHome(): Response {
  const h = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Bubble Surf 🌈 | なんでも検索もリンクもプロキシで</title>
<meta name="theme-color" content="#7C9BFF" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{
  --bg1:#0c0f1e; --bg2:#111632; --card:#121630; --border:#252b4a;
  --text:#f2f6ff; --muted:#a6b0c7;
  --g1:#7C9BFF; --g2:#FF7CB1; --g3:#7CFFE3; --btn:#7C9BFF;
  --chip:#171c3a; --shadow:0 18px 50px rgba(0,0,0,.40);
  --pill:#0e1330; --ok:#76ffa6;
}
*{box-sizing:border-box} html,body{height:100%}
body{
  margin:0; color:var(--text); font-family: ui-sans-serif,-apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial;
  background:
    radial-gradient(1200px 800px at -10% -10%, rgba(124,155,255,.28), transparent 60%),
    radial-gradient(1000px 700px at 110% 10%, rgba(255,124,177,.22), transparent 55%),
    linear-gradient(180deg, var(--bg1), var(--bg2));
}
header{padding:22px 16px}
.wrap{max-width:980px;margin:0 auto}
.brand{display:flex;align-items:center;gap:12px}
.logo{
  width:46px;height:46px;border-radius:16px;position:relative;overflow:hidden;
  background: conic-gradient(from 180deg,var(--g1),var(--g2),var(--g3),var(--g1));
  box-shadow: 0 12px 30px rgba(124,155,255,.45);
}
.logo::after{content:"";position:absolute;inset:2px;border-radius:14px;background:rgba(255,255,255,.07)}
h1{margin:0;font-size:20px;letter-spacing:.2px}
.sub{margin:4px 0 0;color:var(--muted);font-size:13px}
main{padding:16px}
.card{background:var(--card); border:1px solid var(--border); border-radius:22px; padding:22px; box-shadow:var(--shadow);}
.hero{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center}
.title{
  background: linear-gradient(90deg,var(--g1),var(--g2),var(--g3));
  -webkit-background-clip:text;background-clip:text;color:transparent;
  font-size:24px;font-weight:900;letter-spacing:.3px
}
.float{position:relative;height:70px;margin-top:8px}
.st{position:absolute;font-size:28px;filter:drop-shadow(0 8px 18px rgba(0,0,0,.3));animation:up 6s ease-in-out infinite}
.s1{left:6%; top:10px;animation-delay:.2s}
.s2{left:30%;top:0;  animation-delay:.9s}
.s3{left:56%;top:14px;animation-delay:1.6s}
.s4{left:80%;top:4px; animation-delay:2.2s}
@keyframes up{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.form{margin-top:18px;display:flex;gap:10px;flex-wrap:wrap}
input[type="text"]{
  flex:1; min-width:260px; padding:15px 16px; font-size:16px; color:var(--text);
  background:#0e1433; border:1px solid var(--border); border-radius:16px; outline:none;
  transition: box-shadow .15s ease, border-color .15s ease;
}
input[type="text"]::placeholder{color:#8e96ab}
input[type="text"]:focus{ border-color:var(--g2); box-shadow:0 0 0 5px rgba(255,124,177,.22) }
button{
  padding:15px 18px; font-size:16px; border-radius:16px; border:0; cursor:pointer; color:#0d0f1f;
  background: linear-gradient(180deg, #8aa4ff 0%, var(--btn) 100%);
  box-shadow: 0 12px 26px rgba(124,155,255,.50); transition: transform .05s ease, box-shadow .15s ease; font-weight:800;
}
button:hover{ box-shadow: 0 14px 28px rgba(124,155,255,.65) }
button:active{ transform: translateY(1px) }
.chips{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.chip{
  padding:10px 12px;border-radius:999px;border:1px dashed var(--border);
  background: #171c3a; color:#e9efff; font-size:13px; cursor:pointer;
  box-shadow: 0 6px 16px rgba(0,0,0,.18);
}
.cols{display:grid;grid-template-columns:1fr;gap:16px;margin-top:16px}
@media(min-width:860px){ .cols{grid-template-columns:1.3fr .7fr} }
.panel{background:#0f1434;border:1px solid var(--border);border-radius:16px;padding:14px}
.panel h3{margin:0 0 8px;font-size:15px;color:#cfd6ff}
.panel p,.hint{color:#9aa3b2;font-size:13px;line-height:1.7;margin:8px 0 0}
.pill{display:inline-flex;align-items:center;gap:8px;background:#0e1330;border:1px solid var(--border);padding:8px 12px;border-radius:999px;color:#cfe0ff;font-size:12px}
footer{text-align:center;color:#8993aa;font-size:12px;padding:22px}
</style>
</head>
<body>
  <header>
    <div class="wrap brand">
      <div class="logo" aria-hidden="true"></div>
      <div>
        <h1>Bubble Surf</h1>
        <p class="sub">検索もリンクも、ずっとプロキシ経由で。</p>
      </div>
    </div>
  </header>
  <main>
    <div class="wrap card">
      <div class="hero">
        <div>
          <div class="title">はやい・かわいい・迷わない。</div>
          <div class="float">
            <div class="st s1">🫧</div><div class="st s2">🎮</div><div class="st s3">🎬</div><div class="st s4">📚</div>
          </div>
        </div>
        <div class="pill">制作: <b>하루키</b> / <span style="color:#76ffa6">online</span></div>
      </div>
      <form class="form" action="/go" method="post" onsubmit="return handleSubmit(event)">
        <input id="q" type="text" name="q" autocomplete="on"
               placeholder="URL または 検索語（例: https://example.com / スプラ3 情報 / 動画 テスト）" />
        <button type="submit">いってみる 🚀</button>
      </form>
      <div class="chips">
        <div class="chip" onclick="quick('https://ja.wikipedia.org')">📚 Wikipedia</div>
        <div class="chip" onclick="quick('ニュース')">🗞 ニュース</div>
        <div class="chip" onclick="quick('動画 テスト')">🎬 動画テスト</div>
        <div class="chip" onclick="quick('https://developer.mozilla.org')">🛠 MDN</div>
      </div>
      <div class="cols">
        <section class="panel">
          <h3>つかいかた</h3>
          <p>上のボックスにURLかキーワード→「いってみる」。ページ遷移やリンクも自動でプロキシ化します。</p>
          <p class="hint">注: DRMや厳格なボット対策、ログイン保護のあるサイトは動かない/不安定な場合があります。</p>
        </section>
        <section class="panel">
          <h3>ヒント</h3>
          <p>重いページは少し待ってから再読み込みしてね。</p>
        </section>
      </div>
    </div>
  </main>
  <footer>© <span id="year"></span> Haruki. All rights reserved.</footer>
<script>
  document.getElementById('year').textContent = new Date().getFullYear();
  function quick(text){ const el = document.getElementById('q'); el.value = text; el.focus(); }
  function handleSubmit(e){
    const el = document.getElementById('q'); const v = (el.value || '').trim();
    if(!v){ el.focus(); return false; }
    const looksLikeUrl = /^\\w+:\\/\\//i.test(v) || (v.includes('.') && !v.includes(' '));
    if(looksLikeUrl && !/^\\w+:\\/\\//i.test(v)){ el.value = 'https://' + v; }
    return true;
  }
</script>
</body>
</html>`;
  return new Response(h, { headers: { "content-type":"text/html; charset=utf-8" }});
}

function handleGo(u: URL, method: string, req?: Request): Promise<Response> | Response {
  async function inputFromReq(): Promise<string> {
    if (method === "GET") return (u.searchParams.get("q") || "").trim();
    const ct = (req?.headers.get("content-type") || "");
    if (ct.includes("application/x-www-form-urlencoded") && req) {
      const form = new URLSearchParams(await req.text());
      return (form.get("q") || "").trim();
    }
    return "";
  }
  return (async () => {
    const q = (await inputFromReq()).trim();
    if (!q) return Response.redirect("/", 302);
    const looksUrl = /^https?:\\/\\//i.test(q) || (q.includes(".") && !q.includes(" "));
    const target = looksUrl ? (q.match(/^https?:\\/\\//i) ? q : \`https://\${q}\`)
      : \`https://www.google.com/search?hl=ja&gl=JP&q=\${encodeURIComponent(q)}\`;
    return Response.redirect(PREFIX + target, 302);
  })();
}

function favicon(): Response {
  const svg = \`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7C9BFF"/>
      <stop offset="0.5" stop-color="#FF7CB1"/>
      <stop offset="1" stop-color="#7CFFE3"/>
    </linearGradient>
    <filter id="s" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="6" stdDeviation="4" flood-color="#000" flood-opacity=".25"/>
    </filter>
  </defs>
  <rect x="6" y="6" width="52" height="52" rx="16" fill="url(#g)" filter="url(#s)"/>
  <g fill="#0d1030" opacity="0.9">
    <circle cx="24" cy="26" r="4.5"/>
    <circle cx="40" cy="24" r="3.5"/>
    <circle cx="34" cy="36" r="3"/>
  </g>
  <path d="M20 44c8 4 16 4 24 0" stroke="#0d1030" stroke-width="2.8" stroke-linecap="round" fill="none" opacity="0.9"/>
</svg>\`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/") return htmlHome();
  if (u.pathname === "/favicon.svg") return favicon();
  if (u.pathname === "/healthz") return new Response("ok");
  if (u.pathname === "/go") return handleGo(u, req.method, req as Request);
  if (u.pathname.startsWith(PREFIX)) return handleProxy(req);
  return new Response("Not Found", { status: 404 });
});
