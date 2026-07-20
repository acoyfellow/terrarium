<script>
  // Docs shaped by purpose: Tutorial (learning), How-to (tasks), Reference (facts),
  // Explanation (understanding). Kept short and plain on purpose.
  const docs = [
    {
      id: 'tutorial', label: 'Tutorial', kind: 'Learn',
      title: 'Run your first task',
      lead: 'Install the CLI, run one bounded task on your machine, read its receipt.',
      blocks: [
        ['Where does this run? Locally.', 'This tutorial is the local CLI. terra runs on YOUR machine — it spawns a coding agent you already have (Pi, OpenCode…) as a child process, in your filesystem, with your network and API keys. Nothing is sent to any cloud. "Running on the edge" is a separate, optional service you deploy yourself (step 5); the CLI never phones home.', 'text'],
        ['1. Install from source', 'git clone https://github.com/acoyfellow/terrarium\ncd terrarium && npm install -g .', 'code'],
        ['2. Dry-run one bounded task', 'terra --dry-run "summarize README.md and list any stale claims"', 'code'],
        ['3. Run it for real', 'terra --agent "pi -p --no-session" "summarize README.md"', 'code'],
        ['4. Read the receipt', 'terra status <runId>\nterra read <runId>', 'code'],
        ['What you just got', 'One bounded task ran as one isolated child ON YOUR MACHINE and returned one correlated receipt — the run ID, its status, and a verified result you can trust or reject. No guessing from prose. No cloud involved.', 'text'],
        ['5. (optional) Run on your own Cloudflare edge instead', 'wrangler deploy   # deploys a Worker to YOUR Cloudflare account, at your own URL', 'code'],
        ['When to use the cloud path', 'Deploy the cloud service when you want to submit a task over HTTP (POST /api/runs), close your laptop, and pull the proof back later — execution then runs on Cloudflare instead of your machine. It is fully self-hosted: your Worker, your account, your data. terrarium.coey.dev is just the maintainer\'s reference copy, not a shared backend the CLI calls.', 'text'],
      ],
    },
    {
      id: 'howto', label: 'How-to', kind: 'Do',
      title: 'Get a specific job done',
      lead: 'Recipes for the common things.',
      blocks: [
        ['Run in an isolated copy', 'terra --isolation copy --agent "pi -p --no-session" \\\n  "fix the failing callback test and run test/router.test.js"', 'code'],
        ['Fan out several tasks in parallel', 'terra batch --concurrency 8 --strategy allSettled \\\n  "lint src" "run test/router.test.js" "update CHANGELOG"', 'code'],
        ['Cancel a run', 'terra cancel <runId>', 'code'],
        ['Self-heal stuck durable state', 'terra doctor --repair --apply --verify', 'code'],
        ['Deploy your own cloud instance', '# runs on YOUR Cloudflare account — your Worker, your data\nwrangler deploy            # -> https://terrarium-control.<you>.workers.dev\nwrangler secret put TERRARIUM_CONTROL_TOKEN_CURRENT', 'code'],
        ['Run a task on your instance', 'export TERRARIUM_URL=https://terrarium-control.<you>.workers.dev\ncurl -X POST $TERRARIUM_URL/api/runs \\\n  -H "authorization: Bearer $TOKEN" \\\n  -H "idempotency-key: $(uuidgen)" \\\n  -H "content-type: application/json" \\\n  -d \'{"task":"reply with: hello"}\'', 'code'],
      ],
    },
    {
      id: 'reference', label: 'Reference', kind: 'Look up',
      title: 'API and commands',
      lead: 'The exact surface. You deploy your own instance (wrangler deploy); every cloud route is auth-gated and owner-scoped to you.',
      blocks: [
        ['CLI', 'terra [--agent <cmd>] "task"   run one bounded task\nterra --dry-run "task"          plan only, no agent needed\nterra status <runId>           inspect status + receipt\nterra read <runId>             read logs\nterra cancel <runId>           cancel a run\nterra batch <tasks...>         fan out in parallel\nterra doctor --repair          heal durable state', 'code'],
        ['Cloud API', 'POST /api/runs               admit a task -> 202 { runId, contract }\nGET  /api/runs/:id/status    terminal + contract status\nGET  /api/runs/:id/logs      durable logs (+ R2 overflow refs)\nGET  /api/runs/:id/graded    trust grade + re-verifiable receipt\nPOST /api/runs/:id/cancel    cancel\nGET  /api/models             owner-scoped model catalog', 'code'],
        ['MCP tools', 'terrarium_spawn, terrarium_status, terrarium_read, terrarium_cancel,\nterrarium_spawn_batch, terrarium_group, terrarium_callbacks, terrarium_doctor', 'code'],
        ['A receipt', 'runId · taskFingerprint · nonce · summary — a task succeeded only when all three correlate.', 'text'],
      ],
    },
    {
      id: 'explain', label: 'Explanation', kind: 'Understand',
      title: 'Why trust is the bottleneck',
      lead: 'Parallel-first agents, on the edge — and why it only works when every run proves itself.',
      blocks: [
        ['The real bottleneck', 'Running agents in parallel is easy. Trusting the results is not. An agent that says "done" is not evidence; exit code 0 is not evidence; a callback firing is not evidence. So people run one agent, watch it, and never scale. The blocker was never compute — it was trust.', 'text'],
        ['The unlock', 'Make each run prove itself, and fanning out stops being a leap of faith. Trust one run the same way you trust a thousand — individually, by proof.', 'text'],
        ['The primitive', 'one bounded task → one isolated run → one correlated receipt', 'code'],
        ['What counts as success', 'Only a verified result whose run ID, task fingerprint, and nonce all match the task Terrarium handed out. Everything else — logs, callbacks, model prose — is a signal, not proof. The nonce is server-minted, so a run cannot forge its own success.', 'text'],
        ['Provenance vs. correctness', 'A verified receipt proves the task ran and correlated. It does not prove the answer is right. Terrarium adds an advisory, fail-closed trust grade from cross-model agreement — and parallelism helps here too: more independent runs raise confidence. It can annotate a receipt, never upgrade it.', 'text'],
        ['Why the edge', 'Every run lives on Cloudflare — admission, execution, logs, model route, and the wake callback. Submit a task, close your laptop, and pull the proof back later. Correctness and delivery never depend on a machine you own, which is what makes walking away from a thousand parallel runs safe.', 'text'],
      ],
    },
  ];

  let changelog = $state([]);
  let path = $state(location.pathname);
  let hash = $state(location.hash);
  let selectedDoc = $state(new URLSearchParams(location.search).get('page') || 'tutorial');

  const route = () => path === '/docs' ? 'docs' : path === '/runs' ? 'runs' : (path === '/changelog' || hash === '#changelog') ? 'changelog' : 'home';

  // --- Run index (/runs) — owner-authenticated view of GET /api/runs. -------
  // Token lives ONLY in sessionStorage (never localStorage, never committed,
  // never on disk). Cleared on tab close. 401 -> auth prompt, never a broken
  // page. This surface CONSUMES the existing endpoint; no backend changes.
  let runsToken = $state(sessionStorage.getItem('terra_token') || '');
  let runsAuthed = $state(!!sessionStorage.getItem('terra_token'));
  let runsData = $state({ runs: [], channels: {} });
  let runsError = $state('');
  let runsLoading = $state(false);
  let filterStatus = $state('');
  let filterSince = $state('');
  let tokenDraft = $state('');

  function runsQuery() {
    const p = new URLSearchParams();
    if (filterStatus) p.set('status', filterStatus);
    if (filterSince) {
      const ms = Date.parse(filterSince);
      if (!Number.isNaN(ms)) p.set('since', String(ms));
    }
    const qs = p.toString();
    return '/api/runs' + (qs ? '?' + qs : '');
  }

  async function loadRuns() {
    if (!runsToken) { runsAuthed = false; return; }
    runsLoading = true; runsError = '';
    try {
      const res = await fetch(runsQuery(), { headers: { authorization: 'Bearer ' + runsToken } });
      if (res.status === 401) {
        runsAuthed = false;
        runsError = 'Authentication required — token missing, wrong, or expired.';
        sessionStorage.removeItem('terra_token');
        runsToken = '';
        return;
      }
      if (!res.ok) { runsError = 'Request failed (' + res.status + ').'; return; }
      const body = await res.json();
      runsData = { runs: body.runs || [], channels: body.channels || {} };
      runsAuthed = true;
    } catch (e) {
      runsError = 'Network error — could not reach /api/runs.';
    } finally {
      runsLoading = false;
    }
  }

  function submitToken(e) {
    if (e) e.preventDefault();
    if (!tokenDraft.trim()) return;
    runsToken = tokenDraft.trim();
    sessionStorage.setItem('terra_token', runsToken);
    runsAuthed = true;
    tokenDraft = '';
    loadRuns();
  }

  function signOutRuns() {
    sessionStorage.removeItem('terra_token');
    runsToken = ''; runsAuthed = false; runsData = { runs: [], channels: {} }; runsError = '';
  }

  // Group runs by channel for display (channel is the grouping key).
  const runsByChannel = () => {
    const groups = {};
    for (const r of runsData.runs) {
      const ch = r.channel || '(none)';
      (groups[ch] ??= []).push(r);
    }
    return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
  };
  const currentDoc = () => docs.find((d) => d.id === selectedDoc) || docs[0];

  function navigate(to, event) {
    if (event) event.preventDefault();
    history.pushState(null, '', to);
    path = location.pathname; hash = location.hash;
    selectedDoc = new URLSearchParams(location.search).get('page') || selectedDoc;
    scrollTo(0, 0);
  }

  // Parse CHANGELOG.md into { date, title, items[] } entries for clean rendering.
  function parseChangelog(md) {
    const out = [];
    let cur = null;
    for (const raw of md.split('\n')) {
      const h = raw.match(/^##\s+(.+)/);
      if (h) { cur = { heading: h[1].trim(), items: [] }; out.push(cur); continue; }
      const li = raw.match(/^\s*[-*]\s+(.+)/);
      if (li && cur) cur.items.push(li[1].replace(/\*\*/g, '').trim());
    }
    return out.filter((e) => e.items.length).slice(0, 12);
  }

  async function load() {
    try {
      const res = await fetch('/CHANGELOG.md');
      changelog = parseChangelog(await res.text());
    } catch { changelog = []; }
  }
  addEventListener('popstate', () => {
    path = location.pathname; hash = location.hash;
    selectedDoc = new URLSearchParams(location.search).get('page') || 'tutorial';
  });
  load();

  // Scroll-reveal: sections assemble as they enter, like a loading screen
  // booting into view. Re-runs on every route change (SPA nav does NOT re-fire
  // onMount, so navigating home->docs->home must re-observe the fresh DOM, or
  // reveal elements stay stuck at opacity:0). Progressive-enhancement only.
  import { tick } from 'svelte';
  let io;
  if (typeof document !== 'undefined') document.documentElement.classList.add('reveal-js');
  $effect(() => {
    // Auto-load the run index whenever we land on /runs with a stored token.
    if (route() === 'runs' && runsToken && !runsLoading) loadRuns();
  });

  $effect(() => {
    route(); // dependency: re-run whenever the route changes
    if (typeof window === 'undefined') return;
    tick().then(() => {
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const els = document.querySelectorAll('[data-reveal]:not(.in)');
      if (reduce || !('IntersectionObserver' in window)) {
        els.forEach((el) => el.classList.add('in'));
        return;
      }
      io ??= new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
        }
      }, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });
      for (const el of els) {
        // Reveal immediately if already in view (nav-back lands mid-page or top);
        // otherwise observe for scroll. Never leaves in-view content hidden.
        const r = el.getBoundingClientRect();
        if (r.top < innerHeight * 0.92 && r.bottom > 0) el.classList.add('in');
        else io.observe(el);
      }
    });
  });
