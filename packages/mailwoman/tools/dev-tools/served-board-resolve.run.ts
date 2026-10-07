/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A coordinate board read through the resolver: board rows geocoded with the served weights and
 *   the candidate gazetteer, graded on the board's own coordinate.
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
		artifactCoverage: resolver.artifactCoverage,
		capabilityGaps: resolver.capabilityGaps,
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
	// The country the board's rows are in is derived from the locale's region subtag
	// rather than a per-country table, so it stays in step with the boards.
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
