/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Promotion eval runner (#479).
 *   Runs the standard battery, checks spec floors, and writes one machine-readable verdict.
 *
 *   Usage: mailwoman eval promote\
 *   --model <fp32.onnx> [--int8 <int8.onnx>]\
 *   | --weights-cache <fp32-pkg-root> [--int8-weights-cache <int8-pkg-root>]\
 *   --spec packages/mailwoman/lib/eval-harness/specs/<spec>.json\
 *   [--tokenizer <tokenizer.model>] [--card <model-card.json>]\
 *   [--gazetteer-lexicon <lexicon.json>] [--out-dir <temp-root>/eval-<label>]
 *
 *   --model compares raw artifacts: delta checks are valid, absolute floors are not.
 *   --weights-cache is the in-distribution path, and a paired cache run (#47) checks
 *   floors and fp32↔int8 deltas together.
 *
 *   Behavior:
 *
 *   - Runs per-locale-f1, score-affix (+unit), country-homograph, de-order, and preset compare.
 *     With --int8, re-runs per-tag checks and enforces the fp32↔int8 delta cap.
 *   - Runs demo-cascade smoke (#524) when the hot DB exists.
 *     A missing DB warns and skips the leg.
 *     Optional floor key: `cascade.demo_smoke`.
 *   - Runs mask regression (#718) when requires_conventions is set.
 *     A tag drop over 2pp fails the leg.
 *   - Collects headline numbers into <out-dir>/verdict.json with per-floor pass/fail.
 *   - Exit 0 = every floor met and the mask-regression lock held. exit 1 = any miss.
 *
 *   All legs run in-process now (no child processes).
 *   Artifacts are preserved because sinks reproduce line output byte-for-byte.
 *
 *   Error handling behavior is kept per leg.
 *   `nothrow` maps to try/catch.
 *   Throw-on-nonzero still throws, and an aborting leg still aborts.
 *   Legs that merged stdout+stderr still do so in that order.
 *
 *   One intentional change: some previously swallowed stderr now prints to runner stderr.
 *   Written `.md` artifacts are unchanged.
 *
 *   Key guardrails (see CONTRIBUTING_MODEL_WORK.mdx):
 *
 *   - Tokenizer path must match the card tokenizer version.
 *   - If requires_gazetteer_lexicon is set, scorers get gazetteer flags.
 *   - Warn when compiled output is stale.
 *   - Grade affix floors from score-affix (not folded per-locale output).
 */

import { dataRootPath, tempRootPathBuilder } from "@mailwoman/core/data-root"
import { pathExists, readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, toLinesText, writeLocalFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { checkCompiledFreshness } from "@mailwoman/core/module/compiled-freshness"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { isoSeconds } from "@mailwoman/core/utils"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { basename, dirname, PathBuilder, resolvePath, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { deOrderEval } from "#eval-harness/de-order-eval"
import { demoCascadeSmoke } from "#eval-harness/demo/cascade/smoke"
import { externalArenas } from "#eval-harness/external-arenas"
import { frParseRecall } from "#eval-harness/fr-parse-recall"
import { maskRegressionCheck } from "#eval-harness/mask-regression"
import { perLocaleF1 } from "#eval-harness/per/locale-f1"
import { presetCompare } from "#eval-harness/preset-compare"
import { finalizePromotionVerdict } from "#eval-harness/promotion/eval/finalize"
import { LegProfile } from "#eval-harness/promotion/eval/leg-profile"
import { scoreAffix, type ScoreAffixOptions } from "#eval-harness/score/affix"
import { scoreCountryHomograph } from "#eval-harness/score/country-homograph"
import { resolveWOFHotDB } from "#eval-harness/wof-hot-db"

/**
 * Render sink lines with one trailing newline per `report()` call.
 *
 * Keeps `.md` artifacts byte-compatible with prior child stdout capture.
 *
 * Exported for `promotion-eval-sinks.test.ts`.
 */
export function renderLines(lines: readonly string[]): string {
	return lines.map((line) => `${line}\n`).join("")
}

interface ThresholdSpec {
	label: string
	requires_gazetteer_lexicon?: boolean
	requires_conventions?: string
	requires_bridge?: boolean
	/**
	 * Answer key path for per-locale grading, e.g. `data/eval/golden/v0.1.3/dev`.
	 *
	 * Spec-declared for comparability.
	 * Omitted = per-locale-f1 default (v0.1.2/dev).
	 *
	 * If this changes, floors must be re-anchored on fresh measurements.
	 */
	golden_dir?: string
	floors?: Record<string, unknown>
}

interface ModelCard {
	training: { tokenizer_version: string }
}

/**
 * Options for {@linkcode runPromotionEval}.
 */
export interface PromotionEvalOptions {
	/**
	 * Candidate fp32 ONNX (required).
	 */
	model?: string
	/**
	 * Quantized int8 sibling.
	 * Re-runs per-tag checks and enforces delta cap.
	 */
	int8?: string
	/**
	 * Check-spec JSON path, or bare name resolved from bundled specs (required).
	 */
	check?: string
	/**
	 * Tokenizer path.
	 *
	 * Default: the v0.6.0-a0 tokenizer under `$MAILWOMAN_DATA_ROOT`.
	 */
	tokenizer?: string
	/**
	 * Model-card JSON.
	 *
	 * Default `neural-weights-en-us/model-card.json`.
	 */
	card?: string
	/**
	 * Gazetteer lexicon JSON.
	 *
	 * Default `data/gazetteer/anchor-lexicon-v1.json`.
	 */
	gazetteerLexicon?: string
	/**
	 * Package-shaped candidate weights dir `<root>/node_modules/@mailwoman/neural-weights-en-us`.
	 *
	 * #718-safe path that feeds anchor+gazetteer+country via loadFromWeights.
	 *
	 * Alternative to --model/--int8.
	 * Takes precedence.
	 */
	weightsCache?: string
	/**
	 * Package-shaped INT8 dir, same layout as {@linkcode PromotionEvalOptions.weightsCache}.
	 *
	 * Pairing runs a fully package-shaped fp32+int8 battery (#47).
	 *
	 * Requires {@linkcode PromotionEvalOptions.weightsCache} and excludes --model/--int8.
	 *
	 * Makes floors and deltas valid in one run.
	 */
	int8WeightsCache?: string
	/**
	 * Battery output dir.
	 *
	 * Default `<temp-root>/eval-<label>-<hhmm>`, under `$MAILWOMAN_TEMP_ROOT`.
	 */
	outDir?: PathBuilderLike
	/**
	 * Optional per-leg wall-time ledger path.
	 *
	 * Must be outside {@linkcode PromotionEvalOptions.outDir}.
	 * Receipt comparison expects stable bytes under outDir.
	 * Omitted, nothing is written.
	 */
	profileJSON?: string
}

/**
 * Resolve a `--spec` value to a real file.
 *
 * A path that exists wins verbatim.
 * Otherwise, basename lookup is done in the shipped specs dir.
 *
 * Works in source and compiled trees.
 *
 * `.json` suffix is optional.
 */
/**
 * Eval specs directory in source tree.
 */
const SPECS_DIR = resolvePackagePath("mailwoman", "lib", "eval-harness", "specs")

/**
 * Workspaces used by this battery for compiled-freshness checks.
 *
 * Keep this list broad enough to cover parse+resolve paths end-to-end.
 */
const EVAL_HARNESS_WORKSPACES = [
	"packages/mailwoman",
	"packages/core",
	"packages/neural",
	"packages/resolver",
	"packages/resolver-wof-sqlite",
	"packages/normalize",
	"packages/query-shape",
	"packages/locale-hint",
	"packages/kind-classifier",
	"packages/phrase-grouper",
	"packages/codex",
] as const

export async function resolveThresholdSpecPath(check: string): Promise<string> {
	if (await pathExists(check)) return check

	const name = basename(check)

	for (const candidate of name.endsWith(".json") ? [name] : [name, `${name}.json`]) {
		const spec = resolvePath(SPECS_DIR, candidate)

		if (await pathExists(spec)) return spec
	}

	throw new Error(`Check spec not found: "${check}". Known specs: ${(await listEvalSpecs()).join(", ") || "(none)"}`)
}

/**
 * List shipped eval specs, sorted.
 *
 * For `--spec` errors and tooling.
 */
export async function listEvalSpecs(): Promise<string[]> {
	return (
		await Globerator.from("*.json", {
			cwd: SPECS_DIR,
			absolute: false,
		}).toArray()
	).toSorted()
}

/**
 * Pre-flight guards before battery: tokenizer comparability, compiled freshness
 * warning, and artifact provenance.
 *
 * Returns an exit code to propagate, or `null` when the run may proceed.
 *
 * Provenance ensures failures can be tied to exact graded bytes.
 */
async function runLoreGuards(env: {
	WC: string
	WC_MODEL: string
	WC8_MODEL: string
	MODEL: string
	INT8: string
	TOK: PathBuilderLike
	OUT_DIR: PathBuilderLike
	card: ModelCard
}): Promise<number | null> {
	const { WC, WC_MODEL, WC8_MODEL, MODEL, INT8, TOK, OUT_DIR, card } = env
	// Ensure tokenizer version matches the card.
	const CARD_TOK = card.training.tokenizer_version

	// Skip this check for --weights-cache.
	// That path resolves the tokenizer and the model card from the package.
	if (!WC && !TOK.includes(CARD_TOK)) {
		console.error(
			`✗ tokenizer path '${TOK}' does not contain card tokenizer_version '${CARD_TOK}' — F1 would be incomparable`
		)

		return 2
	}

	// Warn when compiled output is stale versus source.
	const freshness = await checkCompiledFreshness(repoRootPath(), EVAL_HARNESS_WORKSPACES)

	if (!freshness.fresh && freshness.reason) {
		console.error(`⚠ ${freshness.reason}`)
	}

	// Write provenance (md5 + DynamicQuantizeLinear line-count fingerprint).
	// Also enforce obvious fp32/int8 labeling checks.
	//
	// Mirrors old `grep -c -a DynamicQuantizeLinear <path>` behavior: counts
	// matching newline-delimited chunks in raw bytes.
	const dql = async (p: string): Promise<string> => {
		const needle = Buffer.from("DynamicQuantizeLinear", "latin1")
		const buffer = await readLocalBuffer(p)

		const NEWLINE = 0x0a

		let count = 0
		let searchFrom = 0

		for (;;) {
			const hit = buffer.indexOf(needle, searchFrom)

			if (hit === -1) break

			// Count at most once per line.
			count++
			const lineEnd = buffer.indexOf(NEWLINE, hit)

			if (lineEnd === -1) break
			searchFrom = lineEnd + 1
		}

		return String(count)
	}

	const md5 = async (p: string): Promise<string> => md5File(p)

	// --weights-cache single-arm: log provenance only.
	// Paired caches (#47): enforce same fp32/int8 mislabel checks as --model flow.
	if (WC) {
		const wcDql = await dql(WC_MODEL)

		const provLines = [`graded at ${isoSeconds()}`, `WEIGHTS-CACHE  ${await md5(WC_MODEL)}  dql=${wcDql}  ${WC_MODEL}`]

		let wc8Dql = ""

		if (WC8_MODEL) {
			wc8Dql = await dql(WC8_MODEL)
			provLines.push(`WC-INT8        ${await md5(WC8_MODEL)}  dql=${wc8Dql}  ${WC8_MODEL}`)
		}

		const provenance = toLinesText(provLines)
		await writeLocalFile(provenance, `${OUT_DIR}/provenance.txt`)
		process.stdout.write(provenance)

		if (WC8_MODEL) {
			if (wcDql !== "0") {
				console.error(`✗ paired --weights-cache '${WC_MODEL}' carries int8 quant nodes — it is not the fp32 arm`)

				return 2
			}

			if (wc8Dql === "0") {
				console.error(`✗ --int8-weights-cache '${WC8_MODEL}' has no quant nodes — it is not a quantized artifact`)

				return 2
			}

			if ((await md5(WC_MODEL)) === (await md5(WC8_MODEL))) {
				console.error("✗ the paired weights-caches are byte-identical — one arm is mislabeled")

				return 2
			}
		}
	} else {
		const modelDql = await dql(MODEL)

		const provLines = [`graded at ${isoSeconds()}`, `MODEL  ${await md5(MODEL)}  dql=${modelDql}  ${MODEL}`]

		let int8Dql = ""

		if (INT8) {
			int8Dql = await dql(INT8)
			provLines.push(`INT8   ${await md5(INT8)}  dql=${int8Dql}  ${INT8}`)
		}

		const provenance = toLinesText(provLines)
		await writeLocalFile(provenance, `${OUT_DIR}/provenance.txt`) // tee to file ...
		process.stdout.write(provenance)

		// ... and stdout

		if (modelDql !== "0") {
			console.error(`✗ --model '${MODEL}' carries int8 quant nodes — it is not an fp32 artifact`)

			return 2
		}

		if (INT8) {
			if (int8Dql === "0") {
				console.error(`✗ --int8 '${INT8}' has no quant nodes — it is not a quantized artifact`)

				return 2
			}

			if ((await md5(MODEL)) === (await md5(INT8))) {
				console.error("✗ --model and --int8 are byte-identical — one is mislabeled")

				return 2
			}
		}
	}

	return null
}

/**
 * Demo-cascade smoke (#524): whole-stack parse→reconcile→resolve coverage.
 *
 * Runs on the ship artifact against the slim hot DB.
 * A missing DB warns and skips.
 *
 * A spec floor declared on this leg then fails, which is the intended outcome.
 *
 * Kept separate for readability and statement count.
 */
async function runDemoCascadeLeg(env: {
	outDir: PathBuilderLike
	shipModel: string
	tokenizer: PathBuilderLike
	card: string
	gazetteerLexicon: string
}): Promise<void> {
	const { outDir, shipModel, tokenizer, card, gazetteerLexicon } = env
	const HOT_DB = resolveWOFHotDB()

	if (!(await pathExists(HOT_DB))) {
		const msg = `⚠ demo-cascade smoke SKIPPED — no wof-hot.db at ${HOT_DB} (set MAILWOMAN_WOF_HOT_DB). The whole-stack lens did NOT run (#524).`
		await writeLocalFile(msg + "\n", `${outDir}/cascade-smoke.md`)

		console.error(msg)

		return
	}

	// nothrow parity: refusal and throw both map to non-zero.
	// Only stdout sink is written to the .md.
	const cascadeLines: string[] = []
	let cascadeExit: number

	try {
		const cascade = await demoCascadeSmoke(
			{
				db: HOT_DB,
				stageDir: dirname(HOT_DB),
				model: shipModel,
				tokenizer,
				card,
				gazetteerLexicon,
				json: `${outDir}/cascade-smoke.json`,
			},
			(line) => cascadeLines.push(line)
		)

		cascadeExit = cascade.exitCode
	} catch (error) {
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))

		cascadeExit = 1
	}

	await writeLocalFile(renderLines(cascadeLines), `${outDir}/cascade-smoke.md`)

	if (cascadeExit !== 0) {
		console.error(
			`✗ demo-cascade smoke errored (see ${outDir}/cascade-smoke.md) — no sidecar; a floored eval spec will FAIL`
		)
	}
}

/**
 * Run the full promotion-eval battery.
 *
 * Returns the process exit code: 0 = every floor met and the mask-regression lock held,
 * 1 = any miss, 2 = usage / lore-guard refusal.
 */
export async function runPromotionEval(options: PromotionEvalOptions): Promise<number> {
	const MODEL = options.model ?? ""
	const INT8 = options.int8 ?? ""
	const CHECK = options.check ? await resolveThresholdSpecPath(options.check) : ""
	let OUT_DIR = options.outDir ?? ""
	const TOK = PathBuilder.from(options.tokenizer ?? dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model"))
	const CARD = options.card ?? "packages/neural-weights-en-us/model-card.json"
	const GAZ = options.gazetteerLexicon ?? "data/gazetteer/anchor-lexicon-v1.json"
	const LK = dataRootPath("anchor", "pilot-anchor-lookup.json")
	await using profile = new LegProfile(options.profileJSON ?? "")

	// Thread tuning was measured and intentionally left at library defaults.

	// Package-shaped mode (#718-safe): resolve model/tokenizer/card from cache package siblings.
	// Use explicit package-dir paths to avoid silent fallback to installed/workspace package.
	const WC = options.weightsCache ?? ""
	const WC_PACKAGE = WC ? weightsCachePackageDir(WC, "en-us") : ""
	const WC_MODEL = WC ? resolvePath(WC_PACKAGE, "model.onnx") : ""
	const EFF_TOK = WC ? resolvePath(WC_PACKAGE, "tokenizer.model") : TOK
	const EFF_CARD = WC ? resolvePath(WC_PACKAGE, "model-card.json") : CARD

	// INT8 arm for package-shaped pair (#47), resolved the same way.
	const WC8 = options.int8WeightsCache ?? ""
	const WC8_PACKAGE = WC8 ? weightsCachePackageDir(WC8, "en-us") : ""
	const WC8_MODEL = WC8 ? resolvePath(WC8_PACKAGE, "model.onnx") : ""

	if (!CHECK || (!MODEL && !WC)) {
		console.error("✗ --spec and one of --model / --weights-cache required")

		return 2
	}

	if (WC8 && !WC) {
		console.error("✗ --int8-weights-cache requires --weights-cache (the fp32 arm of the pair)")

		return 2
	}

	if (WC8 && (MODEL || INT8)) {
		console.error("✗ --int8-weights-cache pairs with --weights-cache only — drop --model/--int8")

		return 2
	}

	const check = await readLocalJSONFile<ThresholdSpec>(CHECK)
	// Fallback label if spec omits it.
	const LABEL = check.label ?? basename(CHECK).replace(/\.json$/, "")
	const hhmm = String(new Date().getUTCHours()).padStart(2, "0") + String(new Date().getUTCMinutes()).padStart(2, "0")

	if (!OUT_DIR) {
		OUT_DIR = tempRootPathBuilder(`eval-${LABEL}-${hhmm}`)
	}

	await makeDirectories(OUT_DIR)

	const card = await readLocalJSONFile<ModelCard>(EFF_CARD)
	const guardExit = await runLoreGuards({ WC, WC_MODEL, WC8_MODEL, MODEL, INT8, TOK, OUT_DIR, card })

	if (guardExit !== null) return guardExit

	// Shared spec-declared channel options for scorers.
	const channelOptions: Pick<
		ScoreAffixOptions,
		"gazetteerLexicon" | "suppressGazNearPostcode" | "conventions" | "bridgeGaps"
	> = {}

	if (check.requires_gazetteer_lexicon === true) {
		channelOptions.gazetteerLexicon = GAZ
		channelOptions.suppressGazNearPostcode = true
	}

	// Conventions channel (#511 Tier A): apply declared mask mode to scorers.
	const CONV_MODE = check.requires_conventions ?? ""

	if (CONV_MODE) {
		channelOptions.conventions = CONV_MODE
	}

	// Span-bridge channel: spec-declared like conventions.
	let BRIDGE_MODE = ""

	if (check.requires_bridge === true) {
		channelOptions.bridgeGaps = true
		BRIDGE_MODE = "1"
	}

	// Answer key is part of ship config.
	if (check.golden_dir) {
		console.log(`golden dir: ${check.golden_dir} (spec-declared)`)
	}

	// Ship artifact: paired int8, else single cache, else --model flow int8/fp32.
	const shipModel = WC ? WC8_MODEL || WC_MODEL : INT8 || MODEL

	const runBattery = async (m: string, tag: string, wc: string = WC): Promise<void> => {
		console.log(`== battery [${tag}] ${m} ==`)

		// A paired run treats fp32 as the arm that does not ship.
		// An unpaired run ships this arm.
		const pairedNonShipArm = tag === "fp32" && Boolean(WC8 || INT8)

		// Package-shaped probes load all channels from the selected arm cache.
		const plOptions = wc
			? { weightsCache: wc }
			: { modelPath: m, tokenizerPath: TOK, modelCardPath: CARD, modelAnchorLookupPath: LK }

		const probeOptions = wc ? { weightsCache: wc } : { model: m }

		// De-order takes explicit arm-specific tokenizer/card paths.
		const armPackage = wc ? weightsCachePackageDir(wc, "en-us") : ""
		const armTok = wc ? resolvePath(armPackage, "tokenizer.model") : EFF_TOK
		const armCard = wc ? resolvePath(armPackage, "model-card.json") : EFF_CARD

		// Capture each leg's output into `.md` with child-stdout-compatible newlines.
		// Throw behavior on non-zero remains unchanged for metric probes.
		const perLocaleLines: string[] = []

		await profile.time("per-locale", tag, () =>
			perLocaleF1(
				{
					...plOptions,
					// per-locale-f1 uses `gazetteerLexiconPath` (not `gazetteerLexicon`).
					...(check.golden_dir ? { goldenDir: check.golden_dir } : {}),
					...(channelOptions.gazetteerLexicon ? { gazetteerLexiconPath: channelOptions.gazetteerLexicon } : {}),
					...(channelOptions.suppressGazNearPostcode ? { suppressGazNearPostcode: true } : {}),
					...(channelOptions.conventions ? { conventions: channelOptions.conventions } : {}),
					...(channelOptions.bridgeGaps ? { bridgeGaps: true } : {}),
					outJSON: `${OUT_DIR}/${tag}-per-locale.json`,
				},
				(line) => perLocaleLines.push(line)
			)
		)

		await writeLocalFile(renderLines(perLocaleLines), `${OUT_DIR}/${tag}-per-locale.md`)

		// Helper for repeated score-affix legs.
		const runAffix = async (mdName: string, extra: ScoreAffixOptions): Promise<void> => {
			const lines: string[] = []

			await profile.time(mdName.replace(`${tag}-`, "").replace(/\.md$/u, ""), tag, () =>
				scoreAffix({ ...probeOptions, ...channelOptions, ...extra }, (line) => lines.push(line))
			)

			await writeLocalFile(renderLines(lines), `${OUT_DIR}/${mdName}`)
		}

		await runAffix(`${tag}-affix.md`, { json: `${OUT_DIR}/${tag}-affix.json` })

		await runAffix(`${tag}-unit.md`, {
			file: "data/eval/external/unit-real-designators.jsonl",
			json: `${OUT_DIR}/${tag}-unit.json`,
		})

		const countryLines: string[] = []

		await profile.time("country", tag, () =>
			scoreCountryHomograph(
				{
					...probeOptions,
					...channelOptions,
					// Country probe always suppresses gaz clues near postcode.
					suppressGazNearPostcode: true,
					json: `${OUT_DIR}/${tag}-country.json`,
				},
				(line) => countryLines.push(line)
			)
		)

		await writeLocalFile(renderLines(countryLines), `${OUT_DIR}/${tag}-country.md`)

		// v4.4.0 floors: po_box/cedex + intersections.
		await runAffix(`${tag}-pobox.md`, {
			file: "data/eval/external/po-box-cedex-val.jsonl",
			json: `${OUT_DIR}/${tag}-pobox.json`,
		})

		await runAffix(`${tag}-intersection.md`, {
			file: "data/eval/external/intersection-real.jsonl",
			json: `${OUT_DIR}/${tag}-intersection.json`,
		})

		// Watch lenses (v4.4.0+), recorded but not floored.
		// No JSON sidecar.
		await runAffix(`${tag}-watch-intersection-vt.md`, { file: "data/eval/external/intersection-golden-vt.jsonl" })
		await runAffix(`${tag}-watch-glue.md`, { file: "data/eval/external/glue-rows-perturb.jsonl" })

		// de-order tolerates a non-zero regression exit.
		// Keep nothrow parity and the merged output.
		const deorderOut: string[] = []
		const deorderErr: string[] = []

		try {
			await profile.time("de-order", tag, () =>
				deOrderEval(
					{
						model: m,
						card: armCard,
						tokenizer: armTok,
						anchorLookup: LK,
						out: `${OUT_DIR}/${tag}-deorder`,
						// Memoize repeated gazetteer lookups for this run.
						lookupMemo: true,
						// On paired non-ship arm, run only the floored/delta-capped de-native-on case.
						...(pairedNonShipArm ? { runs: ["de-native-on" as const] } : {}),
					},
					(line) => deorderOut.push(line),
					(line) => deorderErr.push(line)
				)
			)
		} catch (error) {
			deorderErr.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}

		await writeLocalTextFile(`${renderLines(deorderOut)}${renderLines(deorderErr)}`, `${OUT_DIR}/${tag}-deorder.md`)
	}

	// Run batteries by selected mode:
	// - weights-cache single-arm
	// - paired weights-cache fp32+int8
	// - --model fp32 (+optional int8)
	if (WC) {
		await runBattery(WC_MODEL, "fp32")

		if (WC8) {
			await runBattery(WC8_MODEL, "int8", WC8)
		}
	} else {
		await runBattery(MODEL, "fp32")

		if (INT8) {
			await runBattery(INT8, "int8")
		}
	}

	// Preset compare: in-process, tolerant on failure, captured to presets.md.
	const presetLines: string[] = []

	try {
		await profile.time("presets", undefined, () =>
			presetCompare({ modelPath: shipModel }, (line) => presetLines.push(line))
		)
	} catch (error) {
		console.error(`⚠ preset-compare errored: ${error instanceof Error ? error.message : String(error)}`)
	}

	await writeLocalTextFile(presetLines.map((line) => `${line}\n`).join(""), `${OUT_DIR}/presets.md`)

	// Demo-cascade smoke (#524): whole-stack check, skipped with warning if DB is absent.
	await profile.time("demo-cascade", undefined, () =>
		runDemoCascadeLeg({
			outDir: OUT_DIR,
			shipModel,
			tokenizer: EFF_TOK,
			card: EFF_CARD,
			gazetteerLexicon: GAZ,
		})
	)

	// Arena leg (v4.4.0+): heavy, ship artifact only, enabled by floor presence.
	if ("arena.perturb" in (check.floors ?? {})) {
		// Uses typed options.
		// Behavior matches the untyped call this replaced.
		const arenaOut: string[] = []
		const arenaErr: string[] = []
		let arenaFailed = false

		try {
			await profile.time("arena", undefined, () =>
				externalArenas(
					{
						model: shipModel,
						tokenizer: EFF_TOK,
						modelCard: EFF_CARD,
						gazetteerLexicon: GAZ,
						anchorLookup: LK,
						outDir: `${OUT_DIR}/arenas`,
						...(CONV_MODE ? { conventions: CONV_MODE } : {}),
						...(BRIDGE_MODE ? { bridgeGaps: true } : {}),
					},
					(line) => arenaOut.push(line),
					(line) => arenaErr.push(line)
				)
			)
		} catch (error) {
			// A non-zero exit maps to a throw.
			// The output still reaches arenas.md.
			arenaErr.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
			arenaFailed = true
		}

		await writeLocalTextFile(`${renderLines(arenaOut)}${renderLines(arenaErr)}`, `${OUT_DIR}/arenas.md`)

		// Abort on arena failure.
		if (arenaFailed) {
			return 1
		}
	}

	// FR bare-street floor (#949): parse frozen sample and enforce bare-intact floor.
	const bareStreetFloor = (check.floors ?? {})["fr.bare_street_intact"]

	if (bareStreetFloor !== undefined) {
		// In-process call runs under current runner environment.
		const bareOut: string[] = []
		const bareErr: string[] = []
		let barePassed: boolean

		try {
			const bare = await profile.time("fr-bare-street", undefined, () =>
				frParseRecall(
					{
						model: shipModel,
						tokenizer: EFF_TOK,
						modelCard: EFF_CARD,
						// Resolve anchor/lexicon siblings from graded arm when package-shaped.
						...(WC ? { weightsCache: WC } : {}),
						floor: String(bareStreetFloor),
						json: `${OUT_DIR}/fr-bare-street.json`,
					},
					(line) => bareOut.push(line),
					(line) => bareErr.push(line)
				)
			)

			barePassed = bare.pass
		} catch (error) {
			// nothrow parity: crash counts as failed floor.
			bareErr.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
			barePassed = false
		}

		await writeLocalTextFile(`${renderLines(bareOut)}${renderLines(bareErr)}`, `${OUT_DIR}/fr-bare-street.md`)

		if (!barePassed) {
			console.error(`✗ fr.bare_street_intact FAIL (floor ${bareStreetFloor}%) — see ${OUT_DIR}/fr-bare-street.md`)

			return 1
		}

		console.log(`✓ fr.bare_street_intact PASS (floor ${bareStreetFloor}%)`)
	}

	// Mask-regression is the second promotion lock.
	// Runs only when conventions mode is declared.
	// It writes the report and feeds the final verdict.
	let MASK_CHECK_STATUS = 0

	if (CONV_MODE) {
		console.log("== mask-regression check (#718) ==")

		const maskLines: string[] = []

		try {
			const mask = await profile.time("mask-regression", undefined, () =>
				maskRegressionCheck(
					{
						model: shipModel,
						tokenizer: EFF_TOK,
						modelCard: EFF_CARD,
						anchorLookup: LK,
						gazetteerLexicon: GAZ,
						json: `${OUT_DIR}/mask-regression.json`,
					},
					(line) => maskLines.push(line)
				)
			)

			MASK_CHECK_STATUS = mask.pass ? 0 : 1
		} catch (error) {
			maskLines.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
			MASK_CHECK_STATUS = 1
		}

		await writeLocalTextFile(maskLines.map((line) => `${line}\n`).join(""), `${OUT_DIR}/mask-regression.md`)

		if (MASK_CHECK_STATUS === 0) {
			console.log("✓ mask-regression check PASS (no tag regresses >2pp under the conventions mask)")
		} else {
			console.error(
				`✗ mask-regression check FAIL (see ${OUT_DIR}/mask-regression.md) — a tag regresses >2pp under the '${CONV_MODE}' mask`
			)
		}
	} else {
		console.log("⚠ mask-regression check SKIPPED — spec declares no requires_conventions (no mask in the ship config)")
	}

	return await finalizePromotionVerdict({
		card: EFF_CARD,
		check: CHECK,
		gradedFromWeightsCache: Boolean(options.weightsCache),
		label: LABEL,
		maskCheckStatus: MASK_CHECK_STATUS,
		outDir: OUT_DIR,
		withInt8: Boolean(INT8 || WC8),
	})
}
