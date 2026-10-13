<script>
  const layers = [
    { job: 'Durable steps, retries, history', ours: 'Cloudflare Workflows', theirs: 'Temporal, Inngest, Trigger.dev, Hatchet' },
    { job: 'Exact counters, idempotency, limits', ours: 'One Durable Object (SQLite) per person', theirs: 'Postgres or Redis behind your queue' },
    { job: 'Sandbox for agent code', ours: 'Cloudflare Containers, no internet', theirs: 'E2B, Modal, Daytona, Fly Machines' },
    { job: 'Model access', ours: 'Workers AI, called by the Worker so the box holds no key', theirs: 'An API key inside the sandbox, or your own proxy' },
    { job: 'Sign-in', ours: 'Cloudflare Access (your company login)', theirs: 'API keys you issue and rotate' },
  ];

  const options = [
    {
      name: 'Promise.all on your laptop',
      pick: 'You are at your desk and the tasks are small.',
      honest: 'It is faster. On our 8-task bench the laptop scored 22/24 in 9 s; the cloud scored 18/24 in 543 s.',
      lacks: 'It stops when the laptop sleeps, and the agents run with your files, keys and network.',
    },
    {
      name: 'Temporal or Inngest + E2B',
      pick: 'You are not on Cloudflare, or you need microVM isolation documented by your sandbox vendor today.',
      honest: 'Both are mature and scale further than this. If you already run them, keep them.',
      lacks: 'You assemble the agent part yourself: the MCP tools, results delivered back into the agent session, and a loop the agent cannot declare finished.',
    },
    {
      name: 'LangGraph, CrewAI, AutoGen',
      pick: 'You are writing an agent application in code.',
      honest: 'They have richer fan-out and state graphs than Terrarium.',
      lacks: 'They orchestrate inside your process. They do not give each step a sealed box or a proof the agent cannot skip.',
    },
    {
      name: 'Terrarium',
      pick: 'You use Pi or another MCP client, you are on Cloudflare, and you want work to leave your laptop and come back checked.',
      honest: 'It is small: one Worker, about 1,000 lines. It runs one model today, and loops are capped at 5 attempts.',
      lacks: 'No microVM claim of our own, no multi-cloud, and only a few users so far.',
    },
  ];
</script>

<section class="tl cmp">
  <header class="tl-hero">
    <div class="eyebrow">Compare</div>
    <h1>When to use something else</h1>
    <p class="lead">Terrarium is a thin layer over Cloudflare products. If those products are not a fit, the tools below are good choices. This page says when.</p>
  </header>

  <h2>What each layer is built on</h2>
  <div class="cmp-table-wrap">
    <table class="tl-table cmp-table">
      <thead><tr><th>Job</th><th>Terrarium uses</th><th>Common alternatives</th></tr></thead>
      <tbody>
        {#each layers as row}
          <tr><td>{row.job}</td><td><b>{row.ours}</b></td><td>{row.theirs}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="cmp-note">Terrarium doesn't reimplement any of these. The code that is ours connects the pieces: run admission, the receipt check, the proof step, the MCP tools and the Pi extension that delivers results.</p>

  <h2>Pick by situation</h2>
  <div class="cmp-grid">
    {#each options as option}
      <article class="cmp-card" class:cmp-ours={option.name === 'Terrarium'}>
        <h3>{option.name}</h3>
        <dl>
          <dt>Pick it when</dt><dd>{option.pick}</dd>
          <dt>Honestly</dt><dd>{option.honest}</dd>
          <dt>What it doesn't do</dt><dd>{option.lacks}</dd>
        </dl>
      </article>
    {/each}
  </div>

  <h2>What a Terrarium run proves</h2>
  <ul class="cmp-list">
    <li><b>Provenance:</b> the answer came from this run. A one-time code is checked server-side. It doesn't say the answer is right.</li>
    <li><b>Proof:</b> if you give a <code>proof</code> command, Terrarium runs it in the box after the agent finishes. <code>done</code> needs exit 0. That is the part that checks the work.</li>
    <li><b>Sealed box:</b> outside sites get 403 from inside the box, the model route gets 200, and no secrets are present. A live check proves this, and the gate fails if the receipt is missing or more than 7 days old.</li>
  </ul>
</section>
