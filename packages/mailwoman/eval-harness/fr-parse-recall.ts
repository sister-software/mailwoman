/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Diagnose the FR street parse-recall gap (#148): the en-US model fragments a French street when no
 *   postcode anchors it ("Rue du Chevaleret, Paris" → street="Rue du", locality="Chevaleret"). Sample
 *   real FR addresses from the OSM shard, parse each BARE ("<n> <street>, <city>") and ANCHORED
 *   ("<n> <street>, <pc> <city>"), assemble the street key (FR locale) and check it matches the shard's
 *   street_norm. The bare-vs-anchored match-rate delta IS the gap, and isolates whether the model only
 *   learned FR structure in the postcode-anchored context.
 *
 *   GATE-required (#949). This is a promotion-gate battery leg — the `fr.bare_street_intact`
 *   floor — not a one-off probe, which is why it lives here and not in `scripts/diagnostic/`. It sat
 *   in that drawer until the de-shell migration; the drawer is `.gitignore`d wholesale
 *   (`scripts/diagnostic/`), so the file survived only because it had been force-added to the index,
 *   and any sibling helper swept in beside it would have vanished. See `demo-cascade-rows.ts` for
 *   what that looks like when it goes wrong.
 *
 *   Run: node scripts/eval/fr-parse-recall.ts
 */

import { pathExists, readLocalBuffer, readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { allRows, dataRootPath, mailwomanDataRoot, workspacePath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseGazetteerLexicon, PostcodeBinaryResolver } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import type { OSMAddressPointDatabase } from "@mailwoman/osm/sdk/address-point-schema"
import { normalizeStreetForKeyLocale } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { TextSpliterator } from "spliterator"

const STREET_TAGS = new Set(["street", "street_prefix", "street_suffix"])

/**
 * How many bare-street failures the report lists before it stops. The fixture is 40 rows, so a dozen is enough to see
 * the failure SHAPE without burying the rates underneath it.
 */
const MAX_REPORTED_FAILURES = 12

/**
 * Locate a weights SIBLING artifact — `postcode-us.bin`, `anchor-lexicon-v1.json` — the way the runtime does.
 *
 * These were read from `packages/neural-weights-en-us/` directly, which is EMPTY on a dev checkout: the linkers write
 * into the data-root overlay so the tracked workspace stays bare. So this leg threw ENOENT, and the gate rendered the
 * throw as `fr.bare_street_intact FAIL (floor 75%)` — a crash reported as a measurement, and one indistinguishable from
 * the French regression this floor exists to catch.
 *
 * Order matters. A candidate's OWN siblings come first, so grading a candidate never silently mixes in the shipped
 * lexicon; the data-root overlay is the dev-checkout answer; the tracked workspace is last and is only non-empty on a
 * release checkout where `copy-weights.ts` has run.
 *
 * Throws with every path it tried rather than returning a default. A missing anchor lexicon changes the parse, so a
 * silent fallback here would produce a well-formed wrong floor reading.
 */
async function resolveWeightsSibling(fileName: string, weightsCache?: string): Promise<string> {
	const candidates = [
		...(weightsCache ? [`${weightsCache}/node_modules/@mailwoman/neural-weights-en-us/${fileName}`] : []),
		String(dataRootPath("weights", "en-us", fileName)),
		`${String(workspacePath("neural-weights-en-us"))}/${fileName}`,
	]

	const existing = await Promise.all(candidates.map(async (path) => ({ path, exists: await pathExists(path) })))
	const found = existing.find((entry) => entry.exists)?.path

	if (!found) {
		throw new Error(
			`fr-parse-recall: cannot locate ${fileName}. Tried, in order:\n  ${candidates.join("\n  ")}\n` +
				"On a dev checkout this comes from the data-root overlay — run the en-us link-dev-weights script. " +
				"This is a MISSING ARTIFACT, not a French parse regression; do not read it as the bare-street floor."
		)
	}

	return found
}

/**
 * Options for {@linkcode frParseRecall} — one field per flag the gate used to serialize into argv.
 */
export interface FRParseRecallOptions {
	/**
	 * Candidate-pair override (the v2.2.0 salvage read). Omitting {@linkcode FRParseRecallOptions.model} /
	 * {@linkcode FRParseRecallOptions.tokenizer} uses the installed weights package via `loadFromWeights`, unchanged. When
	 * a pair is given, the classifier is built MANUALLY with the ship-config channels fed from the INSTALLED package's
	 * model-independent artifacts (postcode bins + gazetteer lexicon) — the explicit-path `resolveWeights` drops the
	 * soft-feed siblings, and an unfed arm vs a fed arm is not a comparison.
	 */
	model?: string
	tokenizer?: string
	/**
	 * Default `neural-weights-en-us/model-card.json`.
	 */
	modelCard?: string
	/**
	 * Printed as a `[pair]` provenance line when set. Default `""` (no line).
	 */
	label?: string
	/**
	 * Gate-leg mode (#949): the FROZEN 40-row sample, so the bare-street floor is reproducible anywhere (incl. CI, which
	 * has no shard). Default `scripts/eval/fixtures/fr-bare-street-40.jsonl`.
	 */
	fixture?: string
	/**
	 * Re-derive from the live OSM shard instead of the fixture — the ONLY way the fixture should ever change, and it must
	 * be committed deliberately (the "pin the golden" discipline; a moving sample is a flaky floor).
	 */
	fromDB?: boolean
	/**
	 * Emit machine-readable rates to this path for the promotion gate.
	 */
	json?: string
	/**
	 * Package-shaped candidate weights root. When set, the anchor + lexicon siblings are taken from the CANDIDATE rather
	 * than from the shipped overlay — grading a candidate against the shipped lexicon measures neither.
	 */
	weightsCache?: string
	/**
	 * The enforced floor, in percent. When set, {@linkcode FRParseRecallResult.pass} is false if the BARE-intact rate
	 * falls below it — which is how the leg's old `process.exit(1)` reaches the gate now.
	 */
	floor?: string
}

/**
 * What {@linkcode frParseRecall} returns. `pass` carries the floor verdict the script used to signal with its exit code:
 * true when no floor was given, otherwise `bareRate >= floor`.
 */
export interface FRParseRecallResult {
	bareIntact: number
	anchoredIntact: number
	n: number
	bareRate: number
	anchoredRate: number
	source: string
	pass: boolean
}

interface FRRow {
	street_raw: string
	number: string
	locality_norm: string
	postcode: string
}

function streetKeyOf(tree: {
	roots: readonly { tag: string; value: string; start: number; children: readonly unknown[] }[]
}): string {
	const parts: Array<{ value: string; start: number }> = []
	const stack = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()! as { tag: string; value: string; start: number; children: readonly unknown[] }

		if (STREET_TAGS.has(n.tag) && n.value.trim()) {
			parts.push({ value: n.value.trim(), start: n.start })
		}

		stack.push(...(n.children as typeof stack))
	}

	parts.sort((a, b) => a.start - b.start)

	return normalizeStreetForKeyLocale(parts.map((p) => p.value).join(" "), "fr")
}

/**
 * Measure the FR bare-vs-anchored street parse-recall delta and enforce the `fr.bare_street_intact` floor.
 *
 * The report lines go to `report` and the FAIL line to `reportError`, mirroring the stdout/stderr split the gate
 * captured — it wrote `${stdout}${stderr}` into `fr-bare-street.md`, so the two sinks stay separate and are
 * concatenated in that order. The floor verdict comes back as {@linkcode FRParseRecallResult.pass} instead of the old
 * `process.exit(1)`.
 */
export async function frParseRecall(
	options: FRParseRecallOptions = {},
	report: (line: string) => void = console.log,
	reportError: (line: string) => void = console.error
): Promise<FRParseRecallResult> {
	const args = {
		modelCard: options.modelCard ?? "packages/neural-weights-en-us/model-card.json",
		label: options.label ?? "",
		fixture: options.fixture ?? "scripts/eval/fixtures/fr-bare-street-40.jsonl",
		fromDB: options.fromDB ?? false,
		model: options.model,
		tokenizer: options.tokenizer,
		json: options.json,
		floor: options.floor,
	}

	const rows: FRRow[] = args.fromDB
		? (() => {
				const db = new DatabaseClient<OSMAddressPointDatabase>(`${mailwomanDataRoot()}/osm/address-points-fr-fr.db`, {
					readOnly: true,
				})

				// Distinct streets with a city + postcode, sampled across the table (not one street repeated).
				// DETERMINISTIC (GROUP BY + ORDER BY, no RANDOM) — the same shard yields the same 40 rows.
				return allRows<FRRow>(
					db.prepare(
						`SELECT street_raw, number, locality_norm, postcode FROM address_point
						 WHERE locality_norm IS NOT NULL AND postcode IS NOT NULL AND street_raw LIKE '% %'
						 GROUP BY street_norm ORDER BY number LIMIT 40`
					)
				)
			})()
		: [...TextSpliterator.from(await readLocalTextFile(args.fixture))]
				.filter((l) => l.trim())
				.map((l) => parseJSONStrict<FRRow>(l))

	const classifier = await (async (): Promise<NeuralAddressClassifier> => {
		if (!args.model || !args.tokenizer) return NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

		const card = await readLocalJSONFile<{ labels: string[] }>(args.modelCard)

		const anchor = new PostcodeBinaryResolver(
			await readLocalBuffer(await resolveWeightsSibling("postcode-us.bin", options.weightsCache))
		).toAnchorLookup()

		const lexiconPath = await resolveWeightsSibling("anchor-lexicon-v1.json", options.weightsCache)
		const lexicon = parseGazetteerLexicon(await readLocalJSONFile(lexiconPath))

		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(args.tokenizer),
			ONNXRunner.create(args.model),
		])

		return new NeuralAddressClassifier({
			tokenizer,
			runner,
			labels: card.labels,
			postcodeAnchorLookup: anchor,
			gazetteerLexicon: lexicon,
			suppressGazetteerNearPostcode: true,
			addressSystemConventions: "auto",
			bridgePunctuationGaps: true,
		})
	})()

	if (args.label) {
		report(`[pair] ${args.label}: model=${args.model ?? "package"} tokenizer=${args.tokenizer ?? "package"}`)
	}

	let bareOk = 0
	let anchoredOk = 0
	const fails: string[] = []

	for (const r of rows) {
		const want = normalizeStreetForKeyLocale(r.street_raw, "fr")
		const bareQ = `${r.number} ${r.street_raw}, ${r.locality_norm}`
		const anchQ = `${r.number} ${r.street_raw}, ${r.postcode} ${r.locality_norm}`
		const bare = streetKeyOf(await classifier.parse(bareQ, { postcodeRepair: true, normalizeCase: true }))
		const anch = streetKeyOf(await classifier.parse(anchQ, { postcodeRepair: true, normalizeCase: true }))

		if (bare === want) {
			bareOk++
		}

		if (anch === want) {
			anchoredOk++
		}

		if (bare !== want && fails.length < MAX_REPORTED_FAILURES) {
			fails.push(`  ✗ bare "${r.street_raw}" → "${bare}" (want "${want}")  | anchored→"${anch}"`)
		}
	}

	report(`\nFR street parse-recall on ${rows.length} real OSM addresses:`)

	report(
		`  BARE     (no postcode): ${bareOk}/${rows.length} streets intact  (${((bareOk / rows.length) * 100).toFixed(0)}%)`
	)

	report(
		`  ANCHORED (w/ postcode): ${anchoredOk}/${rows.length} streets intact  (${((anchoredOk / rows.length) * 100).toFixed(0)}%)`
	)

	report(`\nbare failures:`)

	for (const f of fails) {
		report(f)
	}

	const bareRate = (bareOk / rows.length) * 100
	const anchoredRate = (anchoredOk / rows.length) * 100
	const source = args.fromDB ? "live-shard" : args.fixture

	if (args.json) {
		// snake_case wire keys, 2-space indent, trailing newline — the sidecar shape is a contract with
		// whatever reads it next; the migration keeps it byte-for-byte.
		await writeLocalTextFile(
			`${JSON.stringify(
				{
					bare_intact: bareOk,
					anchored_intact: anchoredOk,
					n: rows.length,
					bare_rate: Number(bareRate.toFixed(1)),
					anchored_rate: Number(anchoredRate.toFixed(1)),
					source,
				},
				null,
				2
			)}\n`,
			args.json
		)
	}

	const result: FRParseRecallResult = {
		bareIntact: bareOk,
		anchoredIntact: anchoredOk,
		n: rows.length,
		bareRate: Number(bareRate.toFixed(1)),
		anchoredRate: Number(anchoredRate.toFixed(1)),
		source,
		pass: true,
	}

	if (args.floor !== undefined) {
		const floor = Number(args.floor)

		if (bareRate < floor) {
			reportError(
				`\n✗ fr.bare_street_intact FAIL: ${bareRate.toFixed(1)}% < floor ${floor}% (${bareOk}/${rows.length})`
			)

			return { ...result, pass: false }
		}

		report(`\n✓ fr.bare_street_intact PASS: ${bareRate.toFixed(1)}% ≥ floor ${floor}% (${bareOk}/${rows.length})`)
	}

	return result
}
