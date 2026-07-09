/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Promotion gate runner (#479) — ONE command that runs the standard eval battery against a
 *   candidate model, checks every number against a gate-spec CONTRACT, and emits a single
 *   machine-readable verdict. Exists so promotion gates are ENFORCED, not night-shift discipline,
 *   and so "why did this model ship?" has a one-file answer.
 *
 *   Usage: node scripts/eval/promotion-gate.ts\
 *   --model <fp32.onnx> [--int8 <int8.onnx>]\
 *   --gate scripts/eval/gates/<spec>.json\
 *   [--tokenizer <tokenizer.model>] [--card <model-card.json>]\
 *   [--gazetteer-lexicon <lexicon.json>] [--out-dir /tmp/gate-<label>]
 *
 *   Behavior:
 *
 *   - Runs: per-locale-f1 (US/FR, tokenizer-enforced), score-affix (+ unit-real),
 *       score-country-homograph, de-order-eval, demo-preset-compare. When --int8 is given, re-runs
 *       the per-tag battery on the int8 artifact and enforces the fp32↔int8 delta cap.
 *   - Demo-cascade smoke (#524): whole-stack parse→reconcile→resolve against the slim hot DB
 *       (MAILWOMAN_WOF_HOT_DB or the v4.4.0 stage default). Skips LOUD when the DB is absent; floor
 *       key `cascade.demo_smoke` (pass-rate %) for specs that gate on it.
 *   - Mask-regression gate (#718): when the spec declares requires_conventions, re-runs the ship
 *       artifact mask-off vs mask-on and FAILS the gate if any tag drops >2pp under the mask — the
 *       "second lock" beside createScorer's load-time capability delta-gate.
 *   - Collects headline numbers into <out-dir>/verdict.json with per-floor PASS/FAIL.
 *   - Exit 0 = every floor met AND the mask-regression lock held; exit 1 = any miss.
 *
 *   Lore encoded (the traps that bit before — see CONTRIBUTING_MODEL_WORK.mdx):
 *
 *   - Tokenizer comparability: the tokenizer path must contain the card's tokenizer_version; refuses to
 *       grade otherwise (F1 across tokenizers is meaningless).
 *   - Gaz-fed flags: when the gate spec sets requires_gazetteer_lexicon, every scorer gets
 *       --gazetteer-lexicon + --suppress-gaz-near-postcode (zero-filled clues fake an affix crash
 *       and depress country recall).
 *   - Recompile-before-eval: warns when core/ sources are newer than core/out.
 *   - FoldToComponents: affix floors are graded from score-affix (unfolded), never from per-locale-f1
 *       (whose fold reports 0 even on a perfect split).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parseArgs } from "node:util"

import { $public } from "@mailwoman/core/env"
import { runIfScript } from "@mailwoman/core/scripting"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { dataRootPath } from "@mailwoman/core/utils"
import { $ } from "zx"

interface GateSpec {
	label: string
	requires_gazetteer_lexicon?: boolean
	requires_conventions?: string
	requires_bridge?: boolean
	floors?: Record<string, unknown>
}

interface ModelCard {
	training: { tokenizer_version: string }
}

async function main() {
	// zx: capture output ourselves (don't echo the full stream) and slice the way the bash redirects did.
	$.verbose = false

	// --- arg parse (faithful to the .sh: --flag value; unknown / missing-required → exit 2) ---
	let parsed: { values: Record<string, string | boolean | undefined> }

	try {
		parsed = parseArgs({
			options: {
				model: { type: "string" },
				int8: { type: "string" },
				gate: { type: "string" },
				tokenizer: { type: "string" },
				card: { type: "string" },
				"gazetteer-lexicon": { type: "string" },
				"out-dir": { type: "string" },
			},
		})
	} catch (e) {
		console.error(`unknown arg: ${e instanceof Error ? e.message : e}`)
		process.exit(2)
	}
	const args = parsed.values
	const MODEL = (args.model as string | undefined) ?? ""
	const INT8 = (args.int8 as string | undefined) ?? ""
	const GATE = (args.gate as string | undefined) ?? ""
	let OUT_DIR = (args["out-dir"] as string | undefined) ?? ""
	const TOK =
		(args.tokenizer as string | undefined) ??
		String(dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model"))
	const CARD = (args.card as string | undefined) ?? "neural-weights-en-us/model-card.json"
	const GAZ = (args["gazetteer-lexicon"] as string | undefined) ?? "data/gazetteer/anchor-lexicon-v1.json"
	const LK = dataRootPath("anchor", "pilot-anchor-lookup.json")

	if (!MODEL || !GATE) {
		console.error("✗ --model and --gate required")
		process.exit(2)
	}

	const gate = JSON.parse(readFileSync(GATE, "utf8")) as GateSpec
	const LABEL = gate.label
	const hhmm = String(new Date().getUTCHours()).padStart(2, "0") + String(new Date().getUTCMinutes()).padStart(2, "0")

	if (!OUT_DIR) {
		OUT_DIR = `/tmp/gate-${LABEL}-${hhmm}`
	}
	mkdirSync(OUT_DIR, { recursive: true })

	// --- lore guard: tokenizer comparability -----------------------------------
	const card = JSON.parse(readFileSync(CARD, "utf8")) as ModelCard
	const CARD_TOK = card.training.tokenizer_version

	if (!TOK.includes(CARD_TOK)) {
		console.error(
			`✗ tokenizer path '${TOK}' does not contain card tokenizer_version '${CARD_TOK}' — F1 would be incomparable`
		)
		process.exit(2)
	}

	// --- lore guard: recompile-before-eval --------------------------------------
	if (existsSync("core/out")) {
		const found = await $({ nothrow: true })`find core -maxdepth 2 -name ${"*.ts"} -newer core/out -print -quit`

		if (found.stdout.trim()) {
			console.error("⚠ core/ sources newer than core/out — run 'yarn compile' or the harness grades stale code")
		}
	}

	// --- lore guard: artifact provenance ----------------------------------------
	// A FAIL is only trustworthy if you know WHICH bytes were graded. v1.9.2's first gate run
	// false-FAILed (us.postcode 86.9) because it graded a stale/mislabeled artifact — the real model
	// scored 97.5 under every config. Record md5 + the dynamic-quant fingerprint (count of
	// DynamicQuantizeLinear nodes; 0 = fp32, >0 = int8) of every graded artifact, and hard-assert the
	// obvious mislabels: --model must be fp32, --int8 must actually be quantized and differ from --model.
	// grep -c prints 0 + exits 1 on no-match; nothrow keeps the single "0".
	const dql = async (p: string): Promise<string> => {
		const r = await $({ nothrow: true })`grep -c -a DynamicQuantizeLinear ${p}`

		return r.stdout.trim()
	}
	const md5 = async (p: string): Promise<string> => {
		const r = await $`md5sum ${p}`

		return r.stdout.trim().split(/\s+/)[0] ?? ""
	}

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
	writeFileSync(`${OUT_DIR}/provenance.txt`, provenance) // tee → file …
	process.stdout.write(provenance)

	//                       … and stdout

	if (modelDql !== "0") {
		console.error(`✗ --model '${MODEL}' carries int8 quant nodes — it is not an fp32 artifact`)
		process.exit(2)
	}

	if (INT8) {
		if (int8Dql === "0") {
			console.error(`✗ --int8 '${INT8}' has no quant nodes — it is not a quantized artifact`)
			process.exit(2)
		}

		if ((await md5(MODEL)) === (await md5(INT8))) {
			console.error("✗ --model and --int8 are byte-identical — one is mislabeled")
			process.exit(2)
		}
	}

	const GAZ_ARGS: string[] = []

	if (gate.requires_gazetteer_lexicon === true) {
		GAZ_ARGS.push("--gazetteer-lexicon", GAZ, "--suppress-gaz-near-postcode")
	}
	// Conventions channel (#511 Tier A): when the gate spec declares requires_conventions, every scorer
	// parses with the address-system conventions mask in the declared mode ("auto" = locale-head
	// detection). Same contract discipline as the gaz flags — the spec IS the ship config.
	const CONV_MODE = gate.requires_conventions ?? ""

	if (CONV_MODE) {
		GAZ_ARGS.push("--conventions", CONV_MODE)
	}
	// Span-bridge channel (v4.4.0 corrective): spec-declared like the conventions mask.
	let BRIDGE_MODE = ""

	if (gate.requires_bridge === true) {
		GAZ_ARGS.push("--bridge-gaps")
		BRIDGE_MODE = "1"
	}

	const shipModel = INT8 || MODEL

	const runBattery = async (m: string, tag: string): Promise<void> => {
		console.log(`== battery [${tag}] ${m} ==`)
		const perLocale =
			await $`node scripts/eval/per-locale-f1.ts --model ${m} --tokenizer ${TOK} --model-card ${CARD} --model-anchor-lookup ${LK} ${GAZ_ARGS} --out-json ${`${OUT_DIR}/${tag}-per-locale.json`}`
		writeFileSync(`${OUT_DIR}/${tag}-per-locale.md`, perLocale.stdout)
		const affix =
			await $`node scripts/eval/score-affix.ts --model ${m} ${GAZ_ARGS} --json ${`${OUT_DIR}/${tag}-affix.json`}`
		writeFileSync(`${OUT_DIR}/${tag}-affix.md`, affix.stdout)
		const unit =
			await $`node scripts/eval/score-affix.ts --model ${m} --file data/eval/external/unit-real-designators.jsonl ${GAZ_ARGS} --json ${`${OUT_DIR}/${tag}-unit.json`}`
		writeFileSync(`${OUT_DIR}/${tag}-unit.md`, unit.stdout)
		const country =
			await $`node scripts/eval/score-country-homograph.ts --model ${m} ${GAZ_ARGS} --suppress-gaz-near-postcode --json ${`${OUT_DIR}/${tag}-country.json`}`
		writeFileSync(`${OUT_DIR}/${tag}-country.md`, country.stdout)
		// v4.4.0 floors: po_box/cedex (the coverage-shard val) + intersections (real TIGER crossings).
		const pobox =
			await $`node scripts/eval/score-affix.ts --model ${m} --file data/eval/external/po-box-cedex-val.jsonl ${GAZ_ARGS} --json ${`${OUT_DIR}/${tag}-pobox.json`}`
		writeFileSync(`${OUT_DIR}/${tag}-pobox.md`, pobox.stdout)
		const intersection =
			await $`node scripts/eval/score-affix.ts --model ${m} --file data/eval/external/intersection-real.jsonl ${GAZ_ARGS} --json ${`${OUT_DIR}/${tag}-intersection.json`}`
		writeFileSync(`${OUT_DIR}/${tag}-intersection.md`, intersection.stdout)
		// Watch lenses (v4.4.0+, recorded not floored — one release of history before promotion, #488):
		const watchVt =
			await $`node scripts/eval/score-affix.ts --model ${m} --file data/eval/external/intersection-golden-vt.jsonl ${GAZ_ARGS}`
		writeFileSync(`${OUT_DIR}/${tag}-watch-intersection-vt.md`, watchVt.stdout)
		const watchGlue =
			await $`node scripts/eval/score-affix.ts --model ${m} --file data/eval/external/glue-rows-perturb.jsonl ${GAZ_ARGS}`
		writeFileSync(`${OUT_DIR}/${tag}-watch-glue.md`, watchGlue.stdout)
		// de-order-eval tolerates its own non-zero regression exit (it wrote a valid report) — nothrow,
		// combine stdout+stderr like the bash `> … 2>&1 || true`.
		const deorder = await $({
			nothrow: true,
		})`node scripts/eval/de-order-eval.ts --model ${m} --card ${CARD} --tokenizer ${TOK} --anchor-lookup ${LK} --out ${`${OUT_DIR}/${tag}-deorder`}`
		writeFileSync(`${OUT_DIR}/${tag}-deorder.md`, `${deorder.stdout}${deorder.stderr}`)
	}

	await runBattery(MODEL, "fp32")

	if (INT8) {
		await runBattery(INT8, "int8")
	}
	const presets = await $`node scripts/eval/demo-preset-compare.ts --model-path=${shipModel}`
	writeFileSync(`${OUT_DIR}/presets.md`, presets.stdout)

	// Demo-cascade smoke (#524): the whole-stack parse→reconcile→resolve pass the per-layer battery
	// lacks (the 2026-06-11 lesson: #520/#521/#522 all shipped through green per-layer gates). Runs on
	// the ship artifact against the slim hot DB the demo serves. Env-gated like the other
	// artifact-dependent legs: skips LOUD when the DB is absent so CI stays green without it — but a
	// gate spec that floors `cascade.demo_smoke` will then FAIL on the missing sidecar (by design).
	const HOT_DB = $public.MAILWOMAN_WOF_HOT_DB || "/tmp/v440-stage/en-us/v4.4.0/wof-hot.db"
	const HOT_STAGE = dirname(HOT_DB)

	if (existsSync(HOT_DB)) {
		const cascade = await $({
			nothrow: true,
		})`node scripts/eval/demo-cascade-smoke.ts --db ${HOT_DB} --stage-dir ${HOT_STAGE} --model ${shipModel} --tokenizer ${TOK} --card ${CARD} --gazetteer-lexicon ${GAZ} --json ${`${OUT_DIR}/cascade-smoke.json`}`
		writeFileSync(`${OUT_DIR}/cascade-smoke.md`, cascade.stdout)

		if (cascade.exitCode !== 0) {
			console.error(
				`✗ demo-cascade smoke errored (see ${OUT_DIR}/cascade-smoke.md) — no sidecar; a floored gate spec will FAIL`
			)
		}
	} else {
		const msg = `⚠ demo-cascade smoke SKIPPED — no wof-hot.db at ${HOT_DB} (set MAILWOMAN_WOF_HOT_DB). The whole-stack lens did NOT run (#524).`
		writeFileSync(`${OUT_DIR}/cascade-smoke.md`, msg + "\n")
		console.error(msg)
	}

	// Arena leg (v4.4.0+: arena.perturb is a floor when the spec declares it) — heavy, ship artifact only.
	if ("arena.perturb" in (gate.floors ?? {})) {
		// (Historical note: the compiled v0 arena parser used to ENOENT on libpostal dicts because
		// repo.ts's __isCompiledTree detection landed CorePackageAbsolutePath at core/out, so dict reads
		// went to core/out/data/... while the data lives at core/data/.... A local core/out/data symlink
		// bridged the gap. #481 fixed the detection — the compiled tree now reads core/data directly — so
		// no bridge is needed here anymore.)
		// Flags replace the bash-era env threading (external-arenas converted to parseArgs).
		const arenaArgs = [
			"--model",
			shipModel,
			"--tokenizer",
			TOK,
			"--model-card",
			CARD,
			"--gazetteer-lexicon",
			GAZ,
			"--anchor-lookup",
			String(LK),
			"--out-dir",
			`${OUT_DIR}/arenas`,
			...(CONV_MODE ? ["--conventions", CONV_MODE] : []),
			...(BRIDGE_MODE ? ["--bridge-gaps"] : []),
		]
		const arena = await $({
			nothrow: true,
		})`node scripts/eval/external-arenas.ts ${arenaArgs}`
		writeFileSync(`${OUT_DIR}/arenas.md`, `${arena.stdout}${arena.stderr}`)

		// set -e: a non-zero arena run aborts the gate before the verdict.
		if (arena.exitCode !== 0) {
			process.exit(1)
		}
	}

	// FR bare-street floor (#949) — the class v5.2.0 silently regressed (34/40 → 16/40) because no
	// standing leg measured FR street parsing WITHOUT a postcode anchor. Reads a FROZEN 40-row OSM
	// sample (committed fixture, no live shard needed), parses each bare + anchored, and fails if the
	// bare-intact rate drops below the spec floor. The leg self-reports its verdict + exits non-zero.
	const bareStreetFloor = (gate.floors ?? {})["fr.bare_street_intact"]

	if (bareStreetFloor !== undefined) {
		const bare = await $({
			nothrow: true,
			env: childEnv(),
		})`node scripts/diagnostic/fr-parse-recall.ts --model ${shipModel} --tokenizer ${TOK} --model-card ${CARD} --floor ${String(bareStreetFloor)} --json ${`${OUT_DIR}/fr-bare-street.json`}`
		writeFileSync(`${OUT_DIR}/fr-bare-street.md`, `${bare.stdout}${bare.stderr}`)

		if (bare.exitCode !== 0) {
			console.error(`✗ fr.bare_street_intact FAIL (floor ${bareStreetFloor}%) — see ${OUT_DIR}/fr-bare-street.md`)
			process.exit(1)
		}

		console.log(`✓ fr.bare_street_intact PASS (floor ${bareStreetFloor}%)`)
	}

	// --- mask-regression gate (#718) — the "second lock" ------------------------
	// Re-runs the SHIP artifact mask-off vs the declared conventions mode and FAILS if any tag's UNFOLDED
	// F1 drops >2pp under the mask — a finer net than createScorer's load-time 5pp delta-gate (it catches
	// INDIRECT mask harms, e.g. forbidding street_suffix depressing street). Weight-dependent, so it lives
	// on the release path here, NOT Test CI (#582). Only meaningful when the spec declares a conventions
	// mask; skipped = PASS otherwise. Its exit folds into the final verdict below.
	let MASK_GATE_STATUS = 0

	if (CONV_MODE) {
		console.log("== mask-regression gate (#718) ==")
		const mask = await $({
			nothrow: true,
		})`node scripts/eval/mask-regression-gate.ts --model ${shipModel} --tokenizer ${TOK} --model-card ${CARD} --anchor-lookup ${LK} --gazetteer-lexicon ${GAZ} --json ${`${OUT_DIR}/mask-regression.json`}`
		writeFileSync(`${OUT_DIR}/mask-regression.md`, `${mask.stdout}${mask.stderr}`)
		MASK_GATE_STATUS = mask.exitCode ?? 0

		if (MASK_GATE_STATUS === 0) {
			console.log("✓ mask-regression gate PASS (no tag regresses >2pp under the conventions mask)")
		} else {
			console.error(
				`✗ mask-regression gate FAIL (see ${OUT_DIR}/mask-regression.md) — a tag regresses >2pp under the '${CONV_MODE}' mask`
			)
		}
	} else {
		console.log("⚠ mask-regression gate SKIPPED — spec declares no requires_conventions (no mask in the ship config)")
	}

	// --- collect + verify (node does the parsing; this orchestrates) ------------
	// Folds BOTH locks: the floor verdict AND the mask-regression gate above. Either miss fails the gate.
	const verdictArgs = ["--gate", GATE, "--out-dir", OUT_DIR]

	if (INT8) {
		verdictArgs.push("--with-int8")
	}
	const verdict = await $({
		nothrow: true,
	})`node scripts/eval/promotion-gate-verdict.ts ${verdictArgs}`

	if (verdict.stdout) {
		process.stdout.write(verdict.stdout)
	}

	if (verdict.stderr) {
		process.stderr.write(verdict.stderr)
	}
	const VERDICT_STATUS = verdict.exitCode ?? 0

	if (VERDICT_STATUS !== 0 || MASK_GATE_STATUS !== 0) {
		if (MASK_GATE_STATUS !== 0) {
			console.error(`✗ gate FAILED the mask-regression lock (#718) — see ${OUT_DIR}/mask-regression.md`)
		}
		process.exit(1)
	}

	// --- ledger (#885) — the update is automatic, not discipline ------------------
	// The ledger froze at v4.4.0 because appending relied on a human remembering. On a PASS, print
	// the exact ledger-append command with everything pre-filled; the release-prep flow runs it with
	// the real npm version. (Not auto-executed here: the gate runs on candidates that may never
	// ship, and the ledger records shipped/shippable versions keyed by npm semver.)
	const shipDate = new Date().toISOString().slice(0, 10)

	console.log(
		`\nledger (#885): on promote, append this run —\n` +
			`  node scripts/eval/ledger-append.ts \\\n` +
			`    --out-dir ${OUT_DIR} --model-version <npm-semver> \\\n` +
			`    --run-id ${LABEL.replace(/[^a-z0-9-]/g, "-")}-${shipDate.replaceAll("-", "")} \\\n` +
			`    --model-path "@mailwoman/neural-weights-en-us@<npm-semver>" --card ${CARD}`
	)
}

runIfScript(import.meta, main)
