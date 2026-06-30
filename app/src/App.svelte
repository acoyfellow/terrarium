<script>
  const docs = [
    { id: 'start', label: 'Start here', title: 'Delegate bounded work. Reconstruct truth.', kicker: 'Start here', sections: [
      ['Terrarium in one sentence', 'Terrarium turns agent orchestration from prompt discipline into receipt-backed loop structure: fan out bounded tasks, collect evidence, repair durable state, and feed every run’s exhaust into the next loop.'],
      ['The primitive', 'one bounded task → one child process → one correlated receipt'],
      ['What to believe', 'Authoritative truth is a terminal run with a matching verified TERRARIUM_RESULT. Callbacks wake consumers. Public pages summarize; they are not proof.'],
    ]},
    { id: 'tutorial', label: 'Tutorial', title: 'First useful delegated loop', kicker: 'Tutorial', sections: [
      ['Preview', 'terra --dry-run --profile minimal "Find the smallest failing callback test; do not edit files"'],
      ['Run isolated', 'terra --isolation copy --keep-workspace "Fix the callback regression and run test/router.test.js"'],
      ['Inspect', 'terra status <runId>\nterra read <runId>\nterra read <runId> mre'],
    ]},
    { id: 'loops', label: 'Loop doctrine', title: 'Delegates, artifacts, exhaust', kicker: 'Explanation', sections: [
      ['Structural, not behavioral', 'Terrarium makes orchestration discipline structural: bounded children, durable receipts, parallel experiments, and explicit repair.'],
      ['Every tool needs a counterweight', 'A single agent, model, reviewer, prompt, or tool will drift if it runs alone. Terrarium gives each tool a bounded job, a receipt, and adjacent checks.'],
      ['Loop contract', 'IN: bounded task, tools, isolation, validation target, receipt requirement. OUT: run id, status, task-contract truth, logs, patch, next-loop suggestion.'],
    ]},
    { id: 'how-to', label: 'How-to', title: 'How-to guides', kicker: 'How-to', sections: [
      ['Run one bounded task', 'terra "summarize docs/PULSE.md and list stale claims"'],
      ['Inspect and cancel', 'terra status <runId>\nterra read <runId>\nterra cancel <runId>'],
      ['Self-heal durable state', 'terra doctor\nterra doctor --repair\nterra doctor --repair --apply --verify'],
      ['Plan without spawning', 'terra plan "bounded task" --json'],
    ]},
    { id: 'scale', label: 'Scale', title: 'Scale without losing truth', kicker: 'How-to', sections: [
      ['Scale queue size, not active children', 'Large batches can queue up to 256 jobs. Over 32 jobs must set concurrency so active children stay bounded.'],
      ['Join strategies', 'all, allSettled, race, any, and quorum. Trust per-run receipts, not the aggregate alone.'],
      ['Batch preflight', 'terrarium_spawn_batch({ jobs, strategy: "allSettled", concurrency: 8 })'],
    ]},
    { id: 'reference', label: 'Reference', title: 'Reference', kicker: 'Reference', sections: [
      ['CLI', 'terra "task"\nterra plan "task"\nterra status [runId]\nterra read <runId>\nterra cancel <runId>\nterra doctor --repair --apply --verify'],
      ['MCP tools', 'terrarium_spawn, terrarium_status, terrarium_read, terrarium_cancel, terrarium_spawn_batch, terrarium_group, terrarium_callbacks, terrarium_doctor'],
      ['Key fields', 'runId, status, taskContractStatus, contractTruth, terminalCallback'],
    ]},
    { id: 'explain', label: 'Explain', title: 'Operational truth', kicker: 'Explanation', sections: [
      ['Proof chain', 'Success is child exit plus a verified TERRARIUM_RESULT with matching run id, task fingerprint, and nonce. Exit alone is process state.'],
      ['Callbacks are wakeups', 'Callbacks and Pulse are at-least-once terminal notifications. They tell a consumer to look; they do not prove success.'],
      ['Engine', 'TypeScript is the product engine. Go code remains internal conformance/research material, not an operator-facing alternate engine.'],
    ]},
    { id: 'ops', label: 'Ops', title: 'When things get weird', kicker: 'Operations', sections: [
      ['Run looks stuck', 'terra status <runId>\nterra read <runId>\nterra doctor'],
      ['Callbacks stopped', 'terra doctor --repair\nterra doctor --repair --apply --verify'],
      ['Before integrating child work', 'Read the receipt, inspect the diff, run targeted tests, and update docs/changelog for surface changes.'],
    ]},
  ];

  let campaign = null;
  let changelog = '';
  let path = location.pathname;
  let hash = location.hash;
  let selectedDoc = new URLSearchParams(location.search).get('page') || 'start';

  const route = () => path === '/docs' ? 'docs' : path === '/runs' || hash === '#runs' ? 'runs' : hash === '#changelog' || path === '/changelog' ? 'changelog' : 'home';
  const currentDoc = () => docs.find((d) => d.id === selectedDoc) || docs[0];
  const stamp = () => campaign?.generatedAt ? `last updated · ${campaign.generatedAt}` : 'local build';
  const turns = () => (campaign?.turns || []).map((turn, index) => ({
    number: turn.turn ?? index + 1,
    status: turn.evidenceClaim ? 'evidence-backed' : 'recorded',
    productArea: turn.productArea || turn.area || 'core',
    agentModel: 'not published',
    agentCommand: 'not published',
    instruction: turn.instruction || turn.prompt || 'Not published.',
    environment: turn.environment || 'local Terrarium repo',
    result: turn.result || turn.summary || 'Recorded public receipt.',
    evidence: turn.evidence || turn.references || [],
  }));

  function navigate(to) {
    history.pushState(null, '', to);
    path = location.pathname; hash = location.hash; selectedDoc = new URLSearchParams(location.search).get('page') || selectedDoc;
  }
  function docSelect(event) { navigate(`/docs?page=${event.target.value}`); selectedDoc = event.target.value; }
  async function load() {
    const [campaignRes, changelogRes] = await Promise.all([fetch('/campaign/manifest.json'), fetch('/CHANGELOG.md')]);
    campaign = await campaignRes.json();
    changelog = await changelogRes.text();
  }
  addEventListener('popstate', () => { path = location.pathname; hash = location.hash; selectedDoc = new URLSearchParams(location.search).get('page') || 'start'; });
  load();
