// ===== YT Loop Live (stream key only) — single file =====
// Setup: npm i express multer     (FFmpeg must be installed)
// Run:   APP_PASSWORD=yourpass node app.js
const express = require('express'), multer = require('multer'), crypto = require('crypto');
const { spawn } = require('child_process'), fs = require('fs');

const PASSWORD = process.env.APP_PASSWORD || 'change-me';
const PORT = process.env.PORT || 3000;

const app = express();
fs.mkdirSync('uploads', { recursive: true });
const upload = multer({ dest: 'uploads/' });
let job = null;

// ---- password auth (signed cookie) ----
const token = crypto.createHmac('sha256', 'yt-loop:' + PASSWORD).update('ok').digest('hex');
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const authed = req => { const m = (req.headers.cookie || '').match(/sid=([a-f0-9]+)/); return !!m && eq(m[1], token); };
let fails = 0;
app.get('/login', (req, res) => res.send(LOGIN('')));
app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  if (fails > 3) await new Promise(r => setTimeout(r, Math.min(fails, 10) * 1000));
  if (eq(String(req.body.password || ''), PASSWORD)) {
    fails = 0;
    res.setHeader('Set-Cookie', 'sid=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800');
    return res.redirect('/');
  }
  fails++; res.status(401).send(LOGIN('Wrong password'));
});
app.get('/logout', (req, res) => { res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/'); res.redirect('/login'); });
app.use((req, res, next) => authed(req) ? next()
  : (req.path.startsWith('/api') ? res.status(401).json({ error: 'Not logged in' }) : res.redirect('/login')));

// ---- API ----
app.get('/', (req, res) => res.send(PAGE));

app.post('/api/start', upload.single('video'), (req, res) => {
  if (job && job.proc) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'A stream is already running' }); }
  if (!req.file) return res.status(400).json({ error: 'Please choose a video' });
  const k = String(req.body.streamKey || '').trim();
  const seconds = Math.round(parseFloat(req.body.hours) * 3600);
  if (!k) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Enter your stream key' }); }
  if (!(seconds > 0)) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'Invalid hours' }); }
  const rtmp = k.startsWith('rtmp') ? k : 'rtmp://a.rtmp.youtube.com/live2/' + k;

  const proc = spawn('ffmpeg', ['-re', '-stream_loop', '-1', '-i', req.file.path, '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3000k', '-maxrate', '3000k', '-bufsize', '6000k',
    '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', rtmp]);
  job = { proc, startedAt: Date.now(), seconds, file: req.file.path, name: req.file.originalname, log: '', error: null };
  proc.stderr.on('data', d => { job.log = (job.log + d).slice(-500).split(k).join('****'); });
  proc.on('error', e => { job.error = 'FFmpeg not found: ' + e.message; job.proc = null; job.endedAt = Date.now(); });
  proc.on('close', code => { if (!job) return; job.proc = null; job.endedAt = Date.now(); job.code = code; fs.unlink(job.file, () => {}); });
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => { if (job && job.proc) { job.stopped = true; job.proc.kill('SIGINT'); } res.json({ ok: true }); });

app.get('/api/status', (req, res) => {
  if (!job) return res.json({ idle: true });
  const last = (job.log.match(/[^\r\n]*time=[^\r\n]*/g) || []).pop() || '';
  const g = r => (last.match(r) || [])[1] || '';
  res.json({
    running: !!job.proc, name: job.name, total: job.seconds, error: job.error, stopped: !!job.stopped,
    elapsed: Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000),
    bitrate: g(/bitrate=\s*(\S+)/), speed: g(/speed=\s*(\S+)/), failed: !job.proc && job.code > 0 && !job.stopped,
    tail: job.proc ? '' : job.log.slice(-200)
  });
});

app.listen(PORT, () => console.log('YT Loop Live → http://localhost:' + PORT + (PASSWORD === 'change-me' ? '  ⚠ set APP_PASSWORD!' : '')));

