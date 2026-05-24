// Empty module shim for browser-bundled `node:*` imports. The isomorphic deps that hit this
// (sentencepiece-js, onnxruntime-web, sqlite-wasm) only execute the corresponding code paths
// under the Node runtime — in the browser they're dead code, but webpack still needs to resolve
// the static `import` to something. This file is what it resolves to.
export default {}