</script>

<div class="shell">
  <div class="atmos" aria-hidden="true">
    <div class="aurora aurora-1"></div>
    <div class="aurora aurora-2"></div>
    <div class="aurora aurora-3"></div>
    <div class="spores">
      {#each Array(14) as _, i}<i style={`--i:${i}`}></i>{/each}
    </div>
    <div class="noise"></div>
  </div>
  <header class="topbar">
    <a class="brand" href="/" onclick={(e) => navigate('/', e)}><span class="mark"></span>Terrarium</a>
    <nav class="topbar-nav">
      <a href="/docs" onclick={(e) => navigate('/docs', e)}>Docs</a>
      <a href="/runs" onclick={(e) => navigate('/runs', e)}>Runs</a>
      <a href="/changelog" onclick={(e) => navigate('/changelog', e)}>Changelog</a>
      <a href="https://github.com/acoyfellow/terrarium">GitHub</a>
      <a class="cta" href="/docs?page=tutorial" onclick={(e) => navigate('/docs?page=tutorial', e)}>Get started</a>
    </nav>
  </header>

  {#if route() === 'home'}
    <section class="hero">
      <div class="hero-glow" aria-hidden="true"></div>
      <div class="hero-grid" aria-hidden="true"></div>
      <div class="hero-inner" data-reveal>
        <div class="hero-split">
          <div class="hero-copy">
            <div class="eyebrow">Parallel-first agents, on the edge</div>
            <h1>Run agents in parallel.<br />Trust <em>every</em> result.</h1>
            <p class="sub">The thing blocking agents at scale isn't compute — it's trust. Terrarium fans out bounded tasks that run <b>on Cloudflare by default</b> and hands each one back a verified receipt: proof it ran, correlated and yours to trust or reject. Submit, close your laptop, pull the proof later. No babysitting one agent at a time. No server. No local machine in the loop.</p>
            <div class="hero-actions">
              <a class="btn btn-primary" href="/docs?page=tutorial" onclick={(e) => navigate('/docs?page=tutorial', e)}>Get started</a>
              <a class="btn" href="https://github.com/acoyfellow/terrarium">View source</a>
            </div>
          </div>
          <div class="hero-art hero-story">
            <img class="hs-frame hs-1" src="/campaign/v6/parallel/fanout.jpg" alt="One bounded task fanned out into many isolated runs" loading="eager" />
            <img class="hs-frame hs-2" src="/campaign/v6/parallel/grid-wall.jpg" alt="" aria-hidden="true" loading="eager" />
            <img class="hs-frame hs-3" src="/campaign/v6/parallel/receipts-rising.jpg" alt="" aria-hidden="true" loading="lazy" />
            <img class="hs-frame hs-4" src="/campaign/v6/parallel/all-verified.jpg" alt="" aria-hidden="true" loading="lazy" />
            <div class="hero-art-veil" aria-hidden="true"></div>
            <div class="hs-caption" aria-hidden="true">
              <span class="hsc hsc-1"><b class="mono">01</b> one task, fanned out</span>
              <span class="hsc hsc-2"><b class="mono">02</b> isolated runs, in parallel</span>
              <span class="hsc hsc-3"><b class="mono">03</b> each returns its own receipt</span>
              <span class="hsc hsc-4"><b class="mono">✓</b> many runs at once — each one proven</span>
            </div>
            <div class="receipt-chip fx-shine hs-receipt">
              <span class="rc-dot"></span>
              <div class="rc-body">
                <span class="rc-status">verified receipt</span>
                <span class="rc-id mono">ter_mrcb3k07_f606b3313eb8</span>
                <span class="rc-meta mono">1 of many · runId · fingerprint · nonce correlate</span>
              </div>
            </div>
          </div>
        </div>
        <pre class="hero-code fx-shine"><span class="scan" aria-hidden="true"></span><code>{`# one bounded task -> one isolated run -> one verified receipt
terra --agent "pi -p --no-session" "fix the failing test"

# on your own edge deploy: submit, close your laptop, pull the receipt later
POST https://terrarium-control.<you>.workers.dev/api/runs  ->  202 { runId }`}</code></pre>
      </div>
    </section>

    <section class="trust">
      <div class="trust-inner">
        <div class="trust-head">
          <span class="trust-label mono">Every run executes on</span>
          <img class="trust-logo" src="/cloudflare.svg" alt="Cloudflare" width="110" height="50" />
        </div>
        <div class="trust-primitives" data-reveal>
          <span class="tp" style="--d:0"><img src="/cf/workers.svg" alt="" aria-hidden="true" /><b class="mono">Workers</b></span>
          <span class="tp" style="--d:1"><img src="/cf/durable-objects.svg" alt="" aria-hidden="true" /><b class="mono">Durable Objects</b></span>
          <span class="tp" style="--d:2"><img src="/cf/containers.svg" alt="" aria-hidden="true" /><b class="mono">Containers</b></span>
          <span class="tp" style="--d:3"><img src="/cf/r2.svg" alt="" aria-hidden="true" /><b class="mono">R2</b></span>
          <span class="tp" style="--d:4"><img src="/cf/workers-ai.svg" alt="" aria-hidden="true" /><b class="mono">Workers AI</b></span>
        </div>
      </div>
    </section>

    <section class="chapter">
      <div class="chapter-inner">
        <div class="chapter-head" data-reveal>
          <div><p class="eyebrow">01 / Why it changes things</p><h2 class="section-title">Trust one run.<br />Now run a thousand.</h2></div>
          <p class="section-lede">When each run proves itself, fanning out stops being a leap of faith. That's the unlock: parallelism you can actually rely on — from the CLI, an agent, or a cloud endpoint, all the same primitive.</p>
        </div>
        <div class="grid-cards" data-reveal>
          <div class="cell fx-shine" style="--d:0"><span class="idx">A</span><h3>Proof per run</h3><p>Success is a verified receipt — run ID, fingerprint, and nonce all correlate. Not exit codes, not prose, not "trust me."</p></div>
          <div class="cell fx-shine" style="--d:1"><span class="idx">B</span><h3>Parallel without fear</h3><p>Fan out with explicit concurrency. Every run is isolated and keeps its own receipt, so more runs never means more guessing.</p></div>
          <div class="cell fx-shine" style="--d:2"><span class="idx">C</span><h3>Nothing to babysit</h3><p>Submit and walk away. Runs live on the edge and wake you when they finish — even after you disconnect.</p></div>
        </div>
      </div>
    </section>

    <section class="chapter">
      <div class="chapter-inner">
        <div class="chapter-head" data-reveal>
          <div><p class="eyebrow">02 / How one run works</p><h2 class="section-title">Task in.<br />Receipt out.</h2></div>
          <p class="section-lede">One run, four steps, one direction — then multiply it. Every task you fan out follows the same path and comes back with its own proof, even if you disconnect mid-flight.</p>
        </div>
        <ol class="flow" data-reveal>
          <li class="fx-shine" style="--d:0"><span class="step-art"><img src="/campaign/v6/steps/task.jpg" alt="" aria-hidden="true" loading="lazy" /></span><span class="step">01</span><b>Task</b><span>Hand Terrarium one bounded job.</span></li>
          <li class="fx-shine" style="--d:1"><span class="step-art"><img src="/campaign/v6/steps/run.jpg" alt="" aria-hidden="true" loading="lazy" /></span><span class="step">02</span><b>Run</b><span>It executes as one isolated child — local or a Cloudflare cell.</span></li>
          <li class="fx-shine" style="--d:2"><span class="step-art"><img src="/campaign/v6/steps/receipt.jpg" alt="" aria-hidden="true" loading="lazy" /></span><span class="step">03</span><b>Receipt</b><span>You get a correlated, verifiable result back.</span></li>
          <li class="fx-shine" style="--d:3"><span class="step-art"><img src="/campaign/v6/steps/wake.jpg" alt="" aria-hidden="true" loading="lazy" /></span><span class="step">04</span><b>Wake</b><span>A durable callback tells you it finished, even after you disconnect.</span></li>
        </ol>
      </div>
    </section>

    <section class="chapter edge">
      <div class="chapter-inner">
        <div class="chapter-head" data-reveal>
          <div><p class="eyebrow">03 / Runs on the edge</p><h2 class="section-title">No origin server.<br />No local machine.</h2></div>
          <p class="section-lede">Submit a task, close your laptop. Admission, the run-control cell, execution, logs, the model route, and the wake callback all live on <b>Cloudflare's global network</b> — so correctness, liveness, logs, and delivery never depend on a machine you own.</p>
        </div>
        <div class="globe-wrap" data-reveal aria-hidden="true">
          <div class="globe">
            <span class="g-ring g-ring-1"></span>
            <span class="g-ring g-ring-2"></span>
            <span class="g-ring g-ring-3"></span>
            <span class="g-core"></span>
            {#each Array(11) as _, i}<span class="pop" style={`--p:${i}`}></span>{/each}
          </div>
          <span class="globe-cap mono">POPs firing — parallel runs across the edge</span>
        </div>
        <ol class="edge-flow" data-reveal>
          <span class="edge-packet" aria-hidden="true"></span>
          <li style="--d:0"><span class="ef-k mono">Worker API</span><span class="ef-v">Authenticated <code>POST /api/runs</code>, ordered admission, per-principal budget.</span></li>
          <li style="--d:1"><span class="ef-k mono">Durable Object</span><span class="ef-v">One run-control cell per run holds authoritative state — survives restarts and reconnects.</span></li>
          <li style="--d:2"><span class="ef-k mono">Container cell</span><span class="ef-v">The task runs in an isolated Cloudflare-managed execution cell. Egress is deny-by-default.</span></li>
          <li style="--d:3"><span class="ef-k mono">Workers AI</span><span class="ef-v">A credentialless, server-owned model route — the cell never holds a reusable key.</span></li>
          <li style="--d:4"><span class="ef-k mono">R2 logs</span><span class="ef-v">Durable, integrity-checked logs (byte count + SHA-256), inline then overflow to R2.</span></li>
          <li style="--d:5"><span class="ef-k mono">Pulse wake</span><span class="ef-v">A durable, principal-scoped terminal callback reaches you across closes, sessions, and machines.</span></li>
        </ol>
      </div>
    </section>

    <section class="closing">
      <div class="closing-inner" data-reveal>
        <p><strong>Parallel-first agents, on the edge</strong> — where every run proves itself.</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="/docs?page=tutorial" onclick={(e) => navigate('/docs?page=tutorial', e)}>Run your first task</a>
          <a class="btn" href="/docs?page=explain" onclick={(e) => navigate('/docs?page=explain', e)}>Why receipts?</a>
        </div>
      </div>
    </section>

  {:else if route() === 'docs'}
    <section class="docs-shell">
      <div class="docs-layout">
        <aside class="docs-nav">
          {#each docs as doc}
            <a class:active={currentDoc().id === doc.id} href="/docs?page={doc.id}" onclick={(e) => navigate(`/docs?page=${doc.id}`, e)}>
              <span class="doc-kind">{doc.kind}</span><span class="doc-label">{doc.label}</span>
            </a>
          {/each}
        </aside>
        <article class="docs-page">
          <div class="eyebrow">{currentDoc().kind}</div>
          <h1>{currentDoc().title}</h1>
          <p class="lead">{currentDoc().lead}</p>
          {#each currentDoc().blocks as [heading, body, kind]}
            <section class="doc-block">
              <h2>{heading}</h2>
              {#if kind === 'code'}<pre><code>{body}</code></pre>{:else}<p>{body}</p>{/if}
            </section>
          {/each}
        </article>
      </div>
    </section>

  {:else if route() === 'runs'}
    <section class="runs-shell">
      <div class="runs-head">
        <div class="eyebrow">Run index</div>
        <h1>Your runs.</h1>
        <p class="lead">Every admitted run on your instance, grouped by channel. Owner-scoped and auth-gated — the token stays in this tab only.</p>
      </div>

      {#if !runsAuthed}
        <form class="runs-auth" onsubmit={submitToken}>
          <label for="tok">Control token</label>
          <p class="runs-auth-note">Paste your control token to list runs. It is kept in <code>sessionStorage</code> for this tab only — never written to disk or sent anywhere but <code>/api/runs</code>.</p>
          <input id="tok" type="password" autocomplete="off" bind:value={tokenDraft} placeholder="Bearer token…" />
          <button class="btn btn-primary" type="submit">Load runs</button>
          {#if runsError}<p class="runs-error">{runsError}</p>{/if}
        </form>
      {:else}
        <div class="runs-controls">
          <div class="runs-filters">
            <label>Status
              <select bind:value={filterStatus} onchange={loadRuns}>
                <option value="">all</option>
                <option value="running">running</option>
                <option value="done">done</option>
                <option value="failed">failed</option>
              </select>
            </label>
            <label>Since
              <input type="datetime-local" bind:value={filterSince} onchange={loadRuns} />
            </label>
            <button class="btn" onclick={loadRuns}>Refresh</button>
          </div>
          <button class="btn runs-signout" onclick={signOutRuns}>Sign out</button>
        </div>

        {#if runsError}<p class="runs-error">{runsError}</p>{/if}
        {#if runsLoading}<p class="runs-empty">Loading…</p>
        {:else if runsData.runs.length === 0}<p class="runs-empty">No runs match.</p>
        {:else}
          {#each runsByChannel() as [channel, rows]}
            <div class="runs-group">
              <h2 class="runs-channel">{channel} <span class="runs-count">{rows.length}</span></h2>
              <table class="runs-table">
                <thead><tr><th>Run</th><th>Status</th><th>Grounding</th><th>Created</th><th>Terminal</th></tr></thead>
                <tbody>
                  {#each rows as r}
                    <tr>
                      <td class="mono">{r.runId}</td>
                      <td><span class="runs-badge runs-{r.status}">{r.status}{#if r.status === 'done' && r.ok === false} · !ok{/if}</span></td>
                      <td class="mono">{r.grounding || '—'}</td>
                      <td>{r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'}</td>
                      <td>{r.terminalAt ? new Date(r.terminalAt).toLocaleString() : '—'}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/each}
        {/if}
      {/if}
    </section>

  {:else}
    <section class="log-shell">
      <div class="log-head">
        <div class="eyebrow">Changelog</div>
        <h1>What actually shipped.</h1>
        <p class="lead">Notable product, API, and safety changes.</p>
      </div>
      <div class="log">
        {#each changelog as entry}
          <div class="log-entry">
            <h3>{entry.heading}</h3>
            <ul>{#each entry.items as item}<li>{item}</li>{/each}</ul>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <footer class="foot">
    <span>Terrarium</span>
    <a href="https://github.com/acoyfellow/terrarium">GitHub</a>
    <a href="/docs" onclick={(e) => navigate('/docs', e)}>Docs</a>
    <a href="https://terrarium.coey.dev">terrarium.coey.dev</a>
  </footer>
</div>
