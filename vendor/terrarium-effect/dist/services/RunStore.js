import { access, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { ClaimConflict, InvalidBudget, StoreReadFailed, StoreWriteFailed } from "../domain/errors.js";
export const RunStore = Context.Service("RunStore");
const validRunId = /^ter_[A-Za-z0-9_]+$/;
const errorCode = (error) => typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
const errorMessage = (error) => error instanceof Error ? error.message : String(error);
const readFailure = (operation, path, error) => new StoreReadFailed({
    operation,
    path,
    reason: errorMessage(error),
    code: errorCode(error)
});
const writeFailure = (operation, path, error) => new StoreWriteFailed({
    operation,
    path,
    reason: errorMessage(error),
    code: errorCode(error)
});
const readDirectory = (path) => Effect.callback((resume) => {
    readdir(path).then((entries) => resume(Effect.succeed(entries)), (error) => resume(Effect.fail(readFailure("read directory", path, error))));
});
const readText = (path) => Effect.callback((resume) => {
    readFile(path, "utf8").then((contents) => resume(Effect.succeed(contents)), (error) => resume(Effect.fail(readFailure("read file", path, error))));
});
const createDirectory = (path) => Effect.callback((resume) => {
    mkdir(path, { recursive: true }).then(() => resume(Effect.void), (error) => resume(Effect.fail(writeFailure("create directory", path, error))));
});
const removePath = (path) => Effect.callback((resume) => {
    rm(path, { force: true }).then(() => resume(Effect.void), (error) => resume(Effect.fail(writeFailure("remove path", path, error))));
});
const removeDirectory = (path) => Effect.callback((resume) => {
    rmdir(path).then(() => resume(Effect.void), (error) => resume(Effect.fail(writeFailure("remove directory", path, error))));
});
const accessPath = (path) => Effect.callback((resume) => {
    access(path).then(() => resume(Effect.void), (error) => resume(Effect.fail(readFailure("access path", path, error))));
});
const writeExclusive = (path, contents) => Effect.callback((resume) => {
    writeFile(path, contents, { flag: "wx" }).then(() => resume(Effect.succeed(path)), (error) => errorCode(error) === "EEXIST"
        ? resume(Effect.succeed(null))
        : resume(Effect.fail(writeFailure("create exclusive claim", path, error))));
});
const parsedBudget = () => {
    const value = process.env.TERRARIUM_CHILD_BUDGET ?? "1";
    const budget = Number(value);
    return Number.isInteger(budget) && budget >= 0 && budget <= 100
        ? budget
        : new InvalidBudget({ value });
};
const claimDirectory = (root, parentRunId) => join(root, `${parentRunId}.children`);
const metadataPath = (root, runId) => join(root, `${runId}.json`);
const claimSlot = (directory, run, slot, budget) => {
    if (slot > budget) {
        return Effect.fail(new ClaimConflict({
            runId: run.runId,
            claimant: run.parentRunId ?? ""
        }));
    }
    const path = join(directory, String(slot));
    return writeExclusive(path, run.runId).pipe(Effect.flatMap((claimPath) => claimPath === null
        ? claimSlot(directory, run, slot + 1, budget)
        : Effect.succeed(claimPath)));
};
const childMetadataExists = (path) => accessPath(path).pipe(Effect.map(() => true), Effect.catchTag("StoreReadFailed", (error) => error.code === "ENOENT" ? Effect.succeed(false) : Effect.fail(error)));
const rootEntries = (root) => readDirectory(root).pipe(Effect.catchTag("StoreReadFailed", (error) => error.code === "ENOENT" ? Effect.succeed([]) : Effect.fail(error)));
const removeEmptyDirectory = (path) => removeDirectory(path).pipe(Effect.catchTag("StoreWriteFailed", (error) => error.code === "ENOTEMPTY" ? Effect.void : Effect.fail(error)));
const prunedClaim = (directory, slot, childRunId) => {
    const claimPath = join(directory, slot);
    return removePath(claimPath).pipe(Effect.map(() => ({
        claimPath,
        childRunId: childRunId.length === 0 ? null : childRunId
    })));
};
const pruneSlot = (root, directory, slot) => {
    const claimPath = join(directory, slot);
    return readText(claimPath).pipe(Effect.flatMap((contents) => {
        const childRunId = contents.trim();
        if (!validRunId.test(childRunId)) {
            return prunedClaim(directory, slot, childRunId);
        }
        return childMetadataExists(metadataPath(root, childRunId)).pipe(Effect.flatMap((exists) => exists ? Effect.succeed(null) : prunedClaim(directory, slot, childRunId)));
    }));
};
const pruneDirectory = (root, directory) => readDirectory(directory).pipe(Effect.flatMap((slots) => Effect.forEach(slots, (slot) => pruneSlot(root, directory, slot)).pipe(Effect.flatMap((results) => removeEmptyDirectory(directory).pipe(Effect.map(() => results.filter((result) => result !== null)))))));
const makeLive = (root) => ({
    claim: (run) => {
        if (!run.parentRunId) {
            return Effect.succeed(null);
        }
        const budget = parsedBudget();
        if (budget instanceof InvalidBudget) {
            return Effect.fail(budget);
        }
        const directory = claimDirectory(root, run.parentRunId);
        return createDirectory(directory).pipe(Effect.flatMap(() => claimSlot(directory, run, 1, budget)));
    },
    release: (claimPath) => claimPath === null
        ? Effect.void
        : removePath(claimPath).pipe(Effect.andThen(removeEmptyDirectory(dirname(claimPath)))),
    prune: (options = {}) => {
        if (options.requesterRunId || process.env.TERRARIUM_RUN_ID) {
            return Effect.fail(new StoreWriteFailed({
                operation: "prune child claims",
                path: root,
                reason: "Child-slot claim pruning is available only to a top-level controller",
                code: null
            }));
        }
        return rootEntries(root).pipe(Effect.flatMap((entries) => Effect.forEach(entries.filter((entry) => entry.endsWith(".children")), (entry) => pruneDirectory(root, join(root, entry))).pipe(Effect.map((prunedByDirectory) => {
            const pruned = prunedByDirectory.flat();
            return { pruned, count: pruned.length };
        }))));
    }
});
export const RunStoreLive = (root) => Layer.succeed(RunStore, makeLive(root));
