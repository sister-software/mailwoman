# @mailwoman/neural-web

**Deprecated.** The browser runtime moved into [`@mailwoman/neural`](https://www.npmjs.com/package/@mailwoman/neural). This package is a re-export shim so existing imports keep working; it will be removed a major later.

## Migrating

Install `@mailwoman/neural` and `onnxruntime-web`, then change the specifier:

```diff
-import { loadNeuralClassifierFromURLs } from "@mailwoman/neural-web"
+import { loadNeuralClassifierFromURLs } from "@mailwoman/neural/web-loader"
```

`WebONNXRunner` and its options live at `@mailwoman/neural/web-onnx-runner`; the tokenizer, classifier and soft-feature channels at `@mailwoman/neural/browser`. Every export keeps its identity, so a mixed-specifier tree behaves the same during the move.

Nothing else changes:

```ts
import { loadNeuralClassifierFromURLs } from "@mailwoman/neural/web-loader"

const { classifier } = await loadNeuralClassifierFromURLs({
	modelURL: "/static/mailwoman/model.onnx",
	tokenizerURL: "/static/mailwoman/tokenizer.model",
	runner: {
		// Optional. Point this at wherever you serve onnxruntime-web's .wasm assets if your
		// bundler doesn't put them in the default location.
		wasmPathsRoot: "/static/ort/",
	},
})

const tree = await classifier.parse("123 Main St, Springfield, IL 62704")
```

## Install the runtime yourself

`onnxruntime-web` is an **optional peer dependency** of `@mailwoman/neural`, not a transitive one. It no longer arrives on its own — install it alongside:

```bash
npm install @mailwoman/neural onnxruntime-web
```

That is the point of the move rather than an inconvenience of it. A Node service installs `onnxruntime-node`, a browser app installs `onnxruntime-web`, and neither pays for the other. Whichever you bundle, you chose it.

## Why the packages merged

`@mailwoman/neural` used to depend on `onnxruntime-node`, which ships native binaries a browser bundler cannot parse — so the browser runtime lived over here, and the boundary between the two was held by hand: a re-export list, a lint rule, a `webpackIgnore` comment. Each held until someone added an import.

The boundary is a resolution contract now. `@mailwoman/neural/onnx-runner` carries a `browser` export condition, so a bundler resolves the Node runner to a counterpart instead of following it, and both runtimes can live in one package.

`WebONNXRunner` still implements the same structural `NeuralRunner` interface as the Node runner — that part was never the problem.

## License

AGPL-3.0-only.
