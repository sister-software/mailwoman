/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman autocomplete <prefix>`
 *
 *   One-shot prefix completion against the FST gazetteer. Returns the top-N place suggestions (name,
 *   placetype, WOF id, importance) that match the given prefix, ranked by importance.
 *
 *   The prefix normalizer is `normalizeTokens` from `fst-matcher` — the SAME function used at FST
 *   build time — so the symmetry contract from #190 is honoured. No third normalizer.
 *
 *   Default FST path: $MAILWOMAN_FST_BIN, else /tmp/v440-stage/en-us/v4.4.0/fst-en-US.bin. Pass --fst
 *   <path> to override.
 */

import { readFileSync } from "node:fs"

import { Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../sdk/cli.js"
import { $public } from "../sdk/runtime/index.js"

export { ArgumentsSchema as args, AutocompleteConfigSchema as options }

const ArgumentsSchema = zod.array(zod.string().describe("Prefix string to complete"))

export const AutocompleteConfigSchema = zod.object({
	limit: zod.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(10)
		.describe("Maximum number of completions to return (default 10)"),
	fst: zod
		.string()
		.optional()
		.describe(
			"Path to the FST binary (fst-en-US.bin). Defaults to $MAILWOMAN_FST_BIN or " +
				"/tmp/v440-stage/en-us/v4.4.0/fst-en-US.bin."
		),
	json: zod.boolean().optional().default(false).describe("Emit results as a JSON array instead of formatted text"),
})

/** Resolve the FST binary path from explicit flag, env var, or the staged default. */
export function resolveFSTPath(explicitPath?: string): string {
	return explicitPath ?? $public.MAILWOMAN_FST_BIN ?? "/tmp/v440-stage/en-us/v4.4.0/fst-en-US.bin"
}

export interface AutocompleteEntry {
	name: string
	placetype: string
	wofID: number
	importance: number
	completionTokens: string[]
}

/**
 * Load the FST from `fstPath` and run prefix autocomplete. Throws with a human-readable message on any IO or format
 * error so callers can surface it cleanly.
 */
export async function runAutocomplete(
	prefix: string,
	opts: { fstPath: string; limit?: number }
): Promise<AutocompleteEntry[]> {
	const { existsSync } = await import("node:fs")
	const fstPath = opts.fstPath

	if (!existsSync(fstPath)) {
		throw new Error(
			`FST binary not found at ${fstPath}.\n` +
				`Pass --fst <path>, set $MAILWOMAN_FST_BIN, or build the FST with:\n` +
				`  mailwoman fst build --db /path/to/wof-admin.db --output fst-en-US.bin`
		)
	}

	let buf: Buffer

	try {
		buf = readFileSync(fstPath)
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		throw new Error(`Failed to read FST binary at ${fstPath}: ${msg}`)
	}

	// Dynamic import keeps @mailwoman/resolver-wof-sqlite a true optional peer dep — only loaded
	// when the autocomplete command is invoked.
	const { deserializeFST } = await import("@mailwoman/resolver-wof-sqlite/fst-serialize")
	const { autocomplete } = await import("@mailwoman/resolver-wof-sqlite/fst-autocomplete")

	let matcher

	try {
		matcher = deserializeFST(buf)
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		throw new Error(`Malformed FST binary at ${fstPath}: ${msg}`)
	}

	const result = autocomplete(matcher, prefix, { maxSuggestions: opts.limit ?? 10 })

	return result.suggestions.map((s) => ({
		name: s.name,
		placetype: s.placetype,
		wofID: s.wofID,
		importance: s.importance,
		completionTokens: s.completionTokens,
	}))
}

function formatSuggestions(entries: AutocompleteEntry[]): string {
	if (entries.length === 0) return "(no completions)"

	return entries
		.map((e, i) => {
			const completion = e.completionTokens.length > 0 ? ` [+${e.completionTokens.join(" ")}]` : ""
			const imp = e.importance.toFixed(4)

			return `${String(i + 1).padStart(2)}. ${e.name}${completion}  (${e.placetype}, wof:${e.wofID}, imp:${imp})`
		})
		.join("\n")
}

const AutocompleteCommand: CommandComponent<typeof AutocompleteConfigSchema, typeof ArgumentsSchema> = ({
	options,
	args,
}) => {
	const [output, setOutput] = useState<string>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		const prefix = args[0]

		if (!prefix) {
			// Intentional: surface the usage error through the same render-then-exit pattern as parse.tsx.
			// The "cascading renders" the rule warns about are not a real cost here — the effect
			// short-circuits with `return`.
			// eslint-disable-next-line react-hooks/set-state-in-effect
			setError("Usage: mailwoman autocomplete <prefix> [--limit N] [--fst <path>]")

			return
		}

		const fstPath = resolveFSTPath(options.fst)

		runAutocomplete(prefix, { fstPath, limit: options.limit })
			.then((entries) => {
				if (options.json) {
					setOutput(JSON.stringify(entries, null, 2))
				} else {
					setOutput(formatSuggestions(entries))
				}
			})
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err)
				setError(msg)
			})
	}, [args, options])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (!output) {
		return <Text dimColor>Searching...</Text>
	}

	return <Text>{output}</Text>
}

export default AutocompleteCommand
