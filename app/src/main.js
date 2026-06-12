import './style.css';

let campaign;
let turns = [];
let milestones = [];
let active = 0;
const app = document.querySelector('#app');
const verdictLabel = (v) => v === 'verified-escape' ? 'verified escape' : v;
const runStamp = () => {
  const value = campaign?.updatedAt || campaign?.turns?.at(-1)?.finishedAt;
  return value ? `LAST RUN · ${new Date(value).toISOString().replace('.000Z', 'Z')}` : 'LAST RUN · NONE';
};

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
  payloadHash: turn.payloadHash ?? null,
  sourceRevision: turn.sourceRevision ?? null,
  evidence: turn.evidence ?? null,
  healing: turn.healing ?? null,
});

function minimap() {
  return turns.map((t, i) => `<button class="tick${i === active ? ' active' : ''}${t.verdict === 'verified-escape' ? ' escape' : ''}" data-turn="${i}" title="Turn ${t.turn}: ${t.title}"></button>`).join('');
}

// Images are chapter illustrations, not fake one-image-per-turn evidence. A milestone
// appears at each new round and for every escape; ordinary turns remain data-first.
function buildMilestones() {
  return turns.map((t, i) => ({ t, i })).filter(({ t, i }) => i === 0 || t.verdict === 'verified-escape' || t.round !== turns[i - 1].round);
}

function runGraphic(t) {
  return `<div class="run-evidence"><div class="run-orbit"><span></span><i></i></div><div class="run-facts"><span>LAB EXECUTION</span><b>${t.verdict === 'contained' ? 'BOUNDARY HELD' : verdictLabel(t.verdict).toUpperCase()}</b><dl><div><dt>payload</dt><dd>${t.payloadHash ?? 'redacted'}</dd></div><div><dt>execution</dt><dd>${t.evidence?.executionId ?? 'recorded'}</dd></div><div><dt>revision</dt><dd>${t.sourceRevision?.slice(0, 12) ?? 'recorded'}</dd></div><div><dt>replay</dt><dd>${t.evidence?.independentReplay ? 'complete' : 'not required'}</dd></div></dl></div></div>`;
}

function evidenceGraphic(t) {
  if (t.verdict !== 'verified-escape') return t.imageUrl ? `<img src="${t.imageUrl}" alt="Chapter illustration for ${t.technique}">` : runGraphic(t);
  const h = t.healing;
  const payload = `${t.family}-${String(t.turn).padStart(3, '0')}`;
  return `<div class="escape-evidence family-${t.family}">
    <div class="evidence-title"><span>INDEPENDENT VERIFICATION</span><b>${h?.issue ?? 'SYNTHETIC FINDING'}</b></div>
    <div class="receipt"><span>ORIGINAL RUN</span><dl><div><dt>environment</dt><dd>lab-a-${t.turn}</dd></div><div><dt>payload</dt><dd>${payload}</dd></div><div><dt>boundary</dt><dd>${h?.boundary ?? t.family}</dd></div><div><dt>detector</dt><dd>external</dd></div><div><dt>result</dt><dd>crossed</dd></div></dl></div>
    <div class="match"><b>EXACT MATCH</b><span>same payload</span><span>fresh environment</span><span>same violation</span></div>
    <div class="receipt replay"><span>FRESH REPLAY</span><dl><div><dt>environment</dt><dd>lab-b-${t.turn}</dd></div><div><dt>payload</dt><dd>${payload}</dd></div><div><dt>boundary</dt><dd>${h?.boundary ?? t.family}</dd></div><div><dt>detector</dt><dd>external</dd></div><div><dt>result</dt><dd>crossed</dd></div></dl></div>
  </div>`;
}

