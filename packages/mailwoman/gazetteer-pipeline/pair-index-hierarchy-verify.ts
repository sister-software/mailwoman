/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ground-truth verifier for the (locality, region) pair-index PROBE artifacts written by
 *   `pair-index-hierarchy-probe.ts` (design:
 *   `docs/superpowers/plans/2026-07-26-pair-index-hierarchy-design.md`). Deliberately a SEPARATE
 *   implementation from the builder — the expected pair set is re-derived here with one flat SQL
 *   query (CTE surface unions, SQL-side joins) instead of the builder's JS-side map joins, then
 *   folded and compared. Two independent code paths converging on the same set is the receipt; a
 *   shared extraction module would verify only the serialization round-trip.
 *
 *   Checks, per country:
 *
 *   1. Header sanity — country, `delta === 0` (uncalibrated probe), `probeArtifact`, edge,
 *      fold/schema versions.
 *   2. Entry-count match — the binary's `pairCount` (read straight from the documented PIX1 layout)
 *      vs the re-derived expected set size.
 *   3. FULL membership sweep — every expected folded pair must probe OK with tag `locality`; any
 *      resolver entry beyond the expected count would surface as a count mismatch in (2).
 *   4. Named receipts — ("Springfield", "Illinois") present in US; ("Springfield", "Bretagne")
 *      ABSENT (cross-country negative control); FR communes under both their région (macroregion:
 *      "Bretagne") and département (WOF region: "Ille-et-Vilaine").
 *
 *   Throws (exits non-zero under `runIfScript`) on any failure.
 *
 *   Run: `node mailwoman/gazetteer-pipeline/pair-index-hierarchy-verify.ts [--countries us,fr] [--db <path>] [--dir <dir>]`
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { runIfScript } from "@mailwoman/core/scripting"
import { dataRootPath } from "@mailwoman/core/utils"
import { normalizeFSTToken } from "@mailwoman/neural/fst-prior"
import { KNOWN_SCHEMA_VERSION, PairIndexResolver, peekPairIndexHeader } from "@mailwoman/neural/pair-index-resolver"

/**
 * Mirror of the builder's per-country WOF parent-placetype sets — restated here on purpose (see file header).
 */
const PARENT_PLACETYPES_BY_COUNTRY: Readonly<Record<string, string[]>> = {
	us: ["region"],
	fr: ["region", "macroregion"],
}

interface NamedProbe {
	child: string
	parent: string
	expect: "present" | "absent"
}

const NAMED_PROBES_BY_COUNTRY: Readonly<Record<string, readonly NamedProbe[]>> = {
	us: [
		{ child: "Springfield", parent: "Illinois", expect: "present" },
		{ child: "Portland", parent: "Oregon", expect: "present" },
		{ child: "Portland", parent: "Maine", expect: "present" },
		// Cross-country negative control: a US child under an FR parent must miss.
		{ child: "Springfield", parent: "Bretagne", expect: "absent" },
		// A real pairing the hierarchy does not contain: Springfield exists, Ontario is not a US region.
		{ child: "Springfield", parent: "Ontario", expect: "absent" },
	],
	fr: [
		// Commune under its région (WOF macroregion, official name "Bretagne" — spr says "Brittany").
		{ child: "Rennes", parent: "Bretagne", expect: "present" },
		// Same commune under its département (WOF region).
		{ child: "Rennes", parent: "Ille-et-Vilaine", expect: "present" },
		{ child: "Brest", parent: "Finistère", expect: "present" },
		{ child: "Marseille", parent: "Bouches-du-Rhône", expect: "present" },
		// Cross-country negative control.
		{ child: "Rennes", parent: "Illinois", expect: "absent" },
		// Wrong-région control: Brest is in Bretagne, not Normandie.
		{ child: "Brest", parent: "Normandie", expect: "absent" },
	],
}

/**
 * Read the PIX1 entry count straight from the documented layout: magic u32, headerLen u32, header, pairCount u32.
 */
function readPairCount(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const headerLen = view.getUint32(4, true)

	return view.getUint32(8 + headerLen, true)
}

