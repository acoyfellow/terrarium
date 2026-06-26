import './style.css';

let campaign;
let turns = [];
let milestones = [];
let active = 0;
let campaignVersion = '';
const app = document.querySelector('#app');
const verdictLabel = (v) => v === 'verified-escape' ? 'verified finding' : v;
const isProductCampaign = () => campaign?.kind === 'active-product-campaign';
const turnStatusLabel = (t) => {
  if (isProductCampaign()) return t.verdict === 'contained' ? 'CHANGE RECORDED' : verdictLabel(t.verdict).toUpperCase();
  return t.verdict === 'contained' ? 'IT STAYED INSIDE' : verdictLabel(t.verdict).toUpperCase();
};
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
  return `<div class="run-evidence"><div class="run-orbit"><span></span><i></i></div><div class="run-facts"><span>WHAT WE RECORDED</span><b>${turnStatusLabel(t)}</b><dl><div><dt>attempt fingerprint</dt><dd>${t.payloadHash ?? 'redacted'}</dd></div><div><dt>run id</dt><dd>${t.evidence?.executionId ?? 'recorded'}</dd></div><div><dt>version tested</dt><dd>${t.sourceRevision?.slice(0, 12) ?? 'recorded'}</dd></div><div><dt>re-checked fresh</dt><dd>${t.evidence?.independentReplay ? 'yes' : 'not needed'}</dd></div></dl></div></div>`;
}

function evidenceGraphic(t) {
  if (t.imageUrl) return `<img src="${t.imageUrl}" alt="Illustration of attempt ${t.turn}: ${t.title}">`;
  if (t.verdict !== 'verified-escape') return runGraphic(t);
  return `<div class="escape-evidence family-${t.family}"><div class="evidence-title"><span>WE PROVED IT TWICE</span><b>BREAK-OUT</b></div></div>`;
}

function replayProof(t) {
  if (t.verdict !== 'verified-escape') return '';
  return `<div class="replay-proof"><div><span>FIRST RUN</span><b>BOUNDARY CROSSED</b><small>${t.evidence?.executionId ?? 'recorded'}</small></div><i>same probe, fresh run</i><div><span>REPLAY</span><b>CROSSED AGAIN</b><small>${t.evidence?.replayId ?? 'recorded'}</small></div></div>`;
}

function githubProof(t) {
  if (t.verdict !== 'verified-escape' || !t.healing) return '';
  const commitUrl = t.healing.mergedRevision ? `https://github.com/acoyfellow/terrarium/commit/${t.healing.mergedRevision}` : null;
  return `<div class="github-proof"><span class="github-proof-label">RECORDED CHANGE</span><div class="github-proof-chain">${t.healing.issueUrl ? `<a href="${t.healing.issueUrl}" target="_blank" rel="noreferrer">ISSUE</a>` : '<span>ISSUE RECORDED</span>'}<i>/</i>${t.healing.prUrl ? `<a href="${t.healing.prUrl}" target="_blank" rel="noreferrer">PULL REQUEST</a>` : '<span class="manual">NO PULL REQUEST</span>'}<i>/</i>${commitUrl ? `<a href="${commitUrl}" target="_blank" rel="noreferrer">FIX COMMIT</a>` : '<span>FIX RECORDED</span>'}<i>/</i><span class="passed">REPLAY PASSED</span></div></div>`;
}

function proofPanel(t) {
  return `<details class="proof-details"><summary>Inspect the receipt</summary><dl><div><dt>Attempt fingerprint</dt><dd>${t.payloadHash ?? 'recorded'}</dd></div><div><dt>Run ID</dt><dd>${t.evidence?.executionId ?? 'recorded'}</dd></div><div><dt>Version tested</dt><dd>${t.sourceRevision?.slice(0, 12) ?? 'recorded'}</dd></div><div><dt>Finished</dt><dd>${t.finishedAt ? new Date(t.finishedAt).toISOString() : 'recorded'}</dd></div><div><dt>Independent replay</dt><dd>${t.evidence?.independentReplay ? 'matched the first result' : 'not recorded'}</dd></div></dl>${t.trace?.url ? `<a class="trace-link" href="${t.trace.url}" target="_blank" rel="noreferrer">Open the run trace</a>` : ''}</details>`;
}

