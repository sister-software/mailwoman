/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Promotion eval runner (#479) — ONE command that runs the standard eval battery against a
 *   candidate model, checks every number against an eval spec CONTRACT, and emits a single
 *   machine-readable verdict. Exists so promotion evals are ENFORCED, not night-shift discipline,
 *   and so "why did this model ship?" has a one-file answer.
 *
 *   Usage: mailwoman eval promote\
 *   --model <fp32.onnx> [--int8 <int8.onnx>]\
 *   | --weights-cache <fp32-pkg-root> [--int8-weights-cache <int8-pkg-root>]\
 *   --spec packages/mailwoman/lib/eval-harness/specs/<spec>.json\
 *   [--tokenizer <tokenizer.model>] [--card <model-card.json>]\
 *   [--gazetteer-lexicon <lexicon.json>] [--out-dir /tmp/eval-<label>]
 *
 *   The --model dual grades RAW artifacts: its fp32↔int8 deltas are valid, but its absolute floors
 *   are NOT for any channel-trained model — the package channel siblings (anchor, gazetteer,
 *   COUNTRY) never load on that path. Package-shaped grading (--weights-cache) is the only
 *   in-distribution floor read, and a PAIR of caches (#47) grades floors and the delta cap together
 *   in one run — the release path.
 *
 *   Behavior:
 *
 *   - Runs: per-locale-f1 (US/FR, tokenizer-enforced), score-affix (+ unit-real),
 *       score-country-homograph, de-order-eval, preset-compare. When --int8 is given, re-runs
 *       the per-tag battery on the int8 artifact and enforces the fp32↔int8 delta cap.
 *   - Demo-cascade smoke (#524): whole-stack parse→reconcile→resolve against the slim hot DB
 *       (MAILWOMAN_WOF_HOT_DB or the v4.4.0 stage default). Skips LOUD when the DB is absent; floor
 *       key `cascade.demo_smoke` (pass-rate %) for specs that eval on it.
 *   - Mask-regression check (#718): when the spec declares requires_conventions, re-runs the ship
 *       artifact mask-off vs mask-on and FAILS the eval if any tag drops >2pp under the mask — the
 *       "second lock" beside createScorer's load-time capability delta check.
 *   - Collects headline numbers into <out-dir>/verdict.json with per-floor PASS/FAIL.
 *   - Exit 0 = every floor met AND the mask-regression lock held; exit 1 = any miss.
 *
 *   EVERY leg RUNS IN-PROCESS. The check spawned eight children (`per-locale-f1`, `score-affix` ×6,
 *   `score-country-homograph`, `de-order-eval`, `external-arenas`, `demo-cascade-smoke`,
 *   `fr-parse-recall`), re-serializing typed options into argv and scraping stdout back out of a
 *   pipe. They are now direct calls into sibling modules with typed options and a line sink,
 *   following `presetCompare` / `maskRegressionCheck` / `assemblePromotionVerdict`. The artifact
 *   files are unchanged — same names, same bytes — because the sinks reproduce each child's stdout
 *   line-for-line, and the verdict assembler still reads exactly what it read before.
 *
 *   Error semantics are preserved leg-for-leg, because they are not uniform and the differences are
 *   deliberate. `nothrow` became try/catch-and-continue; a bare `$` (which threw on non-zero) became
 *   a call whose throw propagates; a leg whose non-zero exit ABORTED the run (arena, fr-recall)
 *   still returns 1; the two legs that merged `${stdout}${stderr}` into one `.md` keep two sinks and
 *   concatenate them in that order. `promotion-eval-sinks.test.ts` pins the table.
 *
 *   ONE deliberate difference, and it touches no artifact: a leg whose stderr the runner captured and
 *   then THREW AWAY (per-locale-f1's progress narration, the cascade leg's preflight complaints) now
 *   reaches the runner's own stderr, because those modules default `reportError` to `console.error`
 *   and this file only overrides the sinks it actually files. `$.verbose = false` used to swallow
 *   them, which is why a 20-minute per-locale leg looked like a hang. Every `.md` is byte-identical
 *   either way — the runner never wrote those bytes anywhere.
 *
 *   Lore encoded (the traps that bit before — see CONTRIBUTING_MODEL_WORK.mdx):
 *
 *   - Tokenizer comparability: the tokenizer path must contain the card's tokenizer_version; refuses to
 *       grade otherwise (F1 across tokenizers is meaningless).
 *   - Gaz-fed flags: when the eval spec sets requires_gazetteer_lexicon, every scorer gets
 *       --gazetteer-lexicon + --suppress-gaz-near-postcode (zero-filled clues fake an affix crash
 *       and depress country recall).
 *   - Recompile-before-eval: warns when core/ sources are newer than core/out.
 *   - FoldToComponents: affix floors are graded from score-affix (unfolded), never from per-locale-f1
 *       (whose fold reports 0 even on a perfect split).
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import {
	pathExists,
	readDirectory,
	readDirectoryEntries,
	readLocalBuffer,
	readLocalJSONFile,
	statPath,
} from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { isoDate } from "@mailwoman/core/utils"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { basename, dirname, join, resolvePath, type PathBuilderLike } from "path-ts"

import { deOrderEval } from "#eval-harness/de-order-eval"
import { demoCascadeSmoke } from "#eval-harness/demo-cascade-smoke"
import { externalArenas } from "#eval-harness/external-arenas"
import { frParseRecall } from "#eval-harness/fr-parse-recall"
import { maskRegressionCheck } from "#eval-harness/mask-regression"
import { perLocaleF1 } from "#eval-harness/per-locale-f1"
import { presetCompare } from "#eval-harness/preset-compare"
import { assemblePromotionVerdict } from "#eval-harness/promotion-eval-verdict"
import { scoreAffix, type ScoreAffixOptions } from "#eval-harness/score-affix"
import { scoreCountryHomograph } from "#eval-harness/score-country-homograph"
import { resolveWOFHotDB } from "#eval-harness/wof-hot-db"

/**
 * Render captured sink lines the way a child process's stdout arrived: one trailing newline per `report()` call. Every
 * `.md` the runner writes goes through this, so the artifacts match the pre-migration bytes.
 *
 * This is the whole migration's required assumption in one line. `console.log(x)` writes `x` then a newline, and zx
 * handed the concatenation of those writes back as `.stdout`; a sink that records one entry per `console.log` call
 * therefore reproduces the same bytes — INCLUDING a multi-line argument (one call, embedded newlines, one trailing
 * newline) and a bare `console.log()` (the empty string, one newline). Exported for `promotion-eval-sinks.test.ts`.
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
	 * The ANSWER KEY the per-locale battery grades against, e.g. `data/eval/golden/v0.1.3/dev`. Spec-declared for the
	 * same reason the conventions mask is: two eval specs that name different golden versions are not comparable, and a
	 * default buried in a scorer makes that invisible. Omitted = per-locale-f1's own default (v0.1.2/dev).
	 *
	 * Answer-key versions are never comparable ACROSS conventions — v0.1.2 folds US street spans, v0.1.3 splits them — so
	 * a spec that moves this field must re-anchor its floors on a fresh reading, never carry the old numbers over.
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
	 * Quantized int8 sibling — re-runs the per-tag battery and enforces the delta cap.
	 */
	int8?: string
	/**
	 * Check-spec JSON: a path, or a bare spec name resolved against the bundled `checks/` dir (required).
	 */
	check?: string
	/**
	 * Tokenizer path. Default: the v0.6.0-a0 tokenizer under `$MAILWOMAN_DATA_ROOT`.
	 */
	tokenizer?: string
	/**
	 * Model-card JSON. Default `neural-weights-en-us/model-card.json`.
	 */
	card?: string
	/**
	 * Gazetteer lexicon JSON. Default `data/gazetteer/anchor-lexicon-v1.json`.
	 */
	gazetteerLexicon?: string
	/**
	 * Package-shaped candidate weights dir `<root>/node_modules/@mailwoman/neural-weights-en-us` — the #718-safe path
	 * that feeds anchor+gazetteer+country via loadFromWeights, the only in-distribution grade for a country-channel model
	 * (v6.2.0+). Alternative to --model/--int8; takes precedence.
	 */
	weightsCache?: string
	/**
	 * Package-shaped INT8 candidate dir, same layout as {@linkcode PromotionEvalOptions.weightsCache} — pairing them runs
	 * the dual fp32+int8 battery entirely package-shaped (#47). The `--model`+`--int8` dual under-feeds the country
	 * channel (channel siblings never load), so its absolute floors are invalid and a release grade needed a second,
	 * single-artifact `--weights-cache` run; a pair makes floors AND deltas valid in one run. Requires
	 * {@linkcode PromotionEvalOptions.weightsCache} (the fp32 arm) and excludes the `--model`/`--int8` flow.
	 */
	int8WeightsCache?: string
	/**
	 * Battery output dir. Default `/tmp/eval-<label>-<hhmm>`.
	 */
	outDir?: PathBuilderLike
}

/**
 * Resolve a `--spec` value to a real file. A path that exists wins verbatim; otherwise the basename is looked up in the
 * `checks/` dir shipped beside this module — `new URL`-relative for the source tree, with a compiled-tree fallback (tsc
 * does not emit readFileSync'd JSON into `out/`, so `packages/mailwoman/out/eval-harness/` reads the source-tree copy
 * at `packages/mailwoman/lib/eval-harness/specs/`; the lint-rules.json pattern). Old `scripts/eval/checks/<spec>.json`
 * invocations therefore keep working by basename.
 *
 * The `.json` suffix is optional, because the help has always advertised "a spec name" and a spec name is what people
 * type. Before that was true, `--spec v5.3.0-family` fell through to `readFileSync("v5.3.0-family")` and died on a bare
 * ENOENT naming a file nobody asked for — which is how it read on 2026-07-16.
 */
/**
 * The eval specs, beside this module in the SOURCE tree — tsc emits no `.json`, so the directory is named from the
 * package root.
 */
const SPECS_DIR = resolvePackagePath("mailwoman", "lib", "eval-harness", "specs")

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
 * Every eval spec shipped beside this module, newest-looking last. For `--spec` errors and tooling.
 */
export async function listEvalSpecs(): Promise<string[]> {
	if (await pathExists(SPECS_DIR)) {
		return (await readDirectory(SPECS_DIR)).filter((file) => file.endsWith(".json")).toSorted()
	}

	return []
}

/**
 * The three pre-flight guards, run before any battery: the tokenizer must be comparable to the card's, `core/out` must
 * not be stale, and every graded artifact's md5 + dynamic-quant fingerprint is recorded to `provenance.txt`. Returns an
 * exit code to propagate, or `null` when the run may proceed.
 *
 * A FAIL is only trustworthy if you know WHICH bytes were graded. v1.9.2's first eval run false-FAILed (us.postcode
 * 86.9) because it graded a stale/mislabeled artifact — the real model scored 97.5 under every config.
 */
async function runLoreGuards(env: {
	WC: string
	WC_MODEL: string
	WC8_MODEL: string
	MODEL: string
	INT8: string
	TOK: string
	OUT_DIR: PathBuilderLike
	card: ModelCard
}): Promise<number | null> {
	const { WC, WC_MODEL, WC8_MODEL, MODEL, INT8, TOK, OUT_DIR, card } = env
	// --- lore guard: tokenizer comparability -----------------------------------
	const CARD_TOK = card.training.tokenizer_version

	// Skipped for --weights-cache: loadFromWeights pairs the package's own tokenizer + card internally,
	// so the (unused) explicit TOK path won't contain the card's version string.
	if (!WC && !TOK.includes(CARD_TOK)) {
		console.error(
			`✗ tokenizer path '${TOK}' does not contain card tokenizer_version '${CARD_TOK}' — F1 would be incomparable`
		)

		return 2
	}

	// --- lore guard: recompile-before-eval --------------------------------------
	// Was `find packages/core -maxdepth 2 -name '*.ts' -newer packages/core/out -print -quit`. Same shape in-process: the
	// same two directory levels, the same `.ts` filter, the same reference mtime (`packages/core/out` itself),
	// and the same short-circuit on the FIRST hit — the `-quit` mattered, since `packages/core/` is large.
	if (await pathExists("packages/core/out")) {
		const reference = (await statPath("packages/core/out")).mtimeMs

		const staleSource = await (async (): Promise<string | undefined> => {
			for (const depth1 of await readDirectoryEntries("packages/core")) {
				const path1 = join("packages/core", depth1.name)

				if (depth1.isFile()) {
					if (depth1.name.endsWith(".ts") && (await statPath(path1)).mtimeMs > reference) return path1

					continue
				}

				if (!depth1.isDirectory()) continue

				for (const depth2 of await readDirectoryEntries(path1)) {
					if (!depth2.isFile() || !depth2.name.endsWith(".ts")) continue
					const path2 = join(path1, depth2.name)

					if ((await statPath(path2)).mtimeMs > reference) return path2
				}
			}

			return undefined
		})()

		if (staleSource) {
			console.error("⚠ core/ sources newer than core/out — run 'yarn compile' or the harness grades stale code")
		}
	}

	// --- lore guard: artifact provenance ----------------------------------------
	// A FAIL is only trustworthy if you know WHICH bytes were graded. v1.9.2's first eval run
	// false-FAILed (us.postcode 86.9) because it graded a stale/mislabeled artifact — the real model
	// scored 97.5 under every config. Record md5 + the dynamic-quant fingerprint (count of
	// DynamicQuantizeLinear nodes; 0 = fp32, >0 = int8) of every graded artifact, and hard-assert the
	// obvious mislabels: --model must be fp32, --int8 must actually be quantized and differ from --model.
	//
	// Was `grep -c -a DynamicQuantizeLinear <path>`. grep -c counts MATCHING LINES, not occurrences, and
	// an ONNX file has no meaningful lines — so the number was only ever read as zero-vs-nonzero, and the
	// scan below reproduces that reading (it counts newline-delimited chunks carrying the needle, over the
	// raw bytes, exactly as `grep -a` treated the binary as text). Kept as a STRING because it is
	// interpolated verbatim into provenance.txt and compared against the literal "0".
	const dql = async (p: string): Promise<string> => {
		const needle = Buffer.from("DynamicQuantizeLinear", "latin1")
		const buffer = await readLocalBuffer(p)

		const NEWLINE = 0x0a

		let count = 0
		let searchFrom = 0

		for (;;) {
			const hit = buffer.indexOf(needle, searchFrom)

			if (hit === -1) break

			// One count per matching LINE: charge this line, then resume past its newline so a second
			// occurrence on the same line cannot be counted twice.
			count++
			const lineEnd = buffer.indexOf(NEWLINE, hit)

			if (lineEnd === -1) break
			searchFrom = lineEnd + 1
		}

		return String(count)
	}

	const md5 = async (p: string): Promise<string> => md5File(p)

	// --weights-cache alone: one artifact (typically the shipped package int8) graded in the primary
	// slot — log its provenance, skip the dual-artifact assertions (there is no pair to cross-check).
	// A PAIR (#47) restores them: the primary arm is the fp32 by contract, so the same three mislabel
	// assertions the --model flow carries apply, against the package-resolved bytes.
	if (WC) {
		const wcDql = await dql(WC_MODEL)

		const provLines = [
			`graded at ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
			`WEIGHTS-CACHE  ${await md5(WC_MODEL)}  dql=${wcDql}  ${WC_MODEL}`,
		]

		let wc8Dql = ""

		if (WC8_MODEL) {
			wc8Dql = await dql(WC8_MODEL)
			provLines.push(`WC-INT8        ${await md5(WC8_MODEL)}  dql=${wc8Dql}  ${WC8_MODEL}`)
		}

		const provenance = provLines.join("\n") + "\n"
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

		const provLines = [
			`graded at ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
			`MODEL  ${await md5(MODEL)}  dql=${modelDql}  ${MODEL}`,
		]

		let int8Dql = ""

		if (INT8) {
			int8Dql = await dql(INT8)
			provLines.push(`INT8   ${await md5(INT8)}  dql=${int8Dql}  ${INT8}`)
		}

		const provenance = provLines.join("\n") + "\n"
		await writeLocalFile(provenance, `${OUT_DIR}/provenance.txt`) // tee → file …
		process.stdout.write(provenance)

		//                       … and stdout

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
 * Demo-cascade smoke (#524): the whole-stack parse→reconcile→resolve pass the per-layer battery lacks (the 2026-06-11
 * lesson: #520/#521/#522 all shipped through green per-layer checks). Runs on the ship artifact against the slim hot DB
 * the demo serves. Env-restricted like the other artifact-dependent legs: skips LOUD when the DB is absent so CI stays
 * green without it — but an eval spec that floors `cascade.demo_smoke` will then FAIL on the missing sidecar (by
 * design).
 *
 * Its own function because it is self-contained and `runPromotionEval` is at the statement ceiling; nothing about the
 * leg's behavior changed in the lift.
 */
async function runDemoCascadeLeg(env: {
	outDir: PathBuilderLike
	shipModel: string
	tokenizer: string
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

	// nothrow parity: a refusal (missing artifacts / malformed rows) comes back as a non-zero exitCode,
	// and an unexpected throw is caught and treated the same way. Only the OUT sink reaches the .md —
	// the child's stderr went nowhere, so a preflight refusal still leaves an empty cascade-smoke.md
	// and only the runner's own line below explains it.
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
 * Run the full promotion-eval battery. Returns the process exit code: 0 = every floor met AND the mask-regression lock
 * held, 1 = any miss, 2 = usage / lore-guard refusal.
 */
export async function runPromotionEval(options: PromotionEvalOptions): Promise<number> {
	const MODEL = options.model ?? ""
	const INT8 = options.int8 ?? ""
	const CHECK = options.check ? await resolveThresholdSpecPath(options.check) : ""
	let OUT_DIR = options.outDir ?? ""
	const TOK = options.tokenizer ?? String(dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model"))
	const CARD = options.card ?? "packages/neural-weights-en-us/model-card.json"
	const GAZ = options.gazetteerLexicon ?? "data/gazetteer/anchor-lexicon-v1.json"
	const LK = dataRootPath("anchor", "pilot-anchor-lookup.json")

	// PACKAGE-SHAPED (#718-safe): when --weights-cache is set, the graded artifact + its tokenizer/card
	// are the cache's own siblings. The metric probes load it via loadFromWeights (feeding anchor +
	// gazetteer + COUNTRY — the only in-distribution grade for a country-channel model); the
	// country-orthogonal downstream legs (preset / cascade / arena / fr-recall / mask) stay on the
	// explicit --model path against these EFF_TOK/EFF_CARD siblings.
	//
	// The cache layout comes from `weightsCachePackageDir` — the resolver's OWN function, not a
	// re-typed `node_modules/@mailwoman/neural-weights-en-us` literal (2026-08-06 triage). The three
	// artifacts are then named as siblings of that directory, which is what `resolveFromPackageDir`
	// does one layer down.
	//
	// NOT `resolveWeights({cacheRoot: WC})`, deliberately: its cache rung is a FALLBACK. A staged
	// bundle missing its binaries falls through to rung 1 (the installed/workspace package), which in
	// this repo always resolves — so a mis-staged candidate would be graded as the SHIPPED model,
	// silently, and the verdict would carry production's numbers under the candidate's label. Naming
	// the directory keeps the failure an ENOENT in the provenance guard's md5 read, three lines down.
	const WC = options.weightsCache ?? ""
	const WC_PACKAGE = WC ? weightsCachePackageDir(WC, "en-us") : ""
	const WC_MODEL = WC ? resolvePath(WC_PACKAGE, "model.onnx") : ""
	const EFF_TOK = WC ? resolvePath(WC_PACKAGE, "tokenizer.model") : TOK
	const EFF_CARD = WC ? resolvePath(WC_PACKAGE, "model-card.json") : CARD

	// The int8 arm of a package-shaped pair (#47) — same layout, resolved the same deliberate way.
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
	// A label-less spec must not crash the PASS path (the post-verdict ledger hint interpolates
	// LABEL — bit on the first v7.0.0-base run, whose spec omitted the field).
	const LABEL = check.label ?? basename(CHECK).replace(/\.json$/, "")
	const hhmm = String(new Date().getUTCHours()).padStart(2, "0") + String(new Date().getUTCMinutes()).padStart(2, "0")

	if (!OUT_DIR) {
		OUT_DIR = `/tmp/eval-${LABEL}-${hhmm}`
	}

	await makeDirectories(OUT_DIR)

	const card = await readLocalJSONFile<ModelCard>(EFF_CARD)
	const guardExit = await runLoreGuards({ WC, WC_MODEL, WC8_MODEL, MODEL, INT8, TOK, OUT_DIR, card })

	if (guardExit !== null) return guardExit

	// The spec-declared channel config every scorer shares. Was an argv fragment (`GAZ_ARGS`) spliced
	// into eight command lines; it is now one typed object spread into eight calls, which is the same
	// contract with the stringly-typed step removed.
	const channelOptions: Pick<
		ScoreAffixOptions,
		"gazetteerLexicon" | "suppressGazNearPostcode" | "conventions" | "bridgeGaps"
	> = {}

	if (check.requires_gazetteer_lexicon === true) {
		channelOptions.gazetteerLexicon = GAZ
		channelOptions.suppressGazNearPostcode = true
	}

	// Conventions channel (#511 Tier A): when the eval spec declares requires_conventions, every scorer
	// parses with the address-system conventions mask in the declared mode ("auto" = locale-head
	// detection). Same contract discipline as the gaz flags — the spec IS the ship config.
	const CONV_MODE = check.requires_conventions ?? ""

	if (CONV_MODE) {
		channelOptions.conventions = CONV_MODE
	}

	// Span-bridge channel (v4.4.0 corrective): spec-declared like the conventions mask.
	let BRIDGE_MODE = ""

	if (check.requires_bridge === true) {
		channelOptions.bridgeGaps = true
		BRIDGE_MODE = "1"
	}

	// The answer key is part of the ship config, exactly like the gaz flags and the conventions mask.
	// Recorded in the provenance line so a verdict says WHICH key produced it.
	if (check.golden_dir) {
		console.log(`golden dir: ${check.golden_dir} (spec-declared)`)
	}

	// The ship artifact: the int8 arm when a pair is graded (the int8 is what ships), else the
	// single cache, else the --model flow's int8-or-fp32.
	const shipModel = WC ? WC8_MODEL || WC_MODEL : INT8 || MODEL

	const runBattery = async (m: string, tag: string, wc: string = WC): Promise<void> => {
		console.log(`== battery [${tag}] ${m} ==`)

		// Package-shaped (#718): the metric probes (which support weightsCache) load ALL channels —
		// anchor + gazetteer + COUNTRY — from the package. The country-orthogonal de-order watch lens
		// stays on the explicit path against the cache siblings (EFF_TOK/EFF_CARD); m = the arm's own
		// model when package-shaped. `wc` is the PER-BATTERY cache root so a paired int8 arm (#47)
		// loads its own package, not the fp32 arm's.
		const plOptions = wc
			? { weightsCache: wc }
			: { modelPath: m, tokenizerPath: TOK, modelCardPath: CARD, modelAnchorLookupPath: String(LK) }

		const probeOptions = wc ? { weightsCache: wc } : { model: m }

		// The de-order watch lens takes explicit paths, so it names the ARM's own siblings — a paired
		// int8 arm must not be decoded under the fp32 arm's card if the two bundles ever diverge.
		const armPackage = wc ? weightsCachePackageDir(wc, "en-us") : ""
		const armTok = wc ? resolvePath(armPackage, "tokenizer.model") : EFF_TOK
		const armCard = wc ? resolvePath(armPackage, "model-card.json") : EFF_CARD

		// Each leg below captured a child's stdout into one `.md`. In-process the sink collects the same
		// lines and `renderLines` re-adds the newline console.log would have. A bare `$` THREW on a
		// non-zero exit, aborting the run — these calls throw the same way, so the abort behavior for
		// the metric probes is unchanged.
		const perLocaleLines: string[] = []

		await perLocaleF1(
			{
				...plOptions,
				// Spec-declared, and spelled out rather than spread: per-locale-f1 names the lexicon field
				// `gazetteerLexiconPath` where the affix probes call it `gazetteerLexicon`, and a spread would
				// have carried the wrong key silently past TypeScript into a channel that stayed unfed.
				...(check.golden_dir ? { goldenDir: check.golden_dir } : {}),
				...(channelOptions.gazetteerLexicon ? { gazetteerLexiconPath: channelOptions.gazetteerLexicon } : {}),
				...(channelOptions.suppressGazNearPostcode ? { suppressGazNearPostcode: true } : {}),
				...(channelOptions.conventions ? { conventions: channelOptions.conventions } : {}),
				...(channelOptions.bridgeGaps ? { bridgeGaps: true } : {}),
				outJSON: `${OUT_DIR}/${tag}-per-locale.json`,
			},
			(line) => perLocaleLines.push(line)
		)

		await writeLocalFile(renderLines(perLocaleLines), `${OUT_DIR}/${tag}-per-locale.md`)

		// One helper for the SIX score-affix legs — the runner's most repeated spawn, and the migration's
		// clearest win: `file`/`json` are the only things that varied.
		const runAffix = async (mdName: string, extra: ScoreAffixOptions): Promise<void> => {
			const lines: string[] = []

			await scoreAffix({ ...probeOptions, ...channelOptions, ...extra }, (line) => lines.push(line))

			await writeLocalFile(renderLines(lines), `${OUT_DIR}/${mdName}`)
		}

		await runAffix(`${tag}-affix.md`, { json: `${OUT_DIR}/${tag}-affix.json` })

		await runAffix(`${tag}-unit.md`, {
			file: "data/eval/external/unit-real-designators.jsonl",
			json: `${OUT_DIR}/${tag}-unit.json`,
		})

		const countryLines: string[] = []

		await scoreCountryHomograph(
			{
				...probeOptions,
				...channelOptions,
				// The country probe ALWAYS suppresses gaz clues near a postcode, whether or not the spec
				// asked for the gaz channel — this flag was hard-coded on its command line.
				suppressGazNearPostcode: true,
				json: `${OUT_DIR}/${tag}-country.json`,
			},
			(line) => countryLines.push(line)
		)

		await writeLocalFile(renderLines(countryLines), `${OUT_DIR}/${tag}-country.md`)

		// v4.4.0 floors: po_box/cedex (the coverage-database val) + intersections (real TIGER crossings).
		await runAffix(`${tag}-pobox.md`, {
			file: "data/eval/external/po-box-cedex-val.jsonl",
			json: `${OUT_DIR}/${tag}-pobox.json`,
		})

		await runAffix(`${tag}-intersection.md`, {
			file: "data/eval/external/intersection-real.jsonl",
			json: `${OUT_DIR}/${tag}-intersection.json`,
		})

		// Watch lenses (v4.4.0+, recorded not floored — one release of history before promotion, #488).
		// No sidecar: these two never passed --json.
		await runAffix(`${tag}-watch-intersection-vt.md`, { file: "data/eval/external/intersection-golden-vt.jsonl" })
		await runAffix(`${tag}-watch-glue.md`, { file: "data/eval/external/glue-rows-perturb.jsonl" })

		// de-order-eval tolerates its own non-zero regression exit (it wrote a valid report) — the
		// try/catch is the in-process `nothrow:`, and the two sinks concatenated below are the
		// `${stdout}${stderr}` the check wrote before.
		const deorderOut: string[] = []
		const deorderErr: string[] = []

		try {
			await deOrderEval(
				{
					model: m,
					card: armCard,
					tokenizer: armTok,
					anchorLookup: String(LK),
					out: `${OUT_DIR}/${tag}-deorder`,
				},
				(line) => deorderOut.push(line),
				(line) => deorderErr.push(line)
			)
		} catch (error) {
			deorderErr.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}

		await writeLocalTextFile(`${renderLines(deorderOut)}${renderLines(deorderErr)}`, `${OUT_DIR}/${tag}-deorder.md`)
	}

	// --weights-cache alone grades the single shipped package (int8) in the primary slot; the verdict
	// reads the `fp32-*` files (its primary-artifact slot) with withInt8=false. Paired (#47), the
	// fp32 arm takes the primary slot and the int8 arm runs the same battery from its OWN package, so
	// floors and the delta cap are both graded in-distribution in one run. The --model path keeps the
	// fp32 + optional int8 dual-artifact flow (deltas valid; absolute floors under-fed — the country
	// channel's siblings never load there).
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

	// In-process since the eval-harness migration (was `node scripts/eval/demo-preset-compare.ts`);
	// same capture: the report lines land in presets.md, a failure is tolerated like the old child's
	// self-caught `.catch(console.error)` (partial output kept, check continues).
	const presetLines: string[] = []

	try {
		await presetCompare({ modelPath: shipModel }, (line) => presetLines.push(line))
	} catch (error) {
		console.error(`⚠ preset-compare errored: ${error instanceof Error ? error.message : String(error)}`)
	}

	await writeLocalTextFile(presetLines.map((line) => `${line}\n`).join(""), `${OUT_DIR}/presets.md`)

	// Demo-cascade smoke (#524): the whole-stack parse→reconcile→resolve pass the per-layer battery
	// lacks (the 2026-06-11 lesson: #520/#521/#522 all shipped through green per-layer checks). Runs on
	// the ship artifact against the slim hot DB the demo serves. Env-restricted like the other
	// artifact-dependent legs: skips LOUD when the DB is absent so CI stays green without it — but a
	// eval spec that floors `cascade.demo_smoke` will then FAIL on the missing sidecar (by design).
	await runDemoCascadeLeg({
		outDir: OUT_DIR,
		shipModel,
		tokenizer: EFF_TOK,
		card: EFF_CARD,
		gazetteerLexicon: GAZ,
	})

	// Arena leg (v4.4.0+: arena.perturb is a floor when the spec declares it) — heavy, ship artifact only.
	if ("arena.perturb" in (check.floors ?? {})) {
		// (Historical note: the compiled v0 arena parser used to ENOENT on libpostal dicts because
		// repo.ts's __isCompiledTree detection landed CorePackageAbsolutePath at core/out, so dict reads
		// went to core/out/data/... while the data lives at core/data/.... A local core/out/data symlink
		// bridged the gap. #481 fixed the detection — the compiled tree now reads core/data directly — so
		// no bridge is needed here anymore.)
		// Typed options replace the argv the bash-era env threading had already become.
		const arenaOut: string[] = []
		const arenaErr: string[] = []
		let arenaFailed = false

		try {
			await externalArenas(
				{
					model: shipModel,
					tokenizer: EFF_TOK,
					modelCard: EFF_CARD,
					gazetteerLexicon: GAZ,
					anchorLookup: String(LK),
					outDir: `${OUT_DIR}/arenas`,
					...(CONV_MODE ? { conventions: CONV_MODE } : {}),
					...(BRIDGE_MODE ? { bridgeGaps: true } : {}),
				},
				(line) => arenaOut.push(line),
				(line) => arenaErr.push(line)
			)
		} catch (error) {
			// The child's non-zero exit is a throw in-process. It still lands in arenas.md — the old
			// capture merged stderr in, and a zx ProcessOutput carried the failing child's output there.
			arenaErr.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
			arenaFailed = true
		}

		await writeLocalTextFile(`${renderLines(arenaOut)}${renderLines(arenaErr)}`, `${OUT_DIR}/arenas.md`)

		// set -e: a non-zero arena run aborts the run before the verdict.
		if (arenaFailed) {
			return 1
		}
	}

	// FR bare-street floor (#949) — the class v5.2.0 silently regressed (34/40 → 16/40) because no
	// standing leg measured FR street parsing WITHOUT a postcode anchor. Reads a FROZEN 40-row OSM
	// sample (committed fixture, no live database needed), parses each bare + anchored, and fails if the
	// bare-intact rate drops below the spec floor. The leg self-reports its verdict + exits non-zero.
	const bareStreetFloor = (check.floors ?? {})["fr.bare_street_intact"]

	if (bareStreetFloor !== undefined) {
		// The `env: childEnv()` this spawn carried is gone with the child — an in-process call already
		// runs under the runner's own environment, which is what childEnv() was reconstructing.
		const bareOut: string[] = []
		const bareErr: string[] = []
		let barePassed: boolean

		try {
			const bare = await frParseRecall(
				{
					model: shipModel,
					tokenizer: EFF_TOK,
					modelCard: EFF_CARD,
					// The leg's anchor + lexicon siblings must come from the arm being graded, not from whatever the
					// checkout happens to have linked. Without this it read the tracked workspace, which is bare on a dev
					// checkout, and the ENOENT surfaced as a bare-street floor FAILURE.
					...(WC ? { weightsCache: WC } : {}),
					floor: String(bareStreetFloor),
					json: `${OUT_DIR}/fr-bare-street.json`,
				},
				(line) => bareOut.push(line),
				(line) => bareErr.push(line)
			)

			barePassed = bare.pass
		} catch (error) {
			// nothrow parity: a crash was a non-zero exit, which failed the floor.
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

	// --- mask-regression check (#718) — the "second lock" ------------------------
	// Re-runs the SHIP artifact mask-off vs the declared conventions mode and FAILS if any tag's UNFOLDED
	// F1 drops >2pp under the mask — a finer net than createScorer's load-time 5pp delta check (it catches
	// INDIRECT mask harms, e.g. forbidding street_suffix depressing street). Weight-dependent, so it lives
	// on the release path here, NOT Test CI (#582). Only meaningful when the spec declares a conventions
	// mask; skipped = PASS otherwise. Its status folds into the final verdict below. In-process since the
	// eval-harness migration; the report lines land in mask-regression.md as the child capture did, and a
	// throw is recorded there like the old child's stderr stack.
	let MASK_CHECK_STATUS = 0

	if (CONV_MODE) {
		console.log("== mask-regression check (#718) ==")

		const maskLines: string[] = []

		try {
			const mask = await maskRegressionCheck(
				{
					model: shipModel,
					tokenizer: EFF_TOK,
					modelCard: EFF_CARD,
					anchorLookup: String(LK),
					gazetteerLexicon: GAZ,
					json: `${OUT_DIR}/mask-regression.json`,
				},
				(line) => maskLines.push(line)
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

	// --- collect + verify --------------------------------------------------------
	// Folds BOTH locks: the floor verdict AND the mask-regression check above. Either miss fails the eval.
	let VERDICT_STATUS: number

	try {
		const { failed } = await assemblePromotionVerdict({
			check: CHECK,
			outDir: OUT_DIR,
			withInt8: Boolean(INT8 || WC8),
			...(options.weightsCache ? { gradedArtifact: "weights-cache" as const } : {}),
		})

		VERDICT_STATUS = failed ? 1 : 0
	} catch (error) {
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))

		VERDICT_STATUS = 1
	}

	if (VERDICT_STATUS !== 0 || MASK_CHECK_STATUS !== 0) {
		if (MASK_CHECK_STATUS !== 0) {
			console.error(`✗ check FAILED the mask-regression lock (#718) — see ${OUT_DIR}/mask-regression.md`)
		}

		return 1
	}

	// --- ledger (#885) — the update is automatic, not discipline ------------------
	// The ledger froze at v4.4.0 because appending relied on a human remembering. On a PASS, print
	// the exact ledger-append command with everything pre-filled; the release-prep flow runs it with
	// the real npm version. (Not auto-executed here: the runner runs on candidates that may never
	// ship, and the ledger records shipped/shippable versions keyed by npm semver.)
	const shipDate = isoDate()

	console.log(
		`\nledger (#885): on promote, append this run —\n` +
			`  node packages/mailwoman/out/cli.js eval ledger-append \\\n` +
			`    --out-dir ${OUT_DIR} --model-version <npm-semver> \\\n` +
			`    --run-id ${LABEL.replaceAll(/[^a-z0-9-]/g, "-")}-${shipDate.replaceAll("-", "")} \\\n` +
			`    --model-path "@mailwoman/neural-weights-en-us@<npm-semver>" --card ${EFF_CARD}`
	)

	return 0
}
