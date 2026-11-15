#!/usr/bin/env node
// One-time helper: creates a TaskAware eval account and saves its API token to eval/.env.
// Run it yourself:  node eval/create_eval_account.mjs
// You type the username and password here; the password is never written to disk,
// only the token the server returns.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.TASKAWARE_BASE_URL || 'https://taskaware-shimon.onrender.com').replace(/\/$/, '');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const username = (await rl.question('Username for the eval account [eval_bot]: ')).trim() || 'eval_bot';
const password = (await rl.question('Choose a password: ')).trim();
rl.close();
if (!password) { console.error('A password is required.'); process.exitCode = 1; }
else {
  console.log(`Creating "${username}" on ${BASE} (the server may take up to a minute to wake up)...`);
  const res = await fetch(`${BASE}/api/signup/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    console.error(`Signup failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
    console.error('If the username is taken, run again with another name.');
    process.exitCode = 1;
  } else {
    const envFile = path.join(HERE, '.env');
    fs.writeFileSync(envFile, `# Created by create_eval_account.mjs for user "${username}"\nTASKAWARE_TOKEN=${data.token}\n`);
    console.log(`Done. Token saved to eval/.env. Now tell Claude to run the eval.`);
  }
}
