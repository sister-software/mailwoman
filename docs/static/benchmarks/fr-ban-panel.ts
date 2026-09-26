#!/usr/bin/env node
//
// fr-ban-panel — a 100-address French panel drawn from the Base Adresse Nationale, graded against BAN's own rooftop coordinate in two surface forms.
//
// The extract this grades against is the same register the answer is looked up in, so the panel is circular and measures whether an address finds its own row — a parse or routing failure, never coordinate accuracy.
//
// The two arms are the canonical French order (`28 Avenue de l'Opéra, 75002 Paris`) and the same tokens with the postcode and commune moved to the front.
//
// The panel is a committed file (`fr-ban-sample.json`), so two runs on two machines grade the same 100 rows; `--resample` regenerates it from a local BAN extract with the seed below.
//
// usage
//
//   npm install mailwoman @mailwoman/neural @mailwoman/neural-weights-fr-fr \
//               @mailwoman/resolver @mailwoman/resolver-wof-sqlite @mailwoman/ban \
//               @mailwoman/core @mailwoman/spatial
//   mailwoman data pull candidate fr node fr-ban-panel.mjs --data-root <DATA_ROOT> --out fr-ban-results.json
//
//   node fr-ban-panel.mjs --resample --data-root <DATA_ROOT> # regenerate fr-ban-sample.json
//
// `--data-root` defaults to $MAILWOMAN_DATA_ROOT. The candidate gazetteer is read from <DATA_ROOT>/db/wof/candidate.db and the BAN extract from <DATA_ROOT>/db/ban/address-points-fr.db.

