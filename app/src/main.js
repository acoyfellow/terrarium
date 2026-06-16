import './style.css';

let campaign;
let turns = [];
let milestones = [];
let active = 0;
let campaignVersion = '';
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
  finishedAt: turn.finishedAt ?? null,
  evidence: turn.evidence ?? null,
  trace: turn.trace ?? null,
  story: turn.story ?? null,
  family: turn.family ?? turn.scenarioId ?? 'finding',
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
  return `<div class="run-evidence"><div class="run-orbit"><span></span><i></i></div><div class="run-facts"><span>WHAT WE RECORDED</span><b>${t.verdict === 'contained' ? 'IT STAYED INSIDE' : verdictLabel(t.verdict).toUpperCase()}</b><dl><div><dt>attempt fingerprint</dt><dd>${t.payloadHash ?? 'redacted'}</dd></div><div><dt>run id</dt><dd>${t.evidence?.executionId ?? 'recorded'}</dd></div><div><dt>version tested</dt><dd>${t.sourceRevision?.slice(0, 12) ?? 'recorded'}</dd></div><div><dt>re-checked fresh</dt><dd>${t.evidence?.independentReplay ? 'yes' : 'not needed'}</dd></div></dl></div></div>`;
}

function evidenceGraphic(t) {
  if (t.verdict !== 'verified-escape') return t.imageUrl ? `<img src="${t.imageUrl}" alt="Chapter illustration for ${t.technique}">` : runGraphic(t);
  const h = t.healing;
  const payload = `${t.family}-${String(t.turn).padStart(3, '0')}`;
  return `<div class="escape-evidence family-${t.family}">
    <div class="evidence-title"><span>WE PROVED IT TWICE</span><b>${h?.status === 'merged' ? 'FIXED' : 'BREAK-OUT'}</b></div>
    <div class="receipt"><span>FIRST TIME</span><dl><div><dt>jar</dt><dd>jar A</dd></div><div><dt>the trick</dt><dd>${payload}</dd></div><div><dt>way out</dt><dd>${h?.boundary ?? t.family}</dd></div><div><dt>judged by</dt><dd>an outside check</dd></div><div><dt>result</dt><dd>got out</dd></div></dl></div>
    <div class="match"><b>SAME RESULT</b><span>same trick</span><span>brand-new jar</span><span>got out again</span></div>
    <div class="receipt replay"><span>AGAIN, FRESH</span><dl><div><dt>jar</dt><dd>jar B</dd></div><div><dt>the trick</dt><dd>${payload}</dd></div><div><dt>way out</dt><dd>${h?.boundary ?? t.family}</dd></div><div><dt>judged by</dt><dd>an outside check</dd></div><div><dt>result</dt><dd>got out</dd></div></dl></div>
  </div>`;
}

function proofPanel(t) {
  return `<details class="proof-details"><summary>See the recorded proof</summary><dl><div><dt>Attempt fingerprint</dt><dd>${t.payloadHash ?? 'recorded'}</dd></div><div><dt>Run ID</dt><dd>${t.evidence?.executionId ?? 'recorded'}</dd></div><div><dt>Version tested</dt><dd>${t.sourceRevision?.slice(0, 12) ?? 'recorded'}</dd></div><div><dt>Finished</dt><dd>${t.finishedAt ? new Date(t.finishedAt).toISOString() : 'recorded'}</dd></div><div><dt>Checked again fresh</dt><dd>${t.evidence?.independentReplay ? 'yes — same result twice' : 'not needed — it stayed inside the first time'}</dd></div></dl>${t.trace?.url ? `<a class="trace-link" href="${t.trace.url}" target="_blank" rel="noreferrer">Open the run trace ↗</a>` : ''}</details>`;
}

function detailPanel() {
  const t = turns[active];
  const proof = t.verdict === 'verified-escape' ? `<div class="proof"><b>Why we believe it</b><p>${t.healing?.lesson ?? 'Before we call a break-out real, we run the exact same trick a second time in a brand-new jar. If it gets out again, it counts.'}</p></div>` : '';
  const healing = t.verdict === 'verified-escape' && t.healing ? `<section class="healing"><div class="healing-head"><span>HOW WE FIXED THE JAR</span><b>${t.healing.status}</b></div><h3>The break-out became a permanent test.</h3><ol><li><span>1</span><div><b>It got out</b><p>An outside check saw it cross the line.</p></div></li><li><span>2</span><div><b>We proved it was real</b><p>The exact same trick worked again in a fresh jar.</p></div></li><li><span>3</span><div><b>We changed Terrarium</b><p>Version ${t.healing.mergedRevision?.slice(0, 12) ?? 'recorded'} closed this way out.</p></div></li><li><span>4</span><div><b>We tried it again</b><p>This time it stayed inside.</p></div></li></ol><div class="code-links">${t.healing.issueUrl ? `<a href="${t.healing.issueUrl}" target="_blank" rel="noreferrer">see the finding ↗</a>` : ''}${t.healing.mergedRevision ? `<a href="https://github.com/acoyfellow/terrarium/commit/${t.healing.mergedRevision}" target="_blank" rel="noreferrer">see the fix ↗</a>` : ''}</div></section>` : '';
  return `<figure class="visual ${t.verdict === 'verified-escape' ? 'evidence-visual' : ''}">${evidenceGraphic(t)}${t.imageUrl ? '<span class="editorial-label">ILLUSTRATION</span>' : ''}<figcaption><span>ATTEMPT ${String(t.turn).padStart(3, '0')}</span><strong class="${t.verdict === 'verified-escape' ? 'danger' : ''}">${t.verdict === 'contained' ? 'stayed inside' : verdictLabel(t.verdict)}</strong></figcaption></figure>
    <article class="detail"><div class="eyebrow">${t.technique}</div><h2>${t.title}</h2><dl>
      <div><dt>Its idea</dt><dd>${t.hypothesis}</dd></div><div><dt>What it tried</dt><dd>It tested this route inside a fresh, sealed environment while an outside check watched for anything crossing the line.</dd></div><div><dt>What happened</dt><dd>${t.result}</dd></div><div><dt>What it tries next</dt><dd>${t.adaptation}</dd></div>
    </dl>${proofPanel(t)}${proof}${healing}<div class="navbuttons"><button data-prev>← Back</button><button data-jump-escape>Jump to a break-out ↦</button><button data-next>Next attempt →</button></div></article>`;
}

