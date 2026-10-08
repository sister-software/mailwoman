/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Trains the production learned-scorer model. `buildNPPESSample` creates the same NPI-keyed records used by
 *   the dedup benchmark and clustering A/B. The sample uses the real registry and includes name drift plus address variation.
 *   The trainer geocodes records and groups them into candidate pairs. It featurizes each pair with
 *   `createMatchFeaturizer`. It labels pairs by NPI and fits a gradient-boosted tree model.
 *   It writes the model to the committed package module `registry/models/dedup-gbt-en-us.ts`.
 *
 *   Unlike the eval, this trains on all sampled NPIs with no held-out split, since the held-out F1
 *   is the eval's job.
 *
 *   Run: `mailwoman registry train-scorer gbt [--state TX] [--npis 3000] [--wof <admin.db>]
 *   [--data-root <dir>] [--out registry/models/dedup-gbt-en-us.ts]`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { makeLcg } from "@mailwoman/core/random"
import { isoDate } from "@mailwoman/core/utils"
import { block, gbtScore, trainGBT } from "@mailwoman/match"
import { dirname } from "path-ts"

import {
	buildDefaultModel,
	createMatchFeaturizer,
	defaultBlockingKeys,
	ingestRows,
	resolveEntities,
	type ColumnMapping,
	type SourceRecord,
} from "#index"
import type { EvalGeocoderFactory } from "#tools/eval-geocoder"
import { buildNPPESSample } from "#tools/nppes/sample"
import { scoreEntities } from "#tools/nppes/scoring"
import { stateOption, uniqueQuantiles } from "#tools/shared"

/**
 * Share of entities assigned to fit.
 * The rest are held out.
 */
const FIT_SPLIT_FRACTION = 0.8

/**
 * Options for {@linkcode trainDedupGBT}.
 */
export interface TrainDedupGBTOptions {
	/**
	 * The injected geocoder factory.
	 *
	 * The command wires `mailwoman/geocode-core`, as `./eval-geocoder.ts` does.
	 */
	createGeocoder: EvalGeocoderFactory
	/**
	 * Record-matcher sources directory.
	 *
	 * @defaultValue `$MAILWOMAN_DATA_ROOT/record-matcher/sources`
	 */
	sources?: string
	/**
	 * State filter.
	 *
	 * @defaultValue TX.
	 */
	state?: string
	/**
	 * NPIs sampled.
	 *
	 * @defaultValue `3000`
	 */
	npis?: number
	/**
	 * Output TS module path.
	 *
	 * @defaultValue `registry/models/dedup-gbt-en-us.ts`
	 */
	out?: string
	/**
	 * Locale recorded in the model meta (the command's factory loads the matching weights).
	 *
	 * @defaultValue `"en-US"`
	 */
	locale?: string
	/**
	 * Cost-sensitive training: up-weight the negative (distinct-pair) class by this factor
	 * so the model is more conservative about merging.
	 *
	 * It trades recall for precision to reduce over-merge.
	 * `1` is the symmetric class-balanced default.
	 *
	 * A value above 1 penalizes a false merge more than a missed merge.
	 */
	cost?: number
	/**
	 * The training date stored in the metadata (overridable for reproducible commits).
	 *
	 * @defaultValue today.
	 */
	date?: string
}

/**
 * Train and emit the production dedup GBT.
 */
