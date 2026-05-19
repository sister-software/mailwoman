/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-package vitest config that resolves @mailwoman/core subpath imports to source rather than the
 *   compiled out/ tree. The root vitest config doesn't do this, and core's package.json exports
 *   field points at ./out/core/.../index.js which doesn't exist until tsc has run.
 *
 *   The alias lets cross-package tests run from a clean checkout without needing a precompile step
 *   for @mailwoman/core. The top-level compile script still produces those .js files for downstream
 *   consumers.
 */

/// <reference types="vitest/config" />

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const here = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
	resolve: {
		// Regex form maps every @mailwoman/core/<subpath> to the source index of that subdir, so
		// transitive imports (e.g. tokenization → solver) resolve without needing an entry per
		// subpath.
		alias: {
			"@mailwoman/core/decoder": resolve(here, "../core/core/decoder/index.ts"),
			"@mailwoman/core/types": resolve(here, "../core/core/types/index.ts"),
			// Sub-subpath alias: bring the pure proposal-pipeline module without dragging in
			// AddressParser → classification → tokenization → libpostal init cascade.
			"@mailwoman/core/parser/proposal-pipeline": resolve(here, "../core/core/parser/proposal-pipeline.ts"),
			"@mailwoman/core/policy": resolve(here, "../core/policy/index.ts"),
		},
	},
	test: {
		isolate: false,
		exclude: ["**/node_modules/**", "**/out/**", "**/dist/**"],
	},
})
