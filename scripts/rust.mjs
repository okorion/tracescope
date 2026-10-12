import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
export const cargo = existsSync(join(homedir(), '.cargo/bin/cargo.exe'))
  ? join(homedir(), '.cargo/bin/cargo.exe') : 'cargo';
if (process.argv[1]?.endsWith('rust.mjs')) run(cargo, process.argv.slice(2));