</script>

{#if !campaign}
  <main class="shell"><p class="empty">Loading…</p></main>
{:else}
<main class="shell" class:home-shell={route()==='home'} class:docs-shell={route()==='docs'}>
  <header class="top">
    <a class="brand" href="/" on:click|preventDefault={() => navigate('/')}><span class="mark"></span>TERRARIUM</a>
    <nav class="top-nav"><a href="/docs" on:click|preventDefault={() => navigate('/docs')}>docs</a><a href="/runs" on:click|preventDefault={() => navigate('/runs')}>runs</a><a href="/#changelog" on:click|preventDefault={() => navigate('/#changelog')}>changelog</a></nav>
    <time class="status">{stamp()}</time>
  </header>

  {#if route() === 'home'}
    <section class="home-hero"><div class="eyebrow">Agent execution with receipts</div><h1>Delegate bounded work. Reconstruct what happened.</h1><p>Terrarium runs one bounded task as one child process with one correlated receipt, then gives agents status, logs, callbacks, groups, batches, and repair tools without turning success into a story.</p><div class="home-actions"><a href="/docs" on:click|preventDefault={() => navigate('/docs')}>Read the docs</a><a href="/runs" on:click|preventDefault={() => navigate('/runs')}>View {turns().length} runs</a></div></section>
    <section class="home-grid"><div><span class="verb-icon use-icon"><i></i></span><b>Use</b><p>Spawn a child, inspect its receipt, read logs, cancel safely.</p></div><div><span class="verb-icon run-icon"><i></i></span><b>Run</b><p>Operate callbacks, Pulse, Pi follow-ups, doctor repair, and groups.</p></div><div><span class="verb-icon scale-icon"><i></i></span><b>Scale</b><p>Fan out bounded batches with explicit concurrency and durable run IDs.</p></div></section>
  {:else if route() === 'docs'}
    <section class="docs-layout"><aside class="docs-nav"><b>Terrarium docs</b>{#each docs as doc}<a class:active={currentDoc().id === doc.id} href="/docs?page={doc.id}" on:click|preventDefault={() => { selectedDoc = doc.id; navigate(`/docs?page=${doc.id}`); }}>{doc.label}</a>{/each}<hr><a href="/CHANGELOG.md">raw changelog</a><a href="https://github.com/acoyfellow/terrarium">source</a></aside><article class="docs-page"><label class="docs-mobile-jump"><span>Section</span><select on:change={docSelect} value={currentDoc().id}>{#each docs as doc}<option value={doc.id}>{doc.label}</option>{/each}</select></label><div class="eyebrow">{currentDoc().kicker}</div><h1>{currentDoc().title}</h1>{#each currentDoc().sections as section}<section class="docs-section"><h2>{section[0]}</h2>{#if section[1].includes('\n') || section[1].startsWith('terra') || section[1].startsWith('one bounded') || section[1].startsWith('terrarium_spawn')}<pre><code>{section[1]}</code></pre>{:else}<p>{section[1]}</p>{/if}</section>{/each}</article></section>
  {:else if route() === 'runs'}
    <section class="sheet-head"><div><div class="eyebrow">Security hardening run log</div><h1>Runs, instructions, environment, result.</h1><p>A public ledger of hardening runs against Terrarium's runner, callback, receipt, batch, and boundary behavior.</p></div><div class="sheet-counts"><b>{turns().length}</b><span>recorded turns</span><b>{turns().filter(t => t.status === 'evidence-backed').length}</b><span>evidence-backed</span></div></section>
    <section class="table-wrap"><table><thead><tr><th>#</th><th>Status</th><th>Product area</th><th>Agent / model</th><th>Instruction</th><th>Environment</th><th>What happened</th><th>Evidence</th></tr></thead><tbody>{#each turns() as turn}<tr><td data-label="#"><span class="turn-id">{String(turn.number).padStart(2,'0')}</span></td><td data-label="Status"><span class="status-pill" class:backed={turn.status==='evidence-backed'}>{turn.status}</span></td><td data-label="Product area"><b>{turn.productArea}</b></td><td data-label="Agent/model"><b>{turn.agentModel}</b><small>{turn.agentCommand}</small></td><td data-label="Instruction">{turn.instruction}</td><td data-label="Environment">{turn.environment}</td><td data-label="What happened">{turn.result}</td><td data-label="Evidence">{#if Array.isArray(turn.evidence)}{#each turn.evidence.slice(0,3) as ev}<code>{typeof ev === 'string' ? ev : ev.label || ev.href || 'evidence'}</code>{/each}{/if}</td></tr>{/each}</tbody></table></section>
  {:else}
    <section class="sheet-head"><div><div class="eyebrow">Changelog</div><h1>What changed.</h1><p>Concise product changes, mirrored from CHANGELOG.md.</p></div></section><article class="changelog"><pre>{changelog}</pre></article>
  {/if}
</main>
{/if}
