import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
export const cargo = existsSync(join(homedir(), '.cargo/bin/cargo.exe'))
  ? join(homedir(), '.cargo/bin/cargo.exe')
  : 'cargo'
// On Windows, an already installed GNU toolchain avoids requiring MSVC link.exe.
// Never change the user's global Rust default.
export const cargoPrefix =
  process.platform === 'win32' &&
  existsSync(
    join(
      process.env.RUSTUP_HOME || join(homedir(), '.rustup'),
      'toolchains/1.99.0-x86_64-pc-windows-gnu',
    ),
  )
    ? ['+1.99.0-x86_64-pc-windows-gnu']
    : []
if (process.argv[1]?.endsWith('rust.mjs')) run(cargo, [...cargoPrefix, ...process.argv.slice(2)])
