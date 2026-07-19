/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure helpers for deriving a consumer-resolvable `exports` map at pack time — the single-map
 *   replacement for the retired hand-maintained `publishConfig.exports` duplication. Used by
 *   `publish-workspace.ts`; kept side-effect-free so tests can import them without triggering a
 *   publish.
 */

/** True for TypeScript SOURCE (`.ts`/`.tsx`) — declaration files (`.d.ts`) are legitimate publish targets. */
export function isTypeScriptSource(path: string): boolean {
	return /\.tsx?$/.test(path) && !path.endsWith(".d.ts")
}

/**
 * Rewrite the packed manifest's `exports` for consumers, in place inside the tarball.
 *
 * The dev map's `node` conditions point at `.ts` source (the repo runs source directly under node); published packages
 * ship only `out/`. This drops every `node` condition whose target is TypeScript source, reorders each entry
 * `types`-first, strips any legacy `publishConfig.exports`, then HARD-FAILS unless every remaining non-pattern target
 * exists inside the tarball and nothing resolves to `.ts`/`.tsx`. Exported for tests.
 */
export function transformExportsForPublish(exports: unknown): unknown {
	if (typeof exports !== "object" || exports === null) return exports

	const out: Record<string, unknown> = {}

	for (const [subpath, value] of Object.entries(exports as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null) {
			out[subpath] = value
			continue
		}
		const conditions = value as Record<string, unknown>
		const rewritten: Record<string, unknown> = {}

		// types first (npm requires it precede default to take effect), then the rest minus node→.ts.
		if (typeof conditions["types"] === "string") {
			rewritten["types"] = conditions["types"]
		}

		for (const [condition, target] of Object.entries(conditions)) {
			if (condition === "types") continue

			if (condition === "node" && typeof target === "string" && isTypeScriptSource(target)) continue
			rewritten[condition] = target
		}
		out[subpath] = rewritten
	}

	return out
}

/** Walk a transformed exports map; return every concrete (non-pattern) file target. */
export function collectExportTargets(exports: unknown): string[] {
	const targets: string[] = []
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			if (!value.includes("*")) {
				targets.push(value)
			}

			return
		}

		if (typeof value === "object" && value !== null) {
			for (const child of Object.values(value)) {
				walk(child)
			}
		}
	}
	walk(exports)

	return targets
}
