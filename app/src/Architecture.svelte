<script>
  const parts = [
    ['Cloudflare Access', 'Signs you in with your company login. The Worker checks the signed token on every request and uses your email as the owner of everything you start.'],
    ['Worker', 'The front door. It serves this site and the API, checks who you are, and hands work to a Workflow. It holds no state of its own.'],
    ['Workflows', 'Every run and every loop is one Workflow instance. Its steps, sleeps, retries and history are kept by Cloudflare, so a crash resumes where it stopped and the history is the record.'],
    ['Durable Object (one per person)', 'The small amount of state that must be exact: which idempotency key made which run, how many runs you have live, your run list, and your completion inbox.'],
    ['Container', 'Where the agent actually runs. It gets only the task text and a one-time code. It has no internet except one route to the model.'],
    ['Workers AI', 'The model. The Worker adds the credential on the way out, so the container never holds a key.'],
    ['KV', 'The loop index the Loops page reads. Plain storage, nothing clever.'],
  ];
  const steps = [
    'You ask your agent to start a run. It calls the API with your Access login.',
    'The Worker checks the login, reserves a slot in your Durable Object and starts a Workflow.',
    'The Workflow starts a container with the task and a one-time code (the nonce).',
    'The agent in the container calls the model through the Worker, which adds the credential.',
    'The agent prints its answer and a receipt line containing the nonce.',
    'The Workflow checks the receipt: exactly one line, the right nonce, this run. Only then does the run have provenance this-run. If you gave a proof, Terrarium runs it in the box, and done needs exit 0.',
    'The result is recorded once in your Durable Object. The Pi extension sees the run finish and puts the result into your session.',
  ];
</script>