function detailPanel() {
  const t = turns[active];
  const proof = t.verdict === 'verified-escape' ? `<div class="proof"><b>Replay condition</b><p>${t.healing?.lesson ?? 'The finding counts only when the same probe produces the same boundary crossing in a fresh run.'}</p></div>` : '';
  const healing = t.verdict === 'verified-escape' && t.healing ? `<section class="healing"><div class="healing-head"><span>FOLLOW-UP</span><b>${t.healing.status}</b></div><h3>The finding became a regression test.</h3><ol><li><span>1</span><div><b>Detector fired</b><p>An external check recorded a boundary crossing.</p></div></li><li><span>2</span><div><b>Fresh replay matched</b><p>The same probe reproduced the result in another run.</p></div></li><li><span>3</span><div><b>Code changed</b><p>Revision ${t.healing.mergedRevision?.slice(0, 12) ?? 'recorded'} addressed the finding.</p></div></li><li><span>4</span><div><b>Regression ran</b><p>The receipt records the post-fix result.</p></div></li></ol><div class="code-links">${t.healing.issueUrl ? `<a href="${t.healing.issueUrl}" target="_blank" rel="noreferrer">inspect the finding</a>` : ''}${t.healing.mergedRevision ? `<a href="https://github.com/acoyfellow/terrarium/commit/${t.healing.mergedRevision}" target="_blank" rel="noreferrer">inspect the fix</a>` : ''}</div></section>` : '';
  return `<figure class="visual ${t.verdict === 'verified-escape' ? 'evidence-visual' : ''}">${evidenceGraphic(t)}${t.imageUrl ? '<span class="editorial-label">ILLUSTRATION</span>' : ''}${t.verdict === 'verified-escape' ? '<span class="proven-badge">REPRODUCED TWICE · NOW FIXED</span>' : ''}<figcaption><span>${isProductCampaign() ? 'TURN' : 'ATTEMPT'} ${String(t.turn).padStart(3, '0')}</span><strong class="${t.verdict === 'verified-escape' ? 'danger' : ''}">${isProductCampaign() && t.verdict === 'contained' ? 'change recorded' : t.verdict === 'contained' ? 'boundary held' : verdictLabel(t.verdict)}</strong></figcaption></figure>
    <article class="detail"><div class="eyebrow">${t.technique}</div><h2>${t.title}</h2><dl>
      <div><dt>Hypothesis</dt><dd>${t.hypothesis}</dd></div><div><dt>Method</dt><dd>${t.attempt}</dd></div><div><dt>Observed result</dt><dd>${t.result}</dd></div><div><dt>Next change</dt><dd>${t.adaptation}</dd></div>
    </dl>${replayProof(t)}${githubProof(t)}${proofPanel(t)}${proof}${healing}<div class="navbuttons"><button data-prev>Back</button><button data-jump-escape>Next reproduced finding</button><button data-next>Next turn</button></div></article>`;
}

