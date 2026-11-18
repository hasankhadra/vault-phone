/* Vault (phone) — the clerk's drawer on the iPhone.
 * Talks only to GitHub (the private vault repo) with a fine-grained token kept on this device.
 * Reads .derived/drawer.json (built in CI on the owner's Claude subscription) and the unfiled capture files;
 * writes only its own capture file and source/ drops. No server; this page holds no data.
 */
'use strict';
Object.defineProperty(globalThis, 'ME', { get: () => (window.__cfgName || 'Owner') });

// ---------- setup & storage ----------
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('vault.' + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem('vault.' + k, JSON.stringify(v)); },
};
function decodeSetup(code) {
  const s = code.trim().replace(/^.*#s=/, '').replace(/-/g, '+').replace(/_/g, '/');
  const j = JSON.parse(decodeURIComponent(escape(atob(s))));
  if (!j.t || !j.r) throw new Error('bad code');
  return j;
}
function readSetupFromURL() {
  const m = location.hash.match(/#s=([A-Za-z0-9_\-+/=]+)/);
  if (!m) return;
  try { LS.set('cfg', decodeSetup(m[1])); } catch {}
}
readSetupFromURL();
let cfg = LS.get('cfg', null);
window.__cfgName = cfg && cfg.n;
const state = {
  later: LS.get('later', {}),      // id -> ISO until   (only on this phone)
  rest: LS.get('rest', {}),        // question id -> ISO until
  shelf: LS.get('shelf', []),      // waiting entries
  mine: LS.get('mine', {}),        // id -> your last note (still open)
  gone: LS.get('gone', {}),        // id -> ISO when you closed it here (until the capture shows up)
};
function save() { for (const k of ['later', 'rest', 'shelf', 'mine', 'gone']) LS.set(k, state[k]); }

// ---------- GitHub ----------
const API = 'https://api.github.com';
async function gh(path, opts = {}) {
  if (cfg.b) {
    if (opts.body) { const j = JSON.parse(opts.body); j.branch = cfg.b; opts = { ...opts, body: JSON.stringify(j) }; }
    else path += (path.includes('?') ? '&' : '?') + 'ref=' + encodeURIComponent(cfg.b);
  }
  const r = await fetch(`${API}/repos/${cfg.r}/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${cfg.t}`, Accept: opts.raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    cache: 'no-store',
  });
  if (!r.ok && !(opts.allow || []).includes(r.status)) throw new Error(`GitHub ${r.status} on ${path}`);
  return r;
}
const b64 = s => btoa(unescape(encodeURIComponent(s)));
const unb64 = s => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));

// ---------- time ----------
const pad = n => String(n).padStart(2, '0');
function stamp(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function dayLabel(d) { return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }
function nextWeekday(wd) { const d = new Date(); d.setHours(9, 0, 0, 0); do { d.setDate(d.getDate() + 1); } while (d.getDay() !== wd); return d; }
function daysSince(raw) { const m = raw.match(/(\d{4})-(\d{2})-(\d{2})/); if (!m) return 0; return Math.max(0, Math.floor((Date.now() - new Date(+m[1], m[2] - 1, +m[3])) / 864e5)); }
function daysUntil(tag) { const t = tag.toUpperCase(); if (t.includes('TODAY')) return 0; const m = t.match(/IN (\d+) D/); return m ? +m[1] : null; }

// ---------- captures (the vault's own record; held a few seconds so Undo works) ----------
const HOLD = 5000;
let writeChain = Promise.resolve();
const pending = new Map();   // id -> timer
function writeCapture(fact, onState) {
  const id = Math.random().toString(36).slice(2);
  const line = `- ${stamp()} ${fact.replace(/\s*\n+\s*/g, ' ')}`;
  onState?.('held');
  const timer = setTimeout(() => {
    pending.delete(id);
    writeChain = writeChain.then(() => appendLine(line)).then(() => onState?.('saved'), e => { onState?.('failed', e); });
  }, HOLD);
  pending.set(id, { timer, line, onState });
  return id;
}
function cancelCapture(id) { const p = pending.get(id); if (!p) return false; clearTimeout(p.timer); pending.delete(id); return true; }
function flushNow() { for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); writeChain = writeChain.then(() => appendLine(p.line)).then(() => p.onState?.('saved'), e => p.onState?.('failed', e)); } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); else load(); });