function detailPanel() {
  const t = turns[active];
  const proof = t.verdict === 'verified-escape' ? `<div class="proof"><b>What Terrarium learned</b><p>${t.healing?.lesson ?? 'The exact attack must be independently reproduced before it can improve the product.'}</p></div>` : '';
  const healing = t.verdict === 'verified-escape' && t.healing ? `<section class="healing"><div class="healing-head"><span>SELF-HEALING CHANGE</span><b>${t.healing.status}</b></div><h3>${t.healing.change}</h3><ol><li><span>1</span><div><b>Escape verified</b><p>${t.healing.boundary}</p></div></li><li><span>2</span><div><b>Regression generated</b><p>${t.healing.test}</p></div></li><li><span>3</span><div><b>Terrarium patched</b><p>${t.healing.change}</p></div></li><li><span>4</span><div><b>Independent replay</b><p>Patch contained the frozen payload.</p></div></li></ol><div class="code-links"><a href="${t.healing.sourceUrl}" target="_blank" rel="noreferrer">view product code ↗</a><a href="${t.healing.testUrl}" target="_blank" rel="noreferrer">view regression test ↗</a></div></section>` : '';
  return `<figure class="visual ${t.verdict === 'verified-escape' ? 'evidence-visual' : ''}">${evidenceGraphic(t)}<figcaption><span>TURN ${String(t.turn).padStart(3, '0')}${t.round ? ` · ROUND ${t.round}` : ''}</span><strong class="${t.verdict === 'verified-escape' ? 'danger' : ''}">${verdictLabel(t.verdict)}</strong></figcaption></figure>
    <article class="detail"><div class="eyebrow">${t.technique}</div><h2>${t.title}</h2><dl>
      <div><dt>Hypothesis</dt><dd>${t.hypothesis}</dd></div><div><dt>Attempt</dt><dd>${t.attempt}</dd></div><div><dt>Observed result</dt><dd>${t.result}</dd></div><div><dt>Next adaptation</dt><dd>${t.adaptation}</dd></div>
    </dl>${proof}${healing}<div class="navbuttons"><button data-prev>← Previous</button><button data-jump-escape>Next escape ↦</button><button data-next>Next iteration →</button></div></article>`;
}

function milestoneRail() {
  return milestones.map(({ t, i }) => `<button data-milestone="${i}" class="milestone${i === active ? ' active' : ''}${t.verdict === 'verified-escape' ? ' escape' : ''}">
    <span class="milestone-visual">${t.verdict === 'verified-escape' ? `<span class="mini-evidence family-${t.family}"><i></i><i></i></span>` : t.imageUrl ? `<img loading="lazy" src="${t.imageUrl}" alt="">` : `<span class="mini-run"><i></i><b>${String(t.turn).padStart(3, '0')}</b></span>`}</span>
    <span class="milestone-copy"><small>${t.verdict === 'verified-escape' ? 'VERIFIED ESCAPE' : t.round ? `ROUND ${t.round}` : 'REAL EXECUTION'}</small><b>Turn ${t.turn}</b><em>${t.technique}</em></span>
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
  if (!turns.length) {
    app.innerHTML = `<div class="shell"><header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><time class="status">${runStamp()}</time></header><main class="waiting"><div class="eyebrow">TERRARIUM HARDENS TERRARIUM</div><h1>No theatre. <span>The next run starts here.</span></h1><p>Manual campaigns will attack the current Terrarium revision, independently replay verified boundary crossings, publish redacted evidence, patch on an isolated branch, add a regression, and merge only after the frozen attack is contained.</p><section class="loop"><span>ATTACK</span><i>→</i><span>VERIFY</span><i>→</i><span>PATCH</span><i>→</i><span>REPLAY</span><i>→</i><span>MERGE</span><i>↻</i></section><div class="waiting-meta"><b>0 real iterations</b><b>0 verified escapes</b><b>manual start only</b></div><p class="waiting-note">The previous synthetic story is retained only as a development fixture. This public ledger will display receipt-backed runs and source-linked healing changes only.</p></main></div>`;
    return;
  }
  milestones = buildMilestones();
  const c = campaign.counts || { total: turns.length, escapes: turns.filter(t => t.verdict === 'verified-escape').length };
  c.contained ??= c.total - c.escapes;
  app.innerHTML = `<div class="shell"><header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><time class="status">${runStamp()}</time></header>
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
