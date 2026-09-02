/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Demo-cascade smoke eval (#524) — the whole-stack lens the per-layer eval battery lacks.
 *
 *   Runs each row of `data/eval/external/demo-cascade-smoke.jsonl` through the FULL stack exactly the
 *   way the demo (and any real consumer) composes it: neural parse with the ship config (gazetteer
 *   lexicon + postcode anchor + conventions mask + span bridge + FST) → `runPipeline` + grouper
 *   audit → the demo's `runCascade` (#861: the SHARED `resolveTree` — greedy walk + admin/
 *   explicit-country coherence + span-rescore — over the lookup, with the demo's pin extraction)
 *   against the slim `wof-hot.db` the demo serves. Each row asserts the RESOLVED WOF PLACE ID of
 *   the top hit — not parse components. See the row README
 *   (`data/eval/external/demo-cascade-smoke.README.md`) for the convention.
 *
 *   Why: on 2026-06-11 three production bugs (#520/#521/#522) shipped through green checks because
 *   every check lens is per-layer. Two of the three would have been caught by exactly this pass.
 *
 *   Usage (after `yarn compile`):
 *
 *   ```
 *   node scripts/eval/demo-cascade-smoke.ts \
 *   [--stage-dir <release-dir>] [--db <wof-hot.db>] [--model <onnx>] \
 *   [--tokenizer <tokenizer.model>] [--card <model-card.json>] [--fst <fst.bin>] \
 *   [--gazetteer-lexicon <lexicon.json>] [--file <rows.jsonl>] [--json <sidecar.json>] \
 *   [--explain]
 * ```
 *
 *   Defaults point at the staged demo release dir (`--stage-dir`, the byte-copies of what the live
 *   demo serves); `MAILWOMAN_WOF_HOT_DB` overrides the DB path (same env the #522 integration tests
 *   use). Exit 0 = the run completed (row failures are reported in the table + sidecar; the
 *   promotion-eval verdict enforces any floor). Exit 2 = missing artifacts / malformed rows.
 *
 *   Measurement only: this script changes no pipeline or resolver behavior.
 *
 *   ONE SUBSTANTIVE CHANGE at the de-shell migration, and it is a REPAIR. This runner imported
 *   `flattenTree` and `runCascade` from `docs/src/shared/demo-helpers.ts` and its row schema from a
 *   sibling `demo-cascade-rows.ts`. That sibling was swept into the gitignored diagnostic drawer by
 *   the 2026-07-10 probe triage (c61159ef) and vanished, so the leg has been UNLOADABLE — a bare
 *   `ERR_MODULE_NOT_FOUND` — ever since; the runner spawned it with `nothrow` and only ever ran it
 *   when a `wof-hot.db` was present, so nothing surfaced it. The schema module is restored beside
 *   this file. `runCascade` now comes from `@mailwoman/resolver-wof-wasm/browser-cascade`, which is
 *   where `demo-helpers` re-exports it FROM — the same function, so the "measure the REAL cascade"
 *   guarantee is intact and the docs dependency (which `mailwoman`'s tsconfig cannot carry: `docs`
 *   depends on `mailwoman`, so a project reference would be a cycle) is gone. The flattener that was
 *   copied here for the same reason now comes from `@mailwoman/core/decoder` (`flattenTreeNodes`),
 *   which both this and the demo take it from — and which fixed the order both copies had wrong.
 */

import { flattenTreeNodes } from "@mailwoman/core/decoder"
import { pathExists, readLocalBuffer, readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { runPipeline } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier, parseGazetteerLexicon, PostcodeBinaryResolver } from "@mailwoman/neural"
import { mergeAnchorLookups } from "@mailwoman/neural/anchor-inference"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { groupPhrases } from "@mailwoman/phrase-grouper"
import { computeQueryShape } from "@mailwoman/query-shape"
import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import { join } from "path-ts"

import { parseSmokeRows, type SmokeRow } from "#eval-harness/demo-cascade-rows"
import { resolveWOFHotDB, wofHotStageDir } from "#eval-harness/wof-hot-db"

/**
 * Options for {@linkcode demoCascadeSmoke} — one field per flag the check used to serialize into argv.
 */
export interface DemoCascadeSmokeOptions {
	/**
	 * Staged demo release directory. Defaults beneath `$MAILWOMAN_TEMP_ROOT`; every artifact below defaults to a sibling
	 * of it.
	 */
	stageDir?: string
	/**
	 * Hot DB path. Falls back to `$MAILWOMAN_WOF_HOT_DB`, then `<stageDir>/wof-hot.db`.
	 */
	db?: string
	model?: string
	tokenizer?: string
	card?: string
	fst?: string
	/**
	 * Default `data/gazetteer/anchor-lexicon-v1.json`.
	 */
	gazetteerLexicon?: string
	/**
	 * Smoke rows JSONL. Default `data/eval/external/demo-cascade-smoke.jsonl`.
	 */
	file?: string
	/**
	 * Write the sidecar here — the check verdict reads `summary.pass_rate_pct` from it for `cascade.demo_smoke`.
	 */
	json?: string
	/**
	 * Per-row parse + hit narration on the error sink.
	 */
	explain?: boolean
}

/**
 * What {@linkcode demoCascadeSmoke} returns. `exitCode` carries what the script signalled with `process.exit`: 0 = the
 * run completed (row failures are in the table + sidecar; the check verdict enforces any floor), 2 = missing artifacts
 * or malformed rows. The check reports a non-zero code and continues, exactly as it did with the child.
 */
export interface DemoCascadeSmokeResult {
	exitCode: number
	total: number
	pass: number
	passRatePct: number
}

/**
 * One graded row: what the cascade's top hit was, and whether it matched the asserted WOF place id.
 */
interface RowResult {
	input: string
	expected: SmokeRow["expect"]
	actual: { id: number; name: string; placetype: string; anchorCentroid?: boolean } | null
	pass: boolean
	note?: string
}

/**
 * Run every smoke row through the FULL stack — neural parse (ship config) → `runPipeline` + grouper audit → the demo's
 * `runCascade` over the slim hot DB — and assert the RESOLVED WOF PLACE ID of the top hit.
 *
 * The table goes to `report` (the runner captures it into `cascade-smoke.md`); preflight refusals and `explain`
 * narration go to `reportError`, which is where the child's stderr went — captured and dropped. A preflight refusal
 * therefore leaves an EMPTY `cascade-smoke.md` and a non-zero {@linkcode DemoCascadeSmokeResult.exitCode}, which is
 * exactly what the child process produced.
 */
export async function demoCascadeSmoke(
	options: DemoCascadeSmokeOptions = {},
	report: (line: string) => void = console.log,
	reportError: (line: string) => void = console.error
): Promise<DemoCascadeSmokeResult> {
	// LAZY, deliberately: `mailwoman` does not depend on `@mailwoman/resolver-wof-wasm`, and the CLI's
	// module walk (`mailwoman --help`) loads this file in every clean install — a top-level import
	// here failed the ci:smoke clean-install leg the day it was added (2026-08-06). The cascade leg
	// is dev-only (it needs a local wof-hot.db), so the dependency loads only when the leg actually
	// runs; in a clean install without the package the leg fails HERE, loudly, naming the import.
	const { runCascade } = await import("@mailwoman/resolver-wof-wasm/browser-cascade")
	const STAGE = options.stageDir || wofHotStageDir()
	const DB = options.db || resolveWOFHotDB(String(STAGE))
	const MODEL = options.model || join(STAGE, "model.onnx")
	const TOK = options.tokenizer || join(STAGE, "tokenizer.model")
	const CARD = options.card || join(STAGE, "model-card.json")
	const FST = options.fst || join(STAGE, "fst-en-US.bin")
	const GAZ = options.gazetteerLexicon || "data/gazetteer/anchor-lexicon-v1.json"
	const FILE = options.file || "data/eval/external/demo-cascade-smoke.jsonl"
	const JSON_OUT = options.json || ""
	const EXPLAIN = options.explain ?? false

	const refused: DemoCascadeSmokeResult = { exitCode: 2, total: 0, pass: 0, passRatePct: 0 }

	// ── Preflight: every artifact loud-missing, never a vague ENOENT mid-run ────────────────────────
	const artifacts = Object.entries({
		db: DB,
		model: MODEL,
		tokenizer: TOK,
		"model-card": CARD,
		fst: FST,
		gazetteer: GAZ,
		rows: FILE,
	})

	const missing = (await Promise.all(artifacts.map(async ([k, p]) => ({ k, p, exists: await pathExists(p) }))))
		.filter((entry) => !entry.exists)
		.map(({ k, p }) => `  ${k}: ${p}`)

	if (missing.length) {
		reportError(
			`✗ demo-cascade smoke: missing artifacts —\n${missing.join("\n")}\n` +
				"  Stage a demo release (yarn start/build in docs/ — the demo-assets plugin stages the artifacts) or point --stage-dir / MAILWOMAN_WOF_HOT_DB at one."
		)

		return refused
	}

	let rows: SmokeRow[]

	try {
		rows = parseSmokeRows(await readLocalTextFile(FILE), FILE)
	} catch (error) {
		reportError(`✗ ${(error as Error).message}`)

		return refused
	}

	// ── Ship-config classifier (mirrors neural-web's loadNeuralClassifierFromURLs defaults) ─────────
	const card = await readLocalJSONFile<{ labels?: readonly string[] }>(CARD)

	const postcodeBinaries = (
		await Promise.all(
			["postcode-us.bin", "postcode-de.bin", "postcode-fr.bin"].map(async (f) => {
				const p = join(STAGE, f)

				return { p, exists: await pathExists(p) }
			})
		)
	)
		.filter((entry) => entry.exists)
		.map((entry) => entry.p)

	if (!postcodeBinaries.length) {
		reportError(`⚠ no postcode-*.bin under ${STAGE} — anchor channel unfed (anchor-trained models will degrade)`)
	}

	const anchorLookup = postcodeBinaries.length
		? mergeAnchorLookups(
				await Promise.all(
					postcodeBinaries.map(async (p) => new PostcodeBinaryResolver(await readLocalBuffer(p)).toAnchorLookup())
				)
			)
		: undefined

	const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), ONNXRunner.create(MODEL)])

	const classifier = new NeuralAddressClassifier({
		tokenizer,
		runner,
		labels: card.labels,
		...(anchorLookup ? { postcodeAnchorLookup: anchorLookup } : {}),
		gazetteerLexicon: parseGazetteerLexicon(await readLocalJSONFile(GAZ)),
		suppressGazetteerNearPostcode: true,
		addressSystemConventions: "auto",
		bridgePunctuationGaps: true,
	})

	const fst = deserializeFST(await readLocalBuffer(FST))
	const lookup = new WOFSQLitePlaceLookup({ databasePath: DB })

	// ── Run ──────────────────────────────────────────────────────────────────────────────────────────
	const results: RowResult[] = []

	for (const row of rows) {
		const { tree } = await runPipeline(row.input, {
			computeQueryShape,
			groupPhrases,
			classifier: classifier as Parameters<typeof runPipeline>[1]["classifier"],
			fst: fst as Parameters<typeof runPipeline>[1]["fst"],
		})

		// Node selection mirrors the demo page (docs/src/pages/demo/_runtime.ts) — same locality filter,
		// same highest-confidence region pick, same postcode find.
		// `city` / `state` / `postal_code` are libpostal vocabulary and are NOT `ComponentTag`s, so the
		// `|| n.tag === "…"` arms that used to sit here could never match. They compiled only while the
		// flattener returned `{ tag: string }`; the real tag union makes them a type error.
		const nodes = flattenTreeNodes(tree)
		const localityNodes = nodes.filter((n) => n.tag === "locality")

		const stateNode = nodes
			.filter((n) => n.tag === "region")
			.toSorted((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]

		const postcodeNode = nodes.find((n) => n.tag === "postcode")

		// #861: runCascade now takes the TREE and runs the shared resolveTree (greedy walk + coherence
		// passes + span-rescore) over the lookup, exactly as the browser composes it. The node
		// extraction above stays for the explain output + the anchor-centroid fallback below.
		const hits = await runCascade(lookup as Parameters<typeof runCascade>[0], tree, row.input)

		// The demo's anchor-centroid fallback for postcode-only dead ends (WOF placeholder zeros / the
		// slim DB's absent postalcode rows): synthesize the approximate hit from the anchor channel.
		let anchorCentroid = false

		if (!hits.length && postcodeNode?.value && anchorLookup) {
			const anchorHit = anchorLookup.get(String(postcodeNode.value).toUpperCase())

			if (anchorHit && (anchorHit.lat !== 0 || anchorHit.lon !== 0)) {
				anchorCentroid = true
			}
		}

		const top = hits[0]

		const actual = top
			? { id: top.id, name: top.name, placetype: String(top.placetype) }
			: anchorCentroid
				? { id: 0, name: `${postcodeNode?.value} (anchor centroid)`, placetype: "postcode", anchorCentroid: true }
				: null

		const pass = row.expect.anchor_centroid === true ? anchorCentroid : top?.id === row.expect.id
		results.push({ input: row.input, expected: row.expect, actual, pass, ...(row.note ? { note: row.note } : {}) })

		if (EXPLAIN) {
			reportError(`\n-- ${JSON.stringify(row.input)}`)

			reportError(
				`   parse: postcode=${JSON.stringify(postcodeNode?.value)} localities=${JSON.stringify(localityNodes.map((n) => n.value))} region=${JSON.stringify(stateNode?.value)}`
			)

			for (const h of hits.slice(0, 3)) {
				reportError(`   hit: id=${h.id} ${h.name} (${h.placetype}) score=${h.score?.toFixed?.(2)}`)
			}
		}
	}

	lookup[Symbol.dispose]()

	// ── Report ───────────────────────────────────────────────────────────────────────────────────────
	const passCount = results.filter((r) => r.pass).length
	const passRate = Number(((100 * passCount) / results.length).toFixed(1))

	report(`# Demo-cascade smoke (#524) — whole-stack parse→reconcile→resolve`)
	report(`model: ${MODEL}`)
	report(`db: ${DB}`)
	report("")
	report("| # | input | expected | actual | result |")
	report("| - | ----- | -------- | ------ | ------ |")

	results.forEach((r, i) => {
		const exp = r.expected.anchor_centroid
			? "anchor centroid"
			: `${r.expected.id} (${r.expected.name ?? "?"}${r.expected.placetype ? `, ${r.expected.placetype}` : ""})`

		const act = r.actual
			? r.actual.anchorCentroid
				? "anchor centroid"
				: `${r.actual.id} (${r.actual.name}, ${r.actual.placetype})`
			: "NO HIT"

		report(`| ${i + 1} | ${r.input} | ${exp} | ${act} | ${r.pass ? "PASS" : "FAIL"} |`)
	})

	report("")
	report(`**${passCount}/${results.length} pass (${passRate}%)**`)

	if (JSON_OUT) {
		const sidecar = {
			label: "demo-cascade-smoke",
			issue: 524,
			generated: new Date().toISOString(),
			db: DB,
			model: MODEL,
			rows: results,
			summary: { total: results.length, pass: passCount, fail: results.length - passCount, pass_rate_pct: passRate },
		}

		await writeLocalJSONFile(sidecar, JSON_OUT)

		report(`\nsidecar: ${JSON_OUT}`)
	}

	return { exitCode: 0, total: results.length, pass: passCount, passRatePct: passRate }
}
