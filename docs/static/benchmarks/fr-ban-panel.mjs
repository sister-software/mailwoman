#!/usr/bin/env node
//
// fr-ban-panel — a 100-address French panel drawn from the Base Adresse Nationale, graded against
// BAN's own rooftop coordinate, in two surface forms.
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT
//
// The French rooftop tier IS the Base Adresse Nationale. `mailwoman data pull fr` downloads a shard
// built from BAN, and this panel grades Mailwoman's answer against the same register the answer was
// looked up in. That is circular, and it is stated on the published page beside every number it
// touches. What survives the circularity is still worth measuring: whether the pipeline PARSES the
// address into the spans the rooftop probe needs, whether it scopes the probe to the right commune,
// and whether it does both when the surface form is rearranged. A miss here is a parse or a routing
// failure, never a coordinate-accuracy failure. So read this panel as "does the address find its own
// row", not as "how accurate is the coordinate".
//
// TWO ARMS
//
//   clean      "28 Avenue de l'Opéra, 75002 Paris"      — the canonical French order.
//   reordered  "75002 Paris, 28 Avenue de l'Opéra"      — postcode and commune moved to the front.
//
// The second arm is the surface-form robustness test. Nothing about the target changed; only the
// order of the same tokens did.
//
// DETERMINISM
//
// The panel is a committed file (`fr-ban-sample.json`), not a fresh draw, so two runs on two machines
// grade the same 100 rows. `--resample` regenerates it from a local BAN shard using the seed below;
// the draw is a seeded pass over rowids, so the same seed against the same BAN release reproduces the
// same panel byte for byte. A different BAN release renumbers the rows and will produce a different
// panel — which is why the sample is committed rather than drawn at run time.
//
// USAGE
//
//   npm install mailwoman @mailwoman/neural @mailwoman/neural-weights-fr-fr \
//               @mailwoman/resolver @mailwoman/resolver-wof-sqlite @mailwoman/ban \
//               @mailwoman/core @mailwoman/spatial
//   mailwoman data pull candidate fr
//   node fr-ban-panel.mjs --data-root <DATA_ROOT> --out fr-ban-results.json
//
//   node fr-ban-panel.mjs --resample --data-root <DATA_ROOT>   # regenerate fr-ban-sample.json
//
// `--data-root` defaults to $MAILWOMAN_DATA_ROOT. The candidate gazetteer is read from
// <DATA_ROOT>/wof/candidate.db and the BAN shard from <DATA_ROOT>/ban/address-points-fr.db.

