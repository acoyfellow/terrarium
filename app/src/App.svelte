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
        ['What you just got', 'One bounded task ran as one isolated child ON YOUR MACHINE and returned one correlated receipt: the run ID, its status, and a verified result you can trust or reject. The check does not depend on prose or on the cloud.', 'text'],
        ['5. (optional) Run on your own Cloudflare edge instead', 'wrangler deploy   # deploys a Worker to YOUR Cloudflare account, at your own URL', 'code'],
        ['When to use the cloud path', 'Deploy the cloud service when you want to submit a task over HTTP (POST /api/runs), close your laptop, and pull the proof back later. Execution then runs on Cloudflare instead of your machine. It is fully self-hosted: it runs in the Cloudflare account where you deploy the Worker. terrarium.coey.dev is the maintainer\'s reference deployment. The CLI uses the instance configured in TERRARIUM_URL.', 'text'],
      ],
    },
    {
      id: 'howto', label: 'How-to', kind: 'Do',
      title: 'Get a specific job done',
      lead: 'Use these commands to run, cancel, and deploy tasks.',
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
        ['Cloud API', 'POST /api/runs               admit a task -> 202 { runId, contract }\nGET  /api/runs               list your runs (channel/status/since)\nPOST /api/batches            admit N tasks as one batch (windowed)\nGET  /api/batches/:id        aggregate (failure-truth, child runIds)\nGET  /api/runs/:id/status    terminal + contract status\nGET  /api/runs/:id/logs      durable logs (+ R2 overflow refs)\nGET  /api/runs/:id/graded    trust grade + re-verifiable receipt\nPOST /api/runs/:id/cancel    cancel\nGET  /api/models             owner-scoped model catalog', 'code'],
        ['MCP tools', [
          ['Tool', 'What it does'],
          ['terrarium_spawn', 'One bounded child. Synchronous unless background: true.'],
          ['terrarium_spawn_batch', 'Fan-out with all / allSettled / race / any / quorum. Prefer isolation copy or worktree.'],
          ['terrarium_status', 'One run by id, or list recent runs.'],
          ['terrarium_read', 'Recorded log. kind: mre for the side log.'],
          ['terrarium_cancel', 'Cancel one run and its process group.'],
          ['terrarium_group', 'Roll up already-started runs. Group ok only if every member is done and ok.'],
          ['terrarium_callbacks', 'Pull terminal events. A callback is not proof the task succeeded.'],
          ['terrarium_doctor', 'Read-only diagnostics. CLI --repair is opt-in.'],
          ['terrarium_report_failure', 'Deduped bug report from a terminal failure.'],
        ], 'table'],
        ['A receipt', 'runId · taskFingerprint · nonce · summary — a task succeeded only when all three correlate.', 'text'],
      ],
    },
    {
      id: 'explain', label: 'Explanation', kind: 'Understand',
      title: 'Why checking results is the bottleneck',
      lead: 'Bounded agent tasks run in parallel on Cloudflare. Each run returns a receipt you can check.',
      blocks: [
        ['The bottleneck', 'Running agents in parallel is easy. Checking the results is the slow part. Agent output and process signals do not prove that a task ran: not a "done" message, not an exit code of 0, not a callback. So people run one agent, watch it by hand, and stop there.', 'text'],
        ['What a receipt changes', 'Each run carries its own receipt. One run and a thousand runs check the same way: one receipt at a time.', 'text'],
        ['The primitive', 'one bounded task -> one isolated run -> one correlated receipt', 'code'],
        ['What counts as success', 'A run succeeds when its run ID, task fingerprint, and nonce match the task Terrarium handed out. Logs, callbacks, and model prose are signals, not the status. The nonce is server-minted, so a run cannot forge its own success.', 'text'],
        ['Provenance and correctness are separate', 'A verified receipt proves the task ran and correlated. It does not prove the answer is correct. Terrarium adds an advisory trust grade from cross-model agreement; more independent runs raise the grade. The grade annotates a receipt. It never changes a receipt from failed to verified.', 'text'],
        ['Why Cloudflare', 'Admission, execution, logs, the model route, and the wake callback all run on Cloudflare. Submit a task, close your laptop, and read the receipt later. State and delivery do not depend on a machine you own, so you can leave a thousand parallel runs and come back to their receipts.', 'text'],
      ],
    },
  ];

  let changelog = $state([]);
  let path = $state(location.pathname);
  let hash = $state(location.hash);
  let selectedDoc = $state(new URLSearchParams(location.search).get('page') || 'tutorial');

  const route = () => path === '/docs' ? 'docs' : (path === '/changelog' || hash === '#changelog') ? 'changelog' : 'home';

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
            <div class="eyebrow">Parallel agents on Cloudflare</div>
            <h1>Run agents in parallel.<br />Check <em>every</em> result.</h1>
            <p class="sub">You can run a hundred agents at once. Checking a hundred results by hand is the part that stops you. Terrarium runs each bounded task <b>on Cloudflare by default</b> and returns a receipt: the run ID, a task fingerprint, and a server-minted nonce that must all correlate. Submit a task, close your laptop, and read the receipt later. The task runs on Cloudflare without an origin server or a machine you own.</p>
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
              <span class="hsc hsc-4"><b class="mono">✓</b> many runs at once, each with its own receipt</span>
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
          <div><p class="eyebrow">01 / What a receipt buys you</p><h2 class="section-title">Check one run.<br />Then check a thousand the same way.</h2></div>
          <p class="section-lede">Each run carries its own receipt, so a thousand runs check the same way as one: read the receipt. The same command runs from the CLI, an agent, or a cloud endpoint.</p>
        </div>
        <div class="grid-cards" data-reveal>
          <div class="cell fx-shine" style="--d:0"><span class="idx">A</span><h3>A receipt per run</h3><p>A run succeeds when its run ID, task fingerprint, and nonce correlate. An exit code of 0 or a line of agent prose does not set the status.</p></div>
          <div class="cell fx-shine" style="--d:1"><span class="idx">B</span><h3>Bounded parallelism</h3><p>Fan out with an explicit concurrency limit. Each run is isolated and keeps its own receipt, so the check per run stays the same as the count grows.</p></div>
          <div class="cell fx-shine" style="--d:2"><span class="idx">C</span><h3>No process to watch</h3><p>Submit a task and disconnect. The run lives on Cloudflare and sends a durable callback when it finishes.</p></div>
        </div>
      </div>
    </section>

    <section class="chapter">
      <div class="chapter-inner">
        <div class="chapter-head" data-reveal>
          <div><p class="eyebrow">02 / How one run works</p><h2 class="section-title">Task in.<br />Receipt out.</h2></div>
          <p class="section-lede">One run takes four steps. Every task you fan out follows the same four steps and returns its own receipt, including runs that finish after you disconnect.</p>
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
          <div><p class="eyebrow">03 / Where a run lives</p><h2 class="section-title">Runs on Cloudflare.<br />No machine you own.</h2></div>
          <p class="section-lede">Submit a task and close your laptop. Admission, the run-control cell, execution, logs, the model route, and the wake callback all run on <b>Cloudflare's global network</b>. State, logs, and delivery do not depend on a machine you own.</p>
        </div>
        <div class="globe-wrap" data-reveal aria-hidden="true">
          <div class="globe">
            <span class="g-ring g-ring-1"></span>
            <span class="g-ring g-ring-2"></span>
            <span class="g-ring g-ring-3"></span>
            <span class="g-core"></span>
            {#each Array(11) as _, i}<span class="pop" style={`--p:${i}`}></span>{/each}
          </div>
          <span class="globe-cap mono">parallel runs across Cloudflare edge POPs</span>
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
        <p><strong>Run bounded agent tasks in parallel on Cloudflare. Read a receipt for each one.</strong></p>
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
              {#if kind === 'code'}<pre><code>{body}</code></pre>{:else if kind === 'table'}<div class="doc-table-wrap"><table class="doc-table"><thead><tr>{#each body[0] as cell}<th>{cell}</th>{/each}</tr></thead><tbody>{#each body.slice(1) as row}<tr>{#each row as cell}<td>{cell}</td>{/each}</tr>{/each}</tbody></table></div>{:else}<p>{body}</p>{/if}
            </section>
          {/each}
        </article>
      </div>
    </section>

  {:else}
    <section class="log-shell">
      <div class="log-head">
        <div class="eyebrow">Changelog</div>
        <h1>What shipped.</h1>
        <p class="lead">Product, API, and safety changes, most recent first.</p>
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
