/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure helpers that derive the consumer `exports` and `imports` maps at pack time.
 */

/**
 * Returns true for a `.ts` or `.tsx` source path.
 * Declaration files (`.d.ts`) are valid publish targets.
 */
function isTypeScriptSource(path: string): boolean {
	return /\.tsx?$/.test(path) && !path.endsWith(".d.ts")
}

/**
 * Maps a TypeScript target in the development map to the JavaScript file that `tsc` emits for it.
 *
 * Every workspace sets `"rootDir": "./lib"`, so the emit drops the `lib/` segment.
 * For example, `./lib/utils/index.ts` compiles to `./out/utils/index.js`. {@link assertNoSourceTargets}
 * cannot detect a wrong JavaScript path, so this mapping must drop the segment.
 */
function emittedTargetFor(target: string): string {
	return `./out/${target
		.replace(/^\.\//, "")
		.replace(/^lib\//, "")
		.replace(/\.tsx?$/, ".js")}`
}

/**
 * Rewrites an `exports` map for the packed consumer manifest.
 *
 * The development map points conditions such as `node` at `.ts` source,
 * and published packages ship only `out/`.
 * This function rewrites every TypeScript target to its emitted JavaScript file
 * and moves `types` to the front of each entry.
 *
 * It keeps every condition, because a Node target and a browser target may be different files.
 *
 * The rewrite checks whether the target is TypeScript source, whatever the condition
 * name. {@link assertNoSourceTargets} rejects any TypeScript target that remains.
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

		// The `types` condition must come before `default` to take effect.
		if (typeof conditions["types"] === "string") {
			rewritten["types"] = conditions["types"]
		}

		for (const [condition, target] of Object.entries(conditions)) {
			if (condition === "types") continue

			rewritten[condition] =
				typeof target === "string" && isTypeScriptSource(target) ? emittedTargetFor(target) : target
		}

		out[subpath] = rewritten
	}

	return out
}

/**
 * Rewrites package-private `imports` aliases for the packed consumer manifest.
 *
 * The development aliases point `node` at TypeScript source, which Node cannot
 * type-strip under `node_modules`.
 * This function rewrites those targets to emitted JavaScript in the same way
 * as {@link transformExportsForPublish}.
 */
export function transformImportsForPublish(imports: unknown): unknown {
	if (typeof imports !== "object" || imports === null) return imports

	const out: Record<string, unknown> = {}

	for (const [specifier, value] of Object.entries(imports as Record<string, unknown>)) {
		// A string alias to TypeScript source is test-only, and the tarball excludes its file.
		if (typeof value === "string") {
			if (!isTypeScriptSource(value)) {
				out[specifier] = value
			}

			continue
		}

		const transformed = transformExportsForPublish({ [specifier]: value }) as Record<string, unknown>
		const rewritten = transformed[specifier]

		if (typeof rewritten === "object" && rewritten !== null && !Object.keys(rewritten).length) continue
		out[specifier] = rewritten
	}

	return out
}

/**
 * Throws when a transformed map still resolves to TypeScript source.
 *
 * Node refuses to type-strip under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`),
 * and consumer bundlers do not compile dependencies.
 * The tarball audit checks only that each target exists, so it cannot catch a shipped `.ts` target.
 *
 * @param label The workspace label that the error message prints.
 */
export function assertNoSourceTargets(label: string, transformed: unknown): void {
	const leaked = collectExportTargets(transformed).filter((target) => isTypeScriptSource(target))

	if (leaked.length) {
		throw new Error(
			`${label}: publish map resolves to TypeScript source, which no consumer can load: ${leaked.join(", ")}. ` +
				`Point the condition at its emitted out/ counterpart.`
		)
	}
}

/**
 * Returns every file target in an exports map.
 * Targets that contain a `*` pattern are skipped.
 */
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