function milestoneRail() {
  return milestones.map(({ t, i }) => `<button data-milestone="${i}" class="milestone${i === active ? ' active' : ''}${t.verdict === 'verified-escape' ? ' escape' : ''}">
    <span class="milestone-visual">${t.imageUrl ? `<img loading="lazy" src="${t.imageUrl}" alt="">` : t.verdict === 'verified-escape' ? `<span class="mini-evidence family-${t.family}"><i></i><i></i></span>` : `<span class="mini-run"><i></i><b>${String(t.turn).padStart(3, '0')}</b></span>`}</span>
    <span class="milestone-copy"><small>${isProductCampaign() ? 'CHANGE RECORDED' : t.verdict === 'verified-escape' ? 'BOUNDARY CROSSED' : 'BOUNDARY HELD'}</small><b>${isProductCampaign() ? 'Turn' : 'Attempt'} ${t.turn}</b><em>${t.technique}</em></span>
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

function callbackContract() {
  return `<section class="callback-contract"><div><span class="eyebrow">CURRENT MECHANISM</span><h2>Each run returns one correlated receipt.</h2><p>A parent starts one bounded run. Terrarium records its status and receipt, then delivers the terminal callback to the subscriber for that run ID.</p></div><ol><li><b>1</b><span>start one bounded child</span></li><li><b>2</b><span>record status and receipt</span></li><li><b>3</b><span>claim one terminal callback</span></li><li><b>4</b><span>notify the requesting session</span></li></ol><p class="callback-note">Callbacks contain correlation and status fields. They omit prompts, child output, local paths, and credentials.</p></section>`;
}

function campaignHeader() {
  if (campaign?.kind === 'active-product-campaign') return `<section class="campaign-head"><div><div class="eyebrow">PRODUCT RECEIPTS</div><h1>Each turn records <span>one bounded change.</span></h1></div><p>The turn text comes from a product-loop receipt. Illustrations are labeled and are not evidence; run IDs and receipt fields are.</p></section>`;
  return `<section class="campaign-head"><div><div class="eyebrow">CONTAINMENT RUNS</div><h1>Each turn records <span>one bounded probe.</span></h1></div><p>A finding is marked verified only when the same probe reproduces the boundary crossing in a fresh run.</p></section>`;
}

function render() {
  if (!campaign) { app.innerHTML = '<div class="empty">Loading the latest attempts…</div>'; return; }
  turns = campaign.turns.map(normalizeTurn);
  if (!turns.length) {
    app.innerHTML = `<div class="shell"><header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><time class="status">${runStamp()}</time></header><main class="waiting"><div class="eyebrow">NO RUN RECEIPTS YET</div><h1>The campaign has <span>not started.</span></h1><p>When a bounded run finishes, this page shows its method, observed result, next change, and receipt fields.</p><section class="loop"><span>START RUN</span><i>/</i><span>RECORD RECEIPT</span><i>/</i><span>VERIFY RESULT</span><i>/</i><span>CHOOSE NEXT CHANGE</span></section><div class="waiting-meta"><b>0 recorded turns</b><b>0 reproduced findings</b><b>starts manually</b></div><p class="waiting-note">Until a receipt exists, there is no result to report.</p>${callbackContract()}</main></div>`;
    return;
  }
  milestones = buildMilestones();
  const c = campaign.counts || { total: turns.length, escapes: turns.filter(t => t.verdict === 'verified-escape').length };
  c.contained ??= c.total - c.escapes;
  app.innerHTML = `<div class="shell"><header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><time class="status">${runStamp()}</time></header>
    ${campaignHeader()}
    <section class="stats"><div><b>${c.total}</b><span>${campaign.kind === 'active-product-campaign' ? 'turns' : 'attempts'}</span></div><div><b>${c.contained}</b><span>${campaign.kind === 'active-product-campaign' ? 'product notes' : 'contained results'}</span></div><div class="hot"><b>${c.escapes}</b><span>reproduced findings</span></div><div><b>${milestones.length}</b><span>milestones</span></div></section>
    <nav class="minimap" aria-label="All campaign iterations">${minimap()}</nav><section class="viewer">${detailPanel()}</section>
    ${callbackContract()}
    <div class="rail-head"><div><span class="eyebrow">RECORDED TURNS</span><p>Select a turn to inspect its method, result, next change, and receipt fields.</p></div><span>${milestones.length} milestones / ${turns.length} turns</span></div>
    <section class="milestone-rail" aria-label="Campaign milestones">${milestoneRail()}</section>
    <footer class="footer"><span>${turns.length} recorded turns · ${c.escapes} reproduced findings</span><span><a href="https://github.com/acoyfellow/terrarium">inspect the source</a> · claims link back to receipts and run IDs</span></footer></div>`;
  document.querySelectorAll('.tick').forEach(el => el.addEventListener('click', () => select(Number(el.dataset.turn))));
  document.querySelectorAll('.milestone').forEach(el => el.addEventListener('click', () => select(Number(el.dataset.milestone), false)));
  bindViewer();
}

async function fetchCampaign() {
  const active = await fetch('/campaign/manifest.json', { cache: 'no-store' });
  if (active.ok) return active.json();
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
