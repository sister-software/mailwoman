/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared helpers for the `registry/tools` probe battery.
 *
 *   The rule: anything reused by two or more probes belongs here; anything a single probe needs
 *   stays with that probe.
 */

import { makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { isPresent } from "@mailwoman/core/objects"
import { makeLcg } from "@mailwoman/core/utils"
import { block, gbtScore, trainGBT, type TermFrequencyTable } from "@mailwoman/match"
import { dirname } from "path-ts"

import {
	addressFrequencyKey,
	buildDefaultModel,
	createMatchFeaturizer,
	defaultBlockingKeys,
	ingestRows,
	normalizePhoneStrict,
	streamRows,
	type ColumnMapping,
	type SourceRecord,
} from "#index"
import type { EvalGeocoderFactory } from "#tools/eval-geocoder"
import type { Score } from "#tools/nppes/scoring"

export { mean } from "@mailwoman/core/utils"

/**
 * One source a cross-source probe ingests: where it lives, the column mapping, and an in-state filter.
 */
export interface SourceSpec {
	source: string
	path: string
	mapping: ColumnMapping
	/**
	 * Keep only rows in-state (reads the row's state column).
	 */
	inState: (row: Record<string, string>) => boolean
	/**
	 * Optional: a row carries ≥1 addressable entity — yield each as its own row. Default identity.
	 */
	explode?: (row: Record<string, string>) => Record<string, string>[]
}

/**
 * Trim, treating `undefined` as empty — the shape every probe's raw CSV columns arrive in.
 */
export const norm = (s: string | undefined): string => (s ?? "").trim()

/**
 * Corporate-form suffixes and function words that carry no identity — dropped from an organization name before its
 * tokens are compared, so the domain words carry the distinguishing signal.
 */
const ORGANIZATION_STOP_WORDS = new Set([
	"llc",
	"inc",
	"incorporated",
	"corp",
	"corporation",
	"co",
	"ltd",
	"pllc",
	"pc",
	"pa",
	"lp",
	"llp",
	"the",
	"of",
	"and",
])

/**
 * The token set of an organization name: lower-cased, non-alphanumerics folded to spaces, stop words removed.
 *
 * NOT a canonical form — `@mailwoman/record`'s `canonicalizeOrganizationName` is the stronger canonical key
 * (jurisdiction-aware designation stripping, a DBA split). This set serves the probes' cheap Jaccard overlap over raw
 * registry names, never blocking or display.
 */
export function orgTokens(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.replaceAll(/[^a-z0-9 ]/g, " ")
			.split(/\s+/)
			.filter((t) => t && !ORGANIZATION_STOP_WORDS.has(t))
	)
}

/**
 * Join the four US address columns into one line, dropping blanks.
 */
export const addr = (line: string, city: string, st: string, zip: string): string =>
	[norm(line), norm(city), norm(st), norm(zip)].filter(isPresent).join(", ")

/**
 * Population standard deviation; `0` on an empty sample, because these feed report tables that print a number per row.
 */
export const std = (xs: readonly number[]): number => {
	const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)

	return Math.sqrt(xs.map((x) => (x - m) ** 2).reduce((a, b) => a + b, 0) / Math.max(1, xs.length))
}

// NOTE(phase4): pct keeps the fraction-in/no-%-suffix shape — not core formatPercent's
// numerator/denominator contract (call sites append their own "%").
export const pct = (x: number): string => (100 * x).toFixed(1)

/**
 * Sign prefix for a signed delta — `"+"` for a non-negative value (a negative one carries its own sign).
 */
export const sgn = (x: number): string => (x >= 0 ? "+" : "")

/**
 * Logistic function with the input clamped to +/-30 — past that `Math.exp` underflows to 0 and the gradient step
 * silently becomes a no-op.
 */
export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))))

/**
 * The probes' shared `--state` option: upper-cased, defaulting to TX (the benchmark corpus state).
 */
