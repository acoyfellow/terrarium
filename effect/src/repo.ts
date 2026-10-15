import { Option, Schema } from "effect";

import { BaseInfo } from "./warm-base.ts";

const OWNER_OR_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const REF = /^[A-Za-z0-9_./-]{1,200}$/;

export const RepoSpec = Schema.Struct({
  github: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)),
  ref: Schema.optionalKey(Schema.String.check(Schema.isPattern(REF))),
  setup: Schema.optionalKey(Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(500))),
});

export type RepoSpec = typeof RepoSpec.Type;

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

export const archiveUrl = (spec: RepoSpec): Option.Option<string> => {
  const [owner, name] = spec.github.split("/");
  const ref = spec.ref ?? "HEAD";

  if (!OWNER_OR_NAME.test(owner) || !OWNER_OR_NAME.test(name) || ref.includes("..")) return Option.none();

  return Option.some(`https://codeload.github.com/${owner}/${name}/tar.gz/${ref}`);
};

export const sessionBranch = (runId: string) => `terrarium/${runId}`;

export const ARCHIVE_PATH = "/tmp/terrarium-repo.tar.gz";

export const unpackCommand = (runId: string) =>
  [
    `tar -xzf ${ARCHIVE_PATH} --strip-components=1 -C /workspace`,
    `rm -f ${ARCHIVE_PATH}`,
    "cd /workspace",
    "git init -q -b base",
    "printf 'node_modules/\\n' >> .git/info/exclude",
    "git -c user.name=terrarium -c user.email=terrarium@localhost add -A",
    "git -c user.name=terrarium -c user.email=terrarium@localhost commit -q -m base --no-verify",
    `git checkout -q -b ${sessionBranch(runId)}`,
    "git rev-parse HEAD",
  ].join(" && ");

export const DIFF_LIMIT = 20_000;

export const diffCommand = "cd /workspace && git add -A -- . ':!terrarium-task.txt' ':!terrarium-contract.json' && git -c core.pager=cat diff --cached --stat base && git -c core.pager=cat diff --cached base";

export const RepoResult = Schema.Struct({
  github: Schema.String,
  ref: Schema.String,
  branch: Schema.String,
  baseCommit: Schema.String,
  diff: Schema.String,
  diffTruncated: Schema.Boolean,
  base: Schema.optionalKey(Schema.NullOr(BaseInfo)),
});

export type RepoResult = typeof RepoResult.Type;

export const clippedDiff = (diff: string) => (diff.length <= DIFF_LIMIT ? { diff, diffTruncated: false } : { diff: diff.slice(0, DIFF_LIMIT), diffTruncated: true });
