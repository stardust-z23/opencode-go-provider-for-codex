#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

const target = path.resolve("out");
fs.rmSync(target, { recursive: true, force: true });
