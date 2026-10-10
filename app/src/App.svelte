<script>
  // Docs shaped by purpose: Tutorial (learning), How-to (tasks), Reference (facts),
  // Explanation (understanding). Kept short and plain on purpose.
  const docs = [
    {
      id: 'tutorial', label: 'Tutorial', kind: 'Learn',
      title: 'Run your first task',
      lead: 'About two minutes. Sign in with your Cloudflare login and run one task in the cloud.',
      blocks: [
        ['If your team runs Terrarium', 'Follow the Your team page instead: install, terra login, reload Pi. About two minutes.', 'text'],
        ['Otherwise, try it on your laptop', 'No cloud needed. These steps run a task locally with an agent you already have.', 'text'],
        ['Where does this run? Locally.', 'This tutorial is the local CLI. terra runs on YOUR machine — it spawns a coding agent you already have (Pi, OpenCode…) as a child process, in your filesystem, with your network and API keys. Nothing is sent to any cloud. "Running on the edge" is a separate, optional service you deploy yourself (step 5); the CLI never phones home.', 'text'],
        ['1. Install from source', 'git clone https://github.com/acoyfellow/terrarium\ncd terrarium && npm install -g .', 'code'],
        ['2. Dry-run one bounded task', 'terra --dry-run "summarize README.md and list any stale claims"', 'code'],
        ['3. Run it for real', 'terra --agent "pi -p --no-session" "summarize README.md"', 'code'],
        ['4. Read the receipt', 'terra status <runId>\nterra read <runId>', 'code'],
        ['What you just got', 'One bounded task ran as one isolated child ON YOUR MACHINE and returned one correlated receipt: the run ID, its status, and a verified result you can trust or reject. The check does not depend on prose or on the cloud.', 'text'],
        ['5. (optional) Run on your own Cloudflare edge instead', 'wrangler deploy   # deploys a Worker to YOUR Cloudflare account, at your own URL', 'code'],
        ['When to use the cloud path', 'Deploy the cloud service when you want to submit a task over HTTP (POST /api/runs), close your laptop, and pull the proof back later. Execution then runs on Cloudflare instead of your machine. It is fully self-hosted: it runs in the Cloudflare account where you deploy the Worker. There is no hosted Terrarium instance; you deploy your own. The CLI uses the instance configured in TERRARIUM_URL.', 'text'],
      ],
    },
    {
      id: 'team', label: 'Your team', kind: 'Join',
      title: "Use your team's Terrarium",
      lead: 'Your team already runs Terrarium. Sign in with your Cloudflare login and you are set up in about two minutes. Your runs are visible only to you.',
      blocks: [
        ['You need', 'Node 22 or newer, Pi, and the Terrarium URL from your team. You can paste this page into your coding agent and tell it to follow along.', 'text'],
        ['1. Install and sign in', 'brew install cloudflared\ngit clone https://github.com/acoyfellow/terrarium ~/terrarium\ncd ~/terrarium && npm ci && npm install -g .\nterra login https://terrarium.<your-team-domain>', 'code'],
        ['What terra login does', 'It opens your browser. Sign in and approve. It prints who you are, adds the Terrarium tools to Pi, and installs the callback extension. You do not copy any tokens.', 'text'],
        ['2. Reload Pi', 'That is the whole setup.', 'text'],
        ['3. Try it', 'Ask your agent: Use terrarium_spawn to run "Reply with exactly: hello". You get back status done and taskContractStatus verified. Add background: true to keep working; the result shows up in your session when it is done.', 'text'],
        ['Good to know', [
          ['Question', 'Answer'],
          ['Who sees my runs?', 'Only you. Runs, logs, receipts and completion events belong to your email.'],
          ['How long does my login last?', 'About a day. When tools say unauthorized, run terra login again.'],
          ['Can a cloud run see my files?', 'No. It knows only what you put in the task text.'],
          ['Does verified mean correct?', 'No. It means the answer came from your task. Check answers that matter.'],
          ['Who am I signed in as?', 'Run terra whoami.'],
        ], 'table'],
        ['If something is off', [
          ['You see', 'Fix'],
          ['unauthorized or HTTP 401', 'Run terra login again.'],
          ['A Cloudflare "nothing here" page', 'Reload Pi.'],
          ['The login page never opens', 'Copy the URL terra login printed into your browser.'],
          ['No completion event for a background run', 'Run terra login again, then reload Pi.'],
          ['terra: command not found', 'Rerun npm install -g . in ~/terrarium.'],
        ], 'table'],
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

  const THEME_KEY = 'terrarium-theme';
  const THEME_ORDER = ['system', 'light', 'dark'];
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  let themeChoice = $state(localStorage.getItem(THEME_KEY) || 'system');
  let systemPrefersDark = $state(systemDark.matches);
  systemDark.addEventListener('change', (event) => { systemPrefersDark = event.matches; });
  const resolvedTheme = () => themeChoice === 'system' ? (systemPrefersDark ? 'dark' : 'light') : themeChoice;
  $effect(() => { document.documentElement.dataset.theme = resolvedTheme(); });
  function cycleTheme() {
    themeChoice = THEME_ORDER[(THEME_ORDER.indexOf(themeChoice) + 1) % THEME_ORDER.length];
    if (themeChoice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, themeChoice);
  }
  const themeLabel = () => `Theme: ${themeChoice}. Click to change.`;

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
      <button class="theme-toggle" type="button" onclick={cycleTheme} aria-label={themeLabel()} title={themeLabel()}>
        {#if themeChoice === 'light'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
        {:else if themeChoice === 'dark'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
        {/if}
      </button>
      <a class="cta" href="/docs?page=tutorial" onclick={(e) => navigate('/docs?page=tutorial', e)}>Get started</a>
    </nav>
  </header>

  {#if route() === 'home'}
    <section class="hero">
      <div class="hero-inner" data-reveal>
        <div class="hero-copy">
          <h1 class="calm">Hand a task to an agent in the cloud.<br />Get the answer back with a receipt.</h1>
          <p class="sub">You ask your coding agent to run something. It runs on Cloudflare, not your laptop. You get the answer plus a run ID that shows exactly which task produced it.</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="/docs?page=team" onclick={(e) => navigate('/docs?page=team', e)}>Try it</a>
            <a class="btn" href="https://github.com/acoyfellow/terrarium">Read the code</a>
          </div>
        </div>
        <pre class="hero-code"><code>{`> Use terrarium_spawn to run
  "Reply with exactly: hello".

{
  "ok": true,
  "runId": "ter_mv2qdrha_9f5a3a434d2a",
  "status": "done",
  "taskContractStatus": "verified"
}`}</code></pre>
        <p class="sub">That's a real run. Ask for <code>background: true</code> and keep working; the result shows up in your session when it's done.</p>
      </div>
    </section>

    <section class="chapter">
      <div class="chapter-inner">
        <div class="chapter-head" data-reveal>
          <div><h2 class="section-title">What you can check</h2></div>
          <p class="section-lede">Every run hands back a run ID, a fingerprint of the task, and a one-time number the server picked. The agent has to echo all three back. If one is missing or wrong, the run isn't done, however confident the agent sounds.</p>
        </div>
        <div class="grid-cards" data-reveal>
          <div class="cell" style="--d:0"><h3>Did it finish?</h3><p><code>status: done</code> and <code>verified</code>. Nothing else counts.</p></div>
          <div class="cell" style="--d:1"><h3>Which task?</h3><p>The run ID and task fingerprint tie the answer to the task you sent.</p></div>
          <div class="cell" style="--d:2"><h3>Whose run?</h3><p>Yours. Runs, logs and results belong to your login and nobody else sees them.</p></div>
        </div>
      </div>
    </section>

    <section class="chapter">
      <div class="chapter-inner">
        <div class="chapter-head" data-reveal>
          <div><h2 class="section-title">What it doesn't do</h2></div>
          <p class="section-lede">Worth knowing before you rely on it.</p>
        </div>
        <div class="grid-cards" data-reveal>
          <div class="cell" style="--d:0"><h3>Check the answer is right</h3><p>"Verified" means the answer came from your task, not that it's correct. Check answers that matter.</p></div>
          <div class="cell" style="--d:1"><h3>See your files</h3><p>A cloud task knows only what you put in the task text.</p></div>
          <div class="cell" style="--d:2"><h3>Sandbox local runs</h3><p>A local run runs as you. For untrusted code, use the opt-in Docker profile.</p></div>
        </div>
      </div>
    </section>

    <section class="closing">
      <div class="closing-inner" data-reveal>
        <p><strong>Setup takes about two minutes:</strong> install, <code>terra login</code>, reload your agent.</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="/docs?page=team" onclick={(e) => navigate('/docs?page=team', e)}>Try it</a>
          <a class="btn" href="https://github.com/acoyfellow/terrarium">Read the code</a>
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
  </footer>
</div>
