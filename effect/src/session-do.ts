import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createCodingTools } from "@earendil-works/pi-durable/tools";

import { containerEnv } from "./container-env.ts";
import type { BoxCalls } from "./container-env.ts";
import { sessionView } from "./session-view.ts";
import type { SessionTurn } from "./session-view.ts";
import { WORKERS_AI_MODEL, WORKERS_AI_PROVIDER, workersAiProvider } from "./workers-ai-provider.ts";

const INSTRUCTIONS = "You are a Terrarium worker. Your files are in /workspace inside a sealed box with no internet. Use read, write, edit and bash. Keep answers short. Earlier turns of this conversation are real and their files may still exist; check before assuming.";

const BOX_KEY = "terrarium-session-box";

export interface SteerResult {
  readonly steered: boolean;
  readonly reason: string;
}

interface LiveTurn {
  readonly submit: (text: string) => Promise<void>;
}

export class SessionDO extends DurableObject<Env> {
  private live: LiveTurn | null = null;

  async steer(text: string): Promise<SteerResult> {
    const live = this.live;

    if (live === null) return { steered: false, reason: "no turn is running" };

    await live.submit(text);

    return { steered: true, reason: "queued as a steering message for the running turn" };
  }

  private boxCalls(boxName: string): BoxCalls {
    const box = getSandbox(this.env.TERRARIUM_SANDBOX, boxName);

    return {
      exec: (command, options) => box.exec(command, { cwd: options.cwd, timeout: options.timeout, env: options.env }),
      readBase64: (path) => box.readFile(path, { encoding: "base64" }).then((file: { readonly success: boolean; readonly content: string }) => (file.success ? file.content : null), () => null),
      writeText: (path, content) => box.writeFile(path, content).then(() => undefined),
    };
  }

  async currentBox(): Promise<string> {
    const stored = await this.ctx.storage.get<string>(BOX_KEY);

    if (stored !== undefined) return stored;

    const fresh = `ses-${this.ctx.id.toString().slice(0, 20)}-${Date.now().toString(36)}`;

    await this.ctx.storage.put(BOX_KEY, fresh);

    return fresh;
  }

  async replaceBox(): Promise<{ readonly old: string; readonly fresh: string }> {
    const old = await this.currentBox();

    await getSandbox(this.env.TERRARIUM_SANDBOX, old).destroy().catch(() => undefined);
    await this.ctx.storage.delete(BOX_KEY);

    return { old, fresh: await this.currentBox() };
  }

  async turn(text: string): Promise<SessionTurn> {
    const boxName = await this.currentBox();
    const models = createModels();

    models.setProvider(workersAiProvider(this.env.AI));

    const registry = createRegistry();

    registry.install(createCodingTools());

    const env = containerEnv(this.boxCalls(boxName));
    const harness = await Harness.open(await openDurableObjectSqliteStorage(this.ctx.storage), { models, registry, env: () => env }, BACKGROUND_CONTEXT);
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: WORKERS_AI_PROVIDER, modelId: WORKERS_AI_MODEL }, instructions: INSTRUCTIONS, cwd: "/workspace" } });

    harness.resume();

    this.live = { submit: (steerText) => conversation.submit({ type: "input", content: steerText, whenBusy: "steer" }, BACKGROUND_CONTEXT).then(() => undefined) };

    const before = (await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT)).items.flatMap((entry) => entry.model ?? []).length;
    const submission = await conversation.submit({ type: "input", content: text }, BACKGROUND_CONTEXT);

    await submission.wait(BACKGROUND_CONTEXT);
    await conversation.waitForIdle(BACKGROUND_CONTEXT).finally(() => {
      this.live = null;
    });

    const page = await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);

    await harness.close(BACKGROUND_CONTEXT);

    return sessionView(page.items.flatMap((entry) => entry.model ?? []).reverse(), before, boxName);
  }
}
