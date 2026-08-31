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
 *   Pipeline: assemble NPPES + Open Payments TX records for the same NPI population (Phases A/B
 *   here), then the SHARED `trainCrossSourceModel` runs Phases C–F — geocode through the standard
 *   ingest → block the UNION, keep only CROSS-source candidate pairs → the SHARED
 *   `createMatchFeaturizer` (train ≡ inference) → label by NPI → held-out-NPI calibration (the #655
 *   threshold rule: max recall subject to a pairwise-precision bar, reported alongside F1-max) →
 *   train the shipped model on all pairs → emit `registry/models/crosssource-gbt-en-us.ts`.
 *
 *   Sources (both public domain, `.notes/data-sources.md`):
 *
 *   - `nppes_npi-registry_*.tsv` — the practice-location + primary-name records.
 *   - `openpayments_covered-recipient-profile_*.csv` — the OP profile supplement (NPI, profile
 *       first/last, profile practice address).
 *
 *   Run: `mailwoman registry train-scorer cross-gbt [--state TX] [--npis 2000]
 *   [--precision-bar 0.95] [--wof <admin.db>] [--data-root <dir>]
 *   [--out registry/models/crosssource-gbt-en-us.ts]`
 */

import { dataRootPath } from "@mailwoman/core/utils"

import { addressFrequencyKey, streamRows } from "#index"
import type { EvalGeocoderFactory } from "#tools/eval-geocoder"
import { addr, norm, NPPES_COLUMNS as N, stateOption, trainCrossSourceModel, type CrossSourceRow } from "#tools/shared"

/**
 * Options for {@linkcode trainCrossSourceGBT}.
 */
export interface TrainCrossSourceGBTOptions {
	/**
	 * The injected geocoder factory (the command wires `mailwoman/geocode-core`; see `./eval-geocoder.ts`).
	 */
	createGeocoder: EvalGeocoderFactory
	/**
	 * Record-matcher sources directory. Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources`.
	 */
	sources?: string
	/**
	 * State filter. Default TX.
	 */
	state?: string
	/**
	 * NPIs sampled. Default 2000.
	 */
	npis?: number
	/**
	 * Output TS module path. Default `registry/models/crosssource-gbt-en-us.ts`.
	 */
	out?: string
	/**
	 * Locale recorded in the model meta. Default en-US.
	 */
	locale?: string
	/**
	 * #655 threshold rule: max cross-source recall subject to this held-out pairwise precision. Default 0.95.
	 */
	precisionBar?: number
	/**
	 * Training date stamped into the meta. Default today.
	 */
	date?: string
}

/**
 * Train + emit the cross-source link GBT — see the module doc.
 */
export async function trainCrossSourceGBT(
	options: TrainCrossSourceGBTOptions,
	report?: (line: string) => void
): Promise<{ out: string; pairs: number; recommendedThreshold: number }> {
	const SOURCES = options.sources || String(dataRootPath("record-matcher", "sources"))
	const STATE = stateOption(options)
	const NPIS = options.npis ?? 2000
	const OUT = options.out || "packages/registry/models/crosssource-gbt-en-us.ts"
	const LOCALE = options.locale || "en-US"
	// #655 threshold rule: max cross-source recall subject to this held-out pairwise precision.
	const PRECISION_BAR = options.precisionBar ?? 0.95
	const TRAIN_DATE = options.date || new Date().toISOString().slice(0, 10)

	const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`
	const OP_PROFILE = `${SOURCES}/openpayments_covered-recipient-profile_20260603.csv`

	// --- Phase A: Open Payments TX practitioners (NPI + profile name + profile address). ---
	report?.(`[A] streaming the OP profile supplement (${STATE})…`)
	const opByNPI = new Map<string, CrossSourceRow>()

	for await (const r of streamRows(OP_PROFILE)) {
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

	report?.(`    ${opByNPI.size} OP ${STATE} practitioners`)

	// --- Phase B: the SAME NPIs from NPPES (practice address + legal name) + the corpus-wide
	// address-frequency table (one full registry pass, identical to train-gbt). ---
	report?.("[B] full registry pass: address-frequency table + the NPI-joined NPPES rows…")
	const rows: CrossSourceRow[] = []
	const joined = new Set<string>()
	const addrCounts = new Map<string, number>()
	let addrTotal = 0
	let scanned = 0

	for await (const r of streamRows(REGISTRY)) {
		if (++scanned % 1_000_000 === 0) {
			report?.(`    scanned ${scanned / 1e6}M, joined ${joined.size}`)
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

	report?.(`    ${joined.size} NPI-joined pairs → ${rows.length} records`)

	// --- Phases C–F: the SHARED cross-source trainer (geocode → cross-source pairs → #655 calibration
	// → shipped model → committed module). ---
	return trainCrossSourceModel({
		createGeocoder: options.createGeocoder,
		rows,
		joined,
		addressFrequency,
		sources: ["nppes", "openpayments"],
		precisionBar: PRECISION_BAR,
		out: OUT,
		exportPrefix: "CROSS_SOURCE_GBT",
		moduleDoc:
			` *   The CROSS-SOURCE link scorer (#655 option 2) — trained on NPI-joined NPPES ↔ Open Payments\n` +
			` *   pairs (the non-circular cross-registry anchor; both public domain). Scores "same provider,\n` +
			` *   different registry text" links the dedup GBT rejects by construction. Generated by\n` +
			` *   \`mailwoman registry train-scorer cross-gbt\` (registry/tools/train-cross-gbt.ts) — retrain + re-run rather than editing.\n`,
		meta: (figures) => ({
			version: "1.0.0",
			objective: "cross-source-link",
			locale: LOCALE,
			trainedOn: TRAIN_DATE,
			state: STATE,
			npis: joined.size,
			records: figures.records,
			pairs: figures.pairs,
			posRate: figures.posRate,
			precisionBar: PRECISION_BAR,
			holdoutBarRecall: figures.barRecall,
			holdoutF1Max: figures.f1Max,
			hyperparams: figures.hyperparams,
			recommendedThreshold: figures.recommendedThreshold,
			features: figures.features,
			sources: ["nppes", "openpayments"],
		}),
		report,
	})
}
