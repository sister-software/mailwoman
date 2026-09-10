/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Learned-scorer CROSS-STATE generalization (#603 Tier 2, the next axis after the held-out-NPI A/B
 *   in `learned-scorer-clustering-eval.ts`). The held-out-NPI A/B showed the GBT beats the FS
 *   baseline on clustering by +5.2pp — but the GBT was trained and evaluated within ONE state (TX).
 *   The production question is whether that win GENERALIZES: train on one state, evaluate the dedup
 *   clustering F1 on a DIFFERENT state the model never saw. If it holds, the GBM is
 *   production-worthy; if it collapses, the scorer is fitting state-specific structure and needs
 *   per-state training (a finding either way).
 *
 *   One registry pass builds the global address-frequency table + a TRAIN-state sample + an
 *   EVAL-state sample (the SHARED multi-state sample builder); both are geocoded; the GBT + LR are
 *   trained on the train state's pairs and used to cluster the eval state's records through the
 *   same `resolveEntities` pipeline (FS baseline / GBT scorer / LR scorer), best F1 over a fine
 *   per-scorer threshold sweep. The metric is the dedup benchmark's clustering F1.
 *
 *   Run: `mailwoman registry scorer-eval cross-state [--train-state TX] [--eval-state CA]
 *   [--npis 2000] [--out-md <md>]`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { block, gbtScore, trainGBT } from "@mailwoman/match"

import {
	buildDefaultModel,
	createGBTScorer,
	createMatchFeaturizer,
	DEDUP_GBT_MODEL,
	defaultBlockingKeys,
	ingestRows,
	resolveEntities,
	type ColumnMapping,
	type SourceRecord,
} from "#index"
import type { EvalGeocoderFactory } from "#tools/eval-geocoder"
import { buildNPPESStateSamples } from "#tools/nppes/sample"
import { scoreEntities } from "#tools/nppes/scoring"
import {
	bestOver,
	MIN_MEANINGFUL_F1_DELTA,
	pct,
	quantileThresholds,
	sgn,
	toArmScore,
	trainLogisticRegression,
	type ArmScore,
} from "#tools/shared"

/**
 * Options for {@linkcode scorerCrossStateEval}.
 */
export interface ScorerCrossStateEvalOptions {
	/**
	 * The injected geocoder factory (the command wires `mailwoman/geocode-core`; see `./eval-geocoder.ts`).
	 */
	createGeocoder: EvalGeocoderFactory
	/**
	 * Record-matcher sources directory. Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources`.
	 */
	sources?: string
	/**
	 * State the GBT/LR train on. Default TX.
	 */
	trainState?: string
	/**
	 * Held-out state clustered. Default CA.
	 */
	evalState?: string
	/**
	 * NPIs sampled per state. Default 2000.
	 */
	npis?: number
	/**
	 * Also write the markdown report here.
	 */
	outMd?: string
}

/**
 * Learned-scorer cross-state generalization (#603 Tier 2) — see the module doc. Emits the report to stdout.
 */
