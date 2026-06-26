import './style.css';

let campaign;
let changelogText = '';
let turns = [];
const app = document.querySelector('#app');

const runStamp = () => {
  const value = campaign?.updatedAt || campaign?.turns?.at(-1)?.finishedAt;
  return value ? `LAST UPDATED · ${new Date(value).toISOString().replace('.000Z', 'Z')}` : 'LAST UPDATED · NONE';
};

const evidenceRef = (turn) => turn.evidence?.executionId ?? turn.evidenceRef ?? 'not published';
const runType = (turn) => {
  const ref = evidenceRef(turn);
  if (ref.startsWith('terrarium-run:')) return 'terrarium run';
  if (ref.startsWith('commit:')) return 'commit';
  if (ref.startsWith('test:')) return 'test';
  if (ref.startsWith('replay:')) return 'replay';
  return 'record';
};
const shortRef = (value) => String(value ?? '').replace(/^terrarium-run:/, '').replace(/^commit:/, 'commit:');

const normalizeTurn = (turn, index) => ({
  turn: turn.turn ?? index + 1,
  family: turn.family ?? turn.scenarioId ?? 'run',
  title: turn.title ?? `Turn ${index + 1}`,
  instruction: turn.hypothesis ?? turn.attempt ?? 'not recorded',
  environment: turn.environment ?? turn.technique ?? 'not recorded',
  agentModel: turn.agentModel ?? turn.model ?? 'not published',
  agentCommand: turn.agentCommand ?? turn.agent ?? 'not published',
  result: turn.result ?? 'not recorded',
  next: turn.adaptation ?? 'not recorded',
  status: turn.verdict ?? 'unknown',
  contentKind: turn.contentKind ?? 'product-iteration',
  evidenceClaim: turn.evidenceClaim ?? false,
  evidence: turn.evidence ?? null,
  receiptUrl: turn.receiptUrl ?? null,
  trace: turn.trace ?? null,
  finishedAt: turn.finishedAt ?? null,
});

function linkForRef(ref) {
  if (ref.startsWith('commit:')) return `https://github.com/acoyfellow/terrarium/commit/${ref.slice('commit:'.length)}`;
  return null;
}

function evidenceCell(turn) {
  const ref = evidenceRef(turn);
  const href = linkForRef(ref);
  const label = shortRef(ref);
  return `<div class="evidence-links"><span class="ref-kind">${runType(turn)}</span>${href ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>` : `<code>${label}</code>`}${turn.receiptUrl ? `<a href="${turn.receiptUrl}" target="_blank" rel="noreferrer">public receipt</a>` : ''}${turn.trace?.url ? `<a href="${turn.trace.url}" target="_blank" rel="noreferrer">trace</a>` : ''}</div>`;
}

function statusLabel(turn) {
  if (turn.evidenceClaim) return 'evidence-backed';
  if (turn.status === 'contained') return 'recorded';
  return turn.status;
}

function runRow(turn) {
  return `<tr>
    <td data-label="#"><span class="turn-id">${String(turn.turn).padStart(2, '0')}</span></td>
    <td data-label="status"><span class="status-pill ${turn.evidenceClaim ? 'backed' : ''}">${statusLabel(turn)}</span></td>
    <td data-label="product area"><b>${turn.family}</b><small>${turn.title}</small></td>
    <td data-label="agent/model"><code>${turn.agentModel}</code><small>${turn.agentCommand}</small></td>
    <td data-label="instruction">${turn.instruction}</td>
    <td data-label="environment">${turn.environment}</td>
    <td data-label="what happened">${turn.result}<small class="next">Next: ${turn.next}</small></td>
    <td data-label="evidence">${evidenceCell(turn)}</td>
  </tr>`;
}

function renderTable() {
  const evidenceBacked = turns.filter((turn) => turn.evidenceClaim).length;
  return `<main class="shell"><header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><nav class="top-nav"><a href="#runs">runs</a><a href="#changelog">changelog</a></nav><time class="status">${runStamp()}</time></header>
    <section class="sheet-head"><div><div class="eyebrow">SECURITY HARDENING RUN LOG</div><h1>Runs, instructions, environment, result.</h1><p>A public ledger of hardening runs against Terrarium's runner, callback, receipt, batch, and boundary behavior.</p></div><div class="sheet-counts"><b>${turns.length}</b><span>recorded turns</span><b>${evidenceBacked}</b><span>evidence-backed</span></div></section>
    <section class="table-wrap" aria-label="Recorded Terrarium hardening turns"><table><thead><tr><th>#</th><th>Status</th><th>Product area</th><th>Agent / model</th><th>Instruction</th><th>Environment</th><th>What happened</th><th>Evidence / trace</th></tr></thead><tbody>${turns.map(runRow).join('')}</tbody></table></section>
    <section class="table-notes"><div><b>Evidence rule</b><p>A row can say evidence-backed only when it has a commit, Terrarium run, test, replay, or public receipt reference.</p></div><div><b>Security focus</b><p>Future turns should probe callback routing, receipt parsing, cancellation, batch/group truthfulness, and secure workspace boundaries.</p></div></section>
    <footer class="footer"><span>${turns.length} recorded turns · ${evidenceBacked} evidence-backed</span><span><a href="https://github.com/acoyfellow/terrarium">inspect source</a></span></footer>
  </main>`;
}

function renderMarkdown(text) {
  const escaped = String(text || '').replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
  return escaped
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/(?:<li>.*<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .split(/\n{2,}/).map((block) => /^<h\d|^<ul/.test(block) ? block : `<p>${block}</p>`).join('');
}

function renderChangelog() {
  return `<main class="shell"><header class="top"><a class="brand" href="#runs"><span class="mark"></span>TERRARIUM</a><nav class="top-nav"><a href="#runs">runs</a><a href="#changelog">changelog</a></nav><time class="status">${runStamp()}</time></header>
    <section class="sheet-head"><div><div class="eyebrow">CHANGELOG</div><h1>What changed.</h1><p>Concise product changes, mirrored from CHANGELOG.md.</p></div></section>
    <article class="changelog">${renderMarkdown(changelogText || 'Changelog unavailable.')}</article>
    <footer class="footer"><span><a href="#runs">back to runs</a></span><span><a href="https://github.com/acoyfellow/terrarium/blob/main/CHANGELOG.md">inspect changelog source</a></span></footer>
  </main>`;
}

function render() {
  if (!campaign) { app.innerHTML = '<main class="shell"><p class="empty">Loading run table…</p></main>'; return; }
  turns = campaign.turns.map(normalizeTurn);
  app.innerHTML = location.hash === '#changelog' ? renderChangelog() : renderTable();
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
  try { const r = await fetch('/CHANGELOG.md', { cache: 'no-store' }); if (r.ok) changelogText = await r.text(); } catch {}
  render();
}

window.addEventListener('hashchange', render);
load();