export const stateOption = (options: { state?: string }): string => (options.state || "TX").toUpperCase()

/**
 * Texas bounding box (generous) — the shared wrong-region test.
 */
export const TX_BBOX = { latMin: 25.8, latMax: 36.6, lonMin: -106.7, lonMax: -93.4 }

/**
 * Whether a coordinate falls inside {@link TX_BBOX}.
 */
export const inTXBBOX = (lat: number, lon: number): boolean =>
	lat >= TX_BBOX.latMin && lat <= TX_BBOX.latMax && lon >= TX_BBOX.lonMin && lon <= TX_BBOX.lonMax

/**
 * NPPES registry column headers, by the short name the probes read them under.
 *
 * The NPI registry export is a ~330-column TSV with headers this long, so every probe that touches it needs this map,
 * and five of them had grown their own copy. The copies were a NESTED SUPERSET chain, not a disagreement -- each new
 * probe took the previous one's map and appended what it additionally read -- so this is the widest of the five, and no
 * consumer loses a column. Reading extra keys costs nothing: they are inert strings, and nothing enumerates this object
 * (checked: no `Object.keys`/`values`/`entries`/spread over it anywhere in `tools/`), so adding a column can never
 * change a probe's behavior.
 */
export const NPPES_COLUMNS = {
	npi: "NPI",
	entityType: "Entity Type Code",
	orgLegal: "Provider Organization Name (Legal Business Name)",
	last: "Provider Last Name (Legal Name)",
	first: "Provider First Name",
	pAddr: "Provider First Line Business Practice Location Address",
	pCity: "Provider Business Practice Location Address City Name",
	pState: "Provider Business Practice Location Address State Name",
	pZip: "Provider Business Practice Location Address Postcode",
	pPhone: "Provider Business Practice Location Address Telephone Number",
	mAddr: "Provider First Line Business Mailing Address",
	mCity: "Provider Business Mailing Address City Name",
	mState: "Provider Business Mailing Address State Name",
	mZip: "Provider Business Mailing Address Postcode",
	otherOrg: "Provider Other Organization Name",
	authLast: "Authorized Official Last Name",
	authFirst: "Authorized Official First Name",
	isSubpart: "Is Organization Subpart",
	parentLBN: "Parent Organization LBN",
	parentTIN: "Parent Organization TIN",
	// #625 taxonomy discriminator: the 15 taxonomy slots; collected as a set (any shared code = agreement).
	taxonomy: Array.from({ length: 15 }, (_, i) => `Healthcare Provider Taxonomy Code_${i + 1}`),
}

/**
 * Groups below this size are too small for a held-out split to mean anything.
 */
export const MIN_GROUP_SIZE = 5

/**
 * Gradient-descent epochs for {@link trainLogisticRegression}. Fixed rather than early-stopped so seeds stay comparable.
 */
export const TRAINING_EPOCHS = 400

/**
 * Smallest mean F1 gap counted as a real difference between models rather than seed noise. Verdicts inside ±this are
 * reported as a tie.
 */
export const MIN_MEANINGFUL_F1_DELTA = 0.02

/**
 * Batch-gradient-descent learning rate for {@link trainLogisticRegression}.
 */
export const LR_LEARNING_RATE = 0.1

/**
 * L2 regularization strength for {@link trainLogisticRegression}.
 */
export const LR_L2 = 1e-3

/**
 * L2-regularized logistic regression by batch gradient descent ({@link TRAINING_EPOCHS} epochs) — the probes' linear
 * arm. `w` carries the per-sample class weights (the caller up-weights the rare class). Returns the linear scorer: the
 * logit, not the probability, threshold-comparable across a fixed feature layout.
 */