async function appendLine(line) {
  const today = stamp().slice(0, 10);
  let f = LS.get('capfile', null);
  if (!f || f.day !== today) f = { day: today, name: `capture-${stamp().replace(/[: ]/g, '-').replace(/-(\d\d)-(\d\d)$/, '-$1$2')}-${Math.floor(Math.random() * 65536).toString(16).padStart(4, '0')}.md` };
  for (let attempt = 0; attempt < 3; attempt++) {
    const path = `contents/_inbox/captures/${f.name}`;
    const cur = await gh(path, { allow: [404] });
    let body, sha;
    if (cur.status === 404) {
      if (LS.get('capfile', null)?.name === f.name) {   // it existed before: the filing pass claimed it — start a new one
        f = { day: today, name: f.name.replace(/-[0-9a-f]{4}\.md$/, '-' + Math.floor(Math.random() * 65536).toString(16).padStart(4, '0') + '.md') };
        LS.set('capfile', null);
        continue;
      }
      body = line + '\n';
    } else {
      const j = await cur.json(); sha = j.sha; body = unb64(j.content); if (!body.endsWith('\n')) body += '\n'; body += line + '\n';
    }
    const put = await gh(path, { method: 'PUT', allow: [409, 422], body: JSON.stringify({ message: 'capture: Vault phone', content: b64(body), ...(sha ? { sha } : {}) }) });
    if (put.ok) { LS.set('capfile', f); return; }
  }
  throw new Error('could not save the capture');
}

async function sha256Hex(buf) { const h = await crypto.subtle.digest('SHA-256', buf); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function uploadSource(file, note) {
  const buf = await file.arrayBuffer();
  const hash = await sha256Hex(buf);
  let bin = ''; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const base = file.name.replace(/[^\w.\-]+/g, '-');
  let name = /^\d{4}-\d{2}-\d{2}/.test(base) ? base : `${stamp().slice(0, 10)}-phone-${base}`;
  for (let i = 2; (await gh(`contents/source/${name}`, { allow: [404] })).ok; i++) name = name.replace(/(\.[^.]+)?$/, `-${i}$1`);
  await gh(`contents/source/${name}`, { method: 'PUT', body: JSON.stringify({ message: `source: ${name} (Vault phone)`, content: btoa(bin) }) });
  await new Promise(res => writeCapture(`Source drop via Vault phone: ${name} · sha256 ${hash}${note ? ` · ${ME}'s note: “${note}”` : ''}`, s => { if (s !== 'held') res(); }));
  return name;
}

// ---------- the drawer ----------
let drawer = null, overlay = { answered: new Set(), doneRefs: new Set(), waitingRefs: new Set() };
async function load() {
  if (!cfg) return;
  document.getElementById('refresh').classList.add('spin');
  try {
    const [d, list] = await Promise.all([
      gh('contents/.derived/drawer.json', { raw: true }).then(r => r.json()),
      gh('contents/_inbox/captures', { allow: [404] }).then(r => r.ok ? r.json() : []),
    ]);
    drawer = d;
    const files = list.filter(f => f.type === 'file' && /^capture-.*\.md$/.test(f.name) && !f.name.includes('claimed'));
    const texts = await Promise.all(files.map(f => gh(`contents/_inbox/captures/${f.name}`, { raw: true }).then(r => r.text()).catch(() => '')));
    overlay = parseOverlay(texts.join('\n'));
    // forget local hides the vault has caught up with
    for (const id of Object.keys(state.gone)) if (Date.now() - Date.parse(state.gone[id]) > 3 * 864e5) delete state.gone[id];
    save();
    setStatus(`Vault as of ${drawer.asOf}`);
  } catch (e) { setStatus(String(e.message || e)); }
  document.getElementById('refresh').classList.remove('spin');
  render();
}
function parseOverlay(text) {
  const o = { answered: new Set(), doneRefs: new Set(), waitingRefs: new Set() };
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/\(answers ([^)]+)\)/g)) o.answered.add('q:' + m[1].trim());
    const b = line.match(/\(bears on ([^)]+)\)\s*$/);
    if (!b) continue;
    const ref = b[1].trim();
    if (/done —|— yes, it came|: done\b/.test(line)) o.doneRefs.add(ref);
    else if (line.includes('⏳')) o.waitingRefs.add(ref);
  }
  return o;
}
function refOf(item, title) {
  const m = item.id.match(/^ref:(.*)@/);
  return m ? m[1] : `key-dates: ${title}`;
}
function itemTitle(it) { return it.summary?.title || it.text.replace(/\s+—.*$/, '').slice(0, 70); }
function hiddenItem(it) {
  const ref = refOf(it, itemTitle(it));
  if (overlay.doneRefs.has(ref) || overlay.waitingRefs.has(ref)) return true;
  if (state.gone[it.id]) return true;
  if (state.later[it.id] && Date.parse(state.later[it.id]) > Date.now()) return true;
  if (state.shelf.some(s => s.id === it.id)) return true;
  return false;
}
function hiddenQ(q) {
  return overlay.answered.has(q.id) || state.gone[q.id] || (state.rest[q.id] && Date.parse(state.rest[q.id]) > Date.now());
}

