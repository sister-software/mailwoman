/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-package vitest config for @mailwoman/resolver. The resolver's OWN files run from source
 *   (vitest transpiles ./resolve.ts etc.); its workspace deps — @mailwoman/core, /spatial, /codex —
 *   resolve to their compiled `out/` (built by `tsc -b`). vitest's default resolution doesn't
 *   traverse a sibling workspace's package-exports for a transitive import (e.g. spatial →
 * @mailwoman/core/ objects), so the aliases below pin them explicitly. Most subpaths are
 *   directories (→ `<dir>/ index.js`); the handful that are bare files (`objects`) get a
 *   more-specific alias FIRST.
 */

import { resolve } from "node:path"

import { defineConfig } from "vitest/config"

const here = import.meta.dirname
const out = (pkg: string, sub: string) => resolve(here, `../${pkg}/out/${sub}`)

export default defineConfig({
	resolve: {
		alias: [
			// Order matters — file-subpaths (objects.ts → objects.js) before the directory regex.
			{ find: /^@mailwoman\/core\/objects$/, replacement: out("core", "objects.js") },
			{ find: /^@mailwoman\/core\/(.+)$/, replacement: resolve(here, "../core/out/$1/index.js") },
			{ find: /^@mailwoman\/core$/, replacement: out("core", "index.js") },
			{ find: /^@mailwoman\/spatial\/(.+)$/, replacement: resolve(here, "../spatial/out/$1/index.js") },
			{ find: /^@mailwoman\/spatial$/, replacement: out("spatial", "index.js") },
			{ find: /^@mailwoman\/codex\/(.+)$/, replacement: resolve(here, "../codex/out/$1/index.js") },
			{ find: /^@mailwoman\/codex$/, replacement: out("codex", "index.js") },
		],
	},
	test: {
		isolate: true,
		exclude: ["**/node_modules/**", "**/out/**", "**/dist/**"],
	},
})