/**
 * Re-derive the expected folded (child, parent) pair set for a country with a single flat SQL query — surface unions
 * (spr.name ∪ official names) as CTEs, edges joined SQL-side — then fold in JS. Returns folded pairs keyed
 * length-prefixed (the pairKey convention).
 */
function expectedPairSet(db: DatabaseSync, country: string, parentPlacetypes: string[]): Map<string, [string, string]> {
	// Explicitly NUMBERED placeholders throughout: `?1` (country) and `?2..?N` (parent placetypes) are
	// each reused across several clauses. Mixing `?1` with anonymous `?` silently mis-numbers the
	// anonymous ones past the bound arguments (they bind NULL and the INs match nothing) — the first
	// run of this verifier did exactly that and "verified" against an empty expected set.
	const parentPlaceholder = parentPlacetypes.map((_, i) => `?${i + 2}`).join(",")
	const wofCountry = country.toUpperCase()

	const rows = db
		.prepare(
			`WITH child_surface AS (
				SELECT id, name FROM spr
				WHERE country = ?1 AND placetype = 'locality' AND is_current = 1 AND is_deprecated = 0
				UNION
				SELECT s.id, n.name FROM spr s
				JOIN names n ON n.id = s.id AND n.official = 1
				WHERE s.country = ?1 AND s.placetype = 'locality' AND s.is_current = 1 AND s.is_deprecated = 0
			),
			parent_surface AS (
				SELECT id, name FROM spr
				WHERE country = ?1 AND placetype IN (${parentPlaceholder}) AND is_current = 1 AND is_deprecated = 0
				UNION
				SELECT s.id, n.name FROM spr s
				JOIN names n ON n.id = s.id AND n.official = 1
				WHERE s.country = ?1 AND s.placetype IN (${parentPlaceholder}) AND s.is_current = 1 AND s.is_deprecated = 0
			),
			edge AS (
				SELECT DISTINCT a.id AS child_id, a.ancestor_id AS parent_id
				FROM ancestors a
				JOIN spr c ON c.id = a.id AND c.country = ?1 AND c.placetype = 'locality'
					AND c.is_current = 1 AND c.is_deprecated = 0
				WHERE a.ancestor_placetype IN (${parentPlaceholder}) AND a.ancestor_id != a.id
			)
			SELECT cs.name AS child_name, ps.name AS parent_name
			FROM edge e
			JOIN child_surface cs ON cs.id = e.child_id
			JOIN parent_surface ps ON ps.id = e.parent_id`
		)
		.all(wofCountry, ...parentPlacetypes) as unknown as Array<{ child_name: string; parent_name: string }>

	const folded = new Map<string, [string, string]>()

	for (const { child_name, parent_name } of rows) {
		const child = normalizeFSTToken(child_name)
		const parent = normalizeFSTToken(parent_name)

		if (!child) {
			continue
		}

		folded.set(`${child.length}:${child}:${parent}`, [child, parent])
	}

	return folded
}

