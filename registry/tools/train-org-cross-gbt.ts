/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Train the ORG-LEVEL cross-source link scorer (#655 follow-on, 2026-07-06). The practitioner
 *   cross-source GBT does not transfer to organization records (its person-name features go dark),
 *   so the org-level cross-dataset flows pin the FS baseline. The org anchor: **CMS Provider of
 *   Services joins Care Compare by CCN** — the same facility in two separately-maintained CMS
 *   systems (certification vs quality reporting), each with independently-entered name + address.
 *   Measured drift across the national join (n≈5.4k): 12.2% name, 4.9% address — the rename /
 *   system-vs-facility / acquisition class the org objective exists for.
 *
 *   Pipeline: national CCN join → one record per source per facility → geocode → block the UNION,
 *   keep only CROSS-source pairs → the SHARED featurizer → label by CCN → held-out-CCN calibration
 *   (max recall s.t. precision ≥ bar) → train on all pairs → emit
 *   `registry/models/org-crosssource-gbt-en-us.ts`.
 *
 *   Sources (both public domain, direct CSVs):
 *
 *   - `cms-pos_hospital-other_*.csv` — Provider of Services (PRVDR_NUM, FAC_NAME, ST_ADR…).
 *   - `cms-carecompare_hospital-general_*.csv` — Care Compare (Facility ID, Facility Name, Address…).
 *
 *   Run: `mailwoman registry train-scorer org-cross-gbt [--cap 6000] [--precision-bar 0.95]
 *   [--wof <admin.db>] [--data-root <dir>] [--out registry/models/org-crosssource-gbt-en-us.ts]`
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { dataRootPath } from "@mailwoman/core/utils"
import { block, gbtScore, trainGBT } from "@mailwoman/match"
import {
	addressFrequencyKey,
	buildDefaultModel,
	createMatchFeaturizer,
	defaultBlockingKeys,
	ingestRows,
	type ColumnMapping,
	type SourceRecord,
} from "@mailwoman/registry"
import { TextSpliterator } from "spliterator"

import type { EvalGeocoderFactory } from "./eval-geocoder.ts"

/** Options for {@linkcode trainOrgCrossSourceGBT}. */
export interface TrainOrgCrossSourceGBTOptions {
	/** The injected geocoder factory (the command wires `mailwoman/geocode-core`; see `./eval-geocoder.ts`). */
	createGeocoder: EvalGeocoderFactory
	/** Record-matcher sources directory. Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources`. */
	sources?: string
	/** Care Compare facilities sampled. Default 6000. */
	cap?: number
	/** Output TS module path. Default `registry/models/org-crosssource-gbt-en-us.ts`. */
	out?: string
	/** Locale recorded in the model meta. Default en-US. */
	locale?: string
	/** #655 threshold rule: max cross-source recall subject to this held-out pairwise precision. Default 0.95. */
	precisionBar?: number
	/** Training date stamped into the meta. Default today. */
	date?: string
}

const norm = (s: string | undefined) => (s ?? "").trim()
const addr = (line: string, city: string, st: string, zip: string) =>
	[norm(line), norm(city), norm(st), norm(zip)].filter(Boolean).join(", ")

interface MessyRow {
	/** The CCN — the cross-system facility key; rides `record.id` as the held-out label. */
	npi: string
	name: string
	org: string
	address: string
	source: string
}

/** Deterministic LCG (no Math.random — reproducible split + commit). */
function lcg(seed: number): () => number {
	let s = seed >>> 0 || 1

	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0

		return s / 0x100000000
	}
}

/** Up to `n` unique sorted-quantile values from a sorted score array — link-threshold candidates. */
function uniqueQuantiles(sorted: number[], n: number): number[] {
	if (sorted.length === 0) return [0]
	const ts = new Set<number>()

	for (let k = 0; k <= n; k++) {
		ts.add(sorted[Math.floor((k / n) * (sorted.length - 1))]!)
	}

	return [...ts]
}

