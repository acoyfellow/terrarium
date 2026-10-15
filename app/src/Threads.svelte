<script>
  const REFRESH_MS = 4000;

  let runs = $state([]);
  let error = $state('');
  let loaded = $state(false);
  let selected = $state(null);
  let activity = $state({});
  let draft = $state('');
  let proof = $state('');
  let busy = $state(false);
  let messagesEl = $state(null);
  let lastCount = 0;

  async function api(path, init = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (!(res.headers.get('content-type') ?? '').includes('json')) throw new Error(res.ok ? 'The server answered with a page, not run data.' : `HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail?.problems?.join(', ') || body.error || `HTTP ${res.status}`);
    return body;
  }

  const channelOf = (run) => run.channel ?? 'no channel';
  const statusOf = (run) => run.terminal?.status ?? 'running';
  const threads = $derived.by(() => {
    const byChannel = new Map();
    for (const run of runs) byChannel.set(channelOf(run), [...(byChannel.get(channelOf(run)) ?? []), run]);
    return [...byChannel.entries()].map(([channel, list]) => ({ channel, runs: [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), last: list.reduce((max, run) => (run.createdAt > max ? run.createdAt : max), '') })).sort((a, b) => b.last.localeCompare(a.last));
  });
  const thread = $derived(threads.find((t) => t.channel === selected) ?? threads[0] ?? null);

  async function loadActivity(run) {
    const known = activity[run.runId];
    if (known?.done) return;
    try {
      const body = await api(`/api/runs/${run.runId}/activity`);
      activity = { ...activity, [run.runId]: { events: body.events ?? [], done: statusOf(run) !== 'running' } };
    } catch {
      activity = { ...activity, [run.runId]: { events: known?.events ?? [], done: false } };
    }
  }

  async function refresh() {
    try {
      runs = (await api('/api/runs?limit=60')).runs ?? [];
      error = '';
      loaded = true;
      if (thread) await Promise.all(thread.runs.map(loadActivity));
    } catch (e) {
      error = String(e?.message ?? e);
    } finally {
      loaded = true;
    }
  }

  $effect(() => {
    refresh();
    const poll = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(poll);
  });

  $effect(() => {
    if (thread) thread.runs.forEach(loadActivity);
  });

  $effect(() => {
    const count = (thread?.runs.length ?? 0) + Object.values(activity).reduce((n, a) => n + a.events.length, 0) + (thread?.channel.length ?? 0);
    if (messagesEl && count !== lastCount) {
      lastCount = count;
      queueMicrotask(() => messagesEl.scrollTo({ top: messagesEl.scrollHeight }));
    }
  });

  async function send(event) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    busy = true;
    try {
      const channel = thread && thread.channel !== 'no channel' ? thread.channel : `thread-${Date.now().toString(36)}`;
      await api('/api/runs', { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ task: draft.trim(), proof: proof.trim() || null, channel }) });
      selected = channel;
      draft = '';
      proof = '';
      await refresh();
    } catch (e) {
      error = String(e?.message ?? e);
    } finally {
      busy = false;
    }
  }

  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

<section class="threads" aria-label="Run threads">
  <aside class="list">
    <h2>Threads</h2>
    {#if !loaded}<p class="muted">Loading threads…</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#each threads as t (t.channel)}
      <button class="thread" aria-current={thread?.channel === t.channel ? 'true' : undefined} onclick={() => (selected = t.channel)}>
        <span class="name">{t.channel}</span>
        <span class="meta">{t.runs.length} run{t.runs.length === 1 ? '' : 's'} · {statusOf(t.runs.at(-1))}</span>
      </button>
    {/each}
    {#if loaded && threads.length === 0}<p class="muted">No runs yet. Start one below.</p>{/if}
  </aside>

  <div class="conversation">
    {#if thread}
      <header><h2>{thread.channel}</h2></header>
      <ol class="messages" bind:this={messagesEl}>
        {#each thread.runs as run (run.runId)}
          <li class="msg user"><span class="who">You · {time(run.createdAt)}</span><pre>{run.task}</pre>{#if run.proof}<span class="proof">proof: <code>{run.proof}</code></span>{/if}</li>
          {#each activity[run.runId]?.events ?? [] as ev}
            <li class="msg step {ev.kind}"><span class="who">{ev.kind === 'tool' ? 'tool' : 'agent'}</span><code>{ev.detail}</code></li>
          {/each}
          <li class="msg receipt {statusOf(run)}" data-run={run.runId}>
            <span class="who">{run.runId} · {statusOf(run)}{run.terminal ? ` · ${run.terminal.provenance}` : ''}</span>
            {#if run.terminal}
              <p>{run.terminal.summary ?? '(no summary)'}</p>
              {#if run.terminal.proof}<span class="proof">proof exit {run.terminal.proof.exitCode}</span>{/if}
            {:else}
              <p class="muted">Working…</p>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
    <form class="composer" onsubmit={send}>
      <textarea bind:value={draft} placeholder={thread ? `New run in ${thread.channel}` : 'Task for a new thread'} rows="2" aria-label="Task"></textarea>
      <input bind:value={proof} placeholder="Proof command (optional)" aria-label="Proof" />
      <button type="submit" disabled={busy || !draft.trim()}>{busy ? 'Starting…' : 'Run'}</button>
    </form>
  </div>
</section>

<style>
  .threads { display: grid; grid-template-columns: minmax(200px, 280px) 1fr; gap: 1rem; height: calc(100vh - 140px); min-height: 420px; }
  .list { border-right: 1px solid var(--line, #8884); padding-right: 0.75rem; overflow: auto; }
  .thread { display: block; width: 100%; text-align: left; padding: 0.5rem; border: 0; background: none; color: inherit; border-radius: 6px; cursor: pointer; }
  .thread[aria-current='true'] { background: var(--accent-soft, #8882); }
  .name { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta, .muted, .who { font-size: 0.8rem; opacity: 0.7; }
  .conversation { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .messages { list-style: none; padding: 0; margin: 0; flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 0.4rem; }
  .msg { padding: 0.5rem 0.75rem; border-radius: 8px; max-width: 90%; }
  .msg pre { white-space: pre-wrap; margin: 0.2rem 0 0; font: inherit; }
  .user { align-self: flex-end; background: var(--accent-soft, #4a7dff22); }
  .step { font-size: 0.85rem; opacity: 0.85; padding: 0.2rem 0.75rem; }
  .step code { white-space: pre-wrap; word-break: break-word; }
  .receipt { border: 1px solid var(--line, #8884); }
  .receipt.done { border-color: #2a9d5c; }
  .receipt.failed { border-color: #d0453a; }
  .who { display: block; }
  .proof { font-size: 0.8rem; }
  .error { color: #d0453a; }
  .composer { display: grid; grid-template-columns: 1fr minmax(120px, 220px) auto; gap: 0.5rem; padding-top: 0.75rem; }
  .composer textarea, .composer input { font: inherit; padding: 0.4rem; }
  @media (max-width: 720px) { .threads { grid-template-columns: 1fr; grid-template-rows: auto 1fr; } .list { border-right: 0; max-height: 30vh; } .composer { grid-template-columns: 1fr; } }
</style>
