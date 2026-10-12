<script>
  import { seed, view } from '../dev-loops-mock.js';

  const PUBLIC = import.meta.env.VITE_PUBLIC_SITE === '1';
  const demoLoops = PUBLIC ? seed() : [];
  const REFRESH_MS = 3000;
  const ACTIVE = new Set(['running', 'queued', 'waiting', 'waitingForPause', 'paused']);

  let loops = $state([]);
  let error = $state('');
  let loaded = $state(false);
  let filter = $state('all');
  let selectedId = $state(null);
  let composing = $state(false);
  let busy = $state('');
  let draft = $state({ goal: '', task: '', expect: '', maxAttempts: 3 });
  let lastSync = $state(0);
  let now = $state(Date.now());

  async function api(path, init = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (!(res.headers.get('content-type') ?? '').includes('json')) throw new Error(res.ok ? 'The server answered with a page, not loop data. Is the API running here?' : `HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail?.problems?.join(', ') || body.error || `HTTP ${res.status}`);
    return body;
  }

  async function refresh() {
    try {
      loops = PUBLIC ? demoLoops.map(view) : (await api('/api/loops')).loops;
      error = '';
      lastSync = Date.now();
    } catch (e) {
      error = String(e?.message ?? e);
    } finally {
      loaded = true;
    }
  }

  $effect(() => {
    refresh();
    const poll = setInterval(refresh, REFRESH_MS);
    const tick = setInterval(() => { now = Date.now(); }, 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  });

  const stateOf = (loop) => {
    if (loop.status === 'terminated') return 'cancelled';
    if (loop.status === 'errored') return 'errored';
    if (ACTIVE.has(loop.status)) return 'running';
    return loop.output?.decision?.outcome ?? loop.status ?? 'unknown';
  };
  const attemptsOf = (loop) => loop.output?.attempts ?? [];
  const cleanAnswer = (text) => String(text ?? '').split('\n').filter((l) => !/^(TASK_RECEIVED|TASK_ENDED|TERRARIUM_|\[stderr\])/.test(l.trim())).join('\n').trim();
  const ago = (iso) => {
    const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };

  const counts = $derived.by(() => {
    const c = { running: 0, passed: 0, exhausted: 0, cancelled: 0, errored: 0 };
    for (const loop of loops) { const s = stateOf(loop); c[s] = (c[s] ?? 0) + 1; }
    return c;
  });
  const finished = $derived(counts.passed + counts.exhausted);
  const passRate = $derived(finished === 0 ? null : Math.round((counts.passed / finished) * 100));
  const attemptStats = $derived.by(() => {
    const all = loops.flatMap(attemptsOf);
    return { total: all.length, passed: all.filter((a) => a.gate?.passed).length, verified: all.filter((a) => a.verified).length };
  });
  const timeline = $derived.by(() => {
    const buckets = Array.from({ length: 14 }, (_, i) => ({ day: new Date(now - (13 - i) * 86400000).toISOString().slice(0, 10), passed: 0, failed: 0, running: 0 }));
    for (const loop of loops) {
      const bucket = buckets.find((b) => b.day === loop.createdAt.slice(0, 10));
      if (!bucket) continue;
      const s = stateOf(loop);
      if (s === 'passed') bucket.passed += 1; else if (s === 'running') bucket.running += 1; else bucket.failed += 1;
    }
    return buckets;
  });
  const peak = $derived(Math.max(1, ...timeline.map((b) => b.passed + b.failed + b.running)));
  const visible = $derived(filter === 'all' ? loops : loops.filter((loop) => stateOf(loop) === filter));
  const selected = $derived(loops.find((loop) => loop.loopId === selectedId) ?? null);

  const RING = 2 * Math.PI * 42;
  const ringSegments = $derived.by(() => {
    const total = Math.max(1, loops.length);
    let offset = 0;
    return ['passed', 'running', 'exhausted', 'cancelled', 'errored'].map((key) => {
      const length = (counts[key] / total) * RING;
      const seg = { key, length, offset };
      offset += length;
      return seg;
    }).filter((seg) => seg.length > 0);
  });

  async function createLoop(event) {
    event.preventDefault();
    if (PUBLIC) return;
    busy = 'create';
    try {
      const created = await api('/api/loops', { method: 'POST', body: JSON.stringify({ ...draft, maxAttempts: Number(draft.maxAttempts) }) });
      composing = false;
      draft = { goal: '', task: '', expect: '', maxAttempts: 3 };
      selectedId = created.loopId;
      await refresh();
    } catch (e) {
      error = String(e?.message ?? e);
    } finally {
      busy = '';
    }
  }

  async function act(loop, action) {
    if (PUBLIC) return;
    if (action === 'delete' && !confirm(`Delete "${loop.contract.goal}"? This stops it if it is running.`)) return;
    busy = `${action}:${loop.loopId}`;
    try {
      if (action === 'cancel') await api(`/api/loops/${loop.loopId}/cancel`, { method: 'POST' });
      if (action === 'delete') { await api(`/api/loops/${loop.loopId}`, { method: 'DELETE' }); if (selectedId === loop.loopId) selectedId = null; }
      if (action === 'rerun') {
        const created = await api('/api/loops', { method: 'POST', body: JSON.stringify(loop.contract) });
        selectedId = created.loopId;
      }
      await refresh();
    } catch (e) {
      error = String(e?.message ?? e);
    } finally {
      busy = '';
    }
  }

  function edit(loop) {
    draft = { ...loop.contract };
    composing = true;
  }
</script>

<section class="cockpit" class:cp-public={PUBLIC}>
  <header class="cp-top">
    <div>
      <div class="eyebrow">Loops</div>
      <h1>Cockpit</h1>
    </div>
    <div class="cp-top-right">
      {#if PUBLIC}<span class="cp-demo">Demo data · sign in to your team's Terrarium for real loops</span>{/if}
      <span class="cp-sync" class:cp-sync-bad={error}>
        <span class="cp-dot" data-state={error ? 'errored' : 'live'}></span>
        {error ? 'Sync failed' : lastSync ? `Live · synced ${Math.max(0, Math.round((now - lastSync) / 1000))}s ago` : 'Connecting…'}
      </span>
      <button class="btn btn-primary" disabled={PUBLIC} title={PUBLIC ? 'Available on your team\'s Terrarium' : undefined} onclick={() => { draft = { goal: '', task: '', expect: '', maxAttempts: 3 }; composing = true; }}>+ New loop</button>
    </div>
  </header>

  {#if error}<p class="cp-error">{error}</p>{/if}

  <div class="cp-stats">
    <article class="cp-stat cp-stat-live">
      <span class="cp-stat-label">Running now</span>
      <span class="cp-stat-value">
        {#if counts.running > 0}<span class="cp-spinner" aria-hidden="true"></span>{/if}
        {counts.running}
      </span>
      <span class="cp-stat-sub">{counts.running === 0 ? 'All quiet' : `${counts.running} Workflow${counts.running === 1 ? '' : 's'} active`}</span>
    </article>

    <article class="cp-stat cp-ring-card">
      <div class="cp-ring-inner">
      <svg viewBox="0 0 100 100" class="cp-ring" role="img" aria-label="Loop outcomes">
        <circle cx="50" cy="50" r="42" class="cp-ring-track" />
        {#each ringSegments as seg (seg.key)}
          <circle cx="50" cy="50" r="42" class="cp-ring-seg" data-state={seg.key}
            stroke-dasharray={`${seg.length} ${RING - seg.length}`} stroke-dashoffset={-seg.offset} />
        {/each}
        <text x="50" y="47" class="cp-ring-num">{passRate === null ? '–' : `${passRate}%`}</text>
        <text x="50" y="62" class="cp-ring-cap">pass rate</text>
      </svg>
      <ul class="cp-legend">
        {#each [['passed', 'Passed'], ['running', 'Running'], ['exhausted', 'Exhausted'], ['cancelled', 'Cancelled'], ['errored', 'Errored']] as [key, label]}
          <li><span class="cp-dot" data-state={key}></span>{label}<b>{counts[key] ?? 0}</b></li>
        {/each}
      </ul>
      </div>
    </article>

    <article class="cp-stat">
      <span class="cp-stat-label">Attempts</span>
      <span class="cp-stat-value">{attemptStats.total}</span>
      <div class="cp-bar"><span style:width={`${attemptStats.total ? (attemptStats.passed / attemptStats.total) * 100 : 0}%`}></span></div>
      <span class="cp-stat-sub">{attemptStats.passed} passed the gate · {attemptStats.verified} verified receipts</span>
    </article>

    <article class="cp-stat cp-chart-card">
      <span class="cp-stat-label">Last 14 days</span>
      <svg viewBox="0 0 140 48" class="cp-chart" preserveAspectRatio="none" role="img" aria-label="Loops per day">
        {#each timeline as bucket, i}
          {@const h = 44}
          {@const x = i * 10 + 1}
          {@const pass = (bucket.passed / peak) * h}
          {@const fail = (bucket.failed / peak) * h}
          {@const run = (bucket.running / peak) * h}
          <rect x={x} width="8" y={48 - pass} height={pass} class="cp-bar-pass"><title>{bucket.day}: {bucket.passed} passed</title></rect>
          <rect x={x} width="8" y={48 - pass - fail} height={fail} class="cp-bar-fail"><title>{bucket.day}: {bucket.failed} not passed</title></rect>
          <rect x={x} width="8" y={48 - pass - fail - run} height={run} class="cp-bar-run"><title>{bucket.day}: {bucket.running} running</title></rect>
        {/each}
      </svg>
      <span class="cp-stat-sub">{loops.length} loops total</span>
    </article>
  </div>

  <div class="cp-body" class:cp-body-split={selected}>
    <div class="cp-list-wrap">
      <nav class="cp-filters">
        {#each [['all', 'All', loops.length], ['running', 'Running', counts.running], ['passed', 'Passed', counts.passed], ['exhausted', 'Exhausted', counts.exhausted], ['cancelled', 'Cancelled', counts.cancelled]] as [key, label, n]}
          <button class:active={filter === key} onclick={() => { filter = key; }}>{label} <span>{n}</span></button>
        {/each}
      </nav>

      {#if !loaded}
        <div class="cp-empty"><span class="cp-spinner"></span> Loading loops…</div>
      {:else if visible.length === 0}
        <div class="cp-empty">
          {loops.length === 0 ? 'No loops yet.' : 'Nothing in this view.'}
          {#if loops.length === 0}<button class="btn" onclick={() => { composing = true; }}>Start your first loop</button>{/if}
        </div>
      {:else}
        <ul class="cp-list">
          {#each visible as loop (loop.loopId)}
            {@const state = stateOf(loop)}
            {@const attempts = attemptsOf(loop)}
            <li class="cp-row" class:selected={loop.loopId === selectedId} data-state={state}>
              <button class="cp-row-main" onclick={() => { selectedId = loop.loopId === selectedId ? null : loop.loopId; }}>
                <span class="cp-light" data-state={state}>
                  {#if state === 'running'}<span class="cp-spinner cp-spinner-sm"></span>{/if}
                </span>
                <span class="cp-row-text">
                  <strong>{loop.contract.goal}</strong>
                  <span class="cp-row-task">{loop.contract.task}</span>
                </span>
                <span class="cp-pips" aria-label={`${attempts.length} of ${loop.contract.maxAttempts} attempts`}>
                  {#each Array.from({ length: loop.contract.maxAttempts }) as _, i}
                    <span class="cp-pip" data-state={i < attempts.length ? (attempts[i].gate?.passed ? 'passed' : 'exhausted') : (state === 'running' && i === attempts.length ? 'running' : 'empty')}></span>
                  {/each}
                </span>
                <span class="cp-badge" data-state={state}>{state}</span>
                <span class="cp-row-age">{ago(loop.createdAt)}</span>
              </button>
              <span class="cp-row-actions">
                {#if state === 'running'}
                  <button class="cp-icon" title="Cancel" disabled={busy === `cancel:${loop.loopId}`} onclick={() => act(loop, 'cancel')}>■</button>
                {:else}
                  <button class="cp-icon" title="Run again" disabled={busy === `rerun:${loop.loopId}`} onclick={() => act(loop, 'rerun')}>↻</button>
                {/if}
                <button class="cp-icon" title="Edit as new" onclick={() => edit(loop)}>✎</button>
                <button class="cp-icon cp-icon-danger" title="Delete" disabled={busy === `delete:${loop.loopId}`} onclick={() => act(loop, 'delete')}>✕</button>
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    {#if selected}
      {@const state = stateOf(selected)}
      <aside class="cp-detail">
        <header>
          <span class="cp-light cp-light-lg" data-state={state}>{#if state === 'running'}<span class="cp-spinner cp-spinner-sm"></span>{/if}</span>
          <div>
            <h2>{selected.contract.goal}</h2>
            <code>{selected.loopId}</code>
          </div>
          <button class="cp-icon" title="Close" onclick={() => { selectedId = null; }}>✕</button>
        </header>
        <dl class="cp-contract">
          <dt>Task</dt><dd>{selected.contract.task}</dd>
          <dt>Passes when the answer contains</dt><dd><code>{selected.contract.expect}</code></dd>
          <dt>Attempts</dt><dd>{attemptsOf(selected).length} of {selected.contract.maxAttempts}</dd>
          <dt>Started</dt><dd>{new Date(selected.createdAt).toLocaleString()} · {ago(selected.createdAt)}</dd>
          {#if selected.output?.decision?.reason}<dt>Why it stopped</dt><dd>{selected.output.decision.reason}</dd>{/if}
          {#if selected.error}<dt>Workflow error</dt><dd class="cp-err-text">{selected.error.message ?? JSON.stringify(selected.error)}</dd>{/if}
        </dl>
        <h3>Attempts</h3>
        <ol class="cp-timeline">
          {#each attemptsOf(selected) as a, i}
            <li data-state={a.gate?.passed ? 'passed' : 'exhausted'}>
              <span class="cp-tl-dot"></span>
              <div>
                <strong>Attempt {i + 1} · {a.gate?.passed ? 'passed' : 'did not pass'}</strong>
                <span class="cp-tl-meta">{a.gate?.reason} · receipt {a.verified ? 'verified' : 'not verified'} · <code>{a.runId}</code></span>
                {#if cleanAnswer(a.logs)}<pre>{cleanAnswer(a.logs)}</pre>{/if}
              </div>
            </li>
          {/each}
          {#if state === 'running'}
            <li data-state="running"><span class="cp-tl-dot"><span class="cp-spinner cp-spinner-sm"></span></span><div><strong>Attempt {attemptsOf(selected).length + 1} · working…</strong></div></li>
          {/if}
        </ol>
        <footer class="cp-detail-actions">
          {#if state === 'running'}
            <button class="btn" onclick={() => act(selected, 'cancel')}>Cancel loop</button>
          {:else}
            <button class="btn btn-primary" onclick={() => act(selected, 'rerun')}>Run again</button>
          {/if}
          <button class="btn" onclick={() => edit(selected)}>Edit as new</button>
          <button class="btn cp-btn-danger" onclick={() => act(selected, 'delete')}>Delete</button>
        </footer>
      </aside>
    {/if}
  </div>

  {#if composing}
    <div class="cp-modal-back" onclick={() => { composing = false; }} role="presentation"></div>
    <form class="cp-modal" onsubmit={createLoop}>
      <h2>New loop</h2>
      <p class="cp-modal-lead">A Workflow runs the task until the answer contains the expected text, or the attempts run out.</p>
      <label>Goal<input bind:value={draft.goal} required placeholder="Multiply two numbers" /></label>
      <label>Task<textarea bind:value={draft.task} required rows="3" placeholder="What is 17 multiplied by 23? Reply with just the number."></textarea></label>
      <div class="cp-modal-row">
        <label>Passes when the answer contains<input bind:value={draft.expect} required placeholder="391" /></label>
        <label class="cp-narrow">Max attempts<input type="number" min="1" max="5" bind:value={draft.maxAttempts} /></label>
      </div>
      <footer>
        <button type="button" class="btn" onclick={() => { composing = false; }}>Cancel</button>
        <button type="submit" class="btn btn-primary" disabled={busy === 'create'}>{busy === 'create' ? 'Starting…' : 'Start loop'}</button>
      </footer>
    </form>
  {/if}
</section>
