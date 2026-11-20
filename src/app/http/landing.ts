import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { uiHeaders } from "./operations-ui.js";

/**
 * 公开首页。样式与脚本都带 nonce，CSP 不允许任何其它来源。
 * 文案使用 data-zh / data-en，由页面脚本按浏览器语言切换。
 */
function landingHtml(nonce: string): string {
  return `<!doctype html>
<html lang="zh-CN" data-lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>Corvex — GitLab Code Agent</title>
<style nonce="${nonce}">
:root{--bg:#070a18;--panel:rgba(18,24,52,.72);--line:rgba(140,160,255,.16);--text:#e9edff;--muted:#98a4cc;--blue:#5b8cff;--purple:#a06bff;--cyan:#4fd8ff}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.7 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;z-index:-2;background:radial-gradient(900px 600px at 12% -5%,rgba(91,140,255,.22),transparent 65%),radial-gradient(800px 600px at 90% 10%,rgba(160,107,255,.2),transparent 60%),linear-gradient(180deg,#070a18 0%,#090d20 50%,#060817 100%)}
body::after{content:"";position:fixed;inset:0;z-index:-1;background-image:linear-gradient(rgba(120,150,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(120,150,255,.045) 1px,transparent 1px);background-size:56px 56px;mask-image:linear-gradient(180deg,#000,transparent 85%)}
.orb{position:fixed;border-radius:50%;filter:blur(90px);opacity:.35;pointer-events:none;z-index:-1;animation:float 14s ease-in-out infinite}
.orb.a{width:420px;height:420px;background:#3e63ff;top:8%;left:-120px}.orb.b{width:380px;height:380px;background:#9b4dff;top:35%;right:-100px;animation-delay:-6s}
@keyframes float{0%,100%{transform:translate3d(0,0,0)}50%{transform:translate3d(30px,-40px,0)}}
.wrap{width:min(1120px,calc(100% - 40px));margin:0 auto}
nav{display:flex;align-items:center;justify-content:space-between;padding:22px 0;position:relative;z-index:5}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.02em;color:var(--text);text-decoration:none}
.logo-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,var(--blue),var(--purple));box-shadow:0 0 24px rgba(120,110,255,.5);font-size:14px}
.nav-actions{display:flex;align-items:center;gap:10px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border-radius:11px;text-decoration:none;font-weight:600;font-size:14px;transition:transform .2s,box-shadow .2s,border-color .2s;white-space:nowrap}
.btn:hover{transform:translateY(-2px)}
.btn.primary{color:#fff;background:linear-gradient(120deg,#4f7dff,#9a5cff);box-shadow:0 8px 30px rgba(100,90,255,.35)}
.btn.ghost{color:var(--text);border:1px solid var(--line);background:rgba(255,255,255,.03)}
.lang{padding:8px 11px;border-radius:9px;color:var(--muted);background:transparent;border:1px solid var(--line);cursor:pointer;font-size:12px}
.hero{padding:70px 0 40px;min-height:74vh;display:flex;align-items:center}
.hero-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:46px;align-items:center;width:100%}
.badge{display:inline-flex;align-items:center;gap:8px;padding:6px 13px;border:1px solid var(--line);border-radius:99px;color:#b9c5ff;font-size:12px;letter-spacing:.12em;background:rgba(90,120,255,.08)}
.badge i{width:7px;height:7px;border-radius:50%;background:var(--cyan);box-shadow:0 0 12px var(--cyan)}
h1{font-size:clamp(38px,5vw,64px);line-height:1.1;margin:22px 0 18px;letter-spacing:-.03em}
.gradient{background:linear-gradient(100deg,#7fb0ff,#b78cff 55%,#5ee6ff);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p.lead{font-size:17px;color:var(--muted);max-width:540px;margin:0 0 30px}
.hero-actions{display:flex;gap:12px;flex-wrap:wrap}
.hero-card{position:relative;border:1px solid var(--line);border-radius:20px;background:var(--panel);backdrop-filter:blur(18px);padding:20px;box-shadow:0 30px 80px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.02) inset}
.hero-card::before{content:"";position:absolute;inset:-1px;border-radius:20px;background:linear-gradient(130deg,rgba(91,140,255,.5),transparent 40%,rgba(160,107,255,.45));z-index:-1;filter:blur(14px)}
.card-top{display:flex;align-items:center;gap:6px;margin-bottom:16px}.dot{width:9px;height:9px;border-radius:50%;background:#ff6b8a}.dot.y{background:#ffcf5b}.dot.g{background:#5be2a4}
.card-line{display:flex;gap:10px;align-items:flex-start;margin:14px 0}
.avatar{width:28px;height:28px;flex:0 0 auto;border-radius:9px;background:linear-gradient(135deg,#4f7dff,#9a5cff);display:grid;place-items:center;font-size:11px;font-weight:700}
.bubble{border-radius:12px;padding:10px 13px;font-size:13px;line-height:1.6}.bubble.user{background:rgba(91,140,255,.16);border:1px solid rgba(91,140,255,.25)}.bubble.ai{background:rgba(160,107,255,.12);border:1px solid rgba(160,107,255,.22);color:#d7d9ff}
.typing{display:inline-flex;gap:4px;margin-top:8px}.typing span{width:5px;height:5px;border-radius:50%;background:#9a8cff;animation:blink 1.2s infinite}.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,100%{opacity:.25}50%{opacity:1}}
section{padding:66px 0}
.sec-head{max-width:640px;margin-bottom:30px}.eyebrow{color:var(--cyan);font-size:12px;letter-spacing:.18em;text-transform:uppercase}
h2{font-size:clamp(28px,3.5vw,42px);line-height:1.2;margin:12px 0;letter-spacing:-.02em}
.sec-head p{color:var(--muted);margin:0}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.feature{padding:24px;border:1px solid var(--line);border-radius:16px;background:rgba(15,20,45,.55);transition:transform .35s,border-color .35s,box-shadow .35s}
.feature:hover{transform:translateY(-6px);border-color:rgba(150,130,255,.45);box-shadow:0 20px 50px rgba(70,60,180,.2)}
.feature .ico{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,rgba(91,140,255,.25),rgba(160,107,255,.25));font-size:19px;margin-bottom:14px}
.feature h3{margin:0 0 8px;font-size:17px}.feature p{margin:0;color:var(--muted);font-size:14px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;counter-reset:step}
.step{counter-increment:step;padding:22px;border-left:1px solid var(--line);position:relative}
.step::before{content:"0" counter(step);display:block;color:var(--purple);font-weight:800;font-size:13px;letter-spacing:.1em;margin-bottom:8px}
.step h3{margin:0 0 6px;font-size:16px}.step p{margin:0;color:var(--muted);font-size:14px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;text-align:center;padding:28px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(120deg,rgba(50,70,160,.22),rgba(80,40,140,.18))}
.stat b{display:block;font-size:30px;background:linear-gradient(100deg,#8ab4ff,#c69cff);-webkit-background-clip:text;background-clip:text;color:transparent}
.stat span{color:var(--muted);font-size:13px}
.cta{padding:60px 0 90px;text-align:center}.cta h2{font-size:clamp(30px,4vw,48px)}
footer{border-top:1px solid var(--line);padding:26px 0;color:var(--muted);font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
[data-reveal]{opacity:0;transform:translateY(26px);transition:opacity .7s cubic-bezier(.2,.7,.2,1),transform .7s cubic-bezier(.2,.7,.2,1);transition-delay:var(--delay,0ms)}
[data-reveal].visible{opacity:1;transform:none}
html[data-lang="en"] [data-zh]{display:none!important}html[data-lang="zh"] [data-en]{display:none!important}
@media(max-width:860px){.hero-grid,.cards,.steps{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.hero{padding-top:40px}.orb{display:none}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}[data-reveal]{opacity:1;transform:none}}
</style>
</head>
<body>
<div class="orb a" data-parallax="0.06"></div><div class="orb b" data-parallax="-0.04"></div>
<div class="wrap">
<nav>
  <a class="logo" href="/"><span class="logo-mark">C</span><span>Corvex</span></a>
  <div class="nav-actions">
    <button class="lang" id="lang" type="button" aria-label="Language">中文 / EN</button>
    <a class="btn primary" href="/ops"><span data-zh>使用 GitLab 登录</span><span data-en>Sign in with GitLab</span></a>
  </div>
</nav>
<header class="hero"><div class="hero-grid">
  <div>
    <span class="badge" data-reveal><i></i><span data-zh>自托管 · GitLab 原生</span><span data-en>SELF-HOSTED · GITLAB NATIVE</span></span>
    <h1 data-reveal style="--delay:80ms"><span data-zh>让代码审查</span><span data-en>Code review</span><br><span class="gradient" data-zh>拥有记忆</span><span class="gradient" data-en>with memory</span></h1>
    <p class="lead" data-reveal style="--delay:160ms"><span data-zh>在 GitLab 评论里唤起 Corvex，完成审查、解释、修复提案与 Issue 协作。每个用户使用自己的 GitLab 账号登录，会话与令牌彼此隔离。</span><span data-en>Mention Corvex in a GitLab comment to review, explain, propose fixes and assist on issues. Every user signs in with their own GitLab account, with isolated sessions and tokens.</span></p>
    <div class="hero-actions" data-reveal style="--delay:240ms">
      <a class="btn primary" href="/ops"><span data-zh>进入控制台</span><span data-en>Open console</span></a>
      <a class="btn ghost" href="#features"><span data-zh>了解能力</span><span data-en>Explore features</span></a>
    </div>
  </div>
  <div class="hero-card" data-reveal style="--delay:200ms">
    <div class="card-top"><span class="dot"></span><span class="dot y"></span><span class="dot g"></span></div>
    <div class="card-line"><span class="avatar">U</span><div class="bubble user"><span data-zh>帮我看看这个 MR 有什么风险？</span><span data-en>What are the risks in this MR?</span></div></div>
    <div class="card-line"><span class="avatar" style="background:linear-gradient(135deg,#9a5cff,#4fd8ff)">C</span><div class="bubble ai"><span data-zh>发现 1 个高危问题：用户输入未校验即写入数据库。引用新增行 42，并给出修复建议。</span><span data-en>Found 1 high-severity issue: untrusted input is written to the database without validation. See added line 42, with a suggested fix.</span><span class="typing"><span></span><span></span><span></span></span></div></div>
  </div>
</div></header>
<section id="features"><div class="wrap">
  <div class="sec-head" data-reveal><span class="eyebrow">CAPABILITIES</span><h2 data-zh>一个入口，覆盖整个开发流程</h2><h2 data-en>One entry point for the whole workflow</h2><p data-zh>所有操作都固定到精确的代码快照，发布前重新校验授权与版本。</p><p data-en>Every action is pinned to an exact code snapshot, with authorization and revision checks before publishing.</p></div>
  <div class="cards">
    <div class="feature" data-reveal><div class="ico">◎</div><h3 data-zh>合并请求审查</h3><h3 data-en>Merge request review</h3><p data-zh>按新增行校验发现项，行级评论与摘要自动发布。</p><p data-en>Validate findings against added lines; publish inline discussions and a summary.</p></div>
    <div class="feature" data-reveal style="--delay:80ms"><div class="ico">◇</div><h3 data-zh>持久对话</h3><h3 data-en>Persistent conversations</h3><p data-zh>绑定仓库分支与固定 SHA，逐轮保留轨迹和工具调用。</p><p data-en>Bound to a branch and pinned SHA, with per-turn traces and tool calls.</p></div>
    <div class="feature" data-reveal style="--delay:160ms"><div class="ico">✦</div><h3 data-zh>修复提案</h3><h3 data-en>Fix proposals</h3><p data-zh>补丁仅限变更路径，经 git apply --check 校验后供人工审阅。</p><p data-en>Patches are scoped to changed paths and checked before human review.</p></div>
    <div class="feature" data-reveal><div class="ico">⚙</div><h3 data-zh>Issue 助手</h3><h3 data-en>Issue assistant</h3><p data-zh>可回答问题或在显式授权下创建 Draft MR，绝不自动合并。</p><p data-en>Answers questions or opens a Draft MR on explicit request; never auto-merges.</p></div>
    <div class="feature" data-reveal style="--delay:80ms"><div class="ico">⬡</div><h3 data-zh>按用户登录</h3><h3 data-en>Per-user login</h3><p data-zh>GitLab OAuth2 登录，令牌加密存储，会话与数据完全隔离。</p><p data-en>GitLab OAuth2 sign-in, encrypted tokens, fully isolated sessions and data.</p></div>
    <div class="feature" data-reveal style="--delay:160ms"><div class="ico">⌘</div><h3 data-zh>安全边界</h3><h3 data-en>Safety boundaries</h3><p data-zh>无 shell 执行器，不运行仓库代码，权限全部由 Corvex 校验。</p><p data-en>No shell executor, no repository code execution, all authorization in Corvex.</p></div>
  </div>
</div></section>
<section><div class="wrap">
  <div class="sec-head" data-reveal><span class="eyebrow">HOW IT WORKS</span><h2 data-zh>三步开始</h2><h2 data-en>Get started in three steps</h2></div>
  <div class="steps">
    <div class="step" data-reveal><h3 data-zh>连接 GitLab</h3><h3 data-en>Connect GitLab</h3><p data-zh>首次访问进入 /setup，填写实例地址与 OAuth Application 信息，全部保存在本地 SQLite。</p><p data-en>First visit opens /setup to enter your instance URL and OAuth Application details, all stored locally in SQLite.</p></div>
    <div class="step" data-reveal style="--delay:90ms"><h3 data-zh>配置模型</h3><h3 data-en>Configure a model</h3><p data-zh>在设置页添加模型供应商与模型，选择默认模型后立即生效。</p><p data-en>Add a provider and model in Settings and activate one; changes apply immediately.</p></div>
    <div class="step" data-reveal style="--delay:180ms"><h3 data-zh>开始协作</h3><h3 data-en>Start collaborating</h3><p data-zh>注册 Note Hook，在 MR 或 Issue 中 @ 机器人，或在控制台开启持久对话。</p><p data-en>Register the Note Hook, mention the bot in MRs or issues, or start a persistent conversation in the console.</p></div>
  </div>
</div></section>
<section><div class="wrap"><div class="stats" data-reveal>
  <div class="stat"><b class="count" data-target="3">0</b><span data-zh>进程模式</span><span data-en>Process modes</span></div>
  <div class="stat"><b class="count" data-target="5">0</b><span data-zh>事件类型</span><span data-en>Event types</span></div>
  <div class="stat"><b class="count" data-target="30">0</b><span data-zh>秒租约</span><span data-en>Second lease</span></div>
  <div class="stat"><b class="count" data-target="100">0</b><span data-zh>% 本地数据</span><span data-en>% local data</span></div>
</div></div></section>
<section class="cta"><div class="wrap" data-reveal><h2 class="gradient" data-zh>准备好让评审更懂你的仓库了吗？</h2><h2 class="gradient" data-en>Ready for reviews that know your repository?</h2><p data-zh>使用 GitLab 账号登录，立刻开始。</p><p data-en>Sign in with GitLab and start now.</p><a class="btn primary" href="/ops"><span data-zh>进入 Corvex</span><span data-en>Open Corvex</span></a></div></section>
<footer class="wrap"><span>Corvex · GitLab Code Agent</span><span data-zh>自托管 · 数据留在你的基础设施</span><span data-en>Self-hosted · data stays in your infrastructure</span></footer>
</div>
<script nonce="${nonce}">
(function(){
  var root=document.documentElement;
  function setLang(lang){root.setAttribute('data-lang',lang);root.lang=lang==='zh'?'zh-CN':'en';document.getElementById('lang').textContent=lang==='zh'?'中文 / EN':'EN / 中文';}
  var saved=localStorage.getItem('corvex-landing-lang');
  setLang(saved||(navigator.language||'').toLowerCase().indexOf('zh')===0?'zh':'en');
  document.getElementById('lang').addEventListener('click',function(){var next=root.getAttribute('data-lang')==='zh'?'en':'zh';localStorage.setItem('corvex-landing-lang',next);setLang(next);});
  var reveals=document.querySelectorAll('[data-reveal]');
  var io=new IntersectionObserver(function(entries){entries.forEach(function(e){if(e.isIntersecting){e.target.classList.add('visible');io.unobserve(e.target);}});},{threshold:.12});
  reveals.forEach(function(el){io.observe(el);});
  var parallax=document.querySelectorAll('[data-parallax]');
  window.addEventListener('scroll',function(){var y=window.scrollY||0;parallax.forEach(function(el){el.style.transform='translate3d(0,'+(y*parseFloat(el.getAttribute('data-parallax')))+'px,0)';});},{passive:true});
  var counts=document.querySelectorAll('.count');
  var countObserver=new IntersectionObserver(function(entries){entries.forEach(function(e){if(!e.isIntersecting)return;var el=e.target,target=parseInt(el.getAttribute('data-target'),10),start=performance.now();function tick(now){var p=Math.min(1,(now-start)/1100);el.textContent=String(Math.round(target*(1-Math.pow(1-p,3))));if(p<1)requestAnimationFrame(tick);}requestAnimationFrame(tick);countObserver.unobserve(el);});},{threshold:.5});
  counts.forEach(function(el){countObserver.observe(el);});
  fetch('/api/auth/me').then(function(r){return r.ok?r.json():null;}).then(function(user){if(user){document.querySelectorAll('a[href="/ops"]').forEach(function(a){a.textContent=user.username;});}}).catch(function(){});
})();
</script>
</body>
</html>`;
}

function landingPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** 注册公开首页；未登录与登出都回到这里。 */
export function registerLandingRoute(app: FastifyInstance): void {
  const serve = async (_request: unknown, reply: FastifyReply): Promise<void> => {
    const nonce = Buffer.from(randomUUID()).toString("base64url").slice(0, 24);
    reply
      .code(200)
      .headers({ ...uiHeaders("text/html; charset=utf-8"), "content-security-policy": landingPolicy(nonce) })
      .send(landingHtml(nonce));
  };
  app.get("/", serve);
  app.head("/", serve);
}
