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


function renderHome() {
  const total = campaign?.counts?.total ?? campaign?.turns?.length ?? 0;
  return `<main class="shell home-shell"><header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><nav class="top-nav"><a href="/docs">docs</a><a href="/runs">runs</a><a href="/#changelog">changelog</a></nav><time class="status">${runStamp()}</time></header>
    <section class="home-hero"><div class="eyebrow">AGENT EXECUTION WITH RECEIPTS</div><h1>Delegate bounded work. Reconstruct what happened.</h1><p>Terrarium runs one bounded task as one child process with one correlated receipt, then gives agents status, logs, callbacks, groups, batches, and repair tools without turning success into a story.</p><div class="home-actions"><a href="/docs">Read the docs</a><a href="/runs">View ${total} runs</a></div></section>
    <section class="home-grid"><div><span class="verb-icon use-icon" aria-hidden="true"><i></i></span><b>Use</b><p>Spawn a child, inspect its receipt, read logs, cancel safely.</p></div><div><span class="verb-icon run-icon" aria-hidden="true"><i></i></span><b>Run</b><p>Operate callbacks, Pulse, Pi follow-ups, doctor repair, and groups.</p></div><div><span class="verb-icon scale-icon" aria-hidden="true"><i></i></span><b>Scale</b><p>Fan out bounded batches with explicit concurrency and durable run IDs.</p></div></section>
  </main>`;
}