export async function scorerCrossStateEval(
	options: ScorerCrossStateEvalOptions,
	report?: (line: string) => void
): Promise<{ markdown: string }> {
	const SOURCES = options.sources || dataRootPath("record-matcher", "sources")
	const TRAIN_STATE = (options.trainState || "TX").toUpperCase()
	const EVAL_STATE = (options.evalState || "CA").toUpperCase()
	const NPIS = options.npis ?? 2000
	const OUT_MD = options.outMd || ""

	const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`
	const OTHER_NAMES = `${SOURCES}/nppes_other-names_20260607.tsv`

	// ONE registry pass fills BOTH state buckets (the SHARED multi-state sample builder): the global
	// address-frequency table + a TRAIN-state sample + an EVAL-state sample.
	const { byState, addressFrequency } = await buildNPPESStateSamples(
		{
			registryPath: REGISTRY,
			otherNamesPath: OTHER_NAMES,
			states: [TRAIN_STATE, EVAL_STATE],
			maxNpisPerState: NPIS,
		},
		report
	)

	const trainSample = byState.get(TRAIN_STATE)!
	const evalSample = byState.get(EVAL_STATE)!

	report?.("[C] geocoding both states…")
	const geocoder = await options.createGeocoder()

	// `auth`/`taxonomy` ride as attributes so the SHARED featurizer's #625 roll-up features can read the
	// authorized official; the FS arm ignores them (no discriminators configured).
	const mapping: ColumnMapping = {
		id: "npi",
		name: "name",
		organization: "org",
		address: "address",
		attributes: { authorizedOfficial: "auth", taxonomy: "taxonomy" },
		source: "nppes",
	}

	const trainRecords = await ingestRows(trainSample.rows, mapping, { geocodeAddress: geocoder.geocodeAddress })
	const evalRecords = await ingestRows(evalSample.rows, mapping, { geocodeAddress: geocoder.geocodeAddress })
	geocoder[Symbol.dispose]()

	// Feature basis: the SHARED production featurizer (train ≡ eval ≡ inference, one definition) over the
	// collapsed-spatial + address-frequency comparison set (the baseline).
	const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons
	const featurize = createMatchFeaturizer({ comparisons, addressFrequency })

	report?.(`[D] training GBT + LR on ${TRAIN_STATE} pairs…`)
	const { pairs: trainPairs } = block(trainRecords, defaultBlockingKeys())
	const trainX = trainPairs.map(([a, b]) => featurize(a, b))
	const trainY = trainPairs.map(([a, b]) => (a.id === b.id ? 1 : 0))
	const posRate = trainY.reduce<number>((s, v) => s + v, 0) / Math.max(1, trainY.length)
	const trainW = trainY.map((y) => (y === 1 ? 1 - posRate : posRate))
	const dim = trainX[0]?.length ?? 0
	const gbt = trainGBT(trainX, trainY, trainW, { rounds: 120, depth: 3, lr: 0.3, minLeaf: 20 })

	// LR (batch GD, class-balanced) — the SHARED trainer.
	const lrSc = trainLogisticRegression(trainX, trainY, trainW, dim)

	const gbtScorer = (a: SourceRecord, b: SourceRecord) => gbtScore(gbt, featurize(a, b))
	const lrScorer = (a: SourceRecord, b: SourceRecord) => lrSc(featurize(a, b))

	report?.(`[E] clustering ${EVAL_STATE} records (FS baseline vs GBT vs LR, trained on ${TRAIN_STATE})…`)

	const npiLabel = (rec: SourceRecord) => rec.id

	const armOver = (
		thresholds: readonly number[],
		cfg: (t: number) => Parameters<typeof resolveEntities>[1]
	): ArmScore =>
		bestOver(thresholds, (t) =>
			toArmScore(scoreEntities(resolveEntities(evalRecords, cfg(t)).entities, npiLabel, evalRecords.length))
		)

	const { pairs: evalPairs } = block(evalRecords, defaultBlockingKeys())

	const fs = armOver(
		Array.from({ length: 26 }, (_, i) => i),
		// learnedScorer:false — the FS baseline is the baseline (the learned scorer is now default-on, so
		// without this the "FS arm" would silently BE the GBT).
		(t) => ({ addressFrequency, collapseSpatial: true, trainEM: true, threshold: t, learnedScorer: false })
	)

	const gbtArm = armOver(quantileThresholds(evalPairs.map(([a, b]) => gbtScorer(a, b))), (t) => ({
		addressFrequency,
		collapseSpatial: true,
		scorer: gbtScorer,
		threshold: t,
	}))

	const lrArm = armOver(quantileThresholds(evalPairs.map(([a, b]) => lrScorer(a, b))), (t) => ({
		addressFrequency,
		collapseSpatial: true,
		scorer: lrScorer,
		threshold: t,
	}))

	// The SHIPPED model (the default-on candidate): the bundled DEDUP_GBT_MODEL, NOT a fresh per-run TX
	// fit. This is the arm that justifies flipping `learnedScorer` default-on — the actual artifact every
	// caller would get, evaluated on a state it never trained on.
	const bundledScorer = createGBTScorer({ model: DEDUP_GBT_MODEL, comparisons, addressFrequency })

	const bundledArm = armOver(quantileThresholds(evalPairs.map(([a, b]) => bundledScorer(a, b))), (t) => ({
		addressFrequency,
		collapseSpatial: true,
		scorer: bundledScorer,
		threshold: t,
	}))

	const dBundled = bundledArm.f1 - fs.f1
	const dGbt = gbtArm.f1 - fs.f1
	const dLr = lrArm.f1 - fs.f1

	report?.(
		`    FS  ${pct(fs.f1)}%  ·  LR ${pct(lrArm.f1)}% (${sgn(dLr)}${pct(dLr)})  ·  GBT ${pct(gbtArm.f1)}% (${sgn(dGbt)}${pct(dGbt)})` +
			`  ·  BUNDLED ${pct(bundledArm.f1)}% (${sgn(dBundled)}${pct(dBundled)})`
	)

	const row = (label: string, a: ArmScore, d: number | null, bold: boolean) => {
		const dCell = d === null ? "—" : `${sgn(d * 100)}${(d * 100).toFixed(1)}pp`
		const f1 = bold ? `**${pct(a.f1)}%**` : `${pct(a.f1)}%`

		return `| ${bold ? `**${label}**` : label} | ${pct(a.precision)}% | ${pct(a.recall)}% | ${f1} | ${bold ? `**${dCell}**` : dCell} | ${a.overMerged} |`
	}

	const lines: string[] = [
		`# Learned-scorer CROSS-STATE generalization (#603 Tier 2) — train ${TRAIN_STATE}, evaluate ${EVAL_STATE}`,
		"",
		`_Generated by \`mailwoman registry scorer-eval cross-state\`. The GBT + LR are trained on ` +
			`${trainSample.keptNpis.size} ${TRAIN_STATE} NPIs (${trainRecords.length} records) and used to cluster ` +
			`${evalSample.keptNpis.size} held-out ${EVAL_STATE} NPIs (${evalRecords.length} records) — a state the model ` +
			`never saw — through the same \`resolveEntities\` pipeline (FS baseline / GBT scorer / LR scorer), best F1 over a fine ` +
			`per-scorer threshold sweep. This is the generalization axis the within-state held-out-NPI A/B couldn't cover._`,
		"",
		`## Result — ${EVAL_STATE} clustering F1 (GBT/LR trained on ${TRAIN_STATE})`,
		"",
		`| scorer | precision | recall | F1 | ΔF1 vs FS | over-merged |`,
		`|---|---:|---:|---:|---:|---:|`,
		row("FS baseline (EM-fit)", fs, null, false),
		row("logistic regression", lrArm, dLr, false),
		row(`GBT (fresh ${TRAIN_STATE} fit)`, gbtArm, dGbt, false),
		row("SHIPPED bundled model (default-on candidate)", bundledArm, dBundled, true),
		"",
		`The **bundled** row is the actual shipped \`DEDUP_GBT_MODEL\` (the default-on candidate), evaluated on ` +
			`${EVAL_STATE} — a state it never trained on. The "fresh ${TRAIN_STATE} fit" row retrains per run for comparison.`,
		"",
	]

	const verdict =
		dGbt > MIN_MEANINGFUL_F1_DELTA
			? `**The GBT win GENERALIZES across states** — trained on ${TRAIN_STATE}, it still beats the FS baseline on ${EVAL_STATE} ` +
				`clustering F1 (${pct(gbtArm.f1)}% vs ${pct(fs.f1)}%, ${sgn(dGbt * 100)}${(dGbt * 100).toFixed(1)}pp). The learned scorer ` +
				`isn't fitting ${TRAIN_STATE}-specific structure; the over-merge signal it learns transfers. This is the strongest ` +
				`evidence yet for the #603 production GBM — one model, trained once, helps a state it never saw.`
			: dGbt < -MIN_MEANINGFUL_F1_DELTA
				? `**The GBT win does NOT generalize** — trained on ${TRAIN_STATE}, it is WORSE than the FS baseline on ${EVAL_STATE} ` +
					`(${pct(gbtArm.f1)}% vs ${pct(fs.f1)}%, ${(dGbt * 100).toFixed(1)}pp). The within-state gain was state-specific ` +
					`structure; a production GBM would need per-state (or much broader) training. Important caveat for #603.`
				: `**The GBT roughly TIES the FS baseline cross-state** (${pct(gbtArm.f1)}% vs ${pct(fs.f1)}%, ` +
					`${sgn(dGbt * 100)}${(dGbt * 100).toFixed(1)}pp). The within-state win attenuates across states — partial ` +
					`generalization. A production GBM likely needs broader/multi-state training to recover the full within-state margin.`

	lines.push(verdict)
	lines.push("")
	lines.push(`## Honest caveats`)
	lines.push("")

	lines.push(
		`A single train/eval state pair (${TRAIN_STATE}→${EVAL_STATE}), one geocoded sample each, a compact pure-Node GBT ` +
			`(120 rounds, depth 3). The FS arm is the benchmark baseline (same model), so the comparison is fair. Absolute F1 ` +
			`differs from the within-state A/B because the eval population + over-merge density differ by state. NPI-as-truth is ` +
			`conservative. The within-state held-out-NPI A/B (\`scorer-eval clustering\`) is the companion; together ` +
			`they bound the generalization question a production GBM must answer._`
	)

	lines.push("")
	const md = lines.join("\n")

	console.log(md)

	if (OUT_MD) {
		await writeLocalFile(md, OUT_MD)
		report?.(`[written] ${OUT_MD}`)
	}

	return { markdown: md }
}
