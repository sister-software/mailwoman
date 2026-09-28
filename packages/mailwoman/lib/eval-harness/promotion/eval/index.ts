/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs the standard promotion battery and checks its spec floors. It writes one machine-readable verdict.
 *   `--model` compares raw artifacts and supports delta checks. `--weights-cache` selects the in-distribution path
 *   with absolute floors.
 *
 *   Every leg runs in-process. Written `.md` artifacts match the prior child stdout capture byte for byte.
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
 * Render sink lines with one trailing newline per `report()` call, keeping `.md`
 * artifacts byte-compatible with prior child stdout capture.
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
	 * Answer-key path for per-locale grading, spec-declared for comparability.
	 *
	 * When omitted, the run uses the per-locale-f1 default.
	 * Changing this path requires fresh measurements to re-anchor the floors.
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
	 * Candidate fp32 ONNX, required.
	 */
	model?: string
	/**
	 * Quantized int8 sibling.
	 * Re-runs per-tag checks and enforces the delta cap.
	 */
	int8?: string
	/**
	 * Check-spec JSON path or bare name resolved from bundled specs, required.
	 */
	check?: string
	/**
	 * Tokenizer path.
	 *
	 * Defaults to the v0.6.0-a0 tokenizer under `$MAILWOMAN_DATA_ROOT`.
	 */
	tokenizer?: string
	/**
	 * Model-card JSON.
	 * Defaults to `neural-weights-en-us/model-card.json`.
	 */
	card?: string
	/**
	 * Gazetteer lexicon JSON.
	 *
	 * Default `data/gazetteer/anchor-lexicon-v1.json`.
	 */
	gazetteerLexicon?: string
	/**
	 * Package-shaped candidate weights dir `<root>/node_modules/@mailwoman/neural-weights-en-us`,
	 * which feeds anchor+gazetteer+country via loadFromWeights.
	 * Takes precedence over --model/--int8.
	 */
	weightsCache?: string
	/**
	 * Package-shaped INT8 directory with the same layout as {@linkcode PromotionEvalOptions.weightsCache}.
	 *
	 * Pairing requires `weightsCache` and excludes `--model` and `--int8`.
	 * It makes floors and fp32/int8 deltas valid in one run.
	 */
	int8WeightsCache?: string
	/**
	 * Battery output dir.
	 *
	 * Defaults to `<temp-root>/eval-<label>-<hhmm>` under `$MAILWOMAN_TEMP_ROOT`.
	 */
	outDir?: PathBuilderLike
	/**
	 * Optional per-leg wall-time ledger path.
	 *
	 * It must be outside {@linkcode PromotionEvalOptions.outDir} because receipt
	 * comparison expects stable bytes under `outDir`.
	 * Omitted, the run writes no file.
	 */
	profileJSON?: string
}

/**
 * Eval specs directory in source tree.
 */
const SPECS_DIR = resolvePackagePath("mailwoman", "lib", "eval-harness", "specs")