import { banDatabaseRoot } from "@mailwoman/ban/paths"
import { BANRegionDatabaseProvider } from "@mailwoman/ban/sdk"
import { readLocalJSONFile, realPath } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { createRequire } from "@mailwoman/core/module/resolvers"
import { mulberry32 } from "@mailwoman/core/random"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { median, percentile } from "@mailwoman/core/stats"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { resolveWeights } from "@mailwoman/neural/weights"
import { createWOFResolver } from "@mailwoman/resolver"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite"
import type { AddressPointDatabase } from "@mailwoman/resolver-wof-sqlite/address"
import { wofDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { geocodeAddress } from "mailwoman/geocode"
import { basename, PathBuilder, resolvePath } from "path-ts"

const HERE = PathBuilder.from(import.meta.dirname)

/**
 * The weights locale, a data-only `fr-FR` overlay that ships the French artifacts
 * and takes `model.onnx` from the base package.
 */
const LOCALE = "fr-FR"

/**
 * The committed draw seed, a constant rather than a flag because changing it changes the panel.
 */
const SEED = 20_260_804

const PANEL_SIZE = 100

/**
 * Rowids drawn before deduplication, over-sampled because one row is kept per postcode
 * and dense postcodes are hit repeatedly.
 */
const DRAW_SIZE = 1200

/**
 * Rows averaged to place a postcode's centroid, capped so a dense postcode does not dominate the run.
 */
const CENTROID_SAMPLE = 2000

/**
 * A returned coordinate within this distance of BAN's own counts as the exact row,
 * one meter being below the precision BAN publishes.
 */
const EXACT_ROW_KM = 0.001

/**
 * A resolved coordinate this far from its postcode's centroid counts as routed
 * to the right postcode area, a routing check rather than a precision claim
 * because French postcodes span from about 2 km to 20.
 */
const ROUTING_KM = 15

const { values: flags } = parseArguments({
	options: {
		"data-root": { type: "string" },
		// Strings, because an option default has the option's type.
		out: { type: "string", default: HERE("fr-ban-results.json").toString() },
		sample: { type: "string", default: HERE("fr-ban-sample.json").toString() },
		resample: { type: "boolean", default: false },
		limit: { type: "string" },
	},
})

// oxlint-disable-next-line sister-software/no-process-globals -- shipped doc asset. runs outside this repo
const dataRoot = flags["data-root"] ?? process.env.MAILWOMAN_DATA_ROOT

if (!dataRoot) {
	console.error("fr-ban-panel: pass --data-root <path> or set $MAILWOMAN_DATA_ROOT.")

	// oxlint-disable-next-line sister-software/no-process-globals -- shipped doc asset
	process.exit(1)

	// Throwing states the branch's end, since `process.exit` is typed `never` only when the checker can see it.
	throw new Error("unreachable")
}

/**
 * The checked data root, bound once because module-level narrowing does not reach into function bodies.
 */
const DATA_ROOT = PathBuilder.from(dataRoot)

const banPath = banDatabaseRoot(DATA_ROOT)("address-points-fr.db")
const candidatePath = wofDatabaseRoot(DATA_ROOT)("candidate.db")

interface PanelFile {
	source: string
	generated: string
	seed: number
	release: string | null
	rows: PanelRow[]
}

interface PanelRow {
	number: string
	street: string
	postcode: string
	locality: string
	lat: number
	lon: number
	postcodeCentroid: { lat: number; lon: number; n: number }
}

/**
 * One graded answer, whose `km` is null when the pipeline returned no coordinate,
 * which {@link summarize} keeps apart from a far-away one.
 */
interface GradedRecord {
	km: number | null
	tier?: string | null
	routed?: boolean
}

//#region Address rendering

/**
 * Title-case a BAN `locality_norm` value, which the extract builder lowercases
 * and strips of accents, so every panel row asks for an unaccented commune.
 */
function titleCase(norm: string): string {
	return norm.replaceAll(
		/(^|[\s'’-])(\p{L})/gu,
		(_: string, lead: string, letter: string) => lead + letter.toUpperCase()
	)
}

function cleanForm(row: PanelRow): string {
	return `${row.number} ${row.street}, ${row.postcode} ${titleCase(row.locality)}`
}

function reorderedForm(row: PanelRow): string {
	return `${row.postcode} ${titleCase(row.locality)}, ${row.number} ${row.street}`
}

//#endregion

//#region Resample

async function resample(): Promise<void> {
	using db = new DatabaseClient<AddressPointDatabase>(banPath, { readOnly: true })

	const { m: maxRowid } = db.prepare("SELECT max(rowid) m FROM address_point").get() as { m: number }

	const release = (db.prepare("SELECT release FROM address_point LIMIT 1").get() as { release: string | null }).release

	const rowStatement = db.prepare(
		"SELECT number, street_raw, postcode, locality_norm, lat, lon FROM address_point WHERE rowid = ?"
	)

	const centroidStatement = db.prepare(`SELECT lat, lon FROM address_point WHERE postcode = ? LIMIT ${CENTROID_SAMPLE}`)

	const random = mulberry32(SEED)
	const seenPostcode = new Set()
	const rows = []

	for (let draw = 0; draw < DRAW_SIZE && rows.length < PANEL_SIZE; draw++) {
		const rowid = 1 + Math.floor(random() * maxRowid)
		const hit = rowStatement.get(rowid)

		// A drawn rowid can miss or lack a postcode or commune, and both are skipped
		// rather than retried so the draw stays a pure function of the seed.
		if (!hit?.postcode || !hit.locality_norm || !hit.street_raw || !hit.number) continue

		if (seenPostcode.has(hit.postcode)) continue

		seenPostcode.add(hit.postcode)

		const points = centroidStatement.all(hit.postcode) as Array<{ lat: number; lon: number }>

		const centroid = {
			lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
			lon: points.reduce((sum, p) => sum + p.lon, 0) / points.length,
			n: points.length,
		}

		rows.push({
			number: hit.number,
			street: hit.street_raw,
			postcode: hit.postcode,
			locality: hit.locality_norm,
			lat: hit.lat,
			lon: hit.lon,
			postcodeCentroid: centroid,
		})
	}

	const panel = {
		source: "Base Adresse Nationale (BAN), via `mailwoman data pull fr`",
		license: "Licence Ouverte / Open Licence — https://adresse.data.gouv.fr/",
		release,
		seed: SEED,
		drawSize: DRAW_SIZE,
		centroidSampleCap: CENTROID_SAMPLE,
		note: "One row per postcode. Coordinates are BAN's own; they are the grading target.",
		rows,
	}

	await writeLocalTextFile(prettyJSON(panel), flags.sample)

	console.error(`fr-ban-panel: wrote ${rows.length} rows to ${flags.sample} (BAN release ${release}).`)
}

//#endregion

//#region Versions

/**
 * The code, model, and reference-data versions a differing re-run must tell apart,
 * reporting the artifact `resolveWeights` actually loaded rather than the one asked for
 * and dereferencing paths past development symlinks.
 */
async function versionStamp() {
	const require = createRequire(import.meta.url)
	const resolved = await resolveWeights({ locale: LOCALE })

	// The stamp is the point of this function, so a missing card is a failure to report rather than a field to omit.
	if (!resolved.modelCardPath) throw new Error("fr-ban-panel: the resolved weights bundle carries no model card.")

	const card = await readLocalJSONFile<{ name: string; version: string }>(resolved.modelCardPath)

	return {
		mailwoman: (require("mailwoman/package.json") as { version: string }).version,
		model: basename(await realPath(resolved.modelPath)),
		modelCard: `${card.name}@${card.version}`,
		gazetteer: basename(await realPath(candidatePath)),
		nationalExtract: basename(await realPath(banPath)),
	}
}

//#endregion

//#region Grading

function summarize(records: GradedRecord[]) {
	const distances = records.flatMap((r) => (r.km === null ? [] : [r.km]))
	const within = (km: number): number => records.filter((r) => r.km !== null && r.km <= km).length
	// Bucketed on the tier that answered with `none` for a row that returned no coordinate,
	// because `resolution_tier` reports where the cascade ended rather than whether it produced anything.
	const tiers: Record<string, number> = {}

	for (const record of records) {
		const bucket = record.km === null ? "none" : (record.tier ?? "none")

		tiers[bucket] = (tiers[bucket] ?? 0) + 1
	}

	return {
		n: records.length,
		resolved: distances.length,
		within1km: within(1),
		within5km: within(5),
		within25km: within(25),
		exactRow: records.filter((r) => r.km !== null && r.km <= EXACT_ROW_KM).length,
		routedToPostcodeArea: records.filter((r) => r.routed).length,
		medianKm: distances.length ? Number((median(distances) ?? 0).toFixed(4)) : null,
		p90Km: distances.length ? Number((percentile(distances, 90) ?? 0).toFixed(4)) : null,
		maxKm: distances.length ? Number(Math.max(...distances).toFixed(4)) : null,
		tiers,
	}
}

//#endregion

async function run() {
	const panel = await readLocalJSONFile<PanelFile>(flags.sample)
	const rows = flags.limit ? panel.rows.slice(0, Number(flags.limit)) : panel.rows

	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: LOCALE })
	using lookup = new WOFCandidateTableLookup({ databasePath: candidatePath })
	const resolver = createWOFResolver(lookup)
	const banExtracts = new BANRegionDatabaseProvider(DATA_ROOT)

	const arms: Record<string, (row: PanelRow) => string> = { clean: cleanForm, reordered: reorderedForm }
	const results: Record<string, { summary: ReturnType<typeof summarize>; records: GradedRecord[] }> = {}
	const startedAt = Date.now()

	for (const [arm, render] of Object.entries(arms)) {
		const records = []

		for (const row of rows) {
			const input = render(row)
			let result

			try {
				result = await geocodeAddress(input, {
					classifier,
					resolver,
					nationalDatabases: banExtracts.for,
					// Pinned to `FR`, so the panel measures resolution inside France
					// and makes no claim about country disambiguation.
					defaultCountry: "FR",
				})
			} catch (error) {
				records.push({
					input,
					error: error instanceof Error ? error.message : String(error),
					km: null,
					tier: null,
					routed: false,
				})

				continue
			}

			// Capture the coordinates rather than the object: narrowing `result` does not narrow `result.lat`.
			const answer =
				typeof result.lat === "number" && typeof result.lon === "number" ? { lat: result.lat, lon: result.lon } : null

			const km = answer ? haversineKm(answer.lat, answer.lon, row.lat, row.lon) : null

			const routed =
				answer !== null &&
				haversineKm(answer.lat, answer.lon, row.postcodeCentroid.lat, row.postcodeCentroid.lon) <= ROUTING_KM

			records.push({
				input,
				expected: { lat: row.lat, lon: row.lon, postcode: row.postcode, locality: row.locality },
				got: { lat: result.lat, lon: result.lon },
				parsed: {
					house_number: result.house_number,
					street: result.street,
					postcode: result.postcode,
					locality: result.locality,
				},
				countryCode: result.countryCode,
				tier: result.resolution_tier,
				km: km === null ? null : Number(km.toFixed(4)),
				routed,
			})
		}

		results[arm] = { summary: summarize(records), records }
	}

	const report = {
		harness: "fr-ban-panel.mjs",
		ranAt: new Date().toISOString(),
		elapsedMs: Date.now() - startedAt,
		panel: {
			source: panel.source,
			release: panel.release,
			seed: panel.seed,
			rows: rows.length,
		},
		versions: await versionStamp(),
		config: {
			locale: LOCALE,
			defaultCountry: "FR",
			gazetteer: "candidate.db",
			nationalTier: "BAN FR rooftop extract",
			routingRadiusKm: ROUTING_KM,
		},
		arms: Object.fromEntries(Object.entries(results).map(([arm, r]) => [arm, r.summary])),
		records: Object.fromEntries(Object.entries(results).map(([arm, r]) => [arm, r.records])),
	}

	await writeLocalTextFile(prettyJSON(report), flags.out)

	for (const [arm, summary] of Object.entries(report.arms)) {
		console.log(
			`${arm.padEnd(10)} n=${summary.n} resolved=${summary.resolved} ` +
				`@1km=${summary.within1km} @5km=${summary.within5km} @25km=${summary.within25km} ` +
				`exact=${summary.exactRow} routed=${summary.routedToPostcodeArea} ` +
				`median=${summary.medianKm}km p90=${summary.p90Km}km max=${summary.maxKm}km`
		)
		console.log(`${" ".repeat(10)} tiers ${stringifyJSON(summary.tiers)}`)
	}

	console.log(`wrote ${resolvePath(flags.out)}`)
}

await (flags.resample ? resample() : run())
