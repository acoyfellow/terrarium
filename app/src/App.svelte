<script>
  // Docs shaped by purpose: Tutorial (learning), How-to (tasks), Reference (facts),
  // Explanation (understanding). Kept short and plain on purpose.
  const docs = [
    {
      id: 'tutorial', label: 'Tutorial', kind: 'Learn',
      title: 'Run your first task',
      lead: 'Clone, install, run one bounded task, read its receipt.',
      blocks: [
        ['1. Install from source', 'git clone https://github.com/acoyfellow/terrarium\ncd terrarium && npm install -g .', 'code'],
        ['2. Dry-run one bounded task', 'terra --dry-run "summarize README.md and list any stale claims"', 'code'],
        ['3. Run it for real', 'terra --agent "pi -p --no-session" "summarize README.md"', 'code'],
        ['4. Read the receipt', 'terra status <runId>\nterra read <runId>', 'code'],
        ['What you just got', 'One bounded task ran as one isolated child and returned one correlated receipt — the run ID, its status, and a verified result you can trust or reject. No guessing from prose.', 'text'],
        ['Note', 'terra runs a coding agent you already have (pass it with --agent, e.g. "pi -p --no-session" or "opencode run"). --dry-run needs none, so it always works first.', 'text'],
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
        ['Run a task in the cloud', 'curl -X POST https://terrarium.coey.dev/api/runs \\\n  -H "authorization: Bearer $TOKEN" \\\n  -H "idempotency-key: $(uuidgen)" \\\n  -H "content-type: application/json" \\\n  -d \'{"task":"reply with: hello"}\'', 'code'],
      ],
    },
    {
      id: 'reference', label: 'Reference', kind: 'Look up',
      title: 'API and commands',
      lead: 'The exact surface. Every cloud route is auth-gated and owner-scoped.',
      blocks: [
        ['CLI', 'terra [--agent <cmd>] "task"   run one bounded task\nterra --dry-run "task"          plan only, no agent needed\nterra status <runId>           inspect status + receipt\nterra read <runId>             read logs\nterra cancel <runId>           cancel a run\nterra batch <tasks...>         fan out in parallel\nterra doctor --repair          heal durable state', 'code'],
        ['Cloud API', 'POST /api/runs               admit a task -> 202 { runId, contract }\nGET  /api/runs/:id/status    terminal + contract status\nGET  /api/runs/:id/logs      durable logs (+ R2 overflow refs)\nGET  /api/runs/:id/graded    trust grade + re-verifiable receipt\nPOST /api/runs/:id/cancel    cancel\nGET  /api/models             owner-scoped model catalog', 'code'],
        ['MCP tools', 'terrarium_spawn, terrarium_status, terrarium_read, terrarium_cancel,\nterrarium_spawn_batch, terrarium_group, terrarium_callbacks, terrarium_doctor', 'code'],
        ['A receipt', 'runId · taskFingerprint · nonce · summary — a task succeeded only when all three correlate.', 'text'],
      ],
    },
    {
      id: 'explain', label: 'Explanation', kind: 'Understand',
      title: 'Why receipts, not vibes',
      lead: 'The one idea Terrarium is built on.',
      blocks: [
        ['The problem', 'An agent that says "done" is not evidence. Exit code 0 is not evidence. A callback firing is not evidence. As you delegate more work in parallel, "trust me" does not scale.', 'text'],
        ['The primitive', 'one bounded task → one isolated run → one correlated receipt', 'code'],
        ['What counts as success', 'Only a verified result whose run ID, task fingerprint, and nonce all match the task Terrarium handed out. Everything else — logs, callbacks, model prose — is a signal, not proof.', 'text'],
        ['Provenance vs. correctness', 'A verified receipt proves the task ran and correlated. It does not prove the answer is right. Terrarium adds an advisory, fail-closed trust grade from cross-model agreement — it can annotate a receipt but never upgrade it.', 'text'],
        ['In the cloud', 'Submit a task, close your laptop, and later pull the receipt, logs, and callback back from Cloudflare — no local machine in the loop.', 'text'],
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
      <div class="hero-inner hero-split">
        <div class="hero-copy">
          <div class="eyebrow">Agent runs you can trust</div>
          <h1>Delegate a task.<br />Get back <em>proof</em> it happened.</h1>
          <p class="sub">Terrarium runs one bounded task as one isolated job and hands back a verified receipt — not a "done" you have to believe. From the CLI, from MCP, or over an API that runs entirely on <b>Cloudflare's edge</b>.</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="/docs?page=tutorial" onclick={(e) => navigate('/docs?page=tutorial', e)}>Get started</a>
            <a class="btn" href="https://github.com/acoyfellow/terrarium">View source</a>
          </div>
          <pre class="hero-code fx-shine"><span class="scan" aria-hidden="true"></span><code>{`# one bounded task -> one isolated run -> one verified receipt
terra --agent "pi -p --no-session" "fix the failing test"

# in the cloud: submit, close your laptop, pull the receipt later
POST https://terrarium.coey.dev/api/runs  ->  202 { runId }`}</code></pre>
        </div>
        <div class="hero-art">
          <img src="/campaign/v6/dome-hero.jpg" alt="A figure facing a glowing sealed terrarium dome" loading="eager" />
          <div class="hero-art-veil" aria-hidden="true"></div>
          <div class="receipt-chip fx-shine">
            <span class="rc-dot"></span>
            <div class="rc-body">
              <span class="rc-status">verified receipt</span>
              <span class="rc-id mono">ter_mrcb3k07_f606b3313eb8</span>
              <span class="rc-meta mono">runId · fingerprint · nonce — all correlate</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="trust">
      <div class="trust-inner">
        <div class="trust-head">
          <span class="trust-label mono">The cloud runs entirely on</span>
          <img class="trust-logo" src="/cloudflare.svg" alt="Cloudflare" width="110" height="50" />
        </div>
        <div class="trust-primitives">
          <span class="tp"><img src="/cf/workers.svg" alt="" aria-hidden="true" /><b class="mono">Workers</b></span>
          <span class="tp"><img src="/cf/durable-objects.svg" alt="" aria-hidden="true" /><b class="mono">Durable Objects</b></span>
          <span class="tp"><img src="/cf/containers.svg" alt="" aria-hidden="true" /><b class="mono">Containers</b></span>
          <span class="tp"><img src="/cf/r2.svg" alt="" aria-hidden="true" /><b class="mono">R2</b></span>
          <span class="tp"><img src="/cf/workers-ai.svg" alt="" aria-hidden="true" /><b class="mono">Workers AI</b></span>
        </div>
      </div>
    </section>

    <section class="chapter">
      <div class="chapter-inner">
        <div class="chapter-head">
          <div><p class="eyebrow">01 / What you get</p><h2 class="section-title">One primitive.<br />Everywhere you work.</h2></div>
          <p class="section-lede">The same bounded-run-with-a-receipt whether you call it from a terminal, an agent, or a cloud endpoint. No new mental model per surface.</p>
        </div>
        <div class="grid-cards">
          <div class="cell fx-shine"><span class="idx">A</span><h3>Use it anywhere</h3><p>CLI, MCP tool, or an authenticated cloud API. Same primitive everywhere.</p></div>
          <div class="cell fx-shine"><span class="idx">B</span><h3>Trust the result</h3><p>Success means a verified receipt — run ID, fingerprint, and nonce all match. Not exit codes, not prose.</p></div>
          <div class="cell fx-shine"><span class="idx">C</span><h3>Scale in parallel</h3><p>Fan out bounded jobs with explicit concurrency and durable run IDs. Every run keeps its own receipt.</p></div>
        </div>
      </div>
    </section>

    <section class="chapter">
      <div class="chapter-inner">
        <div class="chapter-head">
          <div><p class="eyebrow">02 / How it works</p><h2 class="section-title">Task in.<br />Receipt out.</h2></div>
          <p class="section-lede">Four steps, one direction. You hand off a bounded job and get back correlated proof it ran — even if you disconnect in the middle.</p>
        </div>
        <ol class="flow">
          <li class="fx-shine"><span class="step">01</span><b>Task</b><span>Hand Terrarium one bounded job.</span></li>
          <li class="fx-shine"><span class="step">02</span><b>Run</b><span>It executes as one isolated child — local or a Cloudflare cell.</span></li>
          <li class="fx-shine"><span class="step">03</span><b>Receipt</b><span>You get a correlated, verifiable result back.</span></li>
          <li class="fx-shine"><span class="step">04</span><b>Wake</b><span>A durable callback tells you it finished, even after you disconnect.</span></li>
        </ol>
      </div>
    </section>

    <section class="chapter edge">
      <div class="chapter-inner">
        <div class="chapter-head">
          <div><p class="eyebrow">03 / Runs on the edge</p><h2 class="section-title">No origin server.<br />No local machine.</h2></div>
          <p class="section-lede">Submit a task, close your laptop. Admission, the run-control cell, execution, logs, the model route, and the wake callback all live on <b>Cloudflare's global network</b> — so correctness, liveness, logs, and delivery never depend on a machine you own.</p>
        </div>
        <ol class="edge-flow">
          <li><span class="ef-k mono">Worker API</span><span class="ef-v">Authenticated <code>POST /api/runs</code>, ordered admission, per-principal budget.</span></li>
          <li><span class="ef-k mono">Durable Object</span><span class="ef-v">One run-control cell per run holds authoritative state — survives restarts and reconnects.</span></li>
          <li><span class="ef-k mono">Container cell</span><span class="ef-v">The task runs in an isolated Cloudflare-managed execution cell. Egress is deny-by-default.</span></li>
          <li><span class="ef-k mono">Workers AI</span><span class="ef-v">A credentialless, server-owned model route — the cell never holds a reusable key.</span></li>
          <li><span class="ef-k mono">R2 logs</span><span class="ef-v">Durable, integrity-checked logs (byte count + SHA-256), inline then overflow to R2.</span></li>
          <li><span class="ef-k mono">Pulse wake</span><span class="ef-v">A durable, principal-scoped terminal callback reaches you across closes, sessions, and machines.</span></li>
        </ol>
      </div>
    </section>

    <section class="closing">
      <div class="closing-inner">
        <p>Built on one idea: <strong>a verified receipt, not a promise.</strong></p>
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