// ---------- rendering ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SYM = [['🩺', /health|insurance|medical|clinic/], ['💵', /\$|invoice|payment|paid|ron\b|lei|eur|money|salary/], ['🏛️', /igi|anaf|permit|visa|tax|residence|embassy|onrc|address/],
  ['🎓', /class|course|tascr|ibd|lecture|thesis|exam|presentation|upb/], ['🎁', /birthday|gift/], ['🏠', /flat|lease|rent|apartment|landlord/], ['💼', /kontas|milo|payroll|contract|mandate|micro/]];
const glyph = t => (SYM.find(([, re]) => re.test(t.toLowerCase())) || ['📅'])[0];
const patina = d => d >= 60 ? 'fossil' : d >= 14 ? 'cobweb' : d >= 7 ? 'dusty' : '';
const WEB = `<svg class="web" viewBox="0 0 52 52"><path d="M52 0L24 28M52 0L52 34M52 0L18 0M52 0L32 40M52 0L12 16"/><path d="M43 0Q45 7 52 9M34 0Q38 11 52 18M25 0Q30 17 52 27"/></svg>`;
function tally(n) {
  const shown = Math.min(n, 15); let x = 1, p = '';
  for (let g = 0; g < Math.ceil(shown / 5); g++) { const k = Math.min(5, shown - g * 5);
    for (let i = 0; i < Math.min(k, 4); i++) p += `<path d="M${x + i * 4 + 1} ${2 + ((i * 7 + g * 3) % 5 - 2) * .3}L${x + i * 4 + (i % 2 ? 1.6 : .6)} 14"/>`;
    if (k === 5) p += `<path d="M${x - 1} 11L${x + 15} 4"/>`; x += 21; }
  return `<svg class="tally" width="${x}" height="16" viewBox="0 0 ${x} 16">${p}</svg>`;
}

function board() {
  const cards = [], fyi = [];
  for (const s of state.shelf) if (s.back && Date.parse(s.back) <= Date.now()) cards.push({ back: true, ...s });
  for (const it of drawer?.items || []) {
    if (hiddenItem(it)) continue;
    const late = it.kind === 'overdue' ? daysSince(it.raw) : 0, days = daysUntil(it.tag);
    const isFyi = it.kind === 'upcoming' && ((it.summary && !it.summary.next) || (days ?? 0) > 7);
    (isFyi ? fyi : cards).push({ it, late, days });
  }
  return { cards, fyi };
}
function whenText(c) {
  if (c.it.kind === 'overdue') return c.late >= 60 ? `${c.late} days. Officially a fossil.` : c.late ? `${c.late} days overdue` : 'Overdue';
  const t = c.it.tag.toUpperCase();
  if (t.includes('PAST')) return 'Date passed'; if (t.includes('WINDOW')) return 'Window open';
  return c.days === 0 ? 'Today' : c.days === 1 ? 'Tomorrow' : c.days != null ? `In ${c.days} days` : c.it.tag;
}
function quip(cards) {
  const n = cards.length, fossils = cards.filter(c => c.late >= 60).length;
  const words = ['Nothing wants', 'One thing wants', 'Two things want', 'Three things want', 'Four things want', 'Five things want'];
  if (!n) return '';
  const lead = (words[n] || `${n} things want`) + ' you.';
  return fossils === 1 ? `${lead} One of them is a fossil.` : fossils > 1 ? `${lead} ${fossils} of them are fossils.` : n <= 2 ? 'Just a couple of things. Practically a holiday.' : lead;
}
const EMPTIES = [['Nothing needs you.', "Suspicious. I'll keep watching."], ['All quiet.', 'Even the accountant is quiet. Enjoy it.'], ['Inbox zero, vault edition.', 'Take a walk. I have this.'], ['Nothing on fire.', 'Not even smouldering. I checked twice.']];

