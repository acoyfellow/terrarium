#!/usr/bin/env node
import { main } from "../src/wake.js";
const code = await main();
process.exit(code);
