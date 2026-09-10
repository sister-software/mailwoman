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
 *   Pipeline: national CCN join → one record per source per facility (Phases A/B here), then the
 *   SHARED `trainCrossSourceModel` runs Phases C–F — geocode → block the UNION, keep only
 *   CROSS-source pairs → the SHARED featurizer → label by CCN → held-out-CCN calibration (max
 *   recall s.t. precision ≥ bar) → train on all pairs → emit
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

import { dataRootPath } from "@mailwoman/core/data-root"
import { isoDate } from "@mailwoman/core/utils"

import { addressFrequencyKey, streamRows } from "#index"
import type { EvalGeocoderFactory } from "#tools/eval-geocoder"
import { addr, norm, trainCrossSourceModel, type CrossSourceRow } from "#tools/shared"

/**
 * Options for {@linkcode trainOrgCrossSourceGBT}.
 */
export interface TrainOrgCrossSourceGBTOptions {
	/**
	 * The injected geocoder factory (the command wires `mailwoman/geocode-core`; see `./eval-geocoder.ts`).
	 */
	createGeocoder: EvalGeocoderFactory
	/**
	 * Record-matcher sources directory. Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources`.
	 */
	sources?: string
	/**
	 * Care Compare facilities sampled. Default 6000.
	 */
	cap?: number
	/**
	 * Output TS module path. Default `registry/models/org-crosssource-gbt-en-us.ts`.
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
 * Train + emit the org-level cross-source link GBT — see the module doc. The CCN is the cross-system facility key; it
 * rides {@link CrossSourceRow.npi} → `record.id` as the held-out label.
 */
export async function trainOrgCrossSourceGBT(
	options: TrainOrgCrossSourceGBTOptions,
	report?: (line: string) => void
): Promise<{ out: string; pairs: number; recommendedThreshold: number }> {
	const SOURCES = options.sources || String(dataRootPath("record-matcher", "sources"))
	const CAP = options.cap ?? 6000
	const OUT = options.out || "packages/registry/lib/models/org-crosssource-gbt-en-us.ts"
	const LOCALE = options.locale || "en-US"
	// #655 threshold rule: max cross-source recall subject to this held-out pairwise precision.
	const PRECISION_BAR = options.precisionBar ?? 0.95
	const TRAIN_DATE = options.date || isoDate()

	const POS = `${SOURCES}/cms-pos_hospital-other_2026q1.csv`
	const CARE_COMPARE = `${SOURCES}/cms-carecompare_hospital-general_20260706.csv`

	// --- Phase A: Care Compare (Facility ID + name + address). ---
	report?.("[A] streaming Care Compare…")
	const ccByID = new Map<string, CrossSourceRow>()

	for await (const r of streamRows(CARE_COMPARE)) {
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
	const rows: CrossSourceRow[] = []
	const joined = new Set<string>()
	const addrCounts = new Map<string, number>()
	let addrTotal = 0

	for await (const r of streamRows(POS)) {
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

	// --- Phases C–F: the SHARED cross-source trainer (geocode → cross-source pairs → #655 calibration
	// → shipped model → committed module). ---
	return trainCrossSourceModel({
		createGeocoder: options.createGeocoder,
		rows,
		joined,
		addressFrequency,
		sources: ["cms-pos", "care-compare"],
		precisionBar: PRECISION_BAR,
		out: OUT,
		exportPrefix: "ORG_CROSS_SOURCE_GBT",
		moduleDoc:
			` *   The ORG-LEVEL cross-source link scorer (#655 follow-on) — trained on CCN-joined CMS POS ↔\n` +
			` *   Care Compare facility pairs (both public domain). Scores "same facility, different registry\n` +
			` *   text" links for org-level cross-dataset flows. Generated by\n` +
			` *   \`mailwoman registry train-scorer org-cross-gbt\` (registry/tools/train-org-cross-gbt.ts) — retrain rather than editing.\n`,
		meta: (figures) => ({
			version: "1.0.0",
			objective: "org-cross-source-link",
			locale: LOCALE,
			trainedOn: TRAIN_DATE,
			facilities: joined.size,
			records: figures.records,
			pairs: figures.pairs,
			posRate: figures.posRate,
			precisionBar: PRECISION_BAR,
			holdoutBarRecall: figures.barRecall,
			holdoutF1Max: figures.f1Max,
			hyperparams: figures.hyperparams,
			recommendedThreshold: figures.recommendedThreshold,
			features: figures.features,
			sources: ["cms-pos", "care-compare"],
		}),
		report,
	})
}