function main(): void {
	const { values } = parseArgs({
		options: {
			countries: { type: "string", default: "us,fr" },
			db: { type: "string" },
			dir: { type: "string" },
		},
	})

	const countries = values.countries!.split(",").map((c) => c.trim().toLowerCase())
	const dbPath = values.db ?? dataRootPath("wof", "admin-global-priority.db")
	const dir = values.dir ?? dataRootPath("wof", "pair-index-hierarchy-probe")

	const db = new DatabaseSync(dbPath, { readOnly: true })
	let failures = 0

	const fail = (msg: string): void => {
		failures++

		console.log(`  FAIL: ${msg}`)
	}

	for (const country of countries) {
		const artifactPath = join(dir, `pair-index-locality-region-${country}.bin`)
		const bytes = new Uint8Array(readFileSync(artifactPath))
		const header = peekPairIndexHeader(bytes)
		const parentPlacetypes = PARENT_PLACETYPES_BY_COUNTRY[country]
		const namedProbes = NAMED_PROBES_BY_COUNTRY[country]

		if (!parentPlacetypes || !namedProbes) {
			throw new Error(`pair-index-hierarchy-verify: no spec for country "${country}"`)
		}

		console.log(`\n${artifactPath} (${bytes.length.toLocaleString()} bytes)`)

		// 1. Header sanity.
		if (header.country !== country) {
			fail(`header country "${header.country}" != "${country}"`)
		}

		if (header.delta !== 0) {
			fail(`header delta ${header.delta} != 0 — a probe artifact must be uncalibrated`)
		}

		// Against the reader's OWN constant, not a re-typed literal — this script and the format cannot disagree.
		if (header.schemaVersion !== KNOWN_SCHEMA_VERSION) {
			fail(
				`header schemaVersion ${header.schemaVersion} != ${KNOWN_SCHEMA_VERSION} ` +
					`(typed-parent-record format, PIX2, 2026-08-04)`
			)
		}

		if (header.foldVersion !== 1) {
			fail(`header foldVersion ${header.foldVersion} != 1`)
		}

		const extended = header as unknown as {
			probeArtifact?: boolean
			edge?: { child?: string; parent?: string }
			source?: { kind?: string; namePolicy?: string }
		}

		if (extended.probeArtifact !== true) {
			fail(`header probeArtifact is not true`)
		}

		if (extended.edge?.child !== "locality" || extended.edge?.parent !== "region") {
			fail(`header edge ${JSON.stringify(extended.edge)} != locality→region`)
		}

		if (extended.source?.kind !== "wof-ancestors") {
			fail(`header source.kind "${extended.source?.kind}"`)
		}

		console.log(
			`  header: country=${header.country} delta=${header.delta} edge=${extended.edge?.child}→${extended.edge?.parent} ` +
				`namePolicy=${extended.source?.namePolicy} buildDate=${header.buildDate}`
		)

		// 2. Entry count vs re-derived ground truth.
		const expected = expectedPairSet(db, country, parentPlacetypes)
		const pairCount = readPairCount(bytes)

		if (pairCount === expected.size) {
			console.log(
				`  COUNT OK: artifact pairCount ${pairCount.toLocaleString()} == DB-derived ${expected.size.toLocaleString()}`
			)
		} else {
			fail(`artifact pairCount ${pairCount.toLocaleString()} != DB-derived ${expected.size.toLocaleString()}`)
		}

		// 3. Full membership sweep.
		const resolver = new PairIndexResolver(bytes)
		let misses = 0
		let wrongTag = 0
		let wrongParentTag = 0

		for (const [, [child, parent]] of expected) {
			const edge = resolver.probe(child, parent)

			if (edge === undefined) {
				misses++
			} else if (edge.tag !== "locality") {
				wrongTag++
			} else if (edge.parentTag !== "region") {
				// PIX2: the sweep grades BOTH ends. The probe builder declares a locality→region edge in its
				// header, so an entry whose recorded parent tag is anything else is a builder bug the pre-PIX2
				// sweep could not have seen.
				wrongParentTag++
			}
		}

		if (misses === 0 && wrongTag === 0 && wrongParentTag === 0) {
			console.log(`  SWEEP OK: all ${expected.size.toLocaleString()} expected pairs probe → locality under region`)
		} else {
			fail(
				`membership sweep: ${misses} expected pairs missing, ${wrongTag} with a tag other than locality, ` +
					`${wrongParentTag} with a parent tag other than region`
			)
		}

		// 4. Named receipts.
		for (const probe of namedProbes) {
			const edge = resolver.probe(normalizeFSTToken(probe.child), normalizeFSTToken(probe.parent))
			const present = edge !== undefined
			const ok = probe.expect === "present" ? present : !present

			const line = `("${probe.child}", "${probe.parent}") → ${
				edge ? `${edge.tag} under ${edge.parentTag}` : "(no entry)"
			} [expect ${probe.expect}]`

			if (ok) {
				console.log(`  PROBE OK: ${line}`)
			} else {
				fail(`probe ${line}`)
			}
		}
	}

	db.close()

	if (failures > 0) {
		throw new Error(`pair-index-hierarchy-verify: ${failures} failure(s)`)
	}

	console.log(`\nAll checks passed for: ${countries.join(", ")}`)
}

await runIfScript(import.meta, main)
