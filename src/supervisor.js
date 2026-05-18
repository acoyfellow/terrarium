#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { superviseTerrariumBackground } from "./core.js";

const specPath = process.argv[2];
if (!specPath) throw new Error("missing background spec path");

await superviseTerrariumBackground(JSON.parse(await readFile(specPath, "utf8")));