export async function trainDedupGBT(
	options: TrainDedupGBTOptions,
	report?: (line: string) => void
): Promise<{ out: string; pairs: number; recommendedThreshold: number; heldOutF1: number }> {
	const SOURCES = options.sources || dataRootPath("record-matcher", "sources")
	const STATE = stateOption(options)
	const NPIS = options.npis ?? 3000
	const OUT = options.out || "packages/registry/lib/models/dedup-gbt-en-us.ts"
	const LOCALE = options.locale || "en-US"
	const COST = options.cost ?? 1
	const TRAIN_DATE = options.date || isoDate()

	const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`
	const OTHER_NAMES = `${SOURCES}/nppes_other-names_20260607.tsv`

	const { rows, keptNpis, addressFrequency } = await buildNPPESSample(
		{ registryPath: REGISTRY, otherNamesPath: OTHER_NAMES, state: STATE, maxNpis: NPIS },
		report
	)

	// The geocoder is injected, since the registry package never imports the runtime.
	report?.("[C] geocoding…")
	const geocoder = await options.createGeocoder()

	// `record.id` supplies the NPI label.
	// Multiple records can share an NPI as ground truth.
	const mapping: ColumnMapping = {
		id: "npi",
		name: "name",
		organization: "org",
		address: "address",
		attributes: { authorizedOfficial: "auth" },
	}

	const records: SourceRecord[] = await ingestRows(rows, mapping, {
		geocodeAddress: geocoder.geocodeAddress,
	})

	geocoder[Symbol.dispose]()
	const geocoded = records.filter((r) => r.address?.geocode).length
	report?.(`    ${records.length} records, ${geocoded} geocoded`)

	report?.("[D] blocking + featurizing…")
	const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons
	const featurize = createMatchFeaturizer({ comparisons, addressFrequency })
	const { pairs } = block(records, defaultBlockingKeys())
	const X = pairs.map(([a, b]) => featurize(a, b))
	const Y = pairs.map(([a, b]) => (a.id === b.id ? 1 : 0))
	const posRate = Y.reduce<number>((s, v) => s + v, 0) / Math.max(1, Y.length)
	const W = Y.map((y) => (y === 1 ? 1 - posRate : posRate * COST))
	const hyperparams = { rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 }

	if (COST !== 1) {
		report?.(`    cost-sensitive: negative class weighted ×${COST} (penalize over-merge)`)
	}

	// Calibrate the default link threshold.
	// The GBT logit uses no Fellegi-Sunter weight units.
	// With class-balanced weights, logit 0 ignores the roughly 1% match base rate and over-merges.
	// The threshold is swept on a held-out 20% of NPIs.
	// The shipped full-data model has near-identical logit calibration, so the threshold transfers.
	report?.("[E] calibrating the default link threshold on a held-out NPI split…")
	const rnd = makeLcg(20_260_615)
	const split = new Map<string, "fit" | "holdout">()

	for (const npi of keptNpis) {
		split.set(npi, rnd() < FIT_SPLIT_FRACTION ? "fit" : "holdout")
	}

	const fitPairs = pairs.filter(([a, b]) => split.get(a.id) === "fit" && split.get(b.id) === "fit")

	const calibGbt = trainGBT(
		fitPairs.map(([a, b]) => featurize(a, b)),
		fitPairs.map(([a, b]) => (a.id === b.id ? 1 : 0)),
		fitPairs.map(([a, b]) => (a.id === b.id ? 1 - posRate : posRate * COST)),
		hyperparams
	)

	const calibScorer = (a: SourceRecord, b: SourceRecord) => gbtScore(calibGbt, featurize(a, b))
	const holdoutRecords = records.filter((r) => split.get(r.id) === "holdout")
	const { pairs: holdoutPairs } = block(holdoutRecords, defaultBlockingKeys())
	const holdoutScores = holdoutPairs.map(([a, b]) => calibScorer(a, b)).toSorted((p, q) => p - q)
	const npiLabel = (rec: SourceRecord) => rec.id
	let recommendedThreshold = 0
	let bestF1 = -1

	for (const t of uniqueQuantiles(holdoutScores, 40)) {
		const { entities } = resolveEntities(holdoutRecords, {
			addressFrequency,
			collapseSpatial: true,
			scorer: calibScorer,
			threshold: t,
		})

		const f1 = scoreEntities(entities, npiLabel, holdoutRecords.length).f1

		if (f1 > bestF1) {
			bestF1 = f1
			recommendedThreshold = t
		}
	}

	report?.(
		`    recommended link threshold ${recommendedThreshold.toFixed(3)} (held-out clustering F1 ${(100 * bestF1).toFixed(1)}%)`
	)

	report?.("[F] training the shipped model on all pairs…")
	const model = trainGBT(X, Y, W, hyperparams)
	report?.(`    ${pairs.length} pairs (${(100 * posRate).toFixed(1)}% positive), ${model.trees.length} trees`)

	// Emit the model as a committed TypeScript module with a prettier-stable literal,
	// so a retrain produces a clean one-line diff.
	const meta = {
		version: "1.0.0",
		locale: LOCALE,
		trainedOn: TRAIN_DATE,
		state: STATE,
		npis: keptNpis.size,
		records: records.length,
		pairs: pairs.length,
		posRate: Number(posRate.toFixed(4)),
		costNegative: COST,
		hyperparams,
		recommendedThreshold: Number(recommendedThreshold.toFixed(4)),
		features: X[0]?.length ?? 0,
		addressFrequencyDistinct: addressFrequency.distinct,
		addressFrequencyTotal: addressFrequency.total,
	}

	const moduleSource =
		`/**\n` +
		` * @copyright Sister Software\n` +
		` * @license AGPL-3.0\n` +
		` * @author Teffen Ellis, et al.\n` +
		` *\n` +
		` *   GENERATED by \`mailwoman registry train-scorer gbt\` (registry/tools/train-gbt.ts) — DO NOT edit by hand; retrain to update.\n` +
		` *\n` +
		` *   The default learned-scorer model (#603): a gradient-boosted-tree dedup scorer trained on the\n` +
		` *   NPPES NPI-truth set (${STATE}, ${keptNpis.size} NPIs → ${pairs.length} candidate pairs). Validated to\n` +
		` *   generalize across states by learned-scorer-crossstate-eval.ts. Used by resolveEntities'\n` +
		` *   opt-in learnedScorer hook via createGBTScorer. The trained {@link GBT} is plain data.\n` +
		` */\n\n` +
		`import type { GBT } from "@mailwoman/match"\n\n` +
		`/** Provenance for the bundled model — what it was trained on. */\n` +
		`export const DEDUP_GBT_META = ${prettyJSON(meta)} as const\n\n` +
		`// prettier-ignore\n` +
		`export const DEDUP_GBT_MODEL: GBT = ${stringifyJSON(model)}\n`

	await makeDirectories(dirname(OUT))
	await writeLocalFile(moduleSource, OUT)
	report?.(`[written] ${OUT} (${(moduleSource.length / 1024).toFixed(0)} KB)`)

	return { out: OUT, pairs: pairs.length, recommendedThreshold, heldOutF1: bestF1 }
}
