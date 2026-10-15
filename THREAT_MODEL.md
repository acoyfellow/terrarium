# Threat model

## What runs where

| Piece | Trust |
|---|---|
| Your laptop: Pi, the MCP client, the extension | Trusted. Holds your Access session. |
| The Worker and your Durable Object | Trusted. Holds the model binding and your run records. |
| The container: Pi agent with read, write, edit, bash | Untrusted. Treat everything it writes as a claim. |
| The model | Untrusted output. |

## What the box can and can't do

| Can | Can't |
|---|---|
| Read and write files in its own `/workspace` | Reach any host except the model route (403, checked live) |
| Run commands with bash | See any secret; none are passed in (checked live) |
| Call the model through the Worker | See your laptop, your repo, or other runs |
| Print anything, including a fake receipt | Change the one-time code it was given, or the proof command |

The container has `enableInternet = false` and `interceptHttps = true`. Every request goes to the Worker's `outbound` handler, which answers only a POST to the model path and sends everything else a 403. `GET /api/egress-probe` starts a fresh box, runs a fixed list of requests and records the codes. The gate fails if `effect/receipts/egress.json` is missing, failing, or more than 7 days old.

Two exceptions, both decided by the Worker, never by the box:

- **Repo checkout.** When a run asks for `repo: {github}`, the Worker downloads the GitHub archive and writes it into the box. The box itself still can't reach GitHub (checked live: `git ls-remote` gets 403).
- **Setup window.** When a run asks for `repo.setup` and no warm base exists, the box may make HTTPS `GET`/`HEAD` requests to `registry.npmjs.org` while the setup command runs, and only then. The window is a flag in the box's own Durable Object, set before setup and cleared after, even on failure. During the agent's turn the registry gets a 403 again (checked live). A malicious package's install script could run during setup; pass `--ignore-scripts` if that matters.

Isolation between containers is provided by Cloudflare Containers. Terrarium doesn't claim more than that.

## What a result proves

- **Provenance (`this-run`):** the receipt carries this run's one-time code, which only this box was given. It shows which run answered. It doesn't show the answer is right.
- **Proof:** Terrarium itself runs the proof command in the box after the agent exits and records the exit code. The agent can't change the command. It can write files that the proof reads, which is the point; a proof is only as strong as what it tests.
- **Logs and summaries:** claims. They never set the status.

## Known gaps

- A proof that tests too little lets a bad result through. Write proofs that would fail on the wrong answer.
- The agent has bash inside the box. A container escape would be a Cloudflare Containers issue; we have not tested for one.
- Access tokens on the laptop are as safe as the laptop.
- A warm base is keyed by owner, repo, ref and setup command. It is not keyed by the dependency versions the registry served that day; a base can be up to 7 days stale.
- Loops run on the owner's identity. Anyone with your Access session can start runs as you.

## Reporting

Open an issue without exploit details and ask for a private contact.
