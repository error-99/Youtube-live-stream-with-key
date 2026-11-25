// ===== YT Loop Live v3 (stream key only) — single file =====
// Setup: npm i express multer     (FFmpeg + ffprobe must be installed)
// Run:   APP_PASSWORD=yourpass node app.js
// New:   upload MANY videos -> auto-merged into one -> loop N times OR X minutes/hours
//        landscape/portrait (Reels 9:16), fit/fill, 720p/1080p
const express = require('express'), multer = require('multer'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process'), fs = require('fs'), path = require('path');

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

// ---- helpers ----
function probe(file) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { encoding: 'utf8' });
    const j = JSON.parse(r.stdout);
    return { dur: parseFloat(j.format.duration) || 0, audio: (j.streams || []).some(s => s.codec_type === 'audio') };
  } catch (e) { return { dur: 0, audio: true }; }
}
const SIZES = { // [width, height, video kbps]
  landscape: { 720: [1280, 720, 3000], 1080: [1920, 1080, 5000] },
  portrait:  { 720: [720, 1280, 3000], 1080: [1080, 1920, 5000] }
};
const tsec = log => { const m = (log.match(/time=(\d+):(\d+):(\d+\.?\d*)/g) || []).pop(); if (!m) return 0; const p = m.slice(5).split(':'); return +p[0] * 3600 + +p[1] * 60 + parseFloat(p[2]); };
const cleanup = j => (j.cleanup || []).forEach(f => fs.unlink(f, () => {}));

// ---- API ----
app.get('/', (req, res) => res.send(PAGE));

function startStream(j, input, hasAudio, vf, loops, seconds, kbps, rtmp, k) {
  const args = ['-re', '-stream_loop', String(loops), '-i', input];
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'); // YouTube wants audio
  args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0');
  if (vf) args.push('-vf', vf);
  args.push('-r', '30', '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', kbps + 'k', '-maxrate', kbps + 'k', '-bufsize', (kbps * 2) + 'k',
    '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', rtmp);
  j.phase = 'streaming'; j.startedAt = Date.now(); j.log = '';
  const proc = spawn('ffmpeg', args);
  j.proc = proc;
  proc.stderr.on('data', d => { j.log = (j.log + d).slice(-500).split(k).join('****'); });
  proc.on('error', e => { j.error = 'FFmpeg not found: ' + e.message; j.proc = null; j.endedAt = Date.now(); });
  proc.on('close', code => { j.proc = null; j.endedAt = Date.now(); j.code = code; cleanup(j); });
}