function renderTable() {
  const evidenceBacked = turns.filter((turn) => turn.evidenceClaim).length;
  return `<main class="shell"><header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><nav class="top-nav"><a href="/docs">docs</a><a href="/runs">runs</a><a href="/#changelog">changelog</a></nav><time class="status">${runStamp()}</time></header>
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

function renderDocs() {
  const page = new URLSearchParams(location.search).get('page') || 'start';
  const nav = [
    ['start', 'Start here'], ['tutorial', 'Tutorial'], ['loops', 'Loop doctrine'], ['how-to', 'How-to'], ['scale', 'Scale'], ['reference', 'Reference'], ['explain', 'Explain'], ['ops', 'Ops'],
  ];
  const link = (id, label) => `<a class="${page === id ? 'active' : ''}" href="/docs?page=${id}">${label}</a>`;
  const code = (value) => `<pre><code>${String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]))}</code></pre>`;
  const callout = (title, copy) => `<div class="docs-callout"><b>${title}</b><p>${copy}</p></div>`;
  const card = (title, copy) => `<div><b>${title}</b><p>${copy}</p></div>`;
  const mobileJump = `<label class="docs-mobile-jump"><span>Section</span><select data-docs-jump>${nav.map(([id,label]) => `<option value="${id}"${page === id ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
  const shell = (title, kicker, body) => `<main class="shell docs-shell"><header class="top"><a class="brand" href="/"><span class="mark"></span>TERRARIUM</a><nav class="top-nav"><a href="/docs">docs</a><a href="/runs">runs</a><a href="/#changelog">changelog</a></nav><time class="status">${runStamp()}</time></header><section class="docs-layout"><aside class="docs-nav"><b>Terrarium docs</b>${nav.map(([id,label]) => link(id,label)).join('')}<hr><a href="/CHANGELOG.md">raw changelog</a><a href="https://github.com/acoyfellow/terrarium">source</a></aside><article class="docs-page">${mobileJump}<div class="eyebrow">${kicker}</div><h1>${title}</h1>${body}</article></section></main>`;
  const pages = {
    start: shell('Delegate bounded work. Reconstruct truth.', 'Start here', `${callout('Terrarium in one sentence', 'Terrarium turns agent orchestration from prompt discipline into receipt-backed loop structure: fan out bounded tasks, collect evidence, repair durable state, and feed every run’s exhaust into the next loop.')}
      <div class="docs-grid">${card('Use', 'Run one bounded child, inspect status/logs, and verify the receipt before believing success.')}${card('Run', 'Operate callbacks, Pulse, Pi follow-ups, groups, cancellation, and doctor self-heal without confusing notifications for proof.')}${card('Scale', 'Default to parallel, constrain active concurrency, and integrate only validated artifacts.')}</div>
      <h2>The primitive</h2>${code('one bounded task → one child process → one correlated receipt')}
      <p>Everything else — batches, groups, callbacks, Pulse, Pi, Go, doctor, public campaign — coordinates around that primitive. None of it replaces the receipt.</p>
      <h2>First commands</h2>${code('terra --dry-run "inspect the callback tests; do not edit"\nterra --isolation copy --keep-workspace "patch the callback test and run it"\nterra status <runId>\nterra read <runId>')}
      <h2>What to believe</h2><ul><li><b>Authoritative:</b> terminal run with a matching verified <code>TERRARIUM_RESULT</code>.</li><li><b>Evidence:</b> logs, patches, tests, commits, receipts.</li><li><b>Notifications:</b> callbacks and Pulse wake consumers; they are not proof.</li><li><b>Presentation:</b> website/changelog summarize work; they are not operational truth.</li></ul>`),
    tutorial: shell('Tutorial: first useful delegated loop', 'Tutorial', `<p>This tutorial gets an agent from one task to one validated artifact.</p><h2>1. Preview the delegate</h2>${code('terra --dry-run --profile minimal "Find the smallest failing callback test; do not edit files"')}<h2>2. Run isolated</h2>${code('terra --isolation copy --keep-workspace "Fix the callback regression and run test/router.test.js"')}<h2>3. Harvest exhaust</h2>${code('terra status <runId>\nterra read <runId>\nterra read <runId> mre')}<h2>4. Decide</h2><p>If the task contract is <code>verified</code>, integrate the artifact. If it is missing, malformed, mismatched, cancelled, orphaned, or not-applicable, harvest the logs and turn the failure into the next experiment.</p><h2>5. Feed the next loop</h2>${code('prompt → child run → receipt/log/diff → diagnosis → next bounded task')}`),
    loops: shell('Loop doctrine: delegates, artifacts, exhaust', 'Explanation', `${callout('Structural, not behavioral', 'You cannot rely on tired humans or agents to keep orchestration discipline. Terrarium makes the loop structure do the work: bounded children, durable receipts, parallel experiments, and explicit repair.')}
      <h2>Every tool needs a counterweight</h2><p>A single agent, model, reviewer, prompt, or tool will drift if it runs alone. Terrarium gives each tool a bounded job, a receipt, and adjacent checks so orchestration becomes structural rather than a matter of willpower.</p>
      <h2>Products are byproducts of experiments</h2><p>A feature should be the residue of verified experiments: child runs, diffs, tests, repair plans, docs, and receipts. Public stories are generated after truth exists.</p>
      <h2>Default to parallel</h2><p>A prompt that expects one thing back is usually under-specified. Ask for several bounded perspectives, then integrate only validated artifacts.</p>${code('investigate → implement → attack → converge\nparallel children → receipts → parent integration')}
      <h2>No token is wasted</h2><p>A failed run still leaves logs, stdout/stderr tails, MRE traces, workspace diffs, callback state, doctor findings, and next-loop hypotheses. Harvest now, reap later.</p>
      <h2>Loop contract</h2>${code('IN:\n  bounded task\n  allowed tools\n  isolation\n  validation target\n  receipt required\n\nOUT:\n  runId\n  terminal status\n  taskContractStatus\n  logs / patch / tests\n  next loop suggestion')}`),
    'how-to': shell('How-to guides', 'How-to', `<h2>Use: run one bounded task</h2>${code('terra "summarize docs/PULSE.md and list stale claims"')}<h2>Use: force prose that looks like a command</h2>${code('terra --task "status of the migration"')}<h2>Run: inspect and cancel</h2>${code('terra status <runId>\nterra read <runId>\nterra cancel <runId>')}<h2>Run: self-heal durable state</h2>${code('terra doctor\nterra doctor --repair\nterra doctor --repair --apply --verify')}<h2>Run: group existing work</h2>${code('terra group create "callback hardening" <runA> <runB>\nterra group status <groupId>\nterra group read <groupId>')}<h2>Plan without spawning</h2>${code('terra plan "bounded task" --json')}`),
    scale: shell('Scale delegated work without losing truth', 'How-to: scale', `${callout('Scale queue size, not active children', 'Large batches can queue up to 256 jobs. Over 32 jobs must set concurrency so active children stay bounded.')}
      <h2>Batch preflight</h2><p>Bad batch shape fails before any child launches and returns a suggested concurrency.</p>${code('terrarium_spawn_batch({ jobs, strategy: "allSettled", concurrency: 8 })')}
      <h2>Join strategies</h2><ul><li><code>all</code>: every child must succeed.</li><li><code>allSettled</code>: collect every outcome.</li><li><code>race</code>: earliest terminal wins.</li><li><code>any</code>: earliest success wins.</li><li><code>quorum</code>: first k successes win.</li></ul>
      <h2>Scale checklist</h2><ol><li>Make jobs independent.</li><li>Set <code>concurrency</code>.</li><li>Use copy/worktree isolation for edits.</li><li>Set child and batch timeouts.</li><li>Track every run id and group id.</li><li>Trust per-run receipts, not the aggregate alone.</li></ol>`),
    reference: shell('Reference', 'Reference', `<h2>CLI quick reference</h2>${code('terra "task"\nterra --dry-run "task"\nterra plan "task"\nterra status [runId] [--json]\nterra read <runId> [tailBytes]\nterra cancel <runId>\nterra batch --strategy allSettled --concurrency 8 "a" "b"\nterra group create|status|read\nterra doctor [--repair] [--apply] [--verify]')}<h2>MCP tools</h2><ul><li><code>terrarium_spawn</code>: one bounded task.</li><li><code>terrarium_status</code>: list or inspect runs.</li><li><code>terrarium_read</code>: read logs.</li><li><code>terrarium_cancel</code>: cancel one active run.</li><li><code>terrarium_spawn_batch</code>: flat fanout with join strategy.</li><li><code>terrarium_group</code>: aggregate already-started runs.</li><li><code>terrarium_callbacks</code>: durable pull notifications.</li><li><code>terrarium_doctor</code>: read-only diagnostics.</li></ul><h2>Key fields</h2><ul><li><code>runId</code>: durable handle.</li><li><code>status</code>: liveness/process state.</li><li><code>taskContractStatus</code>: receipt truth.</li><li><code>contractTruth</code>: group receipt buckets.</li><li><code>terminalCallback</code>: wake handle, not proof.</li></ul>`),
    explain: shell('Explanation: operational truth', 'Explanation', `<h2>Proof chain</h2><p>The authoritative success proof is child exit 0 plus a verified <code>TERRARIUM_RESULT</code> receipt with matching run id, task fingerprint, and nonce. Exit 0 alone is process state.</p><h2>Callbacks are wakeups</h2><p>Callbacks and Pulse are at-least-once terminal notifications with dedup. They tell a consumer to look; they do not prove task success.</p><h2>Groups are rollups</h2><p>Groups fail closed and report <code>contractTruth</code>. They never replace per-run receipts.</p><h2>Isolation is not a sandbox</h2><p><code>copy</code> and <code>worktree</code> separate workspaces. They do not create a security sandbox.</p><h2>Go and TypeScript</h2><p>TypeScript owns the adapters and production surface today. Go is the emerging core. Replay conformance keeps terminal truth in lockstep.</p>`),
    ops: shell('Operations: when things get weird', 'Operations', `<h2>Run looks stuck</h2>${code('terra status <runId>\nterra read <runId>\nterra doctor')}<h2>Callbacks stopped</h2>${code('terra doctor --repair\nterra doctor --repair --apply --verify')}<h2>Client timed out</h2><p>Client timeout is not child failure. Use durable run ids, group ids, status, logs, and receipts.</p><h2>Pi follow-up loops</h2><p>Delivery attempts are counted. Poison callbacks can be quarantined into the dead mailbox instead of waking forever.</p><h2>Before committing child work</h2><ol><li>Read the child receipt.</li><li>Inspect the diff; do not copy stale workspaces blindly.</li><li>Run targeted tests.</li><li>Update docs/changelog when behavior or public surfaces change.</li></ol>`),
  };
  return pages[page] || pages.start;
}
function renderChangelog() {
  return `<main class="shell"><header class="top"><a class="brand" href="#runs"><span class="mark"></span>TERRARIUM</a><nav class="top-nav"><a href="/docs">docs</a><a href="/runs">runs</a><a href="/#changelog">changelog</a></nav><time class="status">${runStamp()}</time></header>
    <section class="sheet-head"><div><div class="eyebrow">CHANGELOG</div><h1>What changed.</h1><p>Concise product changes, mirrored from CHANGELOG.md.</p></div></section>
    <article class="changelog">${renderMarkdown(changelogText || 'Changelog unavailable.')}</article>
    <footer class="footer"><span><a href="#runs">back to runs</a></span><span><a href="https://github.com/acoyfellow/terrarium/blob/main/CHANGELOG.md">inspect changelog source</a></span></footer>
  </main>`;
}

function render() {
  if (!campaign) { app.innerHTML = '<main class="shell"><p class="empty">Loading run table…</p></main>'; return; }
  turns = campaign.turns.map(normalizeTurn);
  app.innerHTML = location.pathname === '/docs' ? renderDocs() : location.pathname === '/runs' || location.hash === '#runs' ? renderTable() : location.hash === '#changelog' ? renderChangelog() : renderHome();
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
app.addEventListener('change', (event) => {
  const select = event.target.closest?.('[data-docs-jump]');
  if (!select) return;
  location.href = `/docs?page=${encodeURIComponent(select.value)}`;
});
load();
