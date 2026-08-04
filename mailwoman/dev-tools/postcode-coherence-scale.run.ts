/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #42 scale probe: run `findPostcodeCountryScope` over a whole (postcode, locality) panel on a CHOSEN backend, and
 *   report the outcome BY REGIME.
 *
 *   The 2026-08-04 landing record measured 28,000 pair evaluations this way but only on the candidate table, and the two
 *   backends demonstrably disagree about the one predicate the pass is built on: `exactMatch`. The FTS tier does not
 *   fold `ü`→`u`, so `Munchen`→`München` is exact on the candidate table and NOT exact on FTS — which changes the
 *   firing rate of a mechanism proposed for default-on. Hence a probe you can point at either backend, running the same
 *   protocol, so the two tables are comparable line for line.
 *
 *   Three legs per panel, and the regime split is the load-bearing part:
 *
 *   - `domestic`  — the panel's own country as `defaultCountry`. Any override is a border crossing, i.e. a FALSE
 *       POSITIVE, because the address really is in the panel's country.
 *   - `rescue`    — a deliberately mis-scoped `defaultCountry` (the demo/CLI reality: locale `en-US` → `US` on every
 *       query). An override BACK to the panel's country is the win; an override anywhere else is a false positive.
 *   - `regime`    — the same pass under an impossible default (`ZZ`), which forces step 1 to fail and reports what the
 *       alternative countries alone decide. A row whose regime probe returns the panel country was coherent under its
 *       own default and would have taken the cheap exit in the domestic leg; everything else FELL THROUGH and had every
 *       candidate country actually tried. Without that column a zero false-positive count means nothing — it reads the
 *       same whether the mechanism refused to cross a border or never ran.
 *
 *   The regime probe OVER-counts fall-through: a pair coherent in two countries returns null under `ZZ` (the tie rule)
 *   although the domestic leg would have exited cheaply. It errs toward claiming MORE at-risk rows than there were,
 *   which is the safe direction for the argument it supports.
 *
 *   Run from the repo root:
 *
 *     node mailwoman/dev-tools/postcode-coherence-scale.run.ts <panel> <backend> [limit]
 *
 *     panel    us | fr | gb
 *     backend  fts | candidate
 *
 *   Emits a markdown row per leg on stdout plus the per-case false-positive list, which is the number the D-rule cares
 *   about — every FP is printed with its pair, so a finding is never a bare count.
 */

import { existsSync } from "node:fs"

import type { AddressNode } from "@mailwoman/core/decoder"
import type { ResolverBackend } from "@mailwoman/core/resolver"
import { cliArguments } from "@mailwoman/core/scripting/utils"
import { wofShardPaths } from "@mailwoman/core/utils"
import { findPostcodeCountryScope } from "@mailwoman/resolver"
import { WOFCandidateTableLookup, WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { JSONSpliterator } from "spliterator"

import { conventionCandidateDBPath } from "../resolver-backend.ts"

/**
 * A panel row reduced to the only two fields the pass reads.
 */
interface Pair {
	postcode: string
	locality: string
}

/**
 * The panels, keyed by the country whose addresses they hold. `misScope` is the wrong default the rescue leg pins —
 * `US` for the non-US panels (the en-US locale default that causes the bug in the first place) and `FR` for the US
 * panel, so both mis-scope directions are covered rather than only the convenient one.
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
 * The impossible default the regime probe pins. Not an ISO-3166 assignment, so no codex slice can claim it and step 1
 * always fails — which is the point: it isolates what the ALTERNATIVE countries decide.
 */
const IMPOSSIBLE_DEFAULT = "ZZ"

const [panelName, backendName, limitArg] = cliArguments()
const panel = panelName ? PANELS[panelName] : undefined

if (!panel || (backendName !== "fts" && backendName !== "candidate")) {
	throw new Error("usage: postcode-coherence-scale.run.ts <us|fr|gb> <fts|candidate> [limit]")
}

const limit = limitArg ? Number(limitArg) : Infinity

/**
 * The two roots the pass reads. The real tree carries a street too; it is never consulted here (the pass keys on the
 * postcode string the caller passes plus the first locality node), so the minimal pair is faithful.
 */
function rootsFor(pair: Pair): AddressNode[] {
	return [
		{ tag: "postcode", value: pair.postcode, start: 0, end: pair.postcode.length, confidence: 0.95, children: [] },
		{ tag: "locality", value: pair.locality, start: 0, end: pair.locality.length, confidence: 0.95, children: [] },
	]
}

function makeBackend(): ResolverBackend {
	if (backendName === "candidate") {
		const path = conventionCandidateDBPath()

		if (!existsSync(path)) throw new Error(`candidate gazetteer not found at ${path}`)

		console.error(`[probe] candidate-table backend: ${path}`)

		return new WOFCandidateTableLookup({ databasePath: path })
	}

	// The PRODUCTION shard set, exactly as `wofShardPaths()` orders it — the point of the FTS leg is to measure what a
	// default-on mechanism would see in production, not what a hand-picked shard list can be made to show.
	const paths = wofShardPaths().filter(existsSync)

	console.error(`[probe] FTS backend over ${paths.length} shards: ${paths.join(", ")}`)

	return new WOFSqlitePlaceLookup({ databasePath: paths })
}

const backend = makeBackend()
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
				`${pair.postcode} / ${pair.locality} → ${scope.country} at ${scope.distanceKm.toFixed(2)} km (default ${defaultCountry})`
			)
		}
	}

	return tally
}

const domestic = await leg(panel.country)
const rescue = await leg(panel.misScope)
const regime = await leg(IMPOSSIBLE_DEFAULT)

// A regime probe that returns the panel country means the pair is coherent under its OWN country — the cheap exit.
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
