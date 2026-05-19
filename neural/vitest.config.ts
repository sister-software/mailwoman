/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-package vitest config that resolves @mailwoman/core subpath imports to source. Mirrors the
 *   layout used in core/vitest.config.ts.
 */

/// <reference types="vitest/config" />

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

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
		],
	},
	test: {
		isolate: false,
		exclude: ["**/node_modules/**", "**/out/**", "**/dist/**"],
	},
})