function render() {
  $('#date').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  if (!drawer) { $('#cards').innerHTML = '<div class="empty"><div class="quip">Opening the vault…</div></div>'; return; }
  const { cards, fyi } = board();
  $('#quip').textContent = quip(cards);
  const box = $('#cards'); box.innerHTML = '';
  if (!cards.length) { const [t, s] = EMPTIES[new Date().getDate() % EMPTIES.length]; box.innerHTML = `<div class="empty"><div class="t">${t}</div><div class="quip">${s}</div></div>`; }
  for (const c of cards) box.appendChild(c.back ? backCard(c) : itemCard(c));
  const side = $('#side'); side.innerHTML = '';
  const qs = (drawer.questions || []).filter(q => !hiddenQ(q));
  if (qs.length) {
    const round = Math.min(5, qs.length), most = qs.reduce((a, q) => q.asked > (a?.asked || 0) ? q : a, null);
    const t = document.createElement('button'); t.className = 'tile qtile'; t.style.textAlign = 'left';
    t.innerHTML = `<div class="label">When you have a minute</div><div class="big">${round}</div><div class="quip">quick questions · about ${round * 10} seconds</div>
      ${most && most.asked > 1 ? `<div style="margin-top:8px">${tally(most.asked)} <span class="quip" style="font-size:12.5px">${esc(most.tag)} has been asked ${most.asked} times</span></div>` : ''}
      ${qs.length > round ? `<div class="hint">${qs.length} in the pile. One handful at a time.</div>` : ''}
      <div class="pill primary" style="display:grid;place-items:center;margin-top:12px">Start</div>`;
    t.onclick = () => openDeck(qs.slice(0, 5));
    side.appendChild(t);
  }
  const waiting = state.shelf.filter(s => !s.back || Date.parse(s.back) > Date.now());
  if (waiting.length) {
    const w = document.createElement('div'); w.className = 'tile';
    w.innerHTML = `<div class="label">⏳ Waiting on others</div>` + waiting.map((s, i) => `<div class="shelfrow"><div>${esc(s.title)}</div><div class="hint">${esc(s.who)} · back ${s.back ? dayLabel(new Date(s.back)) : 'when they reply'} · <span class="link" data-i="${i}">Bring back now</span></div></div>`).join('');
    w.querySelectorAll('[data-i]').forEach(el => el.onclick = () => { const s = waiting[+el.dataset.i]; s.back = new Date(Date.now() - 1000).toISOString(); save(); render(); });
    side.appendChild(w);
  }
  if (fyi.length) {
    const f = document.createElement('div'); f.className = 'tile';
    f.innerHTML = `<div class="label">Coming up · nothing to do</div>` + fyi.map(c => `<div class="fyirow"><div class="w">${esc(whenText(c))}</div><div>${esc(itemTitle(c.it))}</div></div>`).join('');
    side.appendChild(f);
  }
}

function cardShell(cls, glyphChar, title, body, when, late) {
  const el = document.createElement('div'); el.className = 'card ' + cls;
  el.innerHTML = `${cls.includes('cobweb') || cls.includes('fossil') ? WEB : ''}
    <div class="row"><div class="glyph">${glyphChar}</div><div style="flex:1;min-width:0">
      <div class="t">${esc(title)}</div>${body}
      <div class="age ${late >= 7 ? 'late' : ''}">${late >= 60 ? '🦴 ' : ''}${esc(when)}</div></div>
      <button class="replybtn" aria-label="Reply"><svg viewBox="0 0 20 20"><path d="M8 4.5 3 9.5l5 5M3.6 9.5H11c3.3 0 5.5 2 5.5 5.5"/></svg></button></div>
    <div class="actions"></div><div class="reply" hidden></div><div class="stamp"></div>`;
  return el;
}

