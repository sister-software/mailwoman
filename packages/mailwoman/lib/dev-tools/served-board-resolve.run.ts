/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A coordinate board read through the resolver: board rows geocoded with the served weights and the candidate
 *   gazetteer, graded on the board's own coordinate (#2164 step 6, the half a parse board cannot read).
 *
 *   The parse board and this one answer different questions. A parse board decodes spans and looks a predicted
 *   (region, locality) pair up in a centroid table. this runs the pipeline a caller runs and grades the coordinate it
 *   returns. A locale can read well on the first and resolve no place on the second, so `scope.mdx`'s rule — a locale is
 *   claimed when a coordinate-graded eval exists for it — is answered here.
 *
 *   `--locale` and `--country` are flags rather than constants because every CJK board has the same shape and a tool
 *   named for one of them grows a copy per country instead of an argument.
 *
 *   Three things had to hold before a JP parse produced a coordinate at all, and this tool measured each: the placetype
 *   map routes `prefecture` / `municipality` / `district` (0 of 300 rows resolved without it), the admin ladder carries
 *   the JP rungs with `municipality` above `district` (202 vs 271 of 300 accepted @15 km), and the normalizer keeps the
 *   postal mark 〒 for the character path (171 vs 202 with the map and a district-first ladder). The resolver's scoped
 *   pair for a compound municipality (`compoundMunicipality`, #2175) then took 271 to 282 of 300. the same split
 *   applied unscoped before the walk had read 251, because a bare ward resolves a namesake in another city.
 *
 *   Usage: node packages/mailwoman/lib/dev-tools/served-board-resolve.run.ts [--board <jsonl>] [--locale ja-JP]
 *   [--country JP] [--rows 300] [--seed 42] [--normalize false] [--tolerance-km 15] [--trace 2] [--json <out>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { mulberry32 } from "@mailwoman/core/random"
import type { Resolver } from "@mailwoman/core/resolver"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { JSONSpliterator } from "spliterator"

import { geocodeAddress } from "#geocode/core"
import { createResolverBackend } from "#resolver-backend"

interface BoardRow {
	raw: string
	register: string
	lon: number
	lat: number
}

interface GradedRow {
	raw: string
	register: string
	lat: number | null
	lon: number | null
	tier: string | null
	distanceKm: number | null
	accepted: boolean
}

const traces: unknown[] = []

function instrumented(resolver: Resolver, trace: boolean): Resolver {
	return {
		resolveTree: (tree, opts) =>
			resolver.resolveTree(tree, {
				...opts,
				...(trace ? { traceSink: (record) => traces.push(record) } : {}),
			}),
		...(resolver.findPlace ? { findPlace: resolver.findPlace } : {}),
	}
}

async function main(): Promise<void> {
	const { values } = parseArguments({
		options: {
			board: { type: "string" },
			locale: { type: "string", default: "ja-JP" },
			country: { type: "string" },
			rows: { type: "string", default: "300" },
			seed: { type: "string", default: "42" },
			normalize: { type: "string", default: "true" },
			"tolerance-km": { type: "string", default: "15" },
			trace: { type: "string", default: "0" },
			json: { type: "string" },
		},
	})

	const boardPath = values.board ?? dataRootPath("corpus", "versioned", "v8-jp-full-2026-08-04", "jp-board.jsonl")

	const wanted = Number(values.rows)
	const toleranceKm = Number(values["tolerance-km"])
	const traceRows = Number(values.trace)

	const all = await JSONSpliterator.fromAsync<BoardRow>(boardPath).toArray()
	const random = mulberry32(Number(values.seed))

	const rows = all
		.map((row) => ({ row, key: random() }))
		.toSorted((a, b) => a.key - b.key)
		.slice(0, wanted)
		.map((entry) => entry.row)

	const locale = values.locale
	// The country the board's rows are in, which scopes the resolve.
	// It defaults from the locale's region subtag rather than a table: `zh-TW` is a
	// Taiwanese board by construction, and a lookup keyed on locale would be one more
	// per-country list to keep in step with the boards themselves.
	const country = (values.country ?? locale.split("-").at(-1) ?? "").toUpperCase()

	if (country.length !== 2) {
		throw new Error(`--country could not be derived from --locale ${locale}; pass it explicitly`)
	}

	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = await createResolverBackend(mod, { dataRoot: dataRootPath(), wofPaths: [] })
	const resolver = instrumented(createWOFResolver(lookup), traceRows > 0)

	const graded: GradedRow[] = []

	for (const [index, row] of rows.entries()) {
		traces.length = 0

		const outcome = (await geocodeAddress(row.raw, {
			classifier,
			resolver,
			defaultCountry: country,
			adminContainmentRerank: true,
			...(values.normalize === "false" ? { normalizeInput: false } : {}),
		})) as { lat: number | null; lon: number | null; resolution_tier?: string | null }

		const distanceKm =
			outcome.lat != null && outcome.lon != null ? haversineKm(row.lat, row.lon, outcome.lat, outcome.lon) : null

		if (index < traceRows) {
			console.log(`TRACE ${row.raw}`)

			for (const record of traces) {
				console.log(`  ${stringifyJSON(record).slice(0, 600)}`)
			}
		}

		graded.push({
			raw: row.raw,
			register: row.register,
			lat: outcome.lat,
			lon: outcome.lon,
			tier: outcome.resolution_tier ?? null,
			distanceKm,
			accepted: distanceKm != null && distanceKm <= toleranceKm,
		})
	}

	const resolved = graded.filter((row) => row.lat != null).length
	const accepted = graded.filter((row) => row.accepted).length
	const byRegister = new Map<string, { n: number; accepted: number }>()

	for (const row of graded) {
		const bucket = byRegister.get(row.register) ?? { n: 0, accepted: 0 }

		bucket.n += 1
		bucket.accepted += row.accepted ? 1 : 0
		byRegister.set(row.register, bucket)
	}

	console.log(
		`locale=${locale} country=${country} board=${boardPath} normalize=${values.normalize} rows=${graded.length} resolved=${resolved} accepted@${toleranceKm}km=${accepted} (${((100 * accepted) / graded.length).toFixed(1)}%)`
	)

	for (const [register, bucket] of [...byRegister].toSorted()) {
		console.log(`  ${register}: ${bucket.accepted}/${bucket.n}`)
	}

	for (const row of graded.filter((r) => !r.accepted).slice(0, 12)) {
		console.log(
			`  MISS ${row.raw}  → ${row.lat ?? "-"},${row.lon ?? "-"} tier=${row.tier ?? "-"} d=${row.distanceKm?.toFixed(1) ?? "-"}`
		)
	}

	if (values.json) {
		await writeLocalJSONFile({ locale, country, board: boardPath.toString(), toleranceKm, rows: graded }, values.json)
	}
}

runIfScript(import.meta, main)