export function trainLogisticRegression(
	X: readonly (readonly number[])[],
	y: readonly number[],
	w: readonly number[],
	dim: number
): (x: readonly number[]) => number {
	const weights = new Array<number>(dim).fill(0)
	let bias = 0

	for (let epoch = 0; epoch < TRAINING_EPOCHS; epoch++) {
		const gw = new Array<number>(dim).fill(0)
		let gb = 0

		for (let i = 0; i < X.length; i++) {
			let z = bias

			for (let j = 0; j < dim; j++) {
				z += weights[j]! * X[i]![j]!
			}

			const err = (sigmoid(z) - y[i]!) * w[i]!

			for (let j = 0; j < dim; j++) {
				gw[j]! += err * X[i]![j]!
			}

			gb += err
		}

		for (let j = 0; j < dim; j++) {
			weights[j]! -= LR_LEARNING_RATE * (gw[j]! / X.length + LR_L2 * weights[j]!)
		}

		bias -= LR_LEARNING_RATE * (gb / X.length)
	}

	return (x) => {
		let z = bias

		for (let j = 0; j < x.length; j++) {
			z += weights[j]! * x[j]!
		}

		return z
	}
}

/**
 * `n + 1` evenly-spaced order statistics of an already-sorted sample, de-duplicated — the candidate split thresholds a
 * GBT node considers. `[0]` for an empty sample so a degenerate feature still yields one (useless but well-formed)
 * threshold rather than an empty split set.
 */
export function uniqueQuantiles(sorted: readonly number[], n: number): number[] {
	if (!sorted.length) return [0]
	const ts = new Set<number>()

	for (let k = 0; k <= n; k++) {
		ts.add(sorted[Math.floor((k / n) * (sorted.length - 1))]!)
	}

	return [...ts]
}

/**
 * Quantile points swept per learned-scorer arm.
 */
const THRESHOLD_QUANTILE_POINTS = 32

/**
 * Link-threshold candidates for a learned scorer: de-duplicated quantiles of the scorer's own eval-pair score
 * distribution across the 0.2–0.999 quantile band — fine enough that a coarse grid can't understate an arm.
 */
export const quantileThresholds = (scores: readonly number[]): number[] => {
	const sorted = [...scores].toSorted((p, q) => p - q)
	const ts = new Set<number>()

	for (let k = 0; k <= THRESHOLD_QUANTILE_POINTS; k++) {
		ts.add(sorted[Math.floor((0.2 + (0.999 - 0.2) * (k / THRESHOLD_QUANTILE_POINTS)) * (sorted.length - 1))]!)
	}

	return [...ts]
}

/**
 * One clustering arm's operating point, as the eval tables print it.
 */
export interface ArmScore {
	precision: number
	recall: number
	f1: number
	overMerged: number
}

/**
 * Project a full {@link Score} onto the arm shape the eval tables print.
 */
export const toArmScore = (s: Score): ArmScore => ({
	precision: s.precision,
	recall: s.recall,
	f1: s.f1,
	overMerged: s.overMergedClusters,
})

/**
 * The best-F1 operating point over a threshold sweep.
 */
export function bestOver(thresholds: readonly number[], scoreAt: (threshold: number) => ArmScore): ArmScore {
	let best: ArmScore = { precision: 0, recall: 0, f1: -1, overMerged: 0 }

	for (const t of thresholds) {
		const s = scoreAt(t)

		if (s.f1 > best.f1) {
			best = s
		}
	}

	return best
}

/**
 * One organization provider at its practice address, as the geocode-free co-location probes read it — the union of what
 * `dedup-ceiling` and `gold-set-sample` each collect.
 */
export interface ColocatedProvider {
	npi: string
	org: string
	tokens: Set<string>
	/**
	 * The composed practice address ({@link addr}), the string the adjudication packets carry.
	 */
	address: string
	/**
	 * Strict last-10-digit phone key; `""` when the column carries fewer than 10 digits.
	 */
	phone: string
	/**
	 * Authorized official, `"last first"`, lowercased.
	 */
	auth: string
	/**
	 * Primary taxonomy (specialty) code.
	 */
	taxonomy: string
	subpart: boolean
	/**
	 * `parentLBN|parentTIN`, lowercased — `"|"` when both are blank.
	 */
	parent: string
}