function itemCard(c) {
  const it = c.it, title = itemTitle(it), ref = refOf(it, title);
  const mine = state.mine[it.id];
  const body = `${mine ? `<div class="s mine">You: “${esc(mine)}”</div>` : ''}<div class="s">${esc(it.summary?.status || it.text)}</div>`;
  const el = cardShell(patina(c.late), glyph(title + ' ' + it.text), title, body, whenText(c), c.late);
  const acts = el.querySelector('.actions');
  const word = c.late >= 60 ? 'FINALLY' : /pay|invoice/i.test(title) ? 'PAID' : /file|submit/i.test(title) ? 'FILED' : /order|buy|gift/i.test(title) ? 'ORDERED' : 'DONE';
  addPill(acts, 'Done', 'primary', () => stampOut(el, word, it.id, `${ME} (Vault phone): done — ${title} (bears on ${ref})`, c.late >= 60 ? 'Fossil retired. It had a good run.' : 'Marked done.'));
  addPill(acts, 'Later ▾', '', () => laterChoices(el, it.id));
  addPill(acts, 'Claude ↗', 'ghost', () => openClaude(handoff(title, it.raw, '')));
  wireReply(el, { title, raw: it.raw, ref, id: it.id, word });
  return el;
}

function backCard(s) {
  const el = cardShell('', '⏳', s.ask, `<div class="s">About ${esc(s.title.toLowerCase())}. Checking in, as promised.</div>`, 'Back today', 0);
  const acts = el.querySelector('.actions');
  addPill(acts, 'Yes, got it', 'primary', () => { state.shelf = state.shelf.filter(x => x !== s); stampOut(el, 'RECEIVED', s.id, `${ME} (Vault phone): ${s.ask.replace(/\?$/, '')} — yes, it came (bears on ${s.ref})`, 'Noted.'); });
  addPill(acts, 'Not yet', '', () => { s.back = nextWeekday((new Date().getDay() + 2) % 7).toISOString(); save(); leave(el); toast('Back in a couple of days.'); });
  wireReply(el, { title: s.title, raw: s.title, ref: s.ref, id: s.id, word: 'NOTED', back: s });
  return el;
}

function addPill(parent, label, kind, fn) { const b = document.createElement('button'); b.className = `pill ${kind}`; b.textContent = label; b.onclick = fn; parent.appendChild(b); return b; }
function leave(el) { el.classList.add('leaving'); setTimeout(render, 450); }

function stampOut(el, word, id, fact, msg) {
  const st = el.querySelector('.stamp'); st.textContent = word; el.classList.add('stamped'); st.classList.add('hit');
  state.gone[id] = new Date().toISOString(); delete state.mine[id]; save();
  const cap = writeCapture(fact, syncStatus);
  setTimeout(() => leave(el), 850);
  toast(msg, () => { cancelCapture(cap); delete state.gone[id]; save(); render(); });
}

