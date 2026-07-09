/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Train the CROSS-SOURCE link scorer (#655 option 2 — unblocked 2026-07-06). The dedup GBT (#603)
 *   is trained on within-NPPES labels, so its strongest feature (`spatial-exact × name-disagree`)
 *   REJECTS the prototypical cross-source pair ("same provider, different operational text across
 *   registries") — the reason the cross-dataset flows pin the FS baseline. The 2026-06-16
 *   feasibility doc blocked a cross-source retrain on "no non-circular anchor"; the anchor exists:
 *   **CMS Open Payments joins NPPES by NPI** — the same practitioner in two INDEPENDENT registries,
 *   each with independently human-entered name + address. Same-NPI cross-source pairs are
 *   ground-truth positives labeled by a key the matcher's features never see.
 *
 *   Pipeline (mirrors train-gbt.ts): assemble NPPES + Open Payments TX records for the same NPI
 *   population → geocode both through the standard ingest → block over the UNION, keep only
 *   CROSS-source candidate pairs → featurize with the SHARED `createMatchFeaturizer` (train ≡
 *   inference) → label by NPI → held-out-NPI calibration (the #655 threshold rule: max recall
 *   subject to a pairwise-precision bar, reported alongside F1-max) → train the shipped model on
 *   all pairs → emit `registry/models/crosssource-gbt-en-us.ts`.
 *
 *   Sources (both public domain, `.notes/data-sources.md`):
 *
 *   - `nppes_npi-registry_*.tsv` — the practice-location + primary-name records.
 *   - `openpayments_covered-recipient-profile_*.csv` — the OP profile supplement (NPI, profile
 *       first/last, profile practice address).
 *
 *   Run: node scripts/eval/record-matcher/train-cross-gbt.ts\
 *   [--state TX] [--npis 2000] [--precision-bar 0.95] [--wof <admin.db>] [--data-root <dir>]\
 *   [--out registry/models/crosssource-gbt-en-us.ts]
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parseArgs } from "node:util"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath, mailwomanDataRoot } from "@mailwoman/core/utils"
import { block, gbtScore, trainGBT } from "@mailwoman/match"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import {
	addressFrequencyKey,
	buildDefaultModel,
	createMatchFeaturizer,
	defaultBlockingKeys,
	geocodeAddressVia,
	ingestRows,
	streamRows,
	type ColumnMapping,
	type SourceRecord,
} from "@mailwoman/registry"
import { createWOFResolver } from "@mailwoman/resolver"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import { TextSpliterator } from "spliterator"

// Loose scan parity with the retired local argv helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: {
		"data-root": { type: "string" },
		date: { type: "string" },
		locale: { type: "string" },
		npis: { type: "string" },
		out: { type: "string" },
		"precision-bar": { type: "string" },
		sources: { type: "string" },
		state: { type: "string" },
		wof: { type: "string" },
	},
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as {
	"data-root"?: string
	date?: string
	locale?: string
	npis?: string
	out?: string
	"precision-bar"?: string
	sources?: string
	state?: string
	wof?: string
}
const SOURCES = values["sources"] || String(dataRootPath("record-matcher", "sources"))
const STATE = (values["state"] || "TX").toUpperCase()
const NPIS = Number(values["npis"] || "2000")
const WOF = values["wof"] || String(dataRootPath("wof", "admin-global-priority.db"))
const DATA_ROOT = values["data-root"] || mailwomanDataRoot()
const OUT = values["out"] || "registry/models/crosssource-gbt-en-us.ts"
const LOCALE = values["locale"] || "en-US"
/** #655 threshold rule: max cross-source recall subject to this held-out pairwise precision. */
const PRECISION_BAR = Number(values["precision-bar"] || "0.95")
const TRAIN_DATE = values["date"] || new Date().toISOString().slice(0, 10)