app.post('/api/start', upload.array('videos', 50), (req, res) => {
  const files = req.files || [];
  const fail = (msg) => { files.forEach(f => fs.unlink(f.path, () => {})); return res.status(400).json({ error: msg }); };
  if (job && job.proc) return fail('A stream is already running');
  if (!files.length) return fail('Please choose at least one video');
  const b = req.body;
  const k = String(b.streamKey || '').trim();
  if (!k) return fail('Enter your stream key');

  const mode = b.mode === 'times' ? 'times' : 'time';
  const orient = b.orient === 'portrait' ? 'portrait' : 'landscape';
  const quality = b.quality === '1080' ? '1080' : '720';
  const fit = b.fit === 'fill' ? 'fill' : 'fit';
  const [W, H, kbps] = SIZES[orient][quality];

  const infos = files.map(f => probe(f.path));
  const n = files.length;
  if (n > 1 && infos.some(i => !(i.dur > 0))) return fail('Could not read a video (is ffprobe installed?)');
  const sumDur = infos.reduce((a, i) => a + i.dur, 0);

  let seconds, loops, times = 0;
  if (mode === 'times') {
    times = Math.floor(parseFloat(b.times));
    if (!(times >= 1) || times > 10000) return fail('Enter how many times to play (1–10000)');
    if (!(sumDur > 0)) return fail('Could not read video length (is ffprobe installed?)');
    seconds = Math.ceil(sumDur * times); loops = times - 1;
  } else {
    seconds = Math.round(parseFloat(b.amount) * (b.unit === 'minutes' ? 60 : 3600)); loops = -1;
    if (!(seconds > 0)) return fail('Invalid time');
  }

  const rtmp = k.startsWith('rtmp') ? k : 'rtmp://a.rtmp.youtube.com/live2/' + k;
  const chain = fit === 'fill'
    ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
    : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;
  const nm = f => Buffer.from(f.originalname, 'latin1').toString('utf8');
  const names = n === 1 ? nm(files[0]) : n + ' videos merged (' + nm(files[0]) + ' …)';

  job = { proc: null, phase: 'streaming', startedAt: Date.now(), seconds, mode, times, vidDur: sumDur, count: n, orient, quality,
          name: names, log: '', error: null, cleanup: files.map(f => f.path), sumDur };

  if (n === 1) {
    startStream(job, files[0].path, infos[0].audio, chain + ',setsar=1', loops, seconds, kbps, rtmp, k);
    return res.json({ ok: true });
  }

  // ---- merge: convert each clip one-by-one (low memory), then join them instantly with concat ----
  const stamp = Date.now(), merged = 'uploads/merged_' + stamp + '.mp4', list = 'uploads/list_' + stamp + '.txt';
  const norms = files.map((_, i) => path.resolve('uploads/norm_' + stamp + '_' + i + '.mp4'));
  job.cleanup.push(merged, list, ...norms);
  job.phase = 'preparing'; job.step = 0; job.doneDur = 0; job.curDur = infos[0].dur;
  const j = job;
  const runFF = (args, onDone) => {
    j.log = '';
    const p = spawn('ffmpeg', ['-nostdin', ...args]);
    j.proc = p;
    p.stderr.on('data', d => { j.log = (j.log + d).slice(-500); });
    p.on('error', e => { j.error = 'FFmpeg not found: ' + e.message; j.proc = null; j.endedAt = Date.now(); cleanup(j); });
    p.on('close', code => {
      j.proc = null;
      if (j.error) return;
      if (j.stopped) { j.endedAt = Date.now(); cleanup(j); return; }
      if (code !== 0) { j.error = 'Merging failed: ' + j.log.slice(-200); j.endedAt = Date.now(); cleanup(j); return; }
      onDone();
    });
  };
  const next = i => {
    if (i === n) {
      fs.writeFileSync(list, norms.map(p => "file '" + p.replace(/'/g, "'\\''") + "'").join('\n'));
      j.step = n; j.curDur = 0;
      return runFF(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', merged],
        () => startStream(j, merged, true, null, loops, seconds, kbps, rtmp, k));
    }
    j.step = i; j.curDur = infos[i].dur;
    const a = ['-y', '-i', files[i].path];
    if (!infos[i].audio) a.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    a.push('-map', '0:v:0', '-map', infos[i].audio ? '0:a:0' : '1:a:0',
      '-vf', chain + ',setsar=1,fps=30,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '160k');
    if (!infos[i].audio) a.push('-shortest');
    a.push(norms[i]);
    runFF(a, () => { j.doneDur += infos[i].dur; next(i + 1); });
  };
  next(0);
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => { if (job && job.proc) { job.stopped = true; job.proc.kill('SIGINT'); } res.json({ ok: true }); });

app.get('/api/status', (req, res) => {
  if (!job) return res.json({ idle: true });
  const prep = job.phase === 'preparing';
  const last = (job.log.match(/[^\r\n]*time=[^\r\n]*/g) || []).pop() || '';
  const g = r => (last.match(r) || [])[1] || '';
  const elapsed = prep ? 0 : Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000);
  const play = job.mode === 'times' && job.vidDur > 0 && !prep ? Math.min(job.times, Math.floor(elapsed / job.vidDur) + 1) : 0;
  res.json({
    running: !!job.proc, prep, prepPct: prep && job.sumDur ? Math.min(99, Math.round(((job.doneDur || 0) + Math.min(tsec(job.log), job.curDur || 0)) / job.sumDur * 100)) : 0,
    step: (job.step || 0) + 1,
    name: job.name, count: job.count, total: job.seconds, error: job.error, stopped: !!job.stopped, elapsed,
    mode: job.mode, times: job.times, play, orient: job.orient, quality: job.quality,
    bitrate: prep ? '' : g(/bitrate=\s*(\S+)/), speed: prep ? '' : g(/speed=\s*(\S+)/),
    failed: !job.proc && !job.stopped && (job.code > 0 || !!job.error),
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

const INPUT = 'w-full rounded-xl border border-white/10 bg-zinc-900/80 px-4 py-3 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-500/30';
const LBL = 'mb-1.5 mt-5 block text-sm text-zinc-400';
const CHIP = 'rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:border-red-500 hover:text-white';

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
  <p class="mt-2 font-medium text-zinc-200">Drop videos here or click to browse</p>
  <p class="mt-1 text-xs text-zinc-500">You can add many videos — they are merged into one, in the order shown below</p>
 </div>
 <input type="file" id="video" accept="video/*" multiple hidden>
 <div id="listbox" class="mt-3 hidden">
  <div class="mb-1 flex items-center justify-between text-xs text-zinc-400"><span id="lsum"></span><button type="button" id="clear" class="text-red-400 hover:underline">Clear all</button></div>
  <div id="flist" class="space-y-1.5"></div>
 </div>

 <label class="${LBL}">Stream key <span class="text-zinc-500">(YouTube Studio → Go live → Stream key)</span></label>
 <div class="relative">
  <input id="key" type="password" autocomplete="off" placeholder="xxxx-xxxx-xxxx-xxxx-xxxx" class="${INPUT} pr-16">
  <button type="button" id="eye" class="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-3 py-1 text-xs text-zinc-400 hover:bg-white/10">Show</button>
 </div>

 <label class="${LBL}">How long to stream</label>
 <div class="grid grid-cols-2 gap-1 rounded-xl bg-zinc-900/80 p-1" id="modes">
  <button type="button" data-v="time" class="rounded-lg py-2 text-sm font-medium transition">⏱ Set time</button>
  <button type="button" data-v="times" class="rounded-lg py-2 text-sm font-medium transition">🔁 Play X times</button>
 </div>

 <div id="timeBox" class="mt-3">
  <div class="flex gap-2">
   <input id="amount" type="number" min="1" step="1" value="1" class="${INPUT}">
   <select id="unit" class="rounded-xl border border-white/10 bg-zinc-900/80 px-3 outline-none focus:border-red-500">
    <option value="hours">Hours</option><option value="minutes">Minutes</option>
   </select>
  </div>
  <div class="mt-2 flex flex-wrap gap-2" id="presets">
   <button type="button" data-a="15" data-u="minutes" class="${CHIP}">15 min</button>
   <button type="button" data-a="30" data-u="minutes" class="${CHIP}">30 min</button>
   <button type="button" data-a="1" data-u="hours" class="${CHIP}">1h</button>
   <button type="button" data-a="3" data-u="hours" class="${CHIP}">3h</button>
   <button type="button" data-a="6" data-u="hours" class="${CHIP}">6h</button>
   <button type="button" data-a="12" data-u="hours" class="${CHIP}">12h</button>
   <button type="button" data-a="24" data-u="hours" class="${CHIP}">24h</button>
  </div>
 </div>

 <div id="timesBox" class="mt-3 hidden">
  <input id="times" type="number" min="1" step="1" value="10" class="${INPUT}">
  <div class="mt-2 flex flex-wrap gap-2" id="tpresets">
   <button type="button" data-t="1" class="${CHIP}">1x</button>
   <button type="button" data-t="5" class="${CHIP}">5x</button>
   <button type="button" data-t="10" class="${CHIP}">10x</button>
   <button type="button" data-t="50" class="${CHIP}">50x</button>
   <button type="button" data-t="100" class="${CHIP}">100x</button>
  </div>
 </div>
 <p id="total" class="mt-2 text-xs text-zinc-500"></p>

 <label class="${LBL}">Video format</label>
 <div class="grid grid-cols-2 gap-3" id="orients">
  <button type="button" data-v="landscape" class="flex items-center gap-3 rounded-xl border p-3 text-left transition">
   <span class="block h-8 w-14 rounded border-2 border-current"></span><span><b class="block text-sm">Landscape</b><span class="text-xs text-zinc-400">16:9 · YouTube</span></span></button>
  <button type="button" data-v="portrait" class="flex items-center gap-3 rounded-xl border p-3 text-left transition">
   <span class="block h-12 w-7 rounded border-2 border-current"></span><span><b class="block text-sm">Portrait</b><span class="text-xs text-zinc-400">9:16 · Reels/Shorts</span></span></button>
 </div>

 <div class="mt-3 grid grid-cols-2 gap-3">
  <div><label class="mb-1 block text-xs text-zinc-400">Fit mode</label>
   <select id="fit" class="w-full rounded-xl border border-white/10 bg-zinc-900/80 px-3 py-2.5 text-sm outline-none focus:border-red-500">
    <option value="fit">Fit (black bars, no crop)</option><option value="fill">Fill (crop to screen)</option></select></div>
  <div><label class="mb-1 block text-xs text-zinc-400">Quality</label>
   <select id="quality" class="w-full rounded-xl border border-white/10 bg-zinc-900/80 px-3 py-2.5 text-sm outline-none focus:border-red-500">
    <option value="720">720p (3 Mbps)</option><option value="1080">1080p (5 Mbps)</option></select></div>
 </div>

 <div id="pwrap" class="mt-4 hidden text-center">
  <p class="mb-2 text-xs text-zinc-500">Live preview of the first video (how it will look)</p>
  <div id="pframe" class="mx-auto overflow-hidden rounded-xl border border-white/10 bg-black"><video id="pvid" muted loop autoplay playsinline class="h-full w-full"></video></div>
 </div>

 <div id="ubox" class="mt-5 hidden"><div class="h-2 overflow-hidden rounded-full bg-zinc-800"><div id="ufill" class="h-full w-0 rounded-full bg-gradient-to-r from-red-500 to-orange-400 transition-all"></div></div>
 <p class="mt-1 text-xs text-zinc-400">Uploading videos…</p></div>

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
var $=function(i){return document.getElementById(i)},items=[],mode='time',orient='landscape',vdur=0;
var ON=['border-red-500','bg-red-500/15','text-white'],OFF=['border-white/10','text-zinc-400'];
function toast(m){var t=$('toast');t.textContent=m;t.classList.remove('hidden');clearTimeout(toast.t);toast.t=setTimeout(function(){t.classList.add('hidden')},3500)}
function fmt(s){s=Math.max(0,Math.round(s));var h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return (h?h+'h ':'')+(m||h?m+'m ':'')+x+'s'}
function t(s){return new Date(Math.max(0,s)*1000).toISOString().substr(11,8)}
function mark(sel,val){document.querySelectorAll(sel+' button').forEach(function(b){var on=b.dataset.v===val;ON.forEach(function(c){b.classList.toggle(c,on)});OFF.forEach(function(c){b.classList.toggle(c,!on)})})}
function sumDur(){var s=0,ok=true;items.forEach(function(it){if(it.dur)s+=it.dur;else ok=false});return ok?s:0}
function total(){
 vdur=sumDur();var file=items.length;
 var s=0;
 if(mode==='times'){var n=parseInt($('times').value)||0;s=vdur*n;
  $('total').textContent=vdur?('Video '+fmt(vdur)+' × '+n+' plays = '+fmt(s)+' of streaming'):(file?'Reading video length…':'Choose a video to see total time')}
 else{var a=parseFloat($('amount').value)||0;s=a*($('unit').value==='minutes'?60:3600);
  $('total').textContent=vdur&&s?('≈ '+Math.floor(s/vdur*10)/10+' plays of your '+fmt(vdur)+' video'):''}
}
function layout(){
 var f=$('pframe'),v=$('pvid'),p=orient==='portrait';
 f.style.aspectRatio=p?'9/16':'16/9';f.style.height=p?'340px':'auto';f.style.width=p?'auto':'100%';f.style.maxWidth=p?'none':'460px';
 v.style.objectFit=$('fit').value==='fill'?'cover':'contain';
}
function esc(x){return String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;')}
function addFiles(fl){
 Array.prototype.forEach.call(fl,function(f){
  if(f.type&&f.type.indexOf('video')!==0)return;
  var it={file:f,dur:0};items.push(it);
  var v=document.createElement('video');v.preload='metadata';v.muted=true;v.src=URL.createObjectURL(f);
  v.onloadedmetadata=function(){it.dur=v.duration||0;URL.revokeObjectURL(v.src);renderList();total()};
  v.onerror=function(){it.dur=1;renderList();total()}});
 renderList()}
function renderList(){
 $('listbox').classList.toggle('hidden',!items.length);
 var sd=sumDur();
 $('lsum').textContent=items.length+' video'+(items.length>1?'s':'')+(sd?' · total '+fmt(sd):'');
 $('flist').innerHTML=items.map(function(it,i){
  return '<div class="flex items-center gap-2 rounded-lg bg-zinc-900/70 px-3 py-2 text-sm">'
   +'<span class="w-5 text-xs text-zinc-500">'+(i+1)+'</span>'
   +'<span class="min-w-0 flex-1 truncate">'+esc(it.file.name)+'</span>'
   +'<span class="text-xs text-zinc-500">'+(it.dur?fmt(it.dur):'…')+' · '+(it.file.size/1048576).toFixed(1)+' MB</span>'
   +'<button type="button" data-i="'+i+'" data-a="up" class="rounded px-1.5 text-zinc-400 hover:bg-white/10">↑</button>'
   +'<button type="button" data-i="'+i+'" data-a="down" class="rounded px-1.5 text-zinc-400 hover:bg-white/10">↓</button>'
   +'<button type="button" data-i="'+i+'" data-a="rm" class="rounded px-1.5 text-red-400 hover:bg-white/10">✕</button></div>'}).join('');
 var pv=$('pvid');
 if(items.length){if(pv.dataset.n!==items[0].file.name+items[0].file.size){pv.dataset.n=items[0].file.name+items[0].file.size;pv.src=URL.createObjectURL(items[0].file)}$('pwrap').classList.remove('hidden');layout()}
 else{pv.removeAttribute('src');pv.dataset.n='';$('pwrap').classList.add('hidden')}}
$('flist').onclick=function(e){var b=e.target.closest('button');if(!b)return;var i=+b.dataset.i,a=b.dataset.a;
 if(a==='rm')items.splice(i,1);
 else{var j=a==='up'?i-1:i+1;if(j<0||j>=items.length)return;var t=items[i];items[i]=items[j];items[j]=t}
 renderList();total()};
$('clear').onclick=function(){items=[];renderList();total()};
function setMode(m){mode=m;mark('#modes',m);$('timeBox').classList.toggle('hidden',m!=='time');$('timesBox').classList.toggle('hidden',m!=='times');total()}
function setOrient(o){orient=o;mark('#orients',o);layout()}
$('modes').onclick=function(e){var b=e.target.closest('button');if(b)setMode(b.dataset.v)};
$('orients').onclick=function(e){var b=e.target.closest('button');if(b)setOrient(b.dataset.v)};
$('fit').onchange=layout;
$('amount').oninput=total;$('unit').onchange=total;$('times').oninput=total;
document.querySelectorAll('#presets button').forEach(function(b){b.onclick=function(){$('amount').value=b.dataset.a;$('unit').value=b.dataset.u;total()}});
document.querySelectorAll('#tpresets button').forEach(function(b){b.onclick=function(){$('times').value=b.dataset.t;total()}});
$('drop').onclick=function(){$('video').click()};
$('video').onchange=function(e){addFiles(e.target.files);e.target.value=''};
$('drop').ondragover=function(e){e.preventDefault();$('drop').classList.add('border-red-500')};
$('drop').ondragleave=function(){$('drop').classList.remove('border-red-500')};
$('drop').ondrop=function(e){e.preventDefault();$('drop').classList.remove('border-red-500');addFiles(e.dataTransfer.files)};
$('eye').onclick=function(){var k=$('key');var s=k.type==='password';k.type=s?'text':'password';$('eye').textContent=s?'Hide':'Show'};
$('go').onclick=function(){
 if(!items.length)return toast('Choose at least one video');
 if(!$('key').value.trim())return toast('Enter your stream key');
 var fd=new FormData();
 fd.append('mode',mode);fd.append('amount',$('amount').value);fd.append('unit',$('unit').value);fd.append('times',$('times').value);
 fd.append('orient',orient);fd.append('fit',$('fit').value);fd.append('quality',$('quality').value);
 fd.append('streamKey',$('key').value);items.forEach(function(it){fd.append('videos',it.file)});
 var x=new XMLHttpRequest();x.open('POST','/api/start');$('go').disabled=true;$('ubox').classList.remove('hidden');
 x.upload.onprogress=function(e){if(e.lengthComputable)$('ufill').style.width=(e.loaded/e.total*100)+'%'};
 x.onload=function(){$('go').disabled=false;$('ubox').classList.add('hidden');$('ufill').style.width='0';
  var j={};try{j=JSON.parse(x.responseText)}catch(e){}toast(j.error||'🔴 Stream started!');poll()};
 x.onerror=function(){$('go').disabled=false;$('ubox').classList.add('hidden');toast('Upload failed')};x.send(fd)};
$('stop').onclick=function(){fetch('/api/stop',{method:'POST'}).then(function(){toast('Stopping…');setTimeout(poll,800)})};
function badge(c,txt){return '<span class="mr-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium '+c+'">'+txt+'</span>'}
function poll(){fetch('/api/status').then(function(r){return r.json()}).then(function(s){
 if(s.idle){$('st').innerHTML='⚪ Idle — no stream running';return}
 if(s.prep){$('st').innerHTML=badge('bg-amber-500/20 text-amber-300','⚙ Merging '+s.count+' videos · '+(s.step>s.count?'joining':'clip '+s.step+' of '+s.count))+'<p class="mt-3 truncate text-zinc-200">'+(s.name||'').replace(/</g,'&lt;')+'</p><div class="my-3 h-3 overflow-hidden rounded-full bg-zinc-800"><div class="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-400 transition-all duration-500" style="width:'+s.prepPct+'%"></div></div><p class="text-xs text-zinc-400">Preparing one combined video… '+s.prepPct+'% — streaming starts automatically</p>';return}
 var p=Math.min(100,s.elapsed/s.total*100),h='';
 if(s.running)h+=badge('bg-green-500/20 text-green-300','● STREAMING');
 else if(s.error||s.failed)h+=badge('bg-red-500/20 text-red-300','✖ Failed');
 else h+=badge('bg-zinc-700 text-zinc-300',s.stopped?'Stopped':'✔ Finished');
 h+=badge('bg-zinc-700 text-zinc-300',(s.orient==='portrait'?'9:16 ':'16:9 ')+s.quality+'p');
 if(s.mode==='times'&&s.play)h+=badge('bg-amber-500/20 text-amber-300','Play '+s.play+' / '+s.times);
 if(s.speed)h+=badge('bg-blue-500/20 text-blue-300','speed '+s.speed);
 if(s.bitrate)h+=badge('bg-purple-500/20 text-purple-300',s.bitrate);
 h+='<p class="mt-3 truncate text-zinc-200">'+(s.name||'').replace(/</g,'&lt;')+'</p>';
 h+='<div class="my-3 h-3 overflow-hidden rounded-full bg-zinc-800"><div class="h-full rounded-full bg-gradient-to-r from-red-500 to-orange-400 transition-all duration-500" style="width:'+p+'%"></div></div>';
 h+='<div class="flex justify-between text-xs text-zinc-400"><span>Elapsed '+t(s.elapsed)+'</span><span>'+Math.round(p)+'%</span><span>Left '+t(s.total-s.elapsed)+'</span></div>';
 if(s.error)h+='<p class="mt-3 text-xs text-red-400">'+s.error+'</p>';
 else if(s.failed)h+='<p class="mt-3 break-all text-xs text-red-400">Check your stream key / internet. '+(s.tail||'').replace(/</g,'&lt;')+'</p>';
 $('st').innerHTML=h})}
setMode('time');setOrient('landscape');
setInterval(poll,2000);poll();
</script></body></html>`;
