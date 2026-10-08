/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Run `findPostcodeCountryScope` over a whole (postcode, locality) panel and report the result
 *   by regime, because the two backends disagree about `exactMatch`: the FTS tier does not fold
 *   `ü`→`u`, so `Munchen`→`München` is exact on the candidate table and not on FTS.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { ResolverBackend } from "@mailwoman/core/resolver"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { findPostcodeCountryScope } from "@mailwoman/resolver"
import { WOFCandidateTableLookup, WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { JSONSpliterator } from "spliterator"

import { conventionCandidateDBPath, existingWOFDatabasePaths } from "#resolver-backend"

interface Pair {
	postcode: string
	locality: string
}

/**
 * Keyed by the country whose addresses each panel holds, with `misScope` the wrong
 * default the rescue leg pins — `US` for the non-US panels and `FR` for the US panel,
 * so both mis-scope directions are covered.
 */
const PANELS: Record<string, { path: string; country: string; misScope: string; read: (row: never) => Pair | null }> = {
	us: {
		path: "data/eval/external/openaddresses-us-sample.jsonl",
		country: "US",
		misScope: "FR",
		read: (row: { expected?: { locality?: string | null; postcode?: string | null } }) =>
			row.expected?.postcode && row.expected.locality
				? { postcode: row.expected.postcode, locality: row.expected.locality }
				: null,
	},
	fr: {
		path: "data/eval/external/openaddresses-fr-sample.jsonl",
		country: "FR",
		misScope: "US",
		read: (row: { expected?: { locality?: string | null; postcode?: string | null } }) =>
			row.expected?.postcode && row.expected.locality
				? { postcode: row.expected.postcode, locality: row.expected.locality }
				: null,
	},
	gb: {
		path: "data/eval/external/oa-gb-coord-1k.jsonl",
		country: "GB",
		misScope: "US",
		read: (row: { components?: { locality?: string | null; postcode?: string | null } }) =>
			row.components?.postcode && row.components.locality
				? { postcode: row.components.postcode, locality: row.components.locality }
				: null,
	},
}

/**
 * It has no ISO-3166 assignment, so no codex address system can claim it.
 *
 * Step 1 therefore fails, isolating what the alternative countries decide by themselves.
 */
const IMPOSSIBLE_DEFAULT = "ZZ"

const { positionals } = parseArguments({
	allowPositionals: true,
})

const [panelName, backendName, limitArg] = positionals

const panel = panelName ? PANELS[panelName] : undefined

if (!panel || (backendName !== "fts" && backendName !== "candidate")) {
	throw new Error("usage: postcode-coherence-scale.run.ts <us|fr|gb> <fts|candidate> [limit]")
}

const limit = limitArg ? Number(limitArg) : Infinity

/**
 * The two roots the pass reads: it keys on the postcode string the caller passes plus the first
 * locality node, so the street node in a real tree is never consulted and the minimal pair is faithful.
 */
function rootsFor(pair: Pair): AddressNode[] {
	return [
		{ tag: "postcode", value: pair.postcode, start: 0, end: pair.postcode.length, confidence: 0.95, children: [] },
		{ tag: "locality", value: pair.locality, start: 0, end: pair.locality.length, confidence: 0.95, children: [] },
	]
}

async function makeBackend(): Promise<ResolverBackend> {
	if (backendName === "candidate") {
		const path = conventionCandidateDBPath()

		if (!(await pathExists(path))) throw new Error(`candidate gazetteer not found at ${path}`)

		console.error(`[probe] candidate-table backend: ${path}`)

		return new WOFCandidateTableLookup({ databasePath: path })
	}

	// The production database set exactly as `wofExtractPaths()` orders it: the FTS leg measures what a
	// default-on mechanism would see in production, rather than what a hand-picked list shows.
	const paths = await existingWOFDatabasePaths()

	console.error(`[probe] FTS backend over ${paths.length} databases: ${paths.join(", ")}`)

	return new WOFSQLitePlaceLookup({ databasePath: paths })
}

const backend = await makeBackend()
const pairs: Pair[] = []

for await (const row of JSONSpliterator.fromAsync<never>(panel.path)) {
	const pair = panel.read(row)

	if (pair) {
		pairs.push(pair)
	}

	if (pairs.length >= limit) break
}

console.error(`[probe] ${panelName} panel: ${pairs.length} pairs with both a postcode and a locality`)

interface LegTally {
	overrides: number
	rescued: number
	falsePositives: string[]
}

async function leg(defaultCountry: string): Promise<LegTally> {
	const tally: LegTally = { overrides: 0, rescued: 0, falsePositives: [] }

	for (const pair of pairs) {
		const scope = await findPostcodeCountryScope(rootsFor(pair), backend, { postcode: pair.postcode, defaultCountry })

		if (!scope) continue

		tally.overrides++

		if (scope.country === panel!.country) {
			tally.rescued++
		} else {
			tally.falsePositives.push(
				`${pair.postcode} / ${pair.locality} → ${scope.country} via ${scope.evidence}${scope.distanceKm === null ? "" : ` at ${scope.distanceKm.toFixed(2)} km`} (default ${defaultCountry})`
			)
		}
	}

	return tally
}

const domestic = await leg(panel.country)
const rescue = await leg(panel.misScope)
const regime = await leg(IMPOSSIBLE_DEFAULT)

// A regime probe that returns the panel country means the pair is coherent under its own country — the cheap exit.
const coherentDefault = regime.rescued
const fellThrough = pairs.length - coherentDefault

console.log(`\n### ${panelName!.toUpperCase()} panel · ${backendName} backend · n=${pairs.length}\n`)
console.log(`| leg | default | fell through | overrides | rescued | false positives |`)
console.log(`| --- | --- | ---: | ---: | ---: | ---: |`)
console.log(
	`| domestic | ${panel.country} | ${fellThrough} | ${domestic.overrides} | — | ${domestic.falsePositives.length} |`
)
console.log(
	`| rescue | ${panel.misScope} | ${pairs.length} | ${rescue.overrides} | ${rescue.rescued} | ${rescue.falsePositives.length} |`
)
console.log(`\ncoherent-default (regime probe): ${coherentDefault}/${pairs.length}`)

for (const [name, tally] of [
	["domestic", domestic],
	["rescue", rescue],
] as const) {
	if (!tally.falsePositives.length) continue

	console.log(`\nfalse positives — ${name} leg:`)

	for (const fp of tally.falsePositives) {
		console.log(`  · ${fp}`)
	}
}
