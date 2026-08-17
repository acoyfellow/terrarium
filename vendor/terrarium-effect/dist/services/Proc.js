import { spawn } from "node:child_process";
import { Context, Effect, Layer } from "effect";
import { SpawnFailed, Timeout } from "../domain/errors.js";
export const Proc = Context.Service("Proc");
const describeProcess = (command, args) => [command, ...args].join(" ");
const sameArguments = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const isProcError = (result) => result instanceof SpawnFailed || result instanceof Timeout;
const waitForClose = (child) => child.exitCode !== null || child.signalCode !== null
    ? Effect.void
    : Effect.callback((resume) => {
        const onClose = () => {
            resume(Effect.void);
        };
        child.once("close", onClose);
        return Effect.sync(() => {
            child.off("close", onClose);
        });
    });
const stopProcess = (child) => Effect.sync(() => {
    if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
    }
}).pipe(Effect.andThen(waitForClose(child)));
const startProcess = (command, args, options) => Effect.callback((resume) => {
    const child = spawn(command, args, options.cwd === undefined ? {} : { cwd: options.cwd });
    const stdout = [];
    const stderr = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
        stderr.push(String(chunk));
    });
    const onStartError = (error) => {
        resume(Effect.fail(new SpawnFailed({ task: describeProcess(command, args), reason: error.message })));
    };
    const onSpawn = () => {
        child.off("error", onStartError);
        resume(Effect.succeed({ child, stdout, stderr }));
    };
    child.once("error", onStartError);
    child.once("spawn", onSpawn);
    return stopProcess(child);
});
const awaitCompletion = (process, command, args) => Effect.callback((resume) => {
    const onError = (error) => {
        resume(Effect.fail(new SpawnFailed({ task: describeProcess(command, args), reason: error.message })));
    };
    const onClose = (exitCode) => {
        resume(Effect.succeed({
            exitCode: exitCode ?? 1,
            stdout: process.stdout.join(""),
            stderr: process.stderr.join("")
        }));
    };
    process.child.once("error", onError);
    process.child.once("close", onClose);
    return Effect.sync(() => {
        process.child.off("error", onError);
        process.child.off("close", onClose);
    });
});
const captureLive = (command, args, options) => {
    const running = Effect.scoped(Effect.flatMap(Effect.acquireRelease(startProcess(command, args, options), (process) => stopProcess(process.child)), (process) => awaitCompletion(process, command, args)));
    const timeoutMs = options.timeoutMs;
    return timeoutMs === undefined
        ? running
        : Effect.timeoutOrElse(running, {
            duration: timeoutMs,
            orElse: () => Effect.fail(new Timeout({
                runId: describeProcess(command, args),
                timeoutMs
            }))
        });
};
export const ProcLive = Layer.succeed(Proc, { capture: captureLive });
export const ProcTest = (scripts) => Layer.succeed(Proc, {
    capture: (command, args) => {
        const script = scripts.find((candidate) => candidate.command === command && sameArguments(candidate.args, args));
        if (script === undefined) {
            return Effect.fail(new SpawnFailed({
                task: describeProcess(command, args),
                reason: "No scripted process result"
            }));
        }
        return isProcError(script.result)
            ? Effect.fail(script.result)
            : Effect.succeed(script.result);
    }
});
