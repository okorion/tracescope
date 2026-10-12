import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { run } from './rust.mjs'

export const version = '0.2.129'
const triples = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
}
const triple = triples[`${process.platform}-${process.arch}`]
if (!triple) throw new Error('Install wasm-bindgen-cli 0.2.129 and use a supported build host.')
const folder = `wasm-bindgen-${version}-${triple}`
export const binary = resolve(
  '.tools',
  folder,
  `wasm-bindgen${process.platform === 'win32' ? '.exe' : ''}`,
)
export async function setup() {
  if (existsSync(binary)) return
  await mkdir('.tools', { recursive: true })
  const url = `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/${folder}.tar.gz`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const checksumResponse = await fetch(`${url}.sha256sum`)
  if (!checksumResponse.ok) throw new Error('Cannot verify release checksum.')
  const expected = (await checksumResponse.text()).trim().split(/\s/)[0]
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new Error('wasm-bindgen release checksum mismatch.')
  const archive = join('.tools', `${folder}.tar.gz`)
  await writeFile(archive, bytes)
  run('tar', ['-xzf', archive, '-C', '.tools'])
  if (!existsSync(binary)) throw new Error('wasm-bindgen executable missing after extraction.')
  console.log(`Verified wasm-bindgen ${version}: ${actual}`)
}
if (process.argv[1]?.endsWith('setup-wasm.mjs')) await setup()