<section class="docs-shell arch">
  <div class="eyebrow">How it's built</div>
  <h1>Built from Cloudflare parts</h1>
  <p class="lead">Terrarium is a thin layer over Cloudflare. Each job goes to the Cloudflare product built for it, so there is very little of our own code to trust.</p>

  <figure class="arch-figure arch-wide">
    <svg viewBox="0 0 640 470" role="img" aria-labelledby="arch-title arch-desc" class="arch-svg">
      <title id="arch-title">Terrarium architecture</title>
      <desc id="arch-desc">Your agent calls a Worker behind Cloudflare Access. The Worker starts a Workflow per run or loop and keeps exact state in one Durable Object per person. The Workflow runs the agent in a container whose only network route is to Workers AI through the Worker. Results go back to your inbox.</desc>
      <defs>
        <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" class="arch-head" />
        </marker>
      </defs>

      <g class="arch-node">
        <rect x="20" y="20" width="150" height="56" rx="10" />
        <text x="95" y="44">Your agent</text>
        <text x="95" y="62" class="arch-sub">Pi, any MCP client</text>
      </g>

      <rect x="200" y="12" width="420" height="300" rx="14" class="arch-zone" />
      <text x="214" y="32" class="arch-zone-label">Cloudflare · behind Access</text>

      <g class="arch-node arch-key">
        <rect x="230" y="48" width="160" height="56" rx="10" />
        <text x="310" y="72">Worker</text>
        <text x="310" y="90" class="arch-sub">site · API · identity</text>
      </g>

      <g class="arch-node">
        <rect x="430" y="48" width="170" height="56" rx="10" />
        <text x="515" y="72">Durable Object</text>
        <text x="515" y="90" class="arch-sub">one per person</text>
      </g>

      <g class="arch-node arch-key">
        <rect x="230" y="150" width="160" height="56" rx="10" />
        <text x="310" y="174">Workflow</text>
        <text x="310" y="192" class="arch-sub">one per run or loop</text>
      </g>

      <g class="arch-node">
        <rect x="430" y="150" width="170" height="56" rx="10" />
        <text x="515" y="174">KV</text>
        <text x="515" y="192" class="arch-sub">loop index</text>
      </g>

      <g class="arch-node arch-cell">
        <rect x="230" y="240" width="160" height="56" rx="10" />
        <text x="310" y="264">Container</text>
        <text x="310" y="282" class="arch-sub">no internet</text>
      </g>

      <g class="arch-node">
        <rect x="430" y="240" width="170" height="56" rx="10" />
        <text x="515" y="264">Workers AI</text>
        <text x="515" y="282" class="arch-sub">key added on the way</text>
      </g>

      <path d="M170,48 L228,72" class="arch-line" marker-end="url(#arch-arrow)" />
      <text x="174" y="102" class="arch-edge">1 start</text>
      <path d="M390,76 L428,76" class="arch-line" marker-end="url(#arch-arrow)" />
      <path d="M310,104 L310,148" class="arch-line" marker-end="url(#arch-arrow)" />
      <text x="318" y="132" class="arch-edge arch-left">2</text>
      <path d="M390,178 L428,178" class="arch-line arch-dash" marker-end="url(#arch-arrow)" />
      <path d="M310,206 L310,238" class="arch-line" marker-end="url(#arch-arrow)" />
      <text x="318" y="228" class="arch-edge arch-left">3</text>
      <path d="M390,268 L428,268" class="arch-line" marker-end="url(#arch-arrow)" />
      <text x="409" y="260" class="arch-edge">4</text>
      <path d="M230,280 C150,300 130,200 95,78" class="arch-line arch-return" marker-end="url(#arch-arrow)" />
      <text x="106" y="210" class="arch-edge">7 result</text>

      <g class="arch-legend">
        <rect x="20" y="340" width="600" height="110" rx="12" class="arch-zone" />
        <text x="40" y="368" class="arch-legend-title">What gives a run provenance</text>
        <text x="40" y="392" class="arch-legend-line">5 · the agent prints one receipt line with the one-time code it was given</text>
        <text x="40" y="414" class="arch-legend-line">6 · the Workflow checks: exactly one line · right code · this run</text>
        <text x="40" y="436" class="arch-legend-line">this-run = it came from this run · a proof checks the work</text>
      </g>
    </svg>
  </figure>

  <figure class="arch-figure arch-mobile">
    <svg viewBox="0 0 340 760" role="img" aria-labelledby="arch-m-title" class="arch-svg">
      <title id="arch-m-title">Terrarium architecture, top to bottom</title>
      <defs>
        <marker id="arch-arrow-m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" class="arch-head" />
        </marker>
      </defs>
      <g class="arch-node"><rect x="70" y="16" width="200" height="60" rx="10" /><text x="170" y="40">Your agent</text><text x="170" y="60" class="arch-sub">Pi, any MCP client</text></g>
      <path d="M170,76 L170,122" class="arch-line" marker-end="url(#arch-arrow-m)" /><text x="180" y="100" class="arch-edge">1 start</text>
      <rect x="12" y="110" width="316" height="476" rx="14" class="arch-zone" />
      <text x="26" y="132" class="arch-zone-label">Cloudflare · behind Access</text>
      <g class="arch-node arch-key"><rect x="70" y="146" width="200" height="60" rx="10" /><text x="170" y="170">Worker</text><text x="170" y="190" class="arch-sub">site · API · identity</text></g>
      <path d="M170,206 L170,240" class="arch-line" marker-end="url(#arch-arrow-m)" /><text x="180" y="224" class="arch-edge">2</text>
      <g class="arch-node"><rect x="70" y="242" width="200" height="52" rx="10" /><text x="170" y="262">Durable Object</text><text x="170" y="280" class="arch-sub">one per person</text></g>
      <path d="M170,294 L170,326" class="arch-line" marker-end="url(#arch-arrow-m)" />
      <g class="arch-node arch-key"><rect x="70" y="328" width="200" height="60" rx="10" /><text x="170" y="352">Workflow</text><text x="170" y="372" class="arch-sub">one per run or loop</text></g>
      <path d="M170,388 L170,420" class="arch-line" marker-end="url(#arch-arrow-m)" /><text x="180" y="404" class="arch-edge">3</text>
      <g class="arch-node arch-cell"><rect x="70" y="422" width="200" height="60" rx="10" /><text x="170" y="446">Container</text><text x="170" y="466" class="arch-sub">no internet</text></g>
      <path d="M170,482 L170,512" class="arch-line" marker-end="url(#arch-arrow-m)" /><text x="180" y="497" class="arch-edge">4</text>
      <g class="arch-node"><rect x="70" y="514" width="200" height="56" rx="10" /><text x="170" y="536">Workers AI</text><text x="170" y="555" class="arch-sub">key added on the way</text></g>
      <rect x="12" y="604" width="316" height="140" rx="12" class="arch-zone" />
      <text x="26" y="630" class="arch-legend-title">What gives a run provenance</text>
      <text x="26" y="658" class="arch-legend-line">5 · one receipt line with the</text>
      <text x="26" y="678" class="arch-legend-line">    one-time code it was given</text>
      <text x="26" y="702" class="arch-legend-line">6 · right code · this run · once</text>
      <text x="26" y="726" class="arch-legend-line">7 · result lands in your session</text>
    </svg>
  </figure>

  <h2>What happens when you start a run</h2>
  <ol class="arch-steps">
    {#each steps as step, index}<li><span class="arch-step-n">{index + 1}</span>{step}</li>{/each}
  </ol>

  <h2>The parts</h2>
  <dl class="arch-parts">
    {#each parts as [name, body]}<div><dt>{name}</dt><dd>{body}</dd></div>{/each}
  </dl>

  <h2>Loops</h2>
  <p>A loop is one more Workflow. It starts a run, waits for it, checks the answer against the exact text in your plan, then stops or tries again. Plain code makes every decision, so the same results always lead to the same decisions. The <a href="/loops">Loops</a> page only reads what the Workflow recorded.</p>

  <h2>Built with Effect 4</h2>
  <p>The service is about 900 lines of Effect 4 TypeScript. Every failure is a typed value, async code exists only where Workers requires it, and lint runs with strict anti-slop rules. 87 tests run in about a second, and mutation testing checks that they catch deliberate bugs.</p>

  <h2>What provenance proves, and what the proof adds</h2>
  <p>Provenance this-run means the right run answered. It does not mean the answer is true. Pi has tools in the box now, but a made-up answer still has provenance this-run. A proof catches it: Terrarium runs your command in the box after the agent finishes, and the run is done only if it exits 0. A proof only checks what it tests.</p>

  <h2>How long a run takes</h2>
  <p>A one-word task takes about 7 seconds end to end: about 1.5 s to start the container and 3 s for Pi and the model. A container kept warm answered in 1.4 s instead of 5.4 s, so a small warm pool is the next speed-up.</p>

  <h2>What we deliberately did not build</h2>
  <ul>
    <li>No job queue, scheduler or retry logic of our own. Workflows does that.</li>
    <li>No login system. Cloudflare Access does that.</li>
    <li>No model keys in the container. The Worker adds them on the way out.</li>
  </ul>
</section>
