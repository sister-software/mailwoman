/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The served JP path through the RESOLVER: board rows geocoded with the CJK weights and the candidate gazetteer,
 *   graded on the board's own coordinate (#2164 step 6, the half the parse board cannot read).
 *
 *   Three things had to hold before a JP parse produced a coordinate at all, and this tool measured each: the placetype
 *   map routes `prefecture` / `municipality` / `district` (0 of 300 rows resolved without it), the admin ladder carries
 *   the JP rungs with `municipality` above `district` (202 vs 271 of 300 accepted @15 km), and the normalizer keeps the
 *   postal mark 〒 for the character path (171 vs 202 with the map and a district-first ladder). Shipped, the run reads
 *   271 of 300 (90.3%).
 *
 *   The `--split` arm reduces a compound municipality (`大島郡知名町` → `知名町`, `大阪市北区` → `北区`) to its trailing
 *   unit before the walk. Unscoped it LOSES rows (251 of 300): a bare ward resolves a namesake in another city
 *   (`神戸市西区` → Fukuoka, 407 km). A scoped form — the city resolved first, the ward probed as its child — is the
 *   design that arm is waiting for; the misses it would reach are the county-town rows that fall to the prefecture
 *   centroid (25–36 km).
 *
 *   Usage: node packages/mailwoman/lib/dev-tools/jp-served-resolve.run.ts [--board <jsonl>] [--rows 300] [--seed 42]
 *   [--split] [--normalize false] [--tolerance-km 15] [--trace 2] [--json <out>]
 */

import { dataRootPath, mailwomanDataRoot } from "@mailwoman/core/data-root"
import type { AddressNode } from "@mailwoman/core/decoder"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
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

/**
 * The trailing administrative unit of a compound municipality: the town after a county (`大島郡知名町` → `知名町`), the ward
 * after a city (`大阪市北区` → `北区`). A plain municipality is returned unchanged.
 */
export function trailingMunicipalityUnit(value: string): string {
	const county = /^.+郡(.+[町村])$/u.exec(value)

	if (county) return county[1]!

	const ward = /^.+市(.+区)$/u.exec(value)

	if (ward) return ward[1]!

	return value
}

function splitCompoundMunicipalities(node: AddressNode): AddressNode {
	const children = node.children?.map(splitCompoundMunicipalities)

	if (node.tag === "municipality") {
		return { ...node, value: trailingMunicipalityUnit(node.value), ...(children ? { children } : {}) }
	}

	return children ? { ...node, children } : node
}

const traces: unknown[] = []

function instrumented(resolver: Resolver, split: boolean, trace: boolean): Resolver {
	return {
		resolveTree: (tree, opts) =>
			resolver.resolveTree(split ? { ...tree, roots: tree.roots.map(splitCompoundMunicipalities) } : tree, {
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
			rows: { type: "string", default: "300" },
			seed: { type: "string", default: "42" },
			split: { type: "boolean", default: false },
			normalize: { type: "string", default: "true" },
			"tolerance-km": { type: "string", default: "15" },
			trace: { type: "string", default: "0" },
			json: { type: "string" },
		},
	})

	const boardPath =
		values.board ?? String(dataRootPath("corpus", "versioned", "v8-jp-full-2026-08-04", "jp-board.jsonl"))

	const wanted = Number(values.rows)
	const toleranceKm = Number(values["tolerance-km"])
	const traceRows = Number(values.trace)

	const all = await Array.fromAsync(JSONSpliterator.fromAsync<BoardRow>(boardPath))
	const random = mulberry32(Number(values.seed))

	const rows = all
		.map((row) => ({ row, key: random() }))
		.toSorted((a, b) => a.key - b.key)
		.slice(0, wanted)
		.map((entry) => entry.row)

	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "ja-JP" })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = await createResolverBackend(mod, { dataRoot: mailwomanDataRoot(), wofPaths: [] })
	const resolver = instrumented(createWOFResolver(lookup), values.split === true, traceRows > 0)

	const graded: GradedRow[] = []

	for (const [index, row] of rows.entries()) {
		traces.length = 0

		const outcome = (await geocodeAddress(row.raw, {
			classifier,
			resolver,
			defaultCountry: "JP",
			adminContainmentRerank: true,
			...(values.normalize === "false" ? { normalizeInput: false } : {}),
		})) as { lat: number | null; lon: number | null; resolution_tier?: string | null }

		const distanceKm =
			outcome.lat != null && outcome.lon != null ? haversineKm(row.lat, row.lon, outcome.lat, outcome.lon) : null

		if (index < traceRows) {
			console.log(`TRACE ${row.raw}`)

			for (const record of traces) {
				console.log(`  ${JSON.stringify(record).slice(0, 600)}`)
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
		`split=${values.split} normalize=${values.normalize} rows=${graded.length} resolved=${resolved} accepted@${toleranceKm}km=${accepted} (${((100 * accepted) / graded.length).toFixed(1)}%)`
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
		await writeLocalJSONFile({ split: values.split, toleranceKm, rows: graded }, values.json)
	}
}

runIfScript(import.meta, main)
