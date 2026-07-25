# Terrarium production sandbox image.
#
# Digest-pinned base is the upstream cloudflare/sandbox OpenCode variant. The
# digest was proven by parent manifest inspection — do not rewrite it without
# re-verifying via `docker manifest inspect`.
#
# The `-opencode` tag ships OpenCode 1.17.13. On top of that we drop in a
# bounded, single-purpose shell runner that reads /workspace/terrarium-
# task.txt and /workspace/terrarium-contract.json as data (never as shell
# programs) and invokes the OpenCode agent using its parent-verified 1.17.13
# CLI: `opencode run "<fixed message>" --pure --file <task> --file
# <contract> --model <provider/model> [--agent <name>]`. Task text is delivered
# ONLY as file attachments. The runner enforces exactly one column-zero
# TERRARIUM_RESULT= line and never synthesizes a receipt.
#
# Fixed runner argv (see src/cloud/sandbox-backend.js DEFAULT_RUNNER_COMMAND):
#   /bin/sh /usr/local/bin/terrarium-runner
#
# Required runtime env (set by RunControlDO / image, never by the task):
#   TERRARIUM_MODEL   provider/model spec passed to `opencode run --model`
#   TERRARIUM_AGENT   optional agent name passed to `opencode run --agent`
FROM docker.io/cloudflare/sandbox:0.12.3-opencode@sha256:dee4b066dd928bd17ef15d0fe9e348419164625d09a0c51819da20293a04c4d9

# The runner is a plain shell script — task text stays data and is passed to
# the agent via file paths, not shell interpolation.
COPY scripts/terrarium-runner /usr/local/bin/terrarium-runner
COPY scripts/terrarium-runner.config.json /etc/terrarium/runner.config.json
COPY scripts/opencode.terrarium.json /etc/terrarium/opencode.json
# OpenCode always ensures its exact-version plugin SDK in the working
# directory before a run. Bake the lockfile-pinned package so deny-by-default
# runtime egress never needs registry.npmjs.org.
COPY scripts/opencode-runtime/package.json /workspace/package.json
COPY scripts/opencode-runtime/package-lock.json /workspace/package-lock.json
RUN cd /workspace \
    && npm ci --omit=dev --ignore-scripts \
    && chmod +x /usr/local/bin/terrarium-runner \
    && chmod 1777 /workspace

WORKDIR /workspace
