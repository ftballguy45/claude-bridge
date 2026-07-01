/**
 * Tiny self-contained live dashboard for GET /usage, served at GET /usage/ui.
 * Same-origin fetch of /usage (no CORS), refetches every 60s, ticks the reset
 * countdowns every second. No external assets. Client JS uses string
 * concatenation only (no template literals) so this whole page can live in a
 * TS template literal without `${}` collisions.
 */
export const USAGE_UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude usage</title>
<style>
:root{--bg:#0A0E17;--panel:#0F141E;--txt:#F5F6FA;--mut:#8A94A6;--track:#1c2431;--green:#00D4AA;--amber:#FDCB6E;--red:#FF6B6B;--border:rgba(255,255,255,.08)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font-family:-apple-system,Segoe UI,Roboto,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:520px;background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:24px 28px}
.hd{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:20px}
.hd h1{font-size:18px;font-weight:600;margin:0}
.hd .sub{font-size:12px;color:var(--mut);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.row{margin:18px 0}
.lbl{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.name{font-size:14px}
.reset{font-size:12px;color:var(--mut);margin-left:6px}
.pct{font-size:14px;font-weight:600}
.track{height:14px;background:var(--track);border-radius:8px;overflow:hidden}
.fill{height:100%;border-radius:8px;width:0;transition:width .6s ease}
.ft{margin-top:22px;font-size:11px;color:var(--mut);display:flex;justify-content:space-between}
.stale{color:var(--amber)}
</style></head>
<body>
<div class="card">
  <div class="hd"><h1>Claude subscription usage</h1><span class="sub">account-wide</span></div>
  <div class="row"><div class="lbl"><span class="name">5-hour window<span class="reset" id="reset5"></span></span><span class="pct" id="pct5">&mdash;</span></div><div class="track"><div class="fill" id="fill5"></div></div></div>
  <div class="row"><div class="lbl"><span class="name">7-day window<span class="reset" id="reset7"></span></span><span class="pct" id="pct7">&mdash;</span></div><div class="track"><div class="fill" id="fill7"></div></div></div>
  <div class="ft"><span id="updated">loading&hellip;</span><span id="status"></span></div>
</div>
<script>
var $=function(id){return document.getElementById(id)};
function color(p){return p>=80?'var(--red)':p>=50?'var(--amber)':'var(--green)'}
function fmt(sec){if(sec==null)return'';sec=Math.max(0,sec);var d=Math.floor(sec/86400),h=Math.floor(sec%86400/3600),m=Math.floor(sec%3600/60);if(d)return'resets in '+d+'d '+h+'h';if(h)return'resets in '+h+'h '+m+'m';return'resets in '+m+'m'}
var last=null,lastAt=0;
function paintWin(pre,w){var p=w?w.usedPercent:0;$('pct'+pre).textContent=w?(p+'%'):'\\u2014';var f=$('fill'+pre);f.style.width=Math.min(100,p)+'%';f.style.background=color(p);var rs=w&&w.resetsAt?Math.round((new Date(w.resetsAt).getTime()-Date.now())/1000):(w?w.resetsInSeconds:null);$('reset'+pre).textContent=fmt(rs)}
function paint(){if(!last)return;paintWin('5',last.fiveHour);paintWin('7',last.sevenDay);var age=Math.round((Date.now()-lastAt)/1000);$('updated').textContent='updated '+age+'s ago'+(last.cached?' (cached)':'');var s=$('status');s.textContent=last.stale?'stale \\u2014 probe failed':(last.status||'');s.className=last.stale?'stale':''}
function load(){fetch('/usage',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){last=j;lastAt=Date.now();paint()}).catch(function(e){$('updated').textContent='fetch error';$('status').textContent=String(e)})}
load();setInterval(load,60000);setInterval(paint,1000);
</script>
</body></html>`;
