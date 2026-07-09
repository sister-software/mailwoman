/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The NON-US assembled-coordinate panel (#229 / #148). For each locale it builds a representative
 *   held-out set from real OpenAddresses data (build-oa-coord-golden.ts) and grades the SHIPPED
 *   model on the metric we ship — parse → resolve → great-circle error — reporting RESOLVE RATE
 *   (did it produce a resolvable parse?) and the RESOLVED-ONLY coordinate (how accurate when it
 *   does). Label-F1 understates non-US (it charges street-boundary mis-tags the coordinate
 *   ignores); this is the honest dial.
 *
 *   The night-22 finding (2026-06-22-fr-eval-coverage-scorecard.md): resolve rate tracks TRAINING
 *   REPRESENTATION — FR/IT (trained) ~80% → PT/PL ~52% → AU 28% — and the gap is PARSE (model), not
 *   gazetteer coverage. This runner makes that map reproducible + lets the next shift complete the
 *   remaining ~15 on-disk locales toward the #148 decision.
 *
 *   ⚠ HEAT: each grade is local ONNX inference and spikes the lab box to ~90 °C (it cools fast when
 *   idle). Grade a few locales, let it cool, repeat — or run on Modal. Use --build-only to
 *   materialise the goldens (cool) without grading.
 *
 *   Usage: node scripts/eval/nonus-coord-panel.ts fr it pt pl au # build +
 *   grade these node scripts/eval/nonus-coord-panel.ts --build-only at
 *   be cz # just build the goldens
 *
 *   Source map: OA ships per-locale in three on-disk forms — the per-country `oa-cache` zips, entries
 *   inside `openaddresses/europe.zip`, and loose CSVs under `openaddresses/extracted/<cc>/`. This
 *   encodes which form each locale uses (the non-obvious part); extend `srcFor` for new locales.
 *
 *   Per-locale data quirks found 2026-06-22: DE (`de/nw/statewide.csv`) has an EMPTY POSTCODE column
 *   → the builder filters every row (the resolve path needs the postcode anchor) → 0 rows. Not a
 *   bug; DE needs a postcode-bearing source (or a no-postcode eval variant). ES (`oa-cache`) is a
 *   cadastral schema (tipo_vial/nombre_via), not the standard columns this builder reads —
 *   label-only spot-check, not coordinate.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"
import { runIfScript } from "mailwoman/sdk/scripting"
import { $ } from "zx"

/** Locale → a zip-entry source or a CSV glob. Mirrors the bash `src_for`; extend as needed. */
type Src = { kind: "zip"; zip: string; entry: string } | { kind: "glob"; glob: string }

function srcFor(cc: string): Src {
	switch (cc) {
		case "it":
			return { kind: "zip", zip: dataRootPath("oa-cache", "it__countrywide.zip"), entry: "it/countrywide.csv" }
		// NB: ES is cadastral schema; label-only.
		case "es":
			return { kind: "zip", zip: dataRootPath("oa-cache", "es__countrywide.zip"), entry: "es/countrywide.csv" }
		case "fr":
			return { kind: "zip", zip: dataRootPath("openaddresses", "europe.zip"), entry: "fr/countrywide.csv" }
		case "nl":
			return { kind: "zip", zip: dataRootPath("openaddresses", "europe.zip"), entry: "nl/countrywide.csv" }
		// at be cz dk ee fi gr il is lt lu lv nz pl pt au qa ro sa se sg si sk
		default:
			return { kind: "glob", glob: dataRootPath("openaddresses", "extracted", cc, "*.csv") }
	}
}

async function main() {
	$.verbose = false

	const outDir = "data/eval/external"
	// node:util parseArgs (strict:false = old scan parity); positionals = the country panel list.
	const { values, positionals: args } = parseArgs({
		options: {
			"build-only": { type: "boolean" },
			model: { type: "string" },
			tokenizer: { type: "string" },
			card: { type: "string" },
			anchor: { type: "string" },
		},
		strict: false,
		allowPositionals: true,
	})
	const buildOnly = (values["build-only"] as boolean | undefined) ?? false

	// Flags replace the bash-era env contract (MODEL=… TOK=… → --model … --tokenizer …).
	const model = (values.model as string | undefined) ?? "out/v180/model.onnx"
	const tok =
		(values.tokenizer as string | undefined) ?? dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
	const card = (values.card as string | undefined) ?? "neural-weights-en-us/model-card.json"
	const anchor = (values.anchor as string | undefined) ?? dataRootPath("anchor", "pilot-anchor-lookup.json")

	if (args.length === 0) {
		console.error("usage: nonus-coord-panel.ts [--build-only] <cc> [cc...]")
		process.exit(2)
	}

	console.log(`${"loc".padEnd(4)} ${"resolve".padEnd(7)} ${"p50_resolved".padEnd(13)} ${"p90_resolved".padEnd(13)}`)

	for (const cc of args) {
		const CC = cc.toUpperCase()
		const out = join(outDir, `oa-${cc}-coord-150.jsonl`)

		if (!existsSync(out) || statSync(out).size === 0) {
			const src = srcFor(cc)
			// Builder noise goes to stderr (the bash `>&2`) so it never pollutes the table on stdout.
			const built =
				src.kind === "zip"
					? await $`node scripts/eval/build-oa-coord-golden.ts --country ${cc} --zip ${src.zip} --entry ${src.entry} --out ${out} --n 150`
					: await $`node scripts/eval/build-oa-coord-golden.ts --country ${cc} --csv-glob ${src.glob} --out ${out} --n 150`

			if (built.stdout.trim()) {
				console.error(built.stdout.trimEnd())
			}

			if (built.stderr.trim()) {
				console.error(built.stderr.trimEnd())
			}
		}

		if (buildOnly) continue
		const jsonPath = `/tmp/nonus-panel-${cc}.json`
		// A grade failure for one locale must not abort the whole panel (the bash `set -e`), so guard it.
		const graded = await $({
			nothrow: true,
		})`node scripts/eval/fr-admin-split-gate.ts --model ${model} --tokenizer ${tok} --model-card ${card} --anchor-lookup ${anchor} --golden ${out} --default-country ${CC} --label ${cc} --out ${jsonPath}`

		if (graded.exitCode === 0) {
			const g = JSON.parse(readFileSync(jsonPath, "utf-8"))
			console.log(`${g.label}\t${g.resolve_rate}\t${g.coord_p50_resolved_km}\t${g.coord_p90_resolved_km}`)
		} else {
			console.log(`${cc}\tGRADE-FAILED (see gate output)`)
		}
	}
}

runIfScript(main)
