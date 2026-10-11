<script>
  const REFRESH_MS = 4000;
  let loops = $state([]);
  let error = $state('');
  let loaded = $state(false);

  async function refresh() {
    try {
      const res = await fetch('/api/loops', { credentials: 'same-origin' });
      const body = await res.json();
      if (!res.ok) { error = body.error || `HTTP ${res.status}`; return; }
      loops = body.loops;
      error = '';
    } catch (e) {
      error = String(e?.message ?? e);
    } finally {
      loaded = true;
    }
  }

  $effect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  });

  const outcomeOf = (loop) => loop.workflow?.output?.outcome ?? loop.workflow?.status ?? 'unknown';
  const attemptsOf = (loop) => loop.workflow?.output?.attempts ?? [];
  const cleanAnswer = (text) => String(text ?? '').split('\n').filter((l) => !/^(TASK_RECEIVED|TASK_ENDED|TERRARIUM_RESULT=)/.test(l.trim())).join('\n').trim();
</script>

<section class="docs-shell loops">
  <div class="eyebrow">Loops</div>
  <h1>What is running on Cloudflare</h1>
  <p class="lead">Each loop is a Cloudflare Workflow. This page only reads what the Workflow recorded. It refreshes every few seconds.</p>

  {#if error}
    <p class="loops-error">Could not load loops: {error}</p>
  {:else if loaded && loops.length === 0}
    <p>No loops yet. Start one with <code>POST /api/loops</code>.</p>
  {/if}

  {#each loops as loop (loop.loopId)}
    <article class="loop-card">
      <header class="loop-head">
        <span class="loop-badge" data-outcome={outcomeOf(loop)}>{outcomeOf(loop)}</span>
        <h3>{loop.contract.goal}</h3>
        <code class="loop-id">{loop.loopId}</code>
      </header>
      <dl class="loop-contract">
        <dt>Task</dt><dd>{loop.contract.task}</dd>
        <dt>Done when the answer contains</dt><dd><code>{loop.contract.expect}</code></dd>
        <dt>Attempts allowed</dt><dd>{loop.contract.maxAttempts}</dd>
        <dt>Locked</dt><dd>{new Date(loop.lockedAt).toLocaleString()}</dd>
        {#if loop.workflow?.output?.reason}<dt>Why it stopped</dt><dd>{loop.workflow.output.reason}</dd>{/if}
        {#if loop.workflow?.error}<dt>Workflow error</dt><dd>{JSON.stringify(loop.workflow.error)}</dd>{/if}
      </dl>
      {#if attemptsOf(loop).length}
        <ol class="loop-attempts">
          {#each attemptsOf(loop) as a}
            <li data-passed={a.gate.passed}>
              <strong>Attempt {a.attempt}</strong>
              <span>{a.gate.passed ? 'passed' : 'did not pass'}: {a.gate.reason}</span>
              <span>run <code>{a.runId}</code>, receipt {a.verified ? 'verified' : 'not verified'}</span>
              {#if cleanAnswer(a.answer)}<pre>{cleanAnswer(a.answer)}</pre>{/if}
            </li>
          {/each}
        </ol>
      {:else if outcomeOf(loop) === 'running' || outcomeOf(loop) === 'queued'}
        <p class="loop-wait">Working on the first attempt…</p>
      {/if}
    </article>
  {/each}
</section>