/**
 * What {@link scanColocatedProviders} collects.
 */
export interface ColocatedScan {
	/**
	 * Providers grouped by their normalized practice-address key.
	 */
	byAddr: Map<string, ColocatedProvider[]>
	kept: number
	scanned: number
}

/**
 * Stream in-state type-2 (organization) providers from the registry — one record per row at its practice address,
 * grouped by `addressFrequencyKey`. Geocode-free on purpose, so it runs at large caps in seconds.
 */
export async function scanColocatedProviders(options: {
	registryPath: string
	state: string
	cap: number
}): Promise<ColocatedScan> {
	const { registryPath, state, cap } = options
	const C = NPPES_COLUMNS
	const byAddr = new Map<string, ColocatedProvider[]>()
	let kept = 0
	let scanned = 0

	for await (const r of streamRows(registryPath)) {
		scanned++

		if (norm(r[C.entityType]) !== "2") continue

		if (norm(r[C.pState]).toUpperCase() !== state) continue
		const org = norm(r[C.orgLegal])
		const line1 = norm(r[C.pAddr])

		if (!org || !line1) continue
		const address = addr(line1, r[C.pCity]!, state, r[C.pZip]!)
		const addrKey = addressFrequencyKey(address)

		if (!addrKey) continue

		const provider: ColocatedProvider = {
			npi: norm(r[C.npi]),
			org,
			tokens: orgTokens(org),
			address,
			phone: normalizePhoneStrict(r[C.pPhone]),
			auth: `${norm(r[C.authLast])} ${norm(r[C.authFirst])}`.toLowerCase().trim(),
			taxonomy: norm(r[C.taxonomy[0]!]),
			subpart: norm(r[C.isSubpart]).toUpperCase() === "Y",
			parent: `${norm(r[C.parentLBN])}|${norm(r[C.parentTIN])}`.toLowerCase(),
		}

		if (!byAddr.has(addrKey)) {
			byAddr.set(addrKey, [])
		}

		byAddr.get(addrKey)!.push(provider)

		kept++

		if (kept >= cap) break
	}

	return { byAddr, kept, scanned }
}

/**
 * One co-located distinct-NPI pair, with the address group it came from.
 */
export interface ColocatedPair {
	a: ColocatedProvider
	b: ColocatedProvider
	/**
	 * The distinct-NPI providers at the shared address, length ≥ 2. One array reference per group, so a consumer tracking
	 * group-level tallies can detect the group boundary by identity.
	 */
	group: readonly ColocatedProvider[]
}

/**
 * Every unordered pair of DISTINCT NPIs sharing a practice-address key — the over-merge population. Providers are
 * de-duplicated per address by NPI (first record wins); single-NPI addresses yield nothing.
 */
export function* colocatedDistinctPairs(
	byAddr: ReadonlyMap<string, readonly ColocatedProvider[]>
): Generator<ColocatedPair> {
	for (const providers of byAddr.values()) {
		const distinct = new Map<string, ColocatedProvider>()

		for (const p of providers)
			if (!distinct.has(p.npi)) {
				distinct.set(p.npi, p)
			}

		const group = [...distinct.values()]

		if (group.length < 2) continue

		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				yield { a: group[i]!, b: group[j]!, group }
			}
		}
	}
}

/**
 * The TX facility source specs the cross-source probes share. `cross-dataset-correlation` composes these with its own
 * commitments spec (the exploded two-entity-per-row source).
 */
