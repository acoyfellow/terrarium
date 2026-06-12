import './style.css';

let campaign;
let turns = [];
let milestones = [];
let active = 0;
const app = document.querySelector('#app');
const verdictLabel = (v) => v === 'verified-escape' ? 'verified escape' : v;

const normalizeTurn = (turn, index) => ({
  turn: turn.turn ?? index + 1,
  round: turn.round ?? null,
  family: turn.family ?? 'probe',
  title: turn.title ?? `Iteration ${index + 1}`,
  technique: turn.technique ?? turn.title ?? 'Adaptive probe',
  hypothesis: turn.hypothesis ?? 'No hypothesis recorded.',
  attempt: turn.attempt ?? 'No attempt detail recorded.',
  result: turn.result ?? (turn.verdict === 'verified-escape' ? 'The finding reproduced in a fresh environment.' : 'No forbidden capability was observed.'),
  adaptation: turn.adaptation ?? 'Continue with a different bounded attack class.',
  verdict: turn.verdict ?? 'inconclusive',
  imageUrl: turn.imageUrl ?? null,
});

function minimap() {
  return turns.map((t, i) => `<button class="tick${i === active ? ' active' : ''}${t.verdict === 'verified-escape' ? ' escape' : ''}" data-turn="${i}" title="Turn ${t.turn}: ${t.title}"></button>`).join('');
}

// Images are chapter illustrations, not fake one-image-per-turn evidence. A milestone
// appears at each new round and for every escape; ordinary turns remain data-first.
function buildMilestones() {
  return turns.map((t, i) => ({ t, i })).filter(({ t, i }) => i === 0 || t.verdict === 'verified-escape' || t.round !== turns[i - 1].round);
}

function evidenceGraphic(t) {
  if (t.verdict !== 'verified-escape') return `<img src="${t.imageUrl}" alt="Chapter illustration for ${t.technique}">`;
  return `<div class="escape-evidence family-${t.family}">
    <div class="receipt"><span>ORIGINAL</span><b>${t.family}</b><i>boundary crossed</i></div>
    <div class="match">≡</div>
    <div class="receipt replay"><span>FRESH REPLAY</span><b>${t.family}</b><i>same crossing</i></div>
  </div>`;
}

function detailPanel() {
  const t = turns[active];
  const proof = t.verdict === 'verified-escape' ? `<div class="proof"><b>Independent match</b><p>The exact payload crossed the same declared boundary in original execution and fresh replay. This evidence diagram is keyed to the ${t.technique.toLowerCase()} finding.</p></div>` : '';
  return `<figure class="visual ${t.verdict === 'verified-escape' ? 'evidence-visual' : ''}">${evidenceGraphic(t)}<figcaption><span>TURN ${String(t.turn).padStart(3, '0')}${t.round ? ` · ROUND ${t.round}` : ''}</span><strong class="${t.verdict === 'verified-escape' ? 'danger' : ''}">${verdictLabel(t.verdict)}</strong></figcaption></figure>
    <article class="detail"><div class="eyebrow">${t.technique}</div><h2>${t.title}</h2><dl>
      <div><dt>Hypothesis</dt><dd>${t.hypothesis}</dd></div><div><dt>Attempt</dt><dd>${t.attempt}</dd></div><div><dt>Observed result</dt><dd>${t.result}</dd></div><div><dt>Next adaptation</dt><dd>${t.adaptation}</dd></div>
    </dl>${proof}<div class="navbuttons"><button data-prev>← Previous</button><button data-jump-escape>Next escape ↦</button><button data-next>Next iteration →</button></div></article>`;
}

function milestoneRail() {
  return milestones.map(({ t, i }) => `<button data-milestone="${i}" class="milestone${i === active ? ' active' : ''}${t.verdict === 'verified-escape' ? ' escape' : ''}">
    <span class="milestone-visual">${t.verdict === 'verified-escape' ? `<span class="mini-evidence family-${t.family}"><i></i><i></i></span>` : `<img loading="lazy" src="${t.imageUrl}" alt="">`}</span>
    <span class="milestone-copy"><small>${t.verdict === 'verified-escape' ? 'VERIFIED ESCAPE' : `ROUND ${t.round}`}</small><b>Turn ${t.turn}</b><em>${t.technique}</em></span>
  </button>`).join('');
}

function select(i, center = true) {
  active = ((i % turns.length) + turns.length) % turns.length;
  document.querySelector('.viewer').innerHTML = detailPanel();
  bindViewer();
  document.querySelectorAll('.tick').forEach((el, idx) => el.classList.toggle('active', idx === active));
  document.querySelectorAll('.milestone').forEach(el => el.classList.toggle('active', Number(el.dataset.milestone) === active));
  if (center) document.querySelector(`.milestone[data-milestone="${active}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

function nextEscape() {
  for (let k = 1; k <= turns.length; k++) { const i = (active + k) % turns.length; if (turns[i].verdict === 'verified-escape') return select(i); }
}
function bindViewer() {
  document.querySelector('[data-prev]')?.addEventListener('click', () => select(active - 1));
  document.querySelector('[data-next]')?.addEventListener('click', () => select(active + 1));
  document.querySelector('[data-jump-escape]')?.addEventListener('click', nextEscape);
}

function render() {
  if (!campaign) { app.innerHTML = '<div class="empty">Loading campaign…</div>'; return; }
  turns = campaign.turns.map(normalizeTurn);
  milestones = buildMilestones();
  const c = campaign.counts || { total: turns.length, escapes: turns.filter(t => t.verdict === 'verified-escape').length };
  c.contained ??= c.total - c.escapes;
  app.innerHTML = `<div class="shell"><header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><div class="status">SYNTHETIC WALKTHROUGH</div></header>
    <section class="campaign-head"><div><div class="eyebrow">ADAPTIVE CONTAINMENT CAMPAIGN</div><h1>An attacker that <span>never stops adapting.</span></h1></div><p>Every contained result triggers a new tactic. Images mark chapters only; individual iterations are evidence records. A finding counts only after independent replay.</p></section>
    <section class="stats"><div><b>${c.total}</b><span>iterations</span></div><div><b>${c.contained}</b><span>contained</span></div><div class="hot"><b>${c.escapes}</b><span>verified escapes</span></div><div><b>${milestones.length}</b><span>story milestones</span></div></section>
    <nav class="minimap" aria-label="All campaign iterations">${minimap()}</nav><section class="viewer">${detailPanel()}</section>
    <div class="rail-head"><div><span class="eyebrow">STORY MILESTONES</span><p>One chapter illustration per round. Escape cards use finding-specific evidence diagrams—not repeated imagery.</p></div><span>${milestones.length} milestones / ${turns.length} iterations</span></div>
    <section class="milestone-rail" aria-label="Campaign milestones">${milestoneRail()}</section>
    <footer class="footer"><span>${campaign.campaignId} · ${turns.length} iterations · ${c.escapes} verified</span><span><a href="https://github.com/acoyfellow/terrarium">source</a> · minimap covers every turn; story rail shows only material transitions</span></footer></div>`;
  document.querySelectorAll('.tick').forEach(el => el.addEventListener('click', () => select(Number(el.dataset.turn))));
  document.querySelectorAll('.milestone').forEach(el => el.addEventListener('click', () => select(Number(el.dataset.milestone), false)));
  bindViewer();
}

async function load() {
  try { const r = await fetch('/api/demo'); if (r.ok) campaign = await r.json(); } catch {}
  if (!campaign) { const r = await fetch('/demo/manifest.json'); campaign = await r.json(); }
  render();
}
load();