function laterChoices(el, id) {
  const acts = el.querySelector('.actions'); acts.innerHTML = '';
  const set = (d, label) => { state.later[id] = d.toISOString(); save(); leave(el); toast(`See you ${label}.`, () => { delete state.later[id]; save(); render(); }, true); };
  const at = n => { const d = new Date(); d.setHours(9, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
  addPill(acts, 'Tomorrow', 'sm', () => set(at(1), 'tomorrow'));
  addPill(acts, 'Monday', 'sm', () => set(nextWeekday(1), dayLabel(nextWeekday(1))));
  addPill(acts, 'Next week', 'sm', () => set(at(7), 'next week'));
  addPill(acts, "When I'm emotionally ready", 'sm', () => { const n = 3 + Math.floor(Math.random() * 8); set(at(n), `in ${n} days. No pressure`); });
}

function wireReply(el, ctx) {
  const box = el.querySelector('.reply');
  el.querySelector('.replybtn').onclick = () => {
    const open = box.hidden; box.hidden = !open; el.classList.toggle('replying', open);
    if (!open) return;
    box.innerHTML = `<textarea rows="3" placeholder="What's really going on? End with ? to ask Claude."></textarea>
      <div class="choices"><button class="pill primary sm" data-a="send">Send</button><span class="hint">Ends with ? → opens Claude · otherwise you pick what it is</span></div>`;
    const ta = box.querySelector('textarea'); ta.focus();
    box.querySelector('[data-a=send]').onclick = () => {
      const t = ta.value.trim(); if (!t) return;
      if (t.endsWith('?')) { openClaude(handoff(ctx.title, ctx.raw, t)); return; }
      pickKind(el, box, ctx, t);
    };
  };
}

function guessWho(t) { const m = t.match(/(?:waiting (?:on|for)|from) ((?:the |my )?[\p{L}]+)/iu) || t.match(/((?:the |my )[\p{L}]+) (?:still )?(?:didn'?t|hasn'?t|has not|did not|won'?t)/iu); return m ? m[1] : ''; }
function guessWhat(t) { const m = t.match(/(?:send|sent|give|gave)(?: me)? (the [\p{L}]+)/iu); return m ? m[1].replace(/pdf/i, 'PDF') : ''; }

function pickKind(el, box, ctx, text) {
  box.innerHTML = `<div class="s mine">“${esc(text)}”</div><div class="choices" style="margin-top:10px">
    <button class="pill primary sm" data-k="done">It's done</button><button class="pill sm" data-k="wait">Waiting on someone</button><button class="pill sm" data-k="note">Just a note</button></div>`;
  box.querySelector('[data-k=done]').onclick = () => stampOut(el, ctx.word, ctx.id, `${ME} (Vault phone): done — ${ctx.title}: “${text}” (bears on ${ctx.ref})`, 'Marked done.');
  box.querySelector('[data-k=note]').onclick = () => {
    state.mine[ctx.id] = text; save();
    const cap = writeCapture(`${ME} (Vault phone, on “${ctx.title}”): “${text}” (bears on ${ctx.ref})`, syncStatus);
    render(); toast('Noted, still open.', () => { cancelCapture(cap); delete state.mine[ctx.id]; save(); render(); });
  };
  box.querySelector('[data-k=wait]').onclick = () => {
    box.innerHTML = `<input class="field" data-f="who" placeholder="Waiting on whom? e.g. the lawyer" value="${esc(guessWho(text))}">
      <input class="field" data-f="what" placeholder="For what? e.g. the policy PDF (optional)" value="${esc(guessWhat(text))}" style="margin-top:8px">
      <div class="choices"><span class="hint">Back on</span><button class="pill sm" data-b="5">Fri</button><button class="pill sm" data-b="1">Mon</button><button class="pill sm" data-b="reply">When they reply</button></div>`;
    box.querySelectorAll('[data-b]').forEach(b => b.onclick = () => {
      const who = box.querySelector('[data-f=who]').value.trim() || 'them', what = box.querySelector('[data-f=what]').value.trim();
      const back = b.dataset.b === 'reply' ? null : nextWeekday(+b.dataset.b);
      const entry = { id: ctx.id, ref: ctx.ref, who, what, title: what ? `${what[0].toUpperCase() + what.slice(1)} · ${ctx.title.toLowerCase()}` : ctx.title,
        ask: what ? `Did ${who} send ${what}?` : `Any news from ${who}?`, back: back?.toISOString() || null, at: new Date().toISOString() };
      state.shelf = state.shelf.filter(s => s.id !== ctx.id); state.shelf.push(entry);
      if (ctx.back) state.shelf = state.shelf.filter(s => s !== ctx.back);
      save();
      const cap = writeCapture(`${ME} (Vault phone, on “${ctx.title}”): “${text}” ⏳ waiting on ${who}${what ? ` for ${what}` : ''}; ${ME} checks back ${back ? dayLabel(back) : 'when they reply'} (bears on ${ctx.ref})`, syncStatus);
      leave(el);
      toast(`Parked: waiting on ${who}, back ${back ? dayLabel(back) : 'when they reply'}.`, () => { cancelCapture(cap); state.shelf = state.shelf.filter(s => s !== entry); save(); render(); });
    });
  };
}

// ---------- quick questions ----------
function openDeck(round) {
  const deck = $('#deck'); deck.hidden = false; let i = 0;
  const show = () => {
    if (i >= round.length) {
      deck.innerHTML = `<div class="empty" style="margin:auto"><div style="font-size:44px">🗂️</div><div class="t">All caught up.</div><div class="quip">The question register just lost a few pounds.</div>
        <button class="pill primary" style="margin-top:16px" id="deckback">Back to today</button></div>`;
      $('#deckback').onclick = () => { deck.hidden = true; render(); }; return;
    }
    const q = round[i], c = q.card || {};
    deck.innerHTML = `<div class="decktop"><button class="pill ghost" id="dclose">‹ Back</button><div class="pips">${round.map((_, j) => `<i class="pip ${j < i ? 'did' : j === i ? 'now' : ''}"></i>`).join('')}</div><span style="width:60px"></span></div>
      <div class="qcard" id="qc"><div style="display:flex;justify-content:space-between" class="hint"><span>${esc(q.tag)}</span><span>${q.asked > 1 ? tally(q.asked) + ` asked ${q.asked}×` : ''}</span></div>
        <div class="qq">${esc(c.short || q.text)}</div><div class="qwhy">${esc(c.why || '')}</div>
        <div id="qx" hidden><div class="explain">${esc(c.explain || q.context || 'No more detail in the register.')}${c.hint ? `<div class="qhint">${esc(c.hint)}</div>` : ''}</div></div>
        <div id="qbox" hidden style="margin-top:12px"><textarea rows="2" placeholder="Answer in your own words, or ask with ?"></textarea>
          <div class="choices"><button class="pill primary sm" id="qsend">Send</button><span class="hint">Ends with ? → opens Claude · otherwise it's your answer</span></div></div>
        <div class="qans">${(c.answers || []).map((a, j) => `<button class="pill ${j ? '' : 'primary'}" data-a="${esc(a)}">${esc(a)}</button>`).join('')}</div>
        <div class="qmeta"><button class="pill ghost sm" id="qdk">Don't know</button><button class="pill ghost sm" id="qdm">Doesn't matter</button><button class="pill ghost sm" id="qex">? Explain</button><button class="pill ghost sm" id="qsay">Say more…</button></div></div>`;
    const next = dir => { $('#qc').classList.add(dir); i++; setTimeout(show, 280); };
    $('#dclose').onclick = () => { deck.hidden = true; render(); };
    const answer = a => { state.gone[q.id] = new Date().toISOString(); save(); writeCapture(`${ME} (Vault phone quick question ${q.tag}): ${c.short || q.text} → “${a}” (answers ${q.tag})`, syncStatus); toast(`${q.tag}: “${a}”.`); next('gone-r'); };
    deck.querySelectorAll('[data-a]').forEach(b => b.onclick = () => answer(b.dataset.a));
    $('#qdk').onclick = () => { state.rest[q.id] = new Date(Date.now() + 7 * 864e5).toISOString(); save(); toast('Resting it for a week.'); next('gone'); };
    $('#qdm').onclick = () => { state.gone[q.id] = new Date().toISOString(); save(); writeCapture(`${ME} (Vault phone quick question ${q.tag}): this doesn't matter to him any more; stop asking (answers ${q.tag})`, syncStatus); toast(`Dropped. ${q.tag} won't be asked again.`); next('gone'); };
    $('#qex').onclick = () => { $('#qx').hidden = !$('#qx').hidden; $('#qbox').hidden = false; };
    $('#qsay').onclick = () => { $('#qbox').hidden = false; $('#qbox textarea').focus(); };
    $('#qsend').onclick = () => { const t = $('#qbox textarea').value.trim(); if (!t) return; if (t.endsWith('?')) openClaude(handoff(c.short || q.text, q.text + ' ' + q.context, t)); else answer(t); };
  };
  show();
}

// ---------- Claude (the app on this phone, with the text typed in) ----------
function handoff(title, record, said) {
  let t = `From my Vault: ${title}.\n\nWhat the vault has: ${String(record).replace(/[*`]/g, '').slice(0, 1200)}`;
  if (said) t += `\n\nWhat I'm asking / saying: ${said}`;
  return t + `\n\nUse my vault (GitHub: ${cfg.r}) and tell me briefly where this stands and the next step.`;
}
function openClaude(text) { location.href = 'https://claude.ai/new?q=' + encodeURIComponent(text); }

// ---------- bar: tell / ask / files ----------
let files = [];
function renderChips() {
  $('#chips').innerHTML = files.map((f, i) => `<span class="fchip">${esc(f.name)} <b data-x="${i}">✕</b></span>`).join('');
  $('#chips').querySelectorAll('[data-x]').forEach(x => x.onclick = () => { files.splice(+x.dataset.x, 1); renderChips(); });
  $('#barinput').placeholder = files.length ? 'Add a note (optional), then ↩' : 'Tell me something, or ask with ?';
}
$('#attach').onclick = () => $('#file').click();
$('#file').onchange = e => { files.push(...e.target.files); e.target.value = ''; renderChips(); $('#barinput').focus(); };
$('#barinput').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const t = e.target.value.trim();
  if (files.length) {
    const batch = files; files = []; renderChips(); e.target.value = '';
    setStatus(`Filing ${batch.length} file(s)…`);
    try { const names = []; for (const f of batch) names.push(await uploadSource(f, t)); setStatus(`✓ Filed ${names.join(', ')} · Claude knows`); }
    catch (err) { files = batch; renderChips(); setStatus(`Couldn't file it: ${err.message}`); }
    return;
  }
  if (!t) return;
  e.target.value = '';
  if (t.endsWith('?')) { openClaude(`${t}\n\n(Look in my vault, GitHub: ${cfg.r}.)`); return; }
  const cap = writeCapture(`${ME} (Vault phone): ${t}`, syncStatus);
  toast(`Noted: “${t}”`, () => cancelCapture(cap));
});

