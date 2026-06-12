import './style.css';

let campaign;
let turns = [];
let active = 0;

const normalizeTurn = (turn, index) => ({
  turn: turn.turn ?? index + 1,
  round: turn.round ?? null,
  title: turn.title ?? `Iteration ${index + 1}`,
  technique: turn.technique ?? turn.title ?? 'Adaptive probe',
  hypothesis: turn.hypothesis ?? 'No hypothesis recorded.',
  attempt: turn.attempt ?? 'No attempt detail recorded.',
  result: turn.result ?? (turn.verdict === 'verified-escape' ? 'The finding reproduced in a fresh environment.' : 'No forbidden capability was observed.'),
  adaptation: turn.adaptation ?? 'Continue with a different bounded attack class.',
  verdict: turn.verdict ?? 'inconclusive',
  imageUrl: turn.imageUrl ?? '/demo/turn-01.jpg',
});

const app = document.querySelector('#app');
const FRAME_W = 150 + 9; // frame width + gap, keep in sync with css
const verdictLabel = (v) => (v === 'verified-escape' ? 'verified escape' : v);

// ---- density minimap: one thin bar per turn, escapes in red ----
function minimap() {
  return turns
    .map((t, i) => {
      const cls = ['tick'];
      if (i === active) cls.push('active');
      if (t.verdict === 'verified-escape') cls.push('escape');
      return `<button class="${cls.join(' ')}" data-turn="${i}" title="Turn ${t.turn}: ${t.title}"></button>`;
    })
    .join('');
}

// ---- virtualized filmstrip: only render frames near the viewport ----
function renderFrames(strip) {
  const start = Math.max(0, Math.floor(strip.scrollLeft / FRAME_W) - 4);
  const visible = Math.ceil(strip.clientWidth / FRAME_W) + 8;
  const end = Math.min(turns.length, start + visible);
  const pad = document.createElement('div');
  pad.style.minWidth = `${start * FRAME_W}px`;
  const frag = document.createDocumentFragment();
  frag.appendChild(pad);
  for (let i = start; i < end; i++) {
    const t = turns[i];
    const b = document.createElement('button');
    b.dataset.turn = String(i);
    b.className = `frame${i === active ? ' active' : ''}${t.verdict === 'verified-escape' ? ' escape' : ''}`;
    b.innerHTML = `<img loading="lazy" src="${t.imageUrl}" alt=""><span>${t.turn}. ${t.title}</span>`;
    b.addEventListener('click', () => select(i, true));
    frag.appendChild(b);
  }
  const tail = document.createElement('div');
  tail.style.minWidth = `${(turns.length - end) * FRAME_W}px`;
  frag.appendChild(tail);
  strip.replaceChildren(frag);
}

function detailPanel() {
  const t = turns[active];
  const proof = t.verdict === 'verified-escape'
    ? `<div class="proof"><b>Why this is verified</b><p>Two fresh environments show the same forbidden boundary crossing from the exact same attack. Original execution and independent replay agree.</p></div>`
    : '';
  return `
    <figure class="visual"><img src="${t.imageUrl}" alt="${t.title}"><figcaption><span>TURN ${String(t.turn).padStart(3, '0')}${t.round ? ` · ROUND ${t.round}` : ''}</span><strong class="${t.verdict === 'verified-escape' ? 'danger' : ''}">${verdictLabel(t.verdict)}</strong></figcaption></figure>
    <article class="detail"><div class="eyebrow">${t.technique}</div><h2>${t.title}</h2><dl>
      <div><dt>Hypothesis</dt><dd>${t.hypothesis}</dd></div>
      <div><dt>Attempt</dt><dd>${t.attempt}</dd></div>
      <div><dt>Observed result</dt><dd>${t.result}</dd></div>
      <div><dt>Next adaptation</dt><dd>${t.adaptation}</dd></div>
    </dl>${proof}
    <div class="navbuttons"><button data-prev>← Previous</button><button data-jump-escape>Next escape ↦</button><button data-next>Next iteration →</button></div></article>`;
}

function select(i, scrollStrip) {
  active = ((i % turns.length) + turns.length) % turns.length;
  document.querySelector('.viewer').innerHTML = detailPanel();
  bindViewer();
  document.querySelectorAll('.tick').forEach((el, idx) => {
    el.classList.toggle('active', idx === active);
  });
  const strip = document.querySelector('.filmstrip');
  if (scrollStrip === undefined) {
    // keep active roughly centered
    strip.scrollLeft = Math.max(0, active * FRAME_W - strip.clientWidth / 2 + FRAME_W / 2);
  }
  renderFrames(strip);
}

function nextEscape() {
  for (let k = 1; k <= turns.length; k++) {
    const i = (active + k) % turns.length;
    if (turns[i].verdict === 'verified-escape') return select(i);
  }
}

function bindViewer() {
  document.querySelector('[data-prev]')?.addEventListener('click', () => select(active - 1));
  document.querySelector('[data-next]')?.addEventListener('click', () => select(active + 1));
  document.querySelector('[data-jump-escape]')?.addEventListener('click', nextEscape);
}

function render() {
  if (!campaign) { app.innerHTML = '<div class="empty">Loading campaign…</div>'; return; }
  turns = campaign.turns.map(normalizeTurn);
  const c = campaign.counts || { total: turns.length, escapes: turns.filter((t) => t.verdict === 'verified-escape').length };
  c.contained = c.contained ?? c.total - c.escapes;
  app.innerHTML = `<div class="shell">
    <header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><div class="status">SYNTHETIC WALKTHROUGH</div></header>
    <section class="campaign-head"><div><div class="eyebrow">ADAPTIVE CONTAINMENT CAMPAIGN</div><h1>An attacker that <span>never stops adapting.</span></h1></div>
      <p>Every contained result triggers a new tactic. The loop runs without a fixed end — a finding only counts when the exact attack crosses the boundary again in a fresh environment.</p></section>
    <section class="stats">
      <div><b>${c.total}</b><span>iterations</span></div>
      <div><b>${c.contained}</b><span>contained</span></div>
      <div class="hot"><b>${c.escapes}</b><span>verified escapes</span></div>
      <div><b>${campaign.backend}</b><span>backend</span></div>
    </section>
    <nav class="minimap" aria-label="Campaign density">${minimap()}</nav>
    <section class="viewer">${detailPanel()}</section>
    <section class="filmstrip" aria-label="All iterations"></section>
    <footer class="footer"><span>${campaign.campaignId} · ${turns.length} iterations · ${c.escapes} verified</span><span><a href="https://github.com/acoyfellow/terrarium">source</a> · timeline + filmstrip are virtualized for unbounded campaigns; only the selected turn is expanded</span></footer>
  </div>`;
  document.querySelectorAll('.tick').forEach((el) => el.addEventListener('click', () => select(Number(el.dataset.turn))));
  bindViewer();
  const strip = document.querySelector('.filmstrip');
  let raf = 0;
  strip.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderFrames(strip); });
  });
  renderFrames(strip);
}

async function load() {
  try { const r = await fetch('/api/demo'); if (r.ok) campaign = await r.json(); } catch {}
  if (!campaign) { const r = await fetch('/demo/manifest.json'); campaign = await r.json(); }
  render();
}
load();