function milestoneRail() {
  return milestones.map(({ t, i }) => `<button data-milestone="${i}" class="milestone${i === active ? ' active' : ''}${t.verdict === 'verified-escape' ? ' escape' : ''}">
    <span class="milestone-visual">${t.verdict === 'verified-escape' ? `<span class="mini-evidence family-${t.family}"><i></i><i></i></span>` : t.imageUrl ? `<img loading="lazy" src="${t.imageUrl}" alt="">` : `<span class="mini-run"><i></i><b>${String(t.turn).padStart(3, '0')}</b></span>`}</span>
    <span class="milestone-copy"><small>${t.verdict === 'verified-escape' ? 'IT GOT OUT' : 'STAYED INSIDE'}</small><b>Attempt ${t.turn}</b><em>${t.technique}</em></span>
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
  if (!campaign) { app.innerHTML = '<div class="empty">Loading the latest attempts…</div>'; return; }
  turns = campaign.turns.map(normalizeTurn);
  if (!turns.length) {
    app.innerHTML = `<div class="shell"><header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><time class="status">${runStamp()}</time></header><main class="waiting"><div class="eyebrow">A ROBOT. A JAR. A LOT OF TRIES.</div><h1>Nothing staged. <span>The next attempt starts here.</span></h1><p>We put an AI in a sealed jar and let it try to get out. Every try is logged. If it ever truly escapes, we prove it by repeating the exact trick in a fresh jar, then fix the jar so the same trick can't work again — and let it keep going.</p><section class="loop"><span>IT TRIES</span><i>→</i><span>WE CHECK</span><i>→</i><span>WE PROVE IT</span><i>→</i><span>WE FIX THE JAR</span><i>↻</i></section><div class="waiting-meta"><b>0 attempts yet</b><b>0 real break-outs</b><b>starts by hand</b></div><p class="waiting-note">Only real, recorded attempts appear here — nothing rehearsed or made up.</p></main></div>`;
    return;
  }
  milestones = buildMilestones();
  const c = campaign.counts || { total: turns.length, escapes: turns.filter(t => t.verdict === 'verified-escape').length };
  c.contained ??= c.total - c.escapes;
  app.innerHTML = `<div class="shell"><header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><time class="status">${runStamp()}</time></header>
    <section class="campaign-head"><div><div class="eyebrow">A ROBOT TRYING TO ESCAPE ITS JAR</div><h1>It never stops <span>trying to get out.</span></h1></div><p>Each time it fails, it changes its approach and tries something new. A break-out only counts if we can make it happen twice — the exact same way, in a brand-new jar.</p></section>
    <section class="stats"><div><b>${c.total}</b><span>attempts</span></div><div><b>${c.contained}</b><span>stayed inside</span></div><div class="hot"><b>${c.escapes}</b><span>real break-outs</span></div><div><b>${milestones.length}</b><span>moments worth watching</span></div></section>
    <nav class="minimap" aria-label="All campaign iterations">${minimap()}</nav><section class="viewer">${detailPanel()}</section>
    <div class="rail-head"><div><span class="eyebrow">THE STORY SO FAR</span><p>Pick any moment to see what the robot tried and what happened. Pictures illustrate the story; the records underneath are the real proof.</p></div><span>${milestones.length} moments / ${turns.length} attempts</span></div>
    <section class="milestone-rail" aria-label="Campaign milestones">${milestoneRail()}</section>
    <footer class="footer"><span>${turns.length} attempts · ${c.escapes} real break-outs</span><span><a href="https://github.com/acoyfellow/terrarium">see how it works</a> · illustrations tell the story; the recorded results are the proof</span></footer></div>`;
  document.querySelectorAll('.tick').forEach(el => el.addEventListener('click', () => select(Number(el.dataset.turn))));
  document.querySelectorAll('.milestone').forEach(el => el.addEventListener('click', () => select(Number(el.dataset.milestone), false)));
  bindViewer();
}

async function fetchCampaign() {
  const r = await fetch('/api/demo', { cache: 'no-store' });
  if (!r.ok) throw new Error(`campaign fetch failed: ${r.status}`);
  return r.json();
}
async function load() {
  try { campaign = await fetchCampaign(); } catch {}
  if (!campaign) { const r = await fetch('/demo/manifest.json'); campaign = await r.json(); }
  campaignVersion = `${campaign.updatedAt ?? ''}:${campaign.turns.length}`;
  render();
  // Low-frequency conditional refresh: tiny today, works unchanged for many viewers
  // because the Worker serves one cacheable public ledger rather than per-client state.
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const next = await fetchCampaign();
      const version = `${next.updatedAt ?? ''}:${next.turns.length}`;
      if (version === campaignVersion) return;
      const followLatest = active >= campaign.turns.length - 1;
      campaign = next;
      campaignVersion = version;
      if (followLatest) active = Math.max(0, campaign.turns.length - 1);
      render();
    } catch {}
  }, 10000);
}
load();