import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { BANShardProvider } from "@mailwoman/ban/sdk"
import { median, mulberry32, percentile } from "@mailwoman/core/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { resolveWeights } from "@mailwoman/neural/weights"
import { createWOFResolver } from "@mailwoman/resolver"
import { WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite"
import { haversineKm } from "@mailwoman/spatial"
import { geocodeAddress } from "mailwoman/geocode-core"

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The weights locale. The `fr-FR` package is a data-only overlay: it ships the French postcode, pair-index and FST
 * artifacts and takes `model.onnx` from the base package, which is what `versions.modelCard` against `versions.model`
 * records in the result file.
 */
const LOCALE = "fr-FR"

/** The committed draw seed. Changing it changes the panel, so it is a constant and not a flag. */
const SEED = 20_260_804

/** Rows in the panel. */
const PANEL_SIZE = 100

/**
 * Rowids drawn before deduplication. One row is kept per postcode, so the draw has to over-sample: dense postcodes (a
 * Paris arrondissement carries tens of thousands of points) are hit repeatedly and counted once.
 */
const DRAW_SIZE = 1200

/** Rows averaged to place a postcode's centroid. Capped so a dense postcode does not dominate the run. */
const CENTROID_SAMPLE = 2000

/**
 * A returned coordinate within this distance of BAN's own is counted as the exact row. One meter is below the precision
 * BAN publishes, so a hit at this radius means the same row was found rather than a neighbouring one.
 */
const EXACT_ROW_KM = 0.001

/**
 * A resolved coordinate this far from its postcode's centroid counts as routed to the right postcode area. French
 * postcodes are not one size — a Paris arrondissement spans about 2 km, a rural postcode can span 20 — so this is a
 * routing check and not a precision claim. The precision claim is the distance table.
 */
const ROUTING_KM = 15

const { values: flags } = parseArgs({
	options: {
		"data-root": { type: "string" },
		out: { type: "string", default: join(HERE, "fr-ban-results.json") },
		sample: { type: "string", default: join(HERE, "fr-ban-sample.json") },
		resample: { type: "boolean", default: false },
		limit: { type: "string" },
	},
})

// This file is served at /benchmarks/fr-ban-panel.mjs and runs in a READER's project, where
// `@mailwoman/core/env` — the blessed env helper inside this repo — is not a dependency.
// oxlint-disable-next-line sister-software/no-process-globals -- shipped doc asset; runs outside this repo
const dataRoot = flags["data-root"] ?? process.env.MAILWOMAN_DATA_ROOT

if (!dataRoot) {
	console.error("fr-ban-panel: pass --data-root <path> or set $MAILWOMAN_DATA_ROOT.")

	// oxlint-disable-next-line sister-software/no-process-globals -- shipped doc asset
	process.exit(1)
}

const banPath = join(dataRoot, "ban", "address-points-fr.db")
const candidatePath = join(dataRoot, "wof", "candidate.db")

//#region Address rendering

/**
 * Title-case a BAN `locality_norm` value. The column is lowercased and accent-stripped by the shard builder, so
 * `orleans` renders as `Orleans` and never as `Orléans`. That loss is real and the published page carries it as a
 * caveat: every panel row asks the pipeline for an unaccented commune.
 */
function titleCase(norm) {
	return norm.replaceAll(/(^|[\s'’-])(\p{L})/gu, (_, lead, letter) => lead + letter.toUpperCase())
}

/** The canonical French order: house number, street, postcode, commune. */
function cleanForm(row) {
	return `${row.number} ${row.street}, ${row.postcode} ${titleCase(row.locality)}`
}

/** The robustness arm: the same tokens with the postcode and commune moved to the front. */
function reorderedForm(row) {
	return `${row.postcode} ${titleCase(row.locality)}, ${row.number} ${row.street}`
}

//#endregion

//#region Resample

function resample() {
	const db = new DatabaseSync(banPath, { readOnly: true })

	try {
		const { m: maxRowid } = db.prepare("SELECT max(rowid) m FROM address_point").get()
		const release = db.prepare("SELECT release FROM address_point LIMIT 1").get().release

		const rowStatement = db.prepare(
			"SELECT number, street_raw, postcode, locality_norm, lat, lon FROM address_point WHERE rowid = ?"
		)

		const centroidStatement = db.prepare(
			`SELECT lat, lon FROM address_point WHERE postcode = ? LIMIT ${CENTROID_SAMPLE}`
		)

		const random = mulberry32(SEED)
		const seenPostcode = new Set()
		const rows = []

		for (let draw = 0; draw < DRAW_SIZE && rows.length < PANEL_SIZE; draw++) {
			const rowid = 1 + Math.floor(random() * maxRowid)
			const hit = rowStatement.get(rowid)

			// A drawn rowid can miss (a vacuumed gap) or land on a row with no postcode or commune to
			// render. Both are skipped rather than retried, so the draw stays a pure function of the seed.
			if (!hit?.postcode || !hit.locality_norm || !hit.street_raw || !hit.number) continue

			if (seenPostcode.has(hit.postcode)) continue

			seenPostcode.add(hit.postcode)

			const points = centroidStatement.all(hit.postcode)

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

		writeFileSync(flags.sample, `${JSON.stringify(panel, null, "\t")}\n`)

		console.error(`fr-ban-panel: wrote ${rows.length} rows to ${flags.sample} (BAN release ${release}).`)
	} finally {
		db.close()
	}
}

//#endregion

//#region Versions

/**
 * The three versions a differing re-run has to be able to tell apart: the code, the model, and the reference data.
 * Without them a reader whose numbers disagree with the published ones cannot tell data drift from code drift, which is
 * the whole value of publishing the result file next to the script.
 *
 * `resolveWeights` runs the same resolution order the classifier does, so this reports the artifact that was loaded
 * rather than the one that was asked for — including the base-package fallback the `fr-FR` overlay takes for its
 * `model.onnx`. Paths are dereferenced because a development checkout symlinks them into the workspace, and the symlink
 * name says nothing about which checkpoint is behind it. The BAN release itself is recorded separately, on the
 * committed panel file, because it is a property of the addresses rather than of the run.
 */
function versionStamp() {
	const require = createRequire(import.meta.url)
	const resolved = resolveWeights({ locale: LOCALE })
	const card = JSON.parse(readFileSync(resolved.modelCardPath, "utf8"))

	return {
		mailwoman: require("mailwoman/package.json").version,
		model: basename(realpathSync(resolved.modelPath)),
		modelCard: `${card.name}@${card.version}`,
		gazetteer: basename(realpathSync(candidatePath)),
		nationalShard: basename(realpathSync(banPath)),
	}
}

//#endregion

//#region Grading

function summarize(records) {
	const distances = records.filter((r) => r.km !== null).map((r) => r.km)
	const within = (km) => records.filter((r) => r.km !== null && r.km <= km).length
	// Bucketed on the tier that ANSWERED, which is `none` for a row that returned no coordinate:
	// `resolution_tier` reports where the cascade ended, not whether it produced anything, so it still
	// reads "admin" on a row that answered nothing. Every row on this panel resolved, so the two
	// bucketings agree here — the guard is in place so they cannot silently disagree on a future run.
	const tiers = {}

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
		medianKm: distances.length ? Number(median(distances).toFixed(4)) : null,
		p90Km: distances.length ? Number(percentile(distances, 90).toFixed(4)) : null,
		maxKm: distances.length ? Number(Math.max(...distances).toFixed(4)) : null,
		tiers,
	}
}

//#endregion

async function run() {
	const panel = JSON.parse(readFileSync(flags.sample, "utf8"))
	const rows = flags.limit ? panel.rows.slice(0, Number(flags.limit)) : panel.rows

	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: LOCALE })
	const lookup = new WOFCandidateTableLookup({ databasePath: candidatePath })
	const resolver = createWOFResolver(lookup)
	const banShards = new BANShardProvider(dataRoot)

	const arms = { clean: cleanForm, reordered: reorderedForm }
	const results = {}
	const startedAt = Date.now()

	try {
		for (const [arm, render] of Object.entries(arms)) {
			const records = []

			for (const row of rows) {
				const input = render(row)
				let result

				try {
					result = await geocodeAddress(input, {
						classifier,
						resolver,
						nationalShards: banShards.for,
						// Pinned: this panel is a French dataset run through a French pipeline, so it measures
						// resolution INSIDE France and makes no claim about country disambiguation.
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

				const hasCoordinate = typeof result.lat === "number" && typeof result.lon === "number"
				const km = hasCoordinate ? haversineKm(result.lat, result.lon, row.lat, row.lon) : null

				const routed =
					hasCoordinate &&
					haversineKm(result.lat, result.lon, row.postcodeCentroid.lat, row.postcodeCentroid.lon) <= ROUTING_KM

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
	} finally {
		lookup.close()
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
		versions: versionStamp(),
		config: {
			locale: LOCALE,
			defaultCountry: "FR",
			gazetteer: "candidate.db",
			nationalTier: "BAN FR rooftop shard",
			routingRadiusKm: ROUTING_KM,
		},
		arms: Object.fromEntries(Object.entries(results).map(([arm, r]) => [arm, r.summary])),
		records: Object.fromEntries(Object.entries(results).map(([arm, r]) => [arm, r.records])),
	}

	writeFileSync(flags.out, `${JSON.stringify(report, null, "\t")}\n`)

	for (const [arm, summary] of Object.entries(report.arms)) {
		console.log(
			`${arm.padEnd(10)} n=${summary.n} resolved=${summary.resolved} ` +
				`@1km=${summary.within1km} @5km=${summary.within5km} @25km=${summary.within25km} ` +
				`exact=${summary.exactRow} routed=${summary.routedToPostcodeArea} ` +
				`median=${summary.medianKm}km p90=${summary.p90Km}km max=${summary.maxKm}km`
		)
		console.log(`${" ".repeat(10)} tiers ${JSON.stringify(summary.tiers)}`)
	}

	console.log(`wrote ${resolve(flags.out)}`)
}

if (flags.resample) {
	resample()
} else {
	await run()
}
