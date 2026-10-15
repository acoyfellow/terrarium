import type { Context } from "@earendil-works/chord";
import { ExecutionError, FileError, LineScanner, err, ok } from "@earendil-works/pi-durable/env";
import type { BinaryReader, DirReader, ExecutionEnv, FileInfo, FileListing, FileWatcher, Result, ShellExecOptions, ShellExecResult, TextLineReader } from "@earendil-works/pi-durable/env";

export interface BoxCalls {
  readonly exec: (command: string, options: { readonly cwd: string; readonly timeout: number; readonly env?: Record<string, string> }) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  readonly readBase64: (path: string) => Promise<string | null>;
  readonly writeText: (path: string, content: string) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const KIND_BY_TYPE = new Map<string, FileInfo["kind"]>([["d", "directory"], ["l", "symlink"], ["f", "file"]]);

const KIND_BY_STAT: ReadonlyArray<readonly [string, FileInfo["kind"]]> = [["directory", "directory"], ["link", "symlink"]];

const textOf = (content: string | Uint8Array): string => (content instanceof Uint8Array ? new TextDecoder().decode(content) : content);

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const joinUnder = (cwd: string, path: string) => (path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`);

const normalize = (path: string) => {
  const parts: Array<string> = [];

  path.split("/").forEach((part) => {
    if (part === "" || part === ".") return;

    if (part === "..") parts.pop();
    else parts.push(part);
  });

  return `/${parts.join("/")}`;
};

const fileError = (code: FileError["code"], message: string, path?: string) => err<never, FileError>(new FileError(code, message, path));

const notSupported = (what: string) => fileError("not_supported", `${what} is not supported in the Terrarium box`);

const decodeBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const bytesReader = (bytes: Uint8Array, info: FileInfo): BinaryReader => {
  const reader: BinaryReader = {
    info: () => Promise.resolve(ok(info)),
    read: (offset: number, length: number) => Promise.resolve(ok(bytes.subarray(offset, offset + length))),
    scanLines: (options: { readonly startLine: number; readonly endLine?: number }) => {
      const scanner = new LineScanner(options.startLine, options.endLine);

      scanner.push(bytes);

      return Promise.resolve(ok(scanner.finish()));
    },
    close: () => Promise.resolve(),
  };

  return reader;
};

export const containerEnv = (box: BoxCalls, cwd = "/workspace"): ExecutionEnv => {
  const resolve = (path: string) => normalize(joinUnder(cwd, path));

  const stat = (path: string): Promise<Result<FileInfo, FileError>> =>
    box.exec(`stat -c '%F|%s|%Y' ${quote(path)}`, { cwd, timeout: 10_000 }).then((result) => {
      if (result.exitCode !== 0) return fileError("not_found", `No such file: ${path}`, path);

      const [kind, size, mtime] = result.stdout.trim().split("|");
      const fileKind = KIND_BY_STAT.find(([marker]) => kind.includes(marker))?.[1] ?? "file";

      return ok({ name: path.split("/").at(-1) ?? path, path, kind: fileKind, size: Number(size), mtimeMs: Number(mtime) * 1000 });
    });

  const readBytes = (path: string): Promise<Result<Uint8Array, FileError>> =>
    box.readBase64(path).then((encoded) => (encoded === null ? fileError("not_found", `No such file: ${path}`, path) : ok(decodeBase64(encoded))));

  const env: ExecutionEnv = {
    id: `terrarium-box:${cwd}`,
    cwd,
    absolutePath: (path) => Promise.resolve(ok(resolve(path))),
    joinPath: (parts) => Promise.resolve(ok(normalize(parts.join("/")))),
    canonicalPath: (path) => Promise.resolve(ok(resolve(path))),
    exists: (path) => box.exec(`test -e ${quote(resolve(path))}`, { cwd, timeout: 10_000 }).then((result) => ok(result.exitCode === 0)),
    fileInfo: (path) => stat(resolve(path)),
    listDir: (path) => {
      const full = resolve(path);

      return box.exec(`find ${quote(full)} -mindepth 1 -maxdepth 1 -printf '%f|%y|%s|%T@\\n'`, { cwd, timeout: 10_000 }).then((result) => {
        if (result.exitCode !== 0) return fileError("not_found", `No such directory: ${full}`, full);

        return ok(result.stdout.split("\n").filter((line) => line.length > 0).map((line): FileInfo => {
          const [name, type, size, mtime] = line.split("|");

          return { name, path: `${full}/${name}`, kind: KIND_BY_TYPE.get(type) ?? "file", size: Number(size), mtimeMs: Math.round(Number(mtime) * 1000) };
        }));
      });
    },
    readTextFile: (path) => readBytes(resolve(path)).then((result) => (result.ok ? ok(new TextDecoder().decode(result.value)) : result)),
    readBinaryFile: (path) => readBytes(resolve(path)),
    readTextLines: (path, options) => readBytes(resolve(path)).then((result) => (result.ok ? ok(new TextDecoder().decode(result.value).split("\n").slice(0, options?.maxLines)) : result)),
    openBinaryReader: (path) => {
      const full = resolve(path);

      return Promise.all([stat(full), readBytes(full)]).then(([info, bytes]) => {
        if (!info.ok) return info;

        if (!bytes.ok) return bytes;

        return ok(bytesReader(bytes.value, info.value));
      });
    },
    writeFile: (path, content) => {
      const full = resolve(path);
      const text = textOf(content);

      return box.exec(`mkdir -p ${quote(full.split("/").slice(0, -1).join("/") || "/")}`, { cwd, timeout: 10_000 })
        .then(() => box.writeText(full, text))
        .then(() => ok<void, FileError>(undefined), (cause) => fileError("unknown", String(cause), full));
    },
    createDir: (path, options) => box.exec(`mkdir ${options?.recursive === true ? "-p " : ""}${quote(resolve(path))}`, { cwd, timeout: 10_000 }).then((result) => (result.exitCode === 0 ? ok(undefined) : fileError("unknown", result.stderr, path))),
    remove: (path, options) => box.exec(`rm ${options?.recursive === true ? "-r " : ""}${options?.force === true ? "-f " : ""}${quote(resolve(path))}`, { cwd, timeout: 10_000 }).then((result) => (result.exitCode === 0 ? ok(undefined) : fileError("unknown", result.stderr, path))),
    exec: (command, options: ShellExecOptions | undefined, context: Context) => {
      const line = Array.isArray(command) ? command.map(quote).join(" ") : String(command);

      return box.exec(line, { cwd: options?.cwd ?? cwd, timeout: options?.timeout === undefined ? DEFAULT_TIMEOUT_MS : options.timeout * 1000, env: options?.env }).then(
        (result): Result<ShellExecResult, ExecutionError> => {
          if (result.stdout.length > 0) options?.onOutput?.(result.stdout, context, { stream: "stdout" });

          if (result.stderr.length > 0) options?.onOutput?.(result.stderr, context, { stream: "stderr" });

          return ok({ exitCode: result.exitCode });
        },
        (cause) => err(new ExecutionError("spawn_error", String(cause))),
      );
    },
    openTextLineReader: (): Promise<Result<TextLineReader, FileError>> => Promise.resolve(notSupported("openTextLineReader")),
    appendFile: () => Promise.resolve(notSupported("appendFile")),
    truncateFile: () => Promise.resolve(notSupported("truncateFile")),
    flushFile: () => Promise.resolve(ok(undefined)),
    renameFile: (source, destination) => box.exec(`mv ${quote(resolve(source))} ${quote(resolve(destination))}`, { cwd, timeout: 10_000 }).then((result) => (result.exitCode === 0 ? ok(undefined) : fileError("unknown", result.stderr, source))),
    openDirReader: (): Promise<Result<DirReader, FileError>> => Promise.resolve(notSupported("openDirReader")),
    listFiles: (): Promise<Result<FileListing, FileError>> => Promise.resolve(notSupported("listFiles")),
    watch: (): Promise<Result<FileWatcher, FileError>> => Promise.resolve(notSupported("watch")),
    createTempDir: () => box.exec("mktemp -d", { cwd, timeout: 10_000 }).then((result) => ok(result.stdout.trim())),
    createTempFile: () => box.exec("mktemp", { cwd, timeout: 10_000 }).then((result) => ok(result.stdout.trim())),
    cleanup: () => Promise.resolve(),
  };

  return env;
};
