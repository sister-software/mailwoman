/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-package vitest config that resolves @mailwoman/core subpath imports to source. Mirrors the
 *   layout used in core/vitest.config.ts.
 */

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
// `defineConfig` from "vitest/config" (not "vite"): vitest's overload carries the `test` field.
// vite 8 (pulled in by docs/ Storybook) no longer applies the `vitest/config` type augmentation to
// vite's own `defineConfig`, so importing from "vite" makes `test` a type error under vite 8.
import { defineConfig } from "vitest/config"

const here = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
	resolve: {
		alias: [
			// Sub-subpath alias for the pure proposal-pipeline module — avoids dragging in
			// AddressParser → classification → tokenization → libpostal init cascade.
			{
				find: "@mailwoman/core/parser/proposal-pipeline",
				replacement: resolve(here, "../core/parser/proposal-pipeline.ts"),
			},
			{ find: /^@mailwoman\/core\/(.+)$/, replacement: resolve(here, "../core/$1/index.ts") },
			{ find: /^@mailwoman\/core$/, replacement: resolve(here, "../core/index.ts") },
			// @mailwoman/codex resolves to source too (per-address-system postal reference data).
			{ find: /^@mailwoman\/codex\/(.+)$/, replacement: resolve(here, "../codex/$1/index.ts") },
			{ find: /^@mailwoman\/codex$/, replacement: resolve(here, "../codex/index.ts") },
		],
	},
	test: {
		isolate: false,
		exclude: ["**/node_modules/**", "**/out/**", "**/dist/**"],
	},
})