export const buildSpecs = (S: string, STATE: string): SourceSpec[] => [
	{
		source: "txhhsc-nursing",
		path: `${S}/txhhsc_nursing-facilities_20260611.tsv`,
		mapping: {
			id: "Facility ID",
			organization: "Facility Name",
			address: ["Physical Address", "Physical Address CITY", "Physical Address State", "Physical Address Zipcode"],
			phone: "Facility Phone Number",
			source: "txhhsc-nursing",
		},
		inState: (r) => norm(r["Physical Address State"]).toUpperCase() === STATE,
	},
	{
		source: "fcc-rhc",
		path: `${S}/fcc-rhc_posted-services_form461-465_20260615.tsv`,
		mapping: {
			id: "HCP Number",
			organization: "HCP Name",
			address: ["Site Address Line 1", "Site City", "Site State", "Site ZIP Code"],
			phone: "Contact Phone",
			email: "Contact E-mail",
			source: "fcc-rhc",
		},
		inState: (r) => norm(r["Site State"]).toUpperCase() === STATE,
	},
	{
		source: "nppes",
		path: `${S}/nppes_npi-registry_20260607.tsv`,
		mapping: {
			id: NPPES_COLUMNS.npi,
			organization: NPPES_COLUMNS.orgLegal,
			address: [NPPES_COLUMNS.pAddr, NPPES_COLUMNS.pCity, NPPES_COLUMNS.pState, NPPES_COLUMNS.pZip],
			phone: NPPES_COLUMNS.pPhone,
			source: "nppes",
		},
		inState: (r) =>
			norm(r[NPPES_COLUMNS.pState]).toUpperCase() === STATE &&
			norm(r[NPPES_COLUMNS.entityType]) === "2" &&
			!!norm(r[NPPES_COLUMNS.orgLegal]),
	},
]

/**
 * The GBT hyperparameter shape the trainers stamp into their model meta.
 */
export interface GBTHyperparameters {
	rounds: number
	depth: number
	lr: number
	minLeaf: number
}

/**
 * The compact pure-Node GBT configuration the cross-source trainers fit with.
 */
const CROSS_SOURCE_HYPERPARAMS: GBTHyperparameters = { rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 }

/**
 * Share of join keys assigned to fit during calibration; the rest are held out.
 */
const FIT_SPLIT_FRACTION = 0.8

/**
 * One assembled input row for a cross-source trainer. `npi` carries the cross-system join key (an NPI or a CCN) — it
 * rides `record.id` as the held-out label.
 */
export interface CrossSourceRow extends Record<string, string> {
	npi: string
	name: string
	org: string
	address: string
	source: string
}

/**
 * Every figure Phases D–F compute — what {@link TrainCrossSourceModelOptions.meta} receives.
 */
export interface CrossSourceTrainingFigures {
	records: number
	pairs: number
	posRate: number
	barRecall: number
	f1Max: number
	recommendedThreshold: number
	features: number
	hyperparams: GBTHyperparameters
}

/**
 * Options for {@linkcode trainCrossSourceModel}.
 */
export interface TrainCrossSourceModelOptions {
	/**
	 * The injected geocoder factory (the command wires `mailwoman/geocode-core`; see `./eval-geocoder.ts`).
	 */
	createGeocoder: EvalGeocoderFactory
	/**
	 * The assembled two-source rows — the caller's source-loading phases stay with the caller.
	 */
	rows: readonly CrossSourceRow[]
	/**
	 * The join keys present in BOTH sources.
	 */
	joined: ReadonlySet<string>
	addressFrequency: TermFrequencyTable
	/**
	 * The two provenance labels, in ingest order.
	 */
	sources: readonly [string, string]
	/**
	 * #655 threshold rule: max cross-source recall subject to this held-out pairwise precision.
	 */
	precisionBar: number
	/**
	 * Output TS module path.
	 */
	out: string
	/**
	 * The emitted module's docstring prose — the ` * `-prefixed lines between the author block and the closer.
	 */
	moduleDoc: string
	/**
	 * Emitted export prefix — the module exports `<prefix>_META` + `<prefix>_MODEL`.
	 */
	exportPrefix: string
	/**
	 * Assemble the emitted `<prefix>_META` object. The caller owns field names and order so a retrain diffs cleanly
	 * against its committed module.
	 */
	meta: (figures: CrossSourceTrainingFigures) => Record<string, unknown>
	report?: (line: string) => void
}

