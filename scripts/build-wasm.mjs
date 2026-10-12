import { run, cargo } from './rust.mjs';
import { setup, binary } from './setup-wasm.mjs';
await setup();
run(cargo, ['build', '--manifest-path', 'engine/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release', '--locked']);
run(binary, ['engine/target/wasm32-unknown-unknown/release/tracescope_engine.wasm', '--target', 'web', '--out-dir', 'web/src/wasm', '--out-name', 'tracescope_engine']);