/**
 * Workspaces used by this battery for compiled-freshness checks.
 *
 * Keep it broad enough to cover parse+resolve paths end-to-end.
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

/**
 * Resolve a `--spec` value to a real file: an existing path wins verbatim, otherwise
 * the basename is looked up in the shipped specs dir, with `.json` optional.
 */
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
 * Runs pre-flight guards before the battery.
 *
 * It checks tokenizer comparability, compiled freshness and artifact provenance,
 * then returns an exit code or `null` when the run can proceed.
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
	const CARD_TOK = card.training.tokenizer_version

	// --weights-cache resolves the tokenizer and card from the package, so skip the path check.
	if (!WC && !TOK.includes(CARD_TOK)) {
		console.error(
			`✗ tokenizer path '${TOK}' does not contain card tokenizer_version '${CARD_TOK}' — F1 would be incomparable`
		)

		return 2
	}

	const freshness = await checkCompiledFreshness(repoRootPath(), EVAL_HARNESS_WORKSPACES)

	if (!freshness.fresh && freshness.reason) {
		console.error(`⚠ ${freshness.reason}`)
	}

	// Provenance fingerprint: md5 plus a per-line count of `DynamicQuantizeLinear` hits.
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

	// --weights-cache single-arm logs provenance only.
	// Paired caches get the same fp32/int8 mislabel checks as the --model flow.
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
 * Demo-cascade smoke: whole-stack parse→reconcile→resolve coverage on the ship
 * artifact against the slim hot DB.
 *
 * A missing database produces a warning and skips the leg.
 * A spec floor declared for this leg then fails.
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

	// Refusals and thrown errors both map to non-zero.
	// Only the stdout sink reaches the `.md` artifact.
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
 * Run the full promotion-eval battery, returning the process exit code: 0 = every floor met
 * and the mask-regression lock held, 1 = any miss, 2 = usage or lore-guard refusal.
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

	// Package-shaped mode resolves model/tokenizer/card from cache package siblings, using
	// explicit package-dir paths to avoid a silent fallback to the installed/workspace package.
	const WC = options.weightsCache ?? ""
	const WC_PACKAGE = WC ? weightsCachePackageDir(WC, "en-us") : ""
	const WC_MODEL = WC ? resolvePath(WC_PACKAGE, "model.onnx") : ""
	const EFF_TOK = WC ? resolvePath(WC_PACKAGE, "tokenizer.model") : TOK
	const EFF_CARD = WC ? resolvePath(WC_PACKAGE, "model-card.json") : CARD

	// INT8 arm for the package-shaped pair, resolved the same way.
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
	const LABEL = check.label ?? basename(CHECK).replace(/\.json$/, "")
	const hhmm = String(new Date().getUTCHours()).padStart(2, "0") + String(new Date().getUTCMinutes()).padStart(2, "0")

	if (!OUT_DIR) {
		OUT_DIR = tempRootPathBuilder(`eval-${LABEL}-${hhmm}`)
	}

	await makeDirectories(OUT_DIR)

	const card = await readLocalJSONFile<ModelCard>(EFF_CARD)
	const guardExit = await runLoreGuards({ WC, WC_MODEL, WC8_MODEL, MODEL, INT8, TOK, OUT_DIR, card })

	if (guardExit !== null) return guardExit

	const channelOptions: Pick<
		ScoreAffixOptions,
		"gazetteerLexicon" | "suppressGazNearPostcode" | "conventions" | "bridgeGaps"
	> = {}

	if (check.requires_gazetteer_lexicon === true) {
		channelOptions.gazetteerLexicon = GAZ
		channelOptions.suppressGazNearPostcode = true
	}

	const CONV_MODE = check.requires_conventions ?? ""

	if (CONV_MODE) {
		channelOptions.conventions = CONV_MODE
	}

	let BRIDGE_MODE = ""

	if (check.requires_bridge === true) {
		channelOptions.bridgeGaps = true
		BRIDGE_MODE = "1"
	}

	if (check.golden_dir) {
		console.log(`golden dir: ${check.golden_dir} (spec-declared)`)
	}

	const shipModel = WC ? WC8_MODEL || WC_MODEL : INT8 || MODEL

	const runBattery = async (m: string, tag: string, wc: string = WC): Promise<void> => {
		console.log(`== battery [${tag}] ${m} ==`)

		// A paired run treats fp32 as the arm that does not ship.
		// An unpaired run ships this arm.
		const pairedNonShipArm = tag === "fp32" && Boolean(WC8 || INT8)

		const plOptions = wc
			? { weightsCache: wc }
			: { modelPath: m, tokenizerPath: TOK, modelCardPath: CARD, modelAnchorLookupPath: LK }

		const probeOptions = wc ? { weightsCache: wc } : { model: m }

		const armPackage = wc ? weightsCachePackageDir(wc, "en-us") : ""
		const armTok = wc ? resolvePath(armPackage, "tokenizer.model") : EFF_TOK
		const armCard = wc ? resolvePath(armPackage, "model-card.json") : EFF_CARD

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
					suppressGazNearPostcode: true,
					json: `${OUT_DIR}/${tag}-country.json`,
				},
				(line) => countryLines.push(line)
			)
		)

		await writeLocalFile(renderLines(countryLines), `${OUT_DIR}/${tag}-country.md`)

		await runAffix(`${tag}-pobox.md`, {
			file: "data/eval/external/po-box-cedex-val.jsonl",
			json: `${OUT_DIR}/${tag}-pobox.json`,
		})

		await runAffix(`${tag}-intersection.md`, {
			file: "data/eval/external/intersection-real.jsonl",
			json: `${OUT_DIR}/${tag}-intersection.json`,
		})

		// Watch lenses, recorded but not floored, with no JSON sidecar.
		await runAffix(`${tag}-watch-intersection-vt.md`, { file: "data/eval/external/intersection-golden-vt.jsonl" })
		await runAffix(`${tag}-watch-glue.md`, { file: "data/eval/external/glue-rows-perturb.jsonl" })

		// de-order tolerates a non-zero regression exit while keeping nothrow parity and the merged output.
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

	// Preset compare is in-process and tolerant on failure.
	const presetLines: string[] = []

	try {
		await profile.time("presets", undefined, () =>
			presetCompare({ modelPath: shipModel }, (line) => presetLines.push(line))
		)
	} catch (error) {
		console.error(`⚠ preset-compare errored: ${error instanceof Error ? error.message : String(error)}`)
	}

	await writeLocalTextFile(presetLines.map((line) => `${line}\n`).join(""), `${OUT_DIR}/presets.md`)

	await profile.time("demo-cascade", undefined, () =>
		runDemoCascadeLeg({
			outDir: OUT_DIR,
			shipModel,
			tokenizer: EFF_TOK,
			card: EFF_CARD,
			gazetteerLexicon: GAZ,
		})
	)

	// Arena leg: heavy and ship-artifact-only, enabled by floor presence.
	if ("arena.perturb" in (check.floors ?? {})) {
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

		if (arenaFailed) {
			return 1
		}
	}

	const bareStreetFloor = (check.floors ?? {})["fr.bare_street_intact"]

	if (bareStreetFloor !== undefined) {
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
	// It runs only in conventions mode and contributes to the final verdict.
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
