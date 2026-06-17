import { execFileSync, spawnSync } from "node:child_process";
import { PROTECTED_FIX_PATHS } from "./fix-policy.js";
import { SECURE_PROFILE } from "./secure.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_WRITES = 20;
const MAX_WRITE_BYTES = 1024 * 1024;

function safePath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\0")) throw new Error("workspace-relative path required");
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) throw new Error("invalid workspace path");
  return parts.join("/");
}

function run(container, script, args = [], { input, timeout = 30000, maxBuffer = 1024 * 1024 } = {}) {
  const result = spawnSync("docker", ["exec", "-i", "--user", SECURE_PROFILE.user, container, "node", "-e", script, ...args], { input, encoding: "utf8", timeout, maxBuffer });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `workspace command failed (${result.status})`).trim());
  return String(result.stdout || "");
}

const PRELUDE = `const fs=require('fs'),p=require('path');const root='/workspace';const rel=process.argv[1];const target=p.resolve(root,rel);if(target!==root&&!target.startsWith(root+'/'))throw Error('path escaped workspace');`;

export class SecureWorkspace {
  constructor(container) { this.container = container; this.originals = new Map(); this.writes = 0; this.writeBytes = 0; }

  listFiles({ path = "", depth = 2 } = {}) {
    const rel = path ? safePath(path) : "";
    const script = `${PRELUDE}const max=Math.min(Math.max(Number(process.argv[2])||2,0),5),out=[];function walk(dir,d){if(d>max)return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(['.git','node_modules','dist'].includes(e.name))continue;const x=p.join(dir,e.name),r=p.relative(root,x);const st=fs.lstatSync(x);if(st.isSymbolicLink())continue;out.push({path:r,type:e.isDirectory()?'directory':'file',bytes:e.isFile()?st.size:undefined});if(e.isDirectory())walk(x,d+1);if(out.length>=500)return}}walk(target,0);console.log(JSON.stringify(out));`;
    return JSON.parse(run(this.container, script, [rel, String(depth)]));
  }

  readFile({ path } = {}) {
    const rel = safePath(path);
    const script = `${PRELUDE}const st=fs.lstatSync(target);if(!st.isFile()||st.isSymbolicLink())throw Error('regular file required');if(st.size>${MAX_FILE_BYTES})throw Error('file too large');process.stdout.write(fs.readFileSync(target,'utf8'));`;
    return { path: rel, content: run(this.container, script, [rel], { maxBuffer: MAX_FILE_BYTES + 1024 }) };
  }

  searchText({ query, path = "", limit = 50 } = {}) {
    if (typeof query !== "string" || !query || query.length > 200) throw new Error("bounded search query required");
    const rel = path ? safePath(path) : "";
    const script = `${PRELUDE}const q=process.argv[2],limit=Math.min(Number(process.argv[3])||50,100),out=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(['.git','node_modules','dist'].includes(e.name))continue;const x=p.join(dir,e.name);if(e.isDirectory())walk(x);else if(e.isFile()&&fs.statSync(x).size<262144){let s;try{s=fs.readFileSync(x,'utf8')}catch{continue}for(const [i,line] of s.split('\\n').entries())if(line.includes(q)){out.push({path:p.relative(root,x),line:i+1,text:line.slice(0,300)});if(out.length>=limit)return}}if(out.length>=limit)return}}walk(target);console.log(JSON.stringify(out));`;
    return JSON.parse(run(this.container, script, [rel, query, String(limit)]));
  }

  writeFile({ path, content } = {}) {
    const rel = safePath(path);
    if (PROTECTED_FIX_PATHS.some((pattern) => pattern.test(rel))) throw new Error(`protected path: ${rel}`);
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("bounded text content required");
    if (this.writes >= MAX_WRITES || this.writeBytes + Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error("workspace write budget exceeded");
    if (!this.originals.has(rel)) { try { this.originals.set(rel, this.readFile({ path: rel }).content); } catch { this.originals.set(rel, null); } }
    const script = `${PRELUDE}if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('symlink writes forbidden');fs.mkdirSync(p.dirname(target),{recursive:true});const chunks=[];process.stdin.on('data',d=>chunks.push(d));process.stdin.on('end',()=>{const tmp=target+'.terrarium-tmp';fs.writeFileSync(tmp,Buffer.concat(chunks),{mode:0o600});fs.renameSync(tmp,target);console.log(JSON.stringify({ok:true,bytes:fs.statSync(target).size}))});`;
    const result = JSON.parse(run(this.container, script, [rel], { input: content, maxBuffer: 4096 }));
    this.writes++; this.writeBytes += result.bytes;
    return { path: rel, ...result };
  }

  runTests({ timeoutMs = 120000 } = {}) {
    const result = spawnSync("docker", ["exec", "--user", SECURE_PROFILE.user, this.container, "sh", "-lc", "test -f package.json && npm test"], { encoding: "utf8", timeout: Math.min(timeoutMs, 180000), maxBuffer: SECURE_PROFILE.maxOutputBytes });
    return { passed: result.status === 0, exitCode: result.status ?? 124, output: String(result.stdout || result.stderr || "").slice(-12000) };
  }

  getDiff() {
    const changes = [];
    for (const [path, before] of this.originals) {
      let after = null; try { after = this.readFile({ path }).content; } catch {}
      if (before !== after) changes.push({ path, status: before === null ? "added" : after === null ? "deleted" : "modified", before, after });
    }
    return { changes, filesChanged: changes.length, bytesWritten: this.writeBytes };
  }
}

export const SECURE_TOOL_SCHEMAS = [
  { name: "list_files", description: "List files inside the secure workspace", inputSchema: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer" } } } },
  { name: "read_file", description: "Read one bounded text file inside the secure workspace", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "search_text", description: "Search text inside bounded workspace files", inputSchema: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } },
  { name: "write_file", description: "Atomically write one non-protected text file", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "run_tests", description: "Run the repository test command inside secure-v1", inputSchema: { type: "object", properties: { timeoutMs: { type: "integer" } } } },
  { name: "get_diff", description: "Return files changed through this secure tool broker", inputSchema: { type: "object", properties: {} } },
];