/** Stream a comma CSV with quoted fields (the OP profile format) as header-keyed rows. */
async function* streamCSV(path: string): AsyncGenerator<Record<string, string>> {
	// spliterator owns the line layer (crlf is load-bearing here: the CMS POS file IS CRLF, and the
	// last column ZIP_CD + the header keys would otherwise carry a stray \r); the manual quote/pending
	// re-join + tokenizer below stays deliberately — spliterator ≥ 3.2.0 CAN do quote handling
	// end-to-end, but this parse feeds model training, so its byte-for-byte behavior is pinned until a
	// re-validation run signs off a swap. Default skipEmpty drops truly-empty lines, so a trailing
	// newline can't inject a spurious empty row.
	let header: string[] | null = null
	let pending = ""

	for await (const rawLine of TextSpliterator.fromAsync(path, { crlf: true })) {
		// Re-join physical lines until quotes balance (quoted fields may contain newlines).
		pending = pending ? `${pending}\n${rawLine}` : rawLine
		const quotes = (pending.match(/"/g) ?? []).length

		if (quotes % 2 === 1) continue
		const line = pending
		pending = ""
		const cells: string[] = []
		let cur = ""
		let inQ = false

		for (let i = 0; i < line.length; i++) {
			const ch = line[i]!

			if (inQ) {
				if (ch === '"') {
					if (line[i + 1] === '"') {
						cur += '"'
						i++
					} else {
						inQ = false
					}
				} else {
					cur += ch
				}
			} else if (ch === '"') {
				inQ = true
			} else if (ch === ",") {
				cells.push(cur)
				cur = ""
			} else {
				cur += ch
			}
		}
		cells.push(cur)

		if (!header) {
			header = cells

			continue
		}
		const row: Record<string, string> = {}

		for (let i = 0; i < header.length; i++) {
			row[header[i]!] = cells[i] ?? ""
		}
		yield row
	}
}

/** Train + emit the org-level cross-source link GBT — see the module doc. */
export async function trainOrgCrossSourceGBT(
	options: TrainOrgCrossSourceGBTOptions,
	report?: (line: string) => void
): Promise<{ out: string; pairs: number; recommendedThreshold: number }> {
	const SOURCES = options.sources || String(dataRootPath("record-matcher", "sources"))
	const CAP = options.cap ?? 6000
	const OUT = options.out || "registry/models/org-crosssource-gbt-en-us.ts"
	const LOCALE = options.locale || "en-US"
	// #655 threshold rule: max cross-source recall subject to this held-out pairwise precision.
	const PRECISION_BAR = options.precisionBar ?? 0.95
	const TRAIN_DATE = options.date || new Date().toISOString().slice(0, 10)

	const POS = `${SOURCES}/cms-pos_hospital-other_2026q1.csv`
	const CARE_COMPARE = `${SOURCES}/cms-carecompare_hospital-general_20260706.csv`

	// --- Phase A: Care Compare (Facility ID + name + address). ---
	report?.("[A] streaming Care Compare…")
	const ccByID = new Map<string, MessyRow>()

	for await (const r of streamCSV(CARE_COMPARE)) {
		if (ccByID.size >= CAP) break
		const ccn = norm(r["Facility ID"])
		const name = norm(r["Facility Name"])
		const address = addr(r["Address"]!, r["City/Town"]!, r["State"]!, r["ZIP Code"]!)

		if (!ccn || !name || !address) continue
		ccByID.set(ccn, { npi: ccn, name, org: name, address, source: "care-compare" })
	}
	report?.(`    ${ccByID.size} Care Compare facilities`)

	// --- Phase B: the SAME CCNs from the POS file + the corpus-wide address-frequency table. ---
	report?.("[B] streaming POS + building the frequency table…")
	const rows: MessyRow[] = []
	const joined = new Set<string>()
	const addrCounts = new Map<string, number>()
	let addrTotal = 0

	for await (const r of streamCSV(POS)) {
		const address = addr(r["ST_ADR"]!, r["CITY_NAME"]!, r["STATE_CD"]!, r["ZIP_CD"]!)

		if (address) {
			const k = addressFrequencyKey(address)
			addrCounts.set(k, (addrCounts.get(k) ?? 0) + 1)
			addrTotal++
		}
		const ccn = norm(r["PRVDR_NUM"])

		if (!ccn || !ccByID.has(ccn) || joined.has(ccn) || !address) continue
		const name = norm(r["FAC_NAME"])

		if (!name) continue
		joined.add(ccn)
		rows.push({ npi: ccn, name, org: name, address, source: "cms-pos" })
	}

	for (const ccn of joined) {
		rows.push(ccByID.get(ccn)!)
	}
	const addressFrequency = {
		total: addrTotal,
		distinct: addrCounts.size,
		frequency: (v: string) => (v ? (addrCounts.get(addressFrequencyKey(v)) ?? 0) / addrTotal : 0),
	}
	report?.(`    ${joined.size} CCN-joined facilities → ${rows.length} records`)

	// --- Phase C: geocode + ingest (record.id = the NPI label; `source` rides the record). The heavy
	// geocoder is injected (see ./eval-geocoder.ts). ---
	report?.("[C] geocoding…")
	const geocoder = await options.createGeocoder()
	// `ColumnMapping.source` is a LITERAL provenance label — ingest each source separately so every
	// record carries its registry of origin (the cross-source filter + the sweep harness key on it).
	const mappingFor = (source: string): ColumnMapping => ({
		id: "npi",
		name: "name",
		organization: "org",
		address: "address",
		source,
	})
	const posRows = rows.filter((r) => r.source === "cms-pos")
	const ccRows = rows.filter((r) => r.source === "care-compare")
	const records: SourceRecord[] = [
		...(await ingestRows(posRows as unknown as Record<string, string>[], mappingFor("cms-pos"), {
			geocodeAddress: geocoder.seam,
		})),
		...(await ingestRows(ccRows as unknown as Record<string, string>[], mappingFor("care-compare"), {
			geocodeAddress: geocoder.seam,
		})),
	]
	geocoder.close()
	report?.(`    ${records.length} records, ${records.filter((r) => r.address?.geocode).length} geocoded`)

	// --- Phase D: block over the UNION; keep only CROSS-source pairs; featurize; label by NPI. ---
	report?.("[D] blocking + featurizing (cross-source pairs only)…")
	const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons
	const featurize = createMatchFeaturizer({ comparisons, addressFrequency })
	const { pairs: allPairs } = block(records, defaultBlockingKeys())
	const pairs = allPairs.filter(([a, b]) => a.source !== b.source)
	const X = pairs.map(([a, b]) => featurize(a, b))
	const Y: number[] = pairs.map(([a, b]) => (a.id === b.id ? 1 : 0))
	const posRate = Y.reduce((s, y) => s + y, 0) / Math.max(1, Y.length)
	const W = Y.map((y) => (y === 1 ? 1 - posRate : posRate))
	report?.(
		`    ${allPairs.length} blocked pairs → ${pairs.length} cross-source (${(100 * posRate).toFixed(1)}% positive)`
	)

	// --- Phase E: held-out-NPI calibration — the #655 threshold rule. ---
	report?.("[E] held-out calibration…")
	const hyperparams = { rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 }
	const rnd = lcg(655)
	const split = new Map<string, "fit" | "holdout">()

	for (const ccn of joined) {
		split.set(ccn, rnd() < 0.8 ? "fit" : "holdout")
	}
	const fitIdx = pairs
		.map((_, i) => i)
		.filter((i) => split.get(pairs[i]![0].id) === "fit" && split.get(pairs[i]![1].id) === "fit")
	const holdIdx = pairs
		.map((_, i) => i)
		.filter((i) => split.get(pairs[i]![0].id) === "holdout" && split.get(pairs[i]![1].id) === "holdout")
	const calib = trainGBT(
		fitIdx.map((i) => X[i]!),
		fitIdx.map((i) => Y[i]!),
		fitIdx.map((i) => W[i]!),
		hyperparams
	)
	const holdScores = holdIdx.map((i) => ({ s: gbtScore(calib, X[i]!), y: Y[i]! }))
	const sorted = holdScores.map((h) => h.s).sort((a, b) => a - b)
	const totalPos = holdScores.reduce((s, h) => s + h.y, 0)
	let recommendedThreshold = Number.POSITIVE_INFINITY
	let barRecall = 0
	let f1MaxThreshold = 0
	let bestF1 = -1

	for (const t of uniqueQuantiles(sorted, 60)) {
		let tp = 0
		let fp = 0

		for (const h of holdScores) {
			if (h.s < t) continue

			if (h.y) {
				tp++
			} else {
				fp++
			}
		}
		const precision = tp + fp > 0 ? tp / (tp + fp) : 1
		const recall = totalPos > 0 ? tp / totalPos : 0
		const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0

		// The #655 rule: the LOWEST threshold whose precision clears the bar (maximizes recall under it).
		if (precision >= PRECISION_BAR && recall > barRecall) {
			barRecall = recall
			recommendedThreshold = t
		}

		if (f1 > bestF1) {
			bestF1 = f1
			f1MaxThreshold = t
		}
	}

	if (!Number.isFinite(recommendedThreshold)) {
		recommendedThreshold = f1MaxThreshold
	}
	report?.(
		`    held-out (${holdIdx.length} pairs, ${totalPos} pos): precision-bar ${PRECISION_BAR} → threshold ${recommendedThreshold.toFixed(3)} (recall ${(100 * barRecall).toFixed(1)}%); F1-max ${(100 * bestF1).toFixed(1)}% @ ${f1MaxThreshold.toFixed(3)}`
	)

	// --- Phase F: train the SHIPPED model on ALL cross-source pairs; emit the committed module. ---
	report?.("[F] training the shipped model on all pairs…")
	const model = trainGBT(X, Y, W, hyperparams)
	const meta = {
		version: "1.0.0",
		objective: "org-cross-source-link" as const,
		locale: LOCALE,
		trainedOn: TRAIN_DATE,
		facilities: joined.size,
		records: records.length,
		pairs: pairs.length,
		posRate: Number(posRate.toFixed(4)),
		precisionBar: PRECISION_BAR,
		holdoutBarRecall: Number(barRecall.toFixed(4)),
		holdoutF1Max: Number(bestF1.toFixed(4)),
		hyperparams,
		recommendedThreshold: Number(recommendedThreshold.toFixed(4)),
		features: X[0]?.length ?? 0,
		sources: ["cms-pos", "care-compare"],
	}
	const moduleSource =
		`/**\n` +
		` * @copyright Sister Software\n` +
		` * @license AGPL-3.0\n` +
		` * @author Teffen Ellis, et al.\n` +
		` *\n` +
		` *   The ORG-LEVEL cross-source link scorer (#655 follow-on) — trained on CCN-joined CMS POS ↔\n` +
		` *   Care Compare facility pairs (both public domain). Scores "same facility, different registry\n` +
		` *   text" links for org-level cross-dataset flows. Generated by\n` +
		` *   \`mailwoman registry train-scorer org-cross-gbt\` (registry/tools/train-org-cross-gbt.ts) — retrain rather than editing.\n` +
		` */\n\n` +
		`import type { GBT } from "@mailwoman/match"\n\n` +
		`export const ORG_CROSS_SOURCE_GBT_META = ${JSON.stringify(meta)} as const\n\n` +
		`// prettier-ignore\n` +
		`export const ORG_CROSS_SOURCE_GBT_MODEL: GBT = ${JSON.stringify(model)}\n`
	mkdirSync(dirname(OUT), { recursive: true })
	writeFileSync(OUT, moduleSource)
	report?.(`    ${model.trees.length} trees, ${meta.features} features -> ${OUT}`)

	return { out: OUT, pairs: pairs.length, recommendedThreshold }
}