/**
 * Phases C–F shared by the cross-source trainers: geocode + ingest each source under its own provenance label, block
 * the union and keep only CROSS-source candidate pairs, featurize with the SHARED `createMatchFeaturizer` (train ≡
 * inference), calibrate the #655 threshold on a held-out split of the join keys, train the shipped model on ALL pairs,
 * and emit it as a committed TS module.
 */
export async function trainCrossSourceModel(
	options: TrainCrossSourceModelOptions
): Promise<{ out: string; pairs: number; recommendedThreshold: number }> {
	const { rows, joined, addressFrequency, sources, precisionBar, out, report } = options

	// --- Phase C: geocode + ingest (record.id = the join-key label; `source` rides the record). The
	// heavy geocoder is injected (see ./eval-geocoder.ts). ---
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

	const records: SourceRecord[] = []

	for (const source of sources) {
		records.push(
			...(await ingestRows(
				rows.filter((r) => r.source === source),
				mappingFor(source),
				{ geocodeAddress: geocoder.seam }
			))
		)
	}

	geocoder[Symbol.dispose]()
	report?.(`    ${records.length} records, ${records.filter((r) => r.address?.geocode).length} geocoded`)

	// --- Phase D: block over the UNION; keep only CROSS-source pairs; featurize; label by join key. ---
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

	// --- Phase E: held-out calibration — the #655 threshold rule. ---
	report?.("[E] held-out calibration…")
	const rnd = makeLcg(655)
	const split = new Map<string, "fit" | "holdout">()

	for (const key of joined) {
		split.set(key, rnd() < FIT_SPLIT_FRACTION ? "fit" : "holdout")
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
		CROSS_SOURCE_HYPERPARAMS
	)

	const holdScores = holdIdx.map((i) => ({ s: gbtScore(calib, X[i]!), y: Y[i]! }))
	const sorted = holdScores.map((h) => h.s).toSorted((a, b) => a - b)
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
		if (precision >= precisionBar && recall > barRecall) {
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
		`    held-out (${holdIdx.length} pairs, ${totalPos} pos): precision-bar ${precisionBar} → threshold ${recommendedThreshold.toFixed(3)} (recall ${(100 * barRecall).toFixed(1)}%); F1-max ${(100 * bestF1).toFixed(1)}% @ ${f1MaxThreshold.toFixed(3)}`
	)

	// --- Phase F: train the SHIPPED model on ALL cross-source pairs; emit the committed module. ---
	report?.("[F] training the shipped model on all pairs…")
	const model = trainGBT(X, Y, W, CROSS_SOURCE_HYPERPARAMS)

	const meta = options.meta({
		records: records.length,
		pairs: pairs.length,
		posRate: Number(posRate.toFixed(4)),
		barRecall: Number(barRecall.toFixed(4)),
		f1Max: Number(bestF1.toFixed(4)),
		recommendedThreshold: Number(recommendedThreshold.toFixed(4)),
		features: X[0]?.length ?? 0,
		hyperparams: CROSS_SOURCE_HYPERPARAMS,
	})

	const moduleSource =
		`/**\n` +
		` * @copyright Sister Software\n` +
		` * @license AGPL-3.0\n` +
		` * @author Teffen Ellis, et al.\n` +
		` *\n` +
		options.moduleDoc +
		` */\n\n` +
		`import type { GBT } from "@mailwoman/match"\n\n` +
		`export const ${options.exportPrefix}_META = ${JSON.stringify(meta)} as const\n\n` +
		`// prettier-ignore\n` +
		`export const ${options.exportPrefix}_MODEL: GBT = ${JSON.stringify(model)}\n`

	await makeDirectories(dirname(out))
	await writeLocalFile(moduleSource, out)
	report?.(`    ${model.trees.length} trees, ${X[0]?.length ?? 0} features -> ${out}`)

	return { out, pairs: pairs.length, recommendedThreshold }
}