// ================= UI (Tailwind CDN) =================
const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com/3.4.17"></script>
<style>body{background:radial-gradient(900px 500px at 50% -10%,#4a0f1c 0%,#0b0b10 60%) fixed}</style>`;

const LOGIN = err => `<!doctype html><html class="dark"><head><title>Login · YT Loop Live</title>${HEAD}</head>
<body class="min-h-screen flex items-center justify-center p-4 text-zinc-100 antialiased">
<form method="post" action="/login" class="w-full max-w-sm rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur">
<div class="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-red-700 text-2xl shadow-lg shadow-red-900/50">▶</div>
<h1 class="text-center text-2xl font-bold">YT Loop Live</h1>
<p class="mb-6 mt-1 text-center text-sm text-zinc-400">Enter password to continue</p>
<input type="password" name="password" placeholder="Password" autofocus required
 class="w-full rounded-xl border border-white/10 bg-zinc-900/80 px-4 py-3 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-500/30">
<button class="mt-4 w-full rounded-xl bg-gradient-to-r from-red-500 to-red-700 py-3 font-semibold shadow-lg shadow-red-900/40 transition hover:brightness-110 active:scale-[.98]">Sign in</button>
<p class="mt-3 min-h-[1.25rem] text-center text-sm text-red-400">${err}</p></form></body></html>`;

const PAGE = `<!doctype html><html class="dark"><head><title>YT Loop Live</title>${HEAD}</head>
<body class="min-h-screen text-zinc-100 antialiased"><div class="mx-auto max-w-2xl px-4 py-8">

<header class="mb-6 flex items-center justify-between">
 <div class="flex items-center gap-3"><div class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-red-500 to-red-700 shadow-lg shadow-red-900/50">▶</div>
 <div><h1 class="text-xl font-bold leading-tight">YT Loop Live</h1><p class="text-xs text-zinc-400">Loop a video to YouTube Live</p></div></div>
 <a href="/logout" class="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/10">Logout</a>
</header>

<section class="mb-5 rounded-3xl border border-white/10 bg-white/5 p-5 shadow-xl backdrop-blur sm:p-6">
 <h2 class="mb-4 text-xs font-semibold uppercase tracking-widest text-zinc-400">New stream</h2>

 <div id="drop" class="cursor-pointer rounded-2xl border-2 border-dashed border-zinc-600 p-8 text-center text-zinc-400 transition hover:border-red-500 hover:bg-red-500/5">
  <div class="text-4xl">🎬</div>
  <p class="mt-2 font-medium text-zinc-200">Drop your video here or click to browse</p>
  <p id="fname" class="mt-1 text-sm text-red-400"></p>
 </div>
 <input type="file" id="video" accept="video/*" hidden>

 <label class="mb-1.5 mt-5 block text-sm text-zinc-400">Stream key <span class="text-zinc-500">(YouTube Studio → Go live → Stream key)</span></label>
 <div class="relative">
  <input id="key" type="password" autocomplete="off" placeholder="xxxx-xxxx-xxxx-xxxx-xxxx"
   class="w-full rounded-xl border border-white/10 bg-zinc-900/80 px-4 py-3 pr-16 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-500/30">
  <button type="button" id="eye" class="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-3 py-1 text-xs text-zinc-400 hover:bg-white/10">Show</button>
 </div>

 <label class="mb-1.5 mt-5 block text-sm text-zinc-400">How long to stream (hours)</label>
 <input id="hours" type="number" min="0.1" step="0.25" value="1"
  class="w-full rounded-xl border border-white/10 bg-zinc-900/80 px-4 py-3 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-500/30">
 <div class="mt-2 flex flex-wrap gap-2" id="presets">
  <button type="button" data-h="1" class="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:border-red-500 hover:text-white">1h</button>
  <button type="button" data-h="3" class="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:border-red-500 hover:text-white">3h</button>
  <button type="button" data-h="6" class="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:border-red-500 hover:text-white">6h</button>
  <button type="button" data-h="12" class="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:border-red-500 hover:text-white">12h</button>
  <button type="button" data-h="24" class="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:border-red-500 hover:text-white">24h</button>
 </div>

 <div id="ubox" class="mt-5 hidden"><div class="h-2 overflow-hidden rounded-full bg-zinc-800"><div id="ufill" class="h-full w-0 rounded-full bg-gradient-to-r from-red-500 to-orange-400 transition-all"></div></div>
 <p class="mt-1 text-xs text-zinc-400">Uploading video…</p></div>

 <button id="go" class="mt-6 w-full rounded-xl bg-gradient-to-r from-red-500 to-red-700 py-3.5 text-base font-bold shadow-lg shadow-red-900/40 transition hover:brightness-110 active:scale-[.98] disabled:opacity-50">🔴 Go Live (loop)</button>
 <p class="mt-3 text-center text-xs text-zinc-500">Category &amp; Private/Public are set in YouTube Studio. If it says “waiting for data”, press Go Live there once.</p>
</section>

<section class="rounded-3xl border border-white/10 bg-white/5 p-5 shadow-xl backdrop-blur sm:p-6">
 <h2 class="mb-4 text-xs font-semibold uppercase tracking-widest text-zinc-400">Current stream</h2>
 <div id="st" class="text-sm text-zinc-400">⚪ Idle — no stream running</div>
 <button id="stop" class="mt-4 w-full rounded-xl border border-white/10 bg-zinc-800 py-2.5 text-sm font-medium transition hover:bg-zinc-700">⏹ Stop stream</button>
</section>

<div id="toast" class="pointer-events-none fixed bottom-6 left-1/2 hidden -translate-x-1/2 rounded-xl border border-white/10 bg-zinc-900 px-5 py-3 text-sm shadow-2xl"></div>
</div>
<script>
var $=function(i){return document.getElementById(i)},file=null;
function toast(m){var t=$('toast');t.textContent=m;t.classList.remove('hidden');clearTimeout(toast.t);toast.t=setTimeout(function(){t.classList.add('hidden')},3500)}
function setFile(f){file=f;$('fname').textContent=f?f.name+'  ('+(f.size/1048576).toFixed(1)+' MB)':''}
$('drop').onclick=function(){$('video').click()};
$('video').onchange=function(e){setFile(e.target.files[0])};
$('drop').ondragover=function(e){e.preventDefault();$('drop').classList.add('border-red-500')};
$('drop').ondragleave=function(){$('drop').classList.remove('border-red-500')};
$('drop').ondrop=function(e){e.preventDefault();$('drop').classList.remove('border-red-500');setFile(e.dataTransfer.files[0])};
$('eye').onclick=function(){var k=$('key');var s=k.type==='password';k.type=s?'text':'password';$('eye').textContent=s?'Hide':'Show'};
document.querySelectorAll('#presets button').forEach(function(b){b.onclick=function(){$('hours').value=b.dataset.h}});
$('go').onclick=function(){
 if(!file)return toast('Choose a video first');
 if(!$('key').value.trim())return toast('Enter your stream key');
 var fd=new FormData();fd.append('hours',$('hours').value);fd.append('streamKey',$('key').value);fd.append('video',file);
 var x=new XMLHttpRequest();x.open('POST','/api/start');$('go').disabled=true;$('ubox').classList.remove('hidden');
 x.upload.onprogress=function(e){if(e.lengthComputable)$('ufill').style.width=(e.loaded/e.total*100)+'%'};
 x.onload=function(){$('go').disabled=false;$('ubox').classList.add('hidden');$('ufill').style.width='0';
  var j={};try{j=JSON.parse(x.responseText)}catch(e){}toast(j.error||'🔴 Stream started!');poll()};
 x.onerror=function(){$('go').disabled=false;$('ubox').classList.add('hidden');toast('Upload failed')};x.send(fd)};
$('stop').onclick=function(){fetch('/api/stop',{method:'POST'}).then(function(){toast('Stopping…');setTimeout(poll,800)})};
function t(s){return new Date(Math.max(0,s)*1000).toISOString().substr(11,8)}
function badge(c,txt){return '<span class="mr-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium '+c+'">'+txt+'</span>'}
function poll(){fetch('/api/status').then(function(r){return r.json()}).then(function(s){
 if(s.idle){$('st').innerHTML='⚪ Idle — no stream running';return}
 var p=Math.min(100,s.elapsed/s.total*100),h='';
 if(s.running)h+=badge('bg-green-500/20 text-green-300','● STREAMING');
 else if(s.error||s.failed)h+=badge('bg-red-500/20 text-red-300','✖ Failed');
 else h+=badge('bg-zinc-700 text-zinc-300',s.stopped?'Stopped':'✔ Finished');
 if(s.speed)h+=badge('bg-blue-500/20 text-blue-300','speed '+s.speed);
 if(s.bitrate)h+=badge('bg-purple-500/20 text-purple-300',s.bitrate);
 h+='<p class="mt-3 truncate text-zinc-200">'+(s.name||'').replace(/</g,'&lt;')+'</p>';
 h+='<div class="my-3 h-3 overflow-hidden rounded-full bg-zinc-800"><div class="h-full rounded-full bg-gradient-to-r from-red-500 to-orange-400 transition-all duration-500" style="width:'+p+'%"></div></div>';
 h+='<div class="flex justify-between text-xs text-zinc-400"><span>Elapsed '+t(s.elapsed)+'</span><span>'+Math.round(p)+'%</span><span>Left '+t(s.total-s.elapsed)+'</span></div>';
 if(s.error)h+='<p class="mt-3 text-xs text-red-400">'+s.error+'</p>';
 else if(s.failed)h+='<p class="mt-3 break-all text-xs text-red-400">Check your stream key / internet. '+(s.tail||'').replace(/</g,'&lt;')+'</p>';
 $('st').innerHTML=h})}
setInterval(poll,2000);poll();
</script></body></html>`;
