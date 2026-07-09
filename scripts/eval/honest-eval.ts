/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Honest-eval harness (#371 leakage-free geographic split + #373 PIP-containment).
 *
 *   The yardstick the rest of the roadmap is graded on. Random OA evaluation flatters us: the model
 *   trains on a corpus that COVERS the same streets OA tests, and the legacy locality NAME-match
 *   metric is blind to picking the right name in the WRONG place. This harness measures only the
 *   LEAKAGE-FREE slice (OA rows in corpus-held-out geography the model never trained on) and
 *   reports the NON-GAMEABLE coordinate truth: region-match, coordinate error (p50/p90), and
 *   PIP-containment (gold OA point inside the resolved WOF polygon) — the last reported WITH a
 *   polygon-coverage denominator, since WOF point-geometry localities can never PIP-contain and
 *   would otherwise count as silent failures.
 *
 *   Per DeepSeek (2026-06-08): lead the scorecard with region-match + coord p50/p90 (100% checkable,
 *   transparent to polygon coverage); treat locality-PIP as a coverage-adjusted secondary. See
 *   docs/articles/evals/2026-06-08-honest-eval.md.
 *
 *   Held-out slices (corpus SPLIT_MANIFEST defaultHoldouts): US = VT/WY/ND, FR = Corse/
 *   Lozère/Creuse. Only US/VT clears the 1000-row trust floor in the current samples (FR held-out
 *   départements = 16 rows; DE has no manifest holdout). Abort/de-risk per the plan: a held-out
 *   slice below 1000 rows is reported as UNTRUSTED, not scored.
 *
 *   Usage: node scripts/eval/honest-eval.ts\
 *   [--model neural-weights-en-us/model.onnx] [--card neural-weights-en-us/model-card.json]\
 *   [--tokenizer ...]\
 *   [--wof <admin.db>,<postcode.db>] # DB under test (default: canonical) [--label fixed] # a tag for
 *   the report [--out docs/articles/evals/2026-06-08-honest-eval.md] [--tmp /tmp/honest]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"
import { runIfScript } from "mailwoman/sdk/scripting"
import { $ } from "zx"

async function main() {
	// zx: capture output ourselves and slice/parse in JS the way the bash awk/jq/grep pipes did.
	$.verbose = false

	let MODEL = "neural-weights-en-us/model.onnx"
	let CARD = "neural-weights-en-us/model-card.json"
	let TOK = "neural-weights-en-us/tokenizer.model"
	const WOF_DEFAULT = `${dataRootPath("wof", "admin-global-priority.db")},${dataRootPath("wof", "postcode-locality-intl.db")}`
	let WOF = WOF_DEFAULT
	let LABEL = "run"
	let OUT = ""
	let TMP = "/tmp/honest"

	// STRICT parseArgs — the original switch errored on unknown args; parity preserved.
	let cliValues: Record<string, string | boolean | undefined>

	try {
		cliValues = parseArgs({
			options: {
				card: { type: "string" },
				label: { type: "string" },
				model: { type: "string" },
				out: { type: "string" },
				tmp: { type: "string" },
				tokenizer: { type: "string" },
				wof: { type: "string" },
			},
		}).values
	} catch (e) {
		console.error(`unknown arg: ${e instanceof Error ? e.message : e}`)
		process.exit(1)
	}

	if (cliValues["model"] != null) {
		MODEL = cliValues["model"] as string
	}

	if (cliValues["card"] != null) {
		CARD = cliValues["card"] as string
	}

	if (cliValues["tokenizer"] != null) {
		TOK = cliValues["tokenizer"] as string
	}

	if (cliValues["wof"] != null) {
		WOF = cliValues["wof"] as string
	}

	if (cliValues["label"] != null) {
		LABEL = cliValues["label"] as string
	}

	if (cliValues["out"] != null) {
		OUT = cliValues["out"] as string
	}

	if (cliValues["tmp"] != null) {
		TMP = cliValues["tmp"] as string
	}

	mkdirSync(TMP, { recursive: true })
	const US_SAMPLE = "data/eval/external/openaddresses-us-sample.jsonl"
	const US_HELD_REGIONS = ["VT", "WY", "ND"] // corpus defaultHoldouts() for US
	const TRUST_FLOOR = 1000

	// --- build the US held-out slice (leakage-free: never in training) ---
	const US_SLICE = `${TMP}/us-heldout.jsonl`
	writeFileSync(US_SLICE, "")

	// : > "$US_SLICE"
	for (const st of US_HELD_REGIONS) {
		const r = await $({ nothrow: true })`jq -c --arg st ${st} ${"select((.state|ascii_upcase) == $st)"} ${US_SAMPLE}`

		if (r.stdout) {
			appendFileSync(US_SLICE, r.stdout)
		}
	}
	const US_N = (readFileSync(US_SLICE, "utf8").match(/\n/g) || []).length
	console.error(`US held-out slice (${US_HELD_REGIONS.join("/")}): ${US_N} rows`)

	/**
	 * Run_locale <name> <slice.jsonl> <default-country> <out-tag> Returns a TSV row: name n regionMatch localityMatch
	 * coordP50 coordP90 pipAll pipPoly polyCov
	 */
	const runLocale = async (name: string, slice: string, cc: string, tag: string): Promise<string> => {
		const n = (existsSync(slice) ? readFileSync(slice, "utf8").match(/\n/g) || [] : []).length

		if (n < TRUST_FLOOR) {
			return `${name}\t${n}\tUNTRUSTED\t-\t-\t-\t-\t-\t-`
		}
		const resolved = `${TMP}/${tag}.json`
		const evalOut =
			await $`node scripts/eval/oa-resolver-eval.ts --eval ${slice} --model ${MODEL} --model-card ${CARD} --tokenizer ${TOK} --wof ${WOF} --default-country ${cc} --out-resolved ${resolved}`
		writeFileSync(`${TMP}/${tag}.eval.md`, evalOut.stdout)
		writeFileSync(`${TMP}/${tag}.log`, evalOut.stderr)
		// neural row: | **neural** | loc% | reg% | resolved% | p50 | p90 | p99 |
		const row = evalOut.stdout.split("\n").find((l) => l.startsWith("| **neural** |")) ?? ""
		const cols = row.split("|").map((c) => c.replace(/ /g, ""))
		const loc = cols[2] ?? ""
		const reg = cols[3] ?? ""
		const p50 = cols[5] ?? ""
		const p90 = cols[6] ?? ""
		const pipJson = `${TMP}/${tag}.pip.json`
		const pip = await $({
			nothrow: true,
		})`python3 scripts/eval/pip-containment.py ${resolved} --label ${name} --json ${pipJson}`
		writeFileSync(`${TMP}/${tag}.pip.txt`, pip.stdout)
		// jq: percent rounded to 1 decimal, "-" when the field is null/missing, "" when the file can't be read.
		const jqPct = async (field: string): Promise<string> => {
			const r = await $({ nothrow: true })`jq -r ${`(.${field}*100|.*10|round/10) // "-"`} ${pipJson}`

			return r.stdout.trim()
		}
		const pipAll = await jqPct("pip_all")
		const pipPoly = await jqPct("pip_poly")
		const polyCov = await jqPct("poly_coverage")

		return `${name}\t${n}\t${reg}\t${loc}\t${p50}\t${p90}\t${pipAll}%\t${pipPoly}%\t${polyCov}%`
	}

	console.error(`== honest eval (label=${LABEL}, wof=${WOF}) ==`)
	const US_ROW = await runLocale("US/VT held-out", US_SLICE, "US", `honest-us-${LABEL}`)

	// --- emit the per-locale table ---
	const u = US_ROW.split("\t")
	const emit = [
		`### Honest-eval scorecard — label: \`${LABEL}\``,
		"",
		`WOF: \`${WOF}\``,
		"",
		"| locale (held-out) | n | region-match | locality-name-match | coord p50 km | coord p90 km | locality-PIP (all) | locality-PIP (coverage-adj) | polygon-coverage |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		`| ${u[0]} | ${u[1]} | ${u[2]} | ${u[3]} | ${u[4]} | ${u[5]} | ${u[6]} | ${u[7]} | ${u[8]} |`,
		`| FR/Corse·Lozère·Creuse | 16 | UNTRUSTED (< ${TRUST_FLOOR}-row floor) | — | — | — | — | — | — |`,
		`| DE | — | no manifest holdout (needs a DE-holdout retrain) | — | — | — | — | — | — |`,
		"",
		"_Headline metrics (per DeepSeek): region-match + coord p50/p90. locality-PIP is reported with a polygon-coverage denominator because WOF point-geometry localities can't PIP-contain._",
	].join("\n")

	if (OUT) {
		writeFileSync(OUT, emit + "\n")
		console.error(`wrote → ${OUT}`)
	} else {
		console.log(emit)
	}
}

runIfScript(import.meta, main)