// ---------- feedback ----------
let toastTimer;
function toast(msg, undo, local) {
  const el = $('#toast'); el.hidden = false;
  el.innerHTML = `<span>${esc(msg)}${local ? ' <span class="hint">· only on this phone</span>' : ''}</span>${undo ? '<button class="link" id="undo">Undo</button>' : ''}`;
  if (undo) $('#undo').onclick = () => { undo(); el.hidden = true; };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, HOLD + 500);
}
function syncStatus(s, e) { setStatus(s === 'held' ? 'Saving…' : s === 'saved' ? '✓ Saved · Claude knows' : `Couldn't save: ${e?.message || e}`); }
function setStatus(t) { $('#status').textContent = t; }

// ---------- start ----------
$('#refresh').onclick = () => { $('#refresh .wheel').style.animation = 'click .6s'; setTimeout(() => $('#refresh .wheel').style.animation = '', 650); load(); };
$('#setupgo').onclick = () => { try { cfg = decodeSetup($('#setupcode').value); LS.set('cfg', cfg); window.__cfgName = cfg.n; $('#setup').hidden = true; load(); } catch { $('#setupcode').value = ''; $('#setupcode').placeholder = "That code didn't work. Try again."; } };
if (!cfg) $('#setup').hidden = false; else load();
if (location.hash.includes('selftest') && cfg && cfg.b) selftest();
async function selftest() {
  const out = [];
  try {
    await load(); out.push(`read: ${drawer.items.length} items, ${drawer.questions.length} questions`);
    await appendLine(`- ${stamp()} selftest line one`); await appendLine(`- ${stamp()} selftest line two`);
    out.push('append: ok');
    const f = new File([new TextEncoder().encode('hello from the selftest')], 'selftest.txt', { type: 'text/plain' });
    const name = await uploadSource(f, 'a note'); out.push('upload: ' + name);
    await writeChain; out.push('done');
    document.title = 'SELFTEST OK · ' + out.join(' · ');
  } catch (e) { document.title = 'SELFTEST FAIL · ' + out.join(' · ') + ' · ' + e.message; }
}
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