const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`
const OP_PROFILE = `${SOURCES}/openpayments_covered-recipient-profile_20260603.csv`

const N = {
	npi: "NPI",
	entityType: "Entity Type Code",
	last: "Provider Last Name (Legal Name)",
	first: "Provider First Name",
	pAddr: "Provider First Line Business Practice Location Address",
	pCity: "Provider Business Practice Location Address City Name",
	pState: "Provider Business Practice Location Address State Name",
	pZip: "Provider Business Practice Location Address Postal Code",
}

const norm = (s: string | undefined) => (s ?? "").trim()
const addr = (line: string, city: string, st: string, zip: string) =>
	[norm(line), norm(city), norm(st), norm(zip)].filter(Boolean).join(", ")

interface MessyRow {
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
	// spliterator owns the line layer (crlf keeps header keys + the last column clean on CRLF sources);
	// the manual quote/pending re-join + tokenizer below stays deliberately — spliterator ≥ 3.2.0 CAN
	// do quote handling end-to-end, but this parse feeds model training, so its byte-for-byte behavior
	// is pinned until a re-validation run signs off a swap. Default skipEmpty drops truly-empty lines,
	// so a trailing newline can't inject a spurious empty row.
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

async function main(): Promise<void> {
	// --- Phase A: Open Payments TX practitioners (NPI + profile name + profile address). ---
	console.error(`[A] streaming the OP profile supplement (${STATE})…`)
	const opByNPI = new Map<string, MessyRow>()

	for await (const r of streamCSV(OP_PROFILE)) {
		if (opByNPI.size >= NPIS) break
		const npi = norm(r["Covered_Recipient_NPI"])
		const st = norm(r["Covered_Recipient_Profile_State"]).toUpperCase()

		if (!npi || st !== STATE || opByNPI.has(npi)) continue
		const name =
			`${norm(r["Covered_Recipient_Profile_First_Name"])} ${norm(r["Covered_Recipient_Profile_Last_Name"])}`.trim()
		const address = addr(
			r["Covered_Recipient_Profile_Address_Line_1"]!,
			r["Covered_Recipient_Profile_City"]!,
			st,
			r["Covered_Recipient_Profile_Zipcode"]!
		)

		if (!name || !address) continue
		opByNPI.set(npi, { npi, name, org: "", address, source: "openpayments" })
	}
	console.error(`    ${opByNPI.size} OP ${STATE} practitioners`)

	// --- Phase B: the SAME NPIs from NPPES (practice address + legal name) + the corpus-wide
	// address-frequency table (one full registry pass, identical to train-gbt). ---
	console.error("[B] full registry pass: address-frequency table + the NPI-joined NPPES rows…")
	const rows: MessyRow[] = []
	const joined = new Set<string>()
	const addrCounts = new Map<string, number>()
	let addrTotal = 0
	let scanned = 0

	for await (const r of streamRows(REGISTRY)) {
		if (++scanned % 1_000_000 === 0) {
			console.error(`    scanned ${scanned / 1e6}M, joined ${joined.size}`)
		}
		const practice = addr(r[N.pAddr]!, r[N.pCity]!, r[N.pState]!, r[N.pZip]!)

		if (practice) {
			const k = addressFrequencyKey(practice)
			addrCounts.set(k, (addrCounts.get(k) ?? 0) + 1)
			addrTotal++
		}
		const npi = norm(r[N.npi])

		if (!npi || !opByNPI.has(npi) || joined.has(npi) || !practice) continue

		// Practitioner-level matching: OP covered recipients are individuals (entity type 1).
		if (norm(r[N.entityType]) !== "1") continue
		const name = `${norm(r[N.first])} ${norm(r[N.last])}`.trim()

		if (!name) continue
		joined.add(npi)
		rows.push({ npi, name, org: "", address: practice, source: "nppes" })
	}

	// Keep only NPIs present in BOTH sources — every record has a cross-source counterpart.
	for (const npi of joined) {
		rows.push(opByNPI.get(npi)!)
	}
	const addressFrequency = {
		total: addrTotal,
		distinct: addrCounts.size,
		frequency: (v: string) => (v ? (addrCounts.get(addressFrequencyKey(v)) ?? 0) / addrTotal : 0),
	}
	console.error(`    ${joined.size} NPI-joined pairs → ${rows.length} records`)

	// --- Phase C: geocode + ingest (record.id = the NPI label; `source` rides the record). ---
	console.error("[C] geocoding…")
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: LOCALE })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new mod.WOFSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWOFResolver(lookup)
	const shardProvider = new ShardProvider(mod, DATA_ROOT)
	const seam = geocodeAddressVia({
		parse: async (raw: string) => decodeAsJSON(await classifier.parse(raw, { postcodeRepair: true })),
		geocode: (raw: string) =>
			geocodeAddress(raw, {
				classifier,
				resolver,
				shards: shardProvider.for,
				defaultCountry: "US",
				placeCountry: false,
			}),
		country: "US",
	})
	// `ColumnMapping.source` is a LITERAL provenance label — ingest each source separately so every
	// record carries its registry of origin (the cross-source filter + the sweep harness key on it).
	const mappingFor = (source: string): ColumnMapping => ({
		id: "npi",
		name: "name",
		organization: "org",
		address: "address",
		source,
	})
	const nppesRows = rows.filter((r) => r.source === "nppes")
	const opRows = rows.filter((r) => r.source === "openpayments")
	const records: SourceRecord[] = [
		...(await ingestRows(nppesRows as unknown as Record<string, string>[], mappingFor("nppes"), {
			geocodeAddress: seam,
		})),
		...(await ingestRows(opRows as unknown as Record<string, string>[], mappingFor("openpayments"), {
			geocodeAddress: seam,
		})),
	]
	shardProvider.close()
	lookup.close()
	console.error(`    ${records.length} records, ${records.filter((r) => r.address?.geocode).length} geocoded`)

	// --- Phase D: block over the UNION; keep only CROSS-source pairs; featurize; label by NPI. ---
	console.error("[D] blocking + featurizing (cross-source pairs only)…")
	const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons
	const featurize = createMatchFeaturizer({ comparisons, addressFrequency })
	const { pairs: allPairs } = block(records, defaultBlockingKeys())
	const pairs = allPairs.filter(([a, b]) => a.source !== b.source)
	const X = pairs.map(([a, b]) => featurize(a, b))
	const Y: number[] = pairs.map(([a, b]) => (a.id === b.id ? 1 : 0))
	const posRate = Y.reduce((s, y) => s + y, 0) / Math.max(1, Y.length)
	const W = Y.map((y) => (y === 1 ? 1 - posRate : posRate))
	console.error(
		`    ${allPairs.length} blocked pairs → ${pairs.length} cross-source (${(100 * posRate).toFixed(1)}% positive)`
	)

	// --- Phase E: held-out-NPI calibration — the #655 threshold rule. ---
	console.error("[E] held-out calibration…")
	const hyperparams = { rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 }
	const rnd = lcg(655)
	const split = new Map<string, "fit" | "holdout">()

	for (const npi of joined) {
		split.set(npi, rnd() < 0.8 ? "fit" : "holdout")
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
	console.error(
		`    held-out (${holdIdx.length} pairs, ${totalPos} pos): precision-bar ${PRECISION_BAR} → threshold ${recommendedThreshold.toFixed(3)} (recall ${(100 * barRecall).toFixed(1)}%); F1-max ${(100 * bestF1).toFixed(1)}% @ ${f1MaxThreshold.toFixed(3)}`
	)

	// --- Phase F: train the SHIPPED model on ALL cross-source pairs; emit the committed module. ---
	console.error("[F] training the shipped model on all pairs…")
	const model = trainGBT(X, Y, W, hyperparams)
	const meta = {
		version: "1.0.0",
		objective: "cross-source-link" as const,
		locale: LOCALE,
		trainedOn: TRAIN_DATE,
		state: STATE,
		npis: joined.size,
		records: records.length,
		pairs: pairs.length,
		posRate: Number(posRate.toFixed(4)),
		precisionBar: PRECISION_BAR,
		holdoutBarRecall: Number(barRecall.toFixed(4)),
		holdoutF1Max: Number(bestF1.toFixed(4)),
		hyperparams,
		recommendedThreshold: Number(recommendedThreshold.toFixed(4)),
		features: X[0]?.length ?? 0,
		sources: ["nppes", "openpayments"],
	}
	const moduleSource =
		`/**\n` +
		` * @copyright Sister Software\n` +
		` * @license AGPL-3.0\n` +
		` * @author Teffen Ellis, et al.\n` +
		` *\n` +
		` *   The CROSS-SOURCE link scorer (#655 option 2) — trained on NPI-joined NPPES ↔ Open Payments\n` +
		` *   pairs (the non-circular cross-registry anchor; both public domain). Scores "same provider,\n` +
		` *   different registry text" links the dedup GBT rejects by construction. Generated by\n` +
		` *   scripts/eval/record-matcher/train-cross-gbt.ts — retrain + re-run rather than editing.\n` +
		` */\n\n` +
		`import type { GBT } from "@mailwoman/match"\n\n` +
		`export const CROSS_SOURCE_GBT_META = ${JSON.stringify(meta)} as const\n\n` +
		`// prettier-ignore\n` +
		`export const CROSS_SOURCE_GBT_MODEL: GBT = ${JSON.stringify(model)}\n`
	mkdirSync(dirname(OUT), { recursive: true })
	writeFileSync(OUT, moduleSource)
	console.error(`    ${model.trees.length} trees, ${meta.features} features -> ${OUT}`)
}

await main()
