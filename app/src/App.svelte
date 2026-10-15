<script>
  import Loops from './Loops.svelte';
  import Threads from './Threads.svelte';
  const PUBLIC_SITE = import.meta.env.VITE_PUBLIC_SITE === '1';
  import Architecture from './Architecture.svelte';
  import Terraloop from './Terraloop.svelte';
  import Explainer from './Explainer.svelte';
  import Compare from './Compare.svelte';
  const docs = [
    {"id": "tutorial", "label": "Tutorial", "kind": "Learn", "title": "Run your first task", "lead": "About two minutes. Sign in with your Cloudflare login and run one task in the cloud.", "blocks": [["1. Install and sign in", "brew install cloudflared\ngit clone https://github.com/acoyfellow/terrarium ~/terrarium\ncd ~/terrarium/effect && npm ci && cd .. && npm install -g .\nterra login https://terrarium.<your-team-domain>", "code"], ["2. Reload Pi", "terra login added the Terrarium tools and the callback extension to Pi.", "text"], ["3. Run a task", "Ask your agent: Use terrarium_spawn to run \"What is 17 multiplied by 23? Reply with just the number.\"", "text"], ["What you get back", "{ \"runId\": \"ter_…\", \"status\": \"done\", \"provenance\": \"this-run\", \"summary\": \"391\" }", "code"], ["4. Run one in the background", "Ask for background: true and keep working. When the run finishes, a \"Terrarium run … finished\" message shows up in your session.", "text"], ["5. Start a loop", "Ask your agent: Use terrarium_loop_start with goal \"multiply\", task \"What is 17 times 23?\", expect \"391\". Watch it on the Loops page.", "text"]]},
    {"id": "team", "label": "Your team", "kind": "Join", "title": "Use your team's Terrarium", "lead": "Your team already runs Terrarium. Sign in with your Cloudflare login and you are set up in about two minutes. Your runs are visible only to you.", "blocks": [["You need", "Node 22 or newer, Pi, and the Terrarium URL from your team. You can paste this page into your coding agent and tell it to follow along.", "text"], ["1. Install and sign in", "brew install cloudflared\ngit clone https://github.com/acoyfellow/terrarium ~/terrarium\ncd ~/terrarium/effect && npm ci && cd .. && npm install -g .\nterra login https://terrarium.<your-team-domain>", "code"], ["What terra login does", "It opens your browser. Sign in and approve. It prints who you are, adds the Terrarium tools to ~/.pi/agent/mcp.json, and links the callback extension. You do not copy any tokens.", "text"], ["2. Reload Pi", "That is the whole setup.", "text"], ["Good to know", [["Question", "Answer"], ["Who sees my runs?", "Only you. Runs, logs and loops belong to your email."], ["How long does my login last?", "About a day. When tools say unauthorized, run terra login again."], ["Can a run see my files or the internet?", "No. It knows only what you put in the task text, and its only route is to the model."], ["Does provenance mean correct?", "No. It means the answer came from your task. Give a proof to check the work. Check answers that matter."], ["Who am I signed in as?", "Run terra whoami."]], "table"], ["If something is off", [["You see", "Fix"], ["unauthorized or HTTP 401", "Run terra login again."], ["The login page never opens", "Copy the URL cloudflared printed into your browser."], ["No finished message for a background run", "Reload Pi, then check terrarium_status for the run."], ["terra: command not found", "Rerun npm install -g . in ~/terrarium."]], "table"]]},
    {"id": "howto", "label": "How-to", "kind": "Do", "title": "Get a specific job done", "lead": "Call the API directly, cancel work, or deploy your own instance.", "blocks": [["Start a run over HTTP", "TOKEN=$(cloudflared access token -app=$TERRARIUM_URL)\ncurl -X POST $TERRARIUM_URL/api/runs \\\n  -H \"cf-access-token: $TOKEN\" \\\n  -H \"idempotency-key: $(uuidgen)\" \\\n  -H \"content-type: application/json\" \\\n  -d '{\"task\":\"Reply with: hello\"}'", "code"], ["Check it", "curl -H \"cf-access-token: $TOKEN\" $TERRARIUM_URL/api/runs/<runId>/status", "code"], ["Cancel a run", "curl -X POST -H \"cf-access-token: $TOKEN\" $TERRARIUM_URL/api/runs/<runId>/cancel", "code"], ["Deploy your own", "cd effect\ncp wrangler.jsonc wrangler.mine.local.jsonc\nnpx wrangler deploy -c wrangler.mine.local.jsonc", "code"], ["Before you deploy", "In your local copy, set the KV namespace ID, your hostname and the Access vars, and put the hostname behind a Cloudflare Access app. The checked-in wrangler.jsonc has no hostname and no Access settings, so it cannot replace a working deploy by mistake.", "text"]]},
    {"id": "reference", "label": "Reference", "kind": "Look up", "title": "API and tools", "lead": "Every route needs your Access login or a machine token, and only ever shows your own runs.", "blocks": [["API", "POST /api/runs              start a run { task, proof?, channel? } -> { runId, contract }\nGET  /api/runs              your runs (channel, status, limit)\nGET  /api/runs/:id/status   status and receipt\nGET  /api/runs/:id/logs     full output\nPOST /api/runs/:id/cancel   cancel\nPOST /api/loops             start a loop { goal, task, expect?, proof?, maxAttempts? }\nGET  /api/loops             your loops\nGET  /api/whoami            who you are", "code"], ["MCP tools", [["Tool", "What it does"], ["terrarium_spawn", "Run one task, with an optional proof. Waits up to 10 minutes unless background: true."], ["terrarium_status", "Status of one run."], ["terrarium_read", "Logs of one run."], ["terrarium_cancel", "Cancel one run."], ["terrarium_list", "Your runs, newest first."], ["terrarium_loop_start", "Retry a task until the proof exits 0 (if given) and the answer contains expect (if given), up to 5 attempts."], ["terrarium_loop_status", "One loop or all of them."]], "table"], ["Limits", "8 live runs per person · 30 new runs per minute · loops up to 5 attempts", "text"], ["A receipt", "runId · taskFingerprint · nonce · summary. A run has provenance this-run only when all three values match what the server handed out.", "text"]]},
    {"id": "explain", "label": "Explanation", "kind": "Understand", "title": "Why checking results is the bottleneck", "lead": "Running agents in parallel is easy. Knowing which answer came from which task is the hard part.", "blocks": [["The bottleneck", "A \"done\" message, an exit code of 0 or a callback does not prove a task ran. So people run one agent, watch it by hand, and stop there.", "text"], ["What a receipt changes", "Each run carries its own receipt. One run and a thousand runs check the same way: one receipt at a time.", "text"], ["What counts as success", "A run has provenance this-run when its run ID, task fingerprint and one-time code match what Terrarium handed out. The code comes from the server, so a run cannot make up its own success.", "text"], ["Provenance is not correctness", "Provenance proves the right run answered. It does not prove the answer is true. A made-up answer still has provenance this-run. Give a proof command: Terrarium runs it in the box after the agent finishes, and a false claim fails.", "text"], ["Why Cloudflare", "Sign-in, runs, loops, the model and the history all live on Cloudflare. Start a task, close your laptop, and read the result later. See How it works for the parts.", "text"]]},
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

  let path = $state(location.pathname);
  let hash = $state(location.hash);
  let selectedDoc = $state(new URLSearchParams(location.search).get('page') || 'tutorial');

  const route = () => path === '/docs' ? 'docs' : path === '/loops' ? 'loops' : path === '/threads' ? 'threads' : path === '/how-it-works' ? 'arch' : path === '/terraloop' ? 'terraloop' : path === '/compare' ? 'compare' : 'home';

  const currentDoc = () => docs.find((d) => d.id === selectedDoc) || docs[0];

  let menuOpen = $state(false);

  function navigate(to, event) {
    menuOpen = false;
    if (event) event.preventDefault();
    history.pushState(null, '', to);
    path = location.pathname; hash = location.hash;
    selectedDoc = new URLSearchParams(location.search).get('page') || selectedDoc;
    scrollTo(0, 0);
  }

  addEventListener('popstate', () => {
    path = location.pathname; hash = location.hash;
    selectedDoc = new URLSearchParams(location.search).get('page') || 'tutorial';
  });

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
    <button class="menu-toggle" type="button" aria-expanded={menuOpen} aria-controls="topbar-nav" aria-label={menuOpen ? 'Close menu' : 'Open menu'} onclick={() => (menuOpen = !menuOpen)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">{#if menuOpen}<path d="M6 6l12 12M18 6L6 18" />{:else}<path d="M4 7h16M4 12h16M4 17h16" />{/if}</svg>
    </button>
    <nav class="topbar-nav" id="topbar-nav" class:open={menuOpen}>
      <a href="/docs" aria-current={path === '/docs' ? 'page' : undefined} onclick={(e) => navigate('/docs', e)}>Docs</a>
      <a href="/how-it-works" aria-current={path === '/how-it-works' ? 'page' : undefined} onclick={(e) => navigate('/how-it-works', e)}>How it works</a>
      <a href="/terraloop" aria-current={path === '/terraloop' ? 'page' : undefined} onclick={(e) => navigate('/terraloop', e)}>Terraloop</a>
      <a href="/compare" aria-current={path === '/compare' ? 'page' : undefined} onclick={(e) => navigate('/compare', e)}>Compare</a>
      <a href="/loops" aria-current={path === '/loops' ? 'page' : undefined} onclick={(e) => navigate('/loops', e)}>Loops</a>
      {#if !PUBLIC_SITE}<a href="/threads" aria-current={path === '/threads' ? 'page' : undefined} onclick={(e) => navigate('/threads', e)}>Threads</a>{/if}
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
        <div class="hero-explainer"><Explainer /></div>
      </div>
    </section>

    <section class="chapter">
      <div class="chapter-inner">
        <div class="chapter-head" data-reveal>
          <div><h2 class="section-title">What you can check</h2></div>
          <p class="section-lede">Every run hands back a run ID, a fingerprint of the task, and a one-time number the server picked. The agent has to echo all three back. If one is missing or wrong, the run isn't done, however confident the agent sounds.</p>
        </div>
        <div class="grid-cards" data-reveal>
          <div class="cell" style="--d:0"><h3>Did it finish?</h3><p><code>status: done</code>: a receipt from this run, and proof exit 0 if you gave one. Nothing else counts.</p></div>
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

  {:else if route() === 'loops'}
    <Loops />
  {:else if route() === 'threads'}
    <Threads />
  {:else if route() === 'arch'}
    <Architecture />
  {:else if route() === 'terraloop'}
    <Terraloop />
  {:else if route() === 'compare'}
    <Compare />
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

  {/if}

  <footer class="foot">
    <span>Terrarium</span>
    <a href="https://github.com/acoyfellow/terrarium">GitHub</a>
    <a href="/docs" onclick={(e) => navigate('/docs', e)}>Docs</a>
  </footer>
</div>
