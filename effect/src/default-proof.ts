import { Option, Schema } from "effect";

const PackageScripts = Schema.fromJsonString(Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) }));

const NPM_PLACEHOLDER = /no test specified/;

const MAKE_TEST_TARGET = /^test\s*:/m;

const npmTest = (packageJson: string): Option.Option<string> =>
  Schema.decodeUnknownOption(PackageScripts)(packageJson).pipe(
    Option.flatMap((pkg) => Option.fromNullishOr(pkg.scripts?.test)),
    Option.filter((script) => script.trim().length > 0 && !NPM_PLACEHOLDER.test(script)),
    Option.map(() => "npm test --silent"),
  );

const byMarker: ReadonlyArray<readonly [string, string]> = [
  ["Cargo.toml", "cargo test --quiet"],
  ["go.mod", "go test ./..."],
  ["pyproject.toml", "python3 -m pytest -q"],
  ["pytest.ini", "python3 -m pytest -q"],
];

export interface Workspace {
  readonly files: ReadonlyArray<string>;
  readonly packageJson: string;
  readonly makefile: string;
}

export const detectProof = (workspace: Workspace): Option.Option<string> => {
  const fromNpm = workspace.files.includes("package.json") ? npmTest(workspace.packageJson) : Option.none<string>();

  if (Option.isSome(fromNpm)) return fromNpm;

  if (workspace.files.includes("Makefile") && MAKE_TEST_TARGET.test(workspace.makefile)) return Option.some("make test");

  return Option.fromNullishOr(byMarker.find(([marker]) => workspace.files.includes(marker))?.[1]);
};
