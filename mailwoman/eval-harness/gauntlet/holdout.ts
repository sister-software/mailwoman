/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Held-out fresh-draw Gauntlet — THE generalization gate (DeepSeek 019f1144: "the only layer that
 *   measures the tail; when it conflicts with the curated suite, it wins"). Each run draws a FRESH random
 *   sample with truth coordinates (BAN for FR), so the model can't memorize it, and runs BOTH the candidate
 *   and the current production model on the SAME draw. It gates on a two-proportion z-test: ship only if the
 *   candidate is NOT statistically worse than production at the locality tolerance. Absolute accuracy is not
 *   the gate — the candidate-vs-prod DELTA is (this controls for data drift + coverage gaps).
 *
 *   Run: mailwoman eval gauntlet --layer holdout --candidate ./out/v194-final/model.onnx [--n 300]
 */

import { resolveWeights } from "@mailwoman/neural"
import { haversineKm } from "@mailwoman/spatial"
import { TextSpliterator } from "spliterator"

import { mailwomanDataRoot } from "../../resolver-backend.ts"
import { buildGauntletDeps, type GauntletDeps } from "./harness.ts"

/** Options for {@linkcode runHoldoutLayer}. */
export interface HoldoutLayerOptions {
	/** Candidate ONNX (required — the layer is candidate-vs-prod). */
	candidate?: string
	/** Fresh-draw sample size. Default 300. */
	n?: number
	/** Truth source: `fr` (BAN) or `us` (FDIC). Default `fr`. */
	source?: string
	/**
	 * A tokenizer-SPLICE candidate (#444/#884/#912) ships a NEW vocab; grading it needs the candidate tokenizer (+ card)
	 * paired with the candidate model. Production is then also run through the SHIPPED trio (createScorer both sides) so
	 * the only variables are the ONNX + the vocab. Omit for a model-only bump.
	 */
	tokenizer?: string
	/** Candidate model-card (paired with `tokenizer`). */
	card?: string
}

const TOLS = [0.1, 0.5, 5] as const // rooftop / street / locality (km)
const GATE_TOL = 5 // the z-test runs at the locality bucket (the dominant resolvable tier)

interface Sample {
	query: string
	lat: number
	lon: number
}

/**
 * Held-out truth sources — fresh-draw, NOT in mailwoman's training corpus, so they measure generalization. Each parses
 * a semicolon row of its staging file into a BARE-form query (no postcode — the hard case the tail exercises) + truth
 * coord. FR/BAN streams the 5 GB file; the smaller pools (US/FDIC, ~77k) are the fast draw. Add a source by dropping a
 * staging file + a parser here.
 */
interface SourceDef {
	file: string
	label: string
	parse(cols: string[]): Sample | null
}

function holdoutSources(): Record<string, SourceDef> {
	return {
		fr: {
			file: `${mailwomanDataRoot()}/corpus/staging/ban-france.csv`,
			label: "FR/BAN",
			// BAN columns: numero(2) nom_voie(4) nom_commune(7) lon(12) lat(13)
			parse(c) {
				const voie = (c[4] ?? "").trim()
				const numero = (c[2] ?? "").trim()
				const commune = (c[7] ?? "").trim()
				const lat = Number(c[13])
				const lon = Number(c[12])

				if (!voie || !numero || !commune || !voie.includes(" ") || !Number.isFinite(lat) || !Number.isFinite(lon))
					return null

				return { query: `${numero} ${voie}, ${commune}`, lat, lon }
			},
		},
		us: {
			file: `${mailwomanDataRoot()}/corpus/staging/fdic-us.csv`,
			label: "US/FDIC",
			// fdic-us.csv columns: address(0) city(1) state(2) zip(3) lat(4) lon(5)
			parse(c) {
				const address = (c[0] ?? "").trim()
				const city = (c[1] ?? "").trim()
				const state = (c[2] ?? "").trim()
				const lat = Number(c[4])
				const lon = Number(c[5])

				if (!address || !city || !state || !Number.isFinite(lat) || !Number.isFinite(lon)) return null

				return { query: `${address}, ${city}, ${state}`, lat, lon }
			},
		},
	}
}

/** Reservoir-sample N rows with truth coords from the selected source — a genuinely fresh draw each run. */
async function draw(src: SourceDef, n: number): Promise<Sample[]> {
	const res: Sample[] = []
	let seen = 0
	let line = 0

	// Semicolon-delimited CSV (not JSONL) → TextSpliterator for the line layer, keep the `.split(";")`.
	// crlf: the staging files are LF today, but the final column (the truth coord) would otherwise
	// carry a stray \r on a CRLF source and fail to parse.
	for await (const raw of TextSpliterator.fromAsync(src.file, { crlf: true })) {
		if (line++ === 0) continue // header
		const s = src.parse(raw.split(";"))

		if (!s) continue
		seen++

		if (res.length < n) {
			res.push(s)
		} else {
			const j = Math.floor(Math.random() * seen)

			if (j < n) {
				res[j] = s
			}
		}
	}

	return res
}

async function score(deps: GauntletDeps, sample: Sample[]): Promise<{ hits: number[]; resolved: number }> {
	const hits = TOLS.map(() => 0)
	let resolved = 0

	for (const s of sample) {
		const g = await deps.geocode(s.query)

		if (g.lat == null || g.lon == null) continue
		resolved++
		const km = haversineKm(g.lat, g.lon, s.lat, s.lon)
		TOLS.forEach((t, i) => {
			if (km <= t) {
				hits[i] = (hits[i] ?? 0) + 1
			}
		})
	}

	return { hits, resolved }
}

/** Two-proportion z (candidate − prod). z < −1.96 → candidate significantly WORSE (block). */
function zStat(cand: number, prod: number, n: number): number {
	const pc = cand / n
	const pp = prod / n
	const pool = (cand + prod) / (2 * n)
	const se = Math.sqrt(pool * (1 - pool) * (2 / n))

	return se === 0 ? 0 : (pc - pp) / se
}

/**
 * Run the held-out candidate-vs-prod layer. `exitCode` mirrors the old script: 0 = PASS, 1 = candidate significantly
 * worse, 2 = usage error (missing candidate / unknown source).
 */
export async function runHoldoutLayer(options: HoldoutLayerOptions = {}): Promise<{ pass: boolean; exitCode: number }> {
	const N = options.n ?? 300
	const CANDIDATE = options.candidate || ""
	const CAND_TOKENIZER = options.tokenizer || ""
	const CAND_CARD = options.card || ""
	const SOURCE = (options.source || "fr").toLowerCase()

	const sources = holdoutSources()
	const selected = sources[SOURCE]

	if (!selected) {
		console.error(`Unknown --source "${SOURCE}". Known: ${Object.keys(sources).join(", ")}`)

		return { pass: false, exitCode: 2 }
	}
	const src: SourceDef = selected

	if (!CANDIDATE) {
		console.error("Usage: mailwoman eval gauntlet --layer holdout --candidate <model.onnx> [--n 300]")

		return { pass: false, exitCode: 2 }
	}
	console.error(`[gauntlet/holdout] drawing ${N} fresh ${src.label} addresses…`)
	const sample = await draw(src, N)
	console.error(`[gauntlet/holdout] scoring production vs candidate on the SAME ${sample.length} addresses…`)

	// A splice candidate (--tokenizer given) swaps the vocab, so production must ALSO run through the SHIPPED
	// (model, tokenizer, card) trio via createScorer — otherwise the two sides have different anchor/gazetteer
	// wiring and the z-test is confounded. resolveWeights gives the shipped trio for the production side.
	const shipped = CAND_TOKENIZER ? resolveWeights({ locale: "en-us" }) : null
	const prodDeps = await buildGauntletDeps(
		shipped
			? { modelPath: shipped.modelPath, tokenizerPath: shipped.tokenizerPath, modelCardPath: shipped.modelCardPath }
			: {}
	)
	const prod = await score(prodDeps, sample)
	prodDeps.close()

	const candDeps = await buildGauntletDeps(
		CAND_TOKENIZER
			? { modelPath: CANDIDATE, tokenizerPath: CAND_TOKENIZER, modelCardPath: CAND_CARD || undefined }
			: { modelPath: CANDIDATE }
	)
	const cand = await score(candDeps, sample)
	candDeps.close()

	const n = sample.length
	const gateIdx = TOLS.indexOf(GATE_TOL as (typeof TOLS)[number])
	const z = zStat(cand.hits[gateIdx]!, prod.hits[gateIdx]!, n)

	console.log(`\n=== Gauntlet · held-out fresh draw (${src.label}, n=${n}) ===`)
	console.log(`  tolerance     production   candidate`)
	TOLS.forEach((t, i) => {
		console.log(
			`  ≤${String(t).padEnd(5)}km   ${String(prod.hits[i]).padStart(8)}     ${String(cand.hits[i]).padStart(8)}`
		)
	})
	console.log(`  resolved      ${String(prod.resolved).padStart(8)}     ${String(cand.resolved).padStart(8)}`)
	console.log(`\n  z (candidate − production) @ ≤${GATE_TOL}km: ${z.toFixed(2)}`)
	// Block ONLY on a significant regression. Candidate ahead or within noise → pass.
	const pass = z >= -1.96
	console.log(
		`  verdict: ${pass ? "PASS (candidate not significantly worse)" : "FAIL (candidate significantly worse — do not ship)"}`
	)

	return { pass, exitCode: pass ? 0 : 1 }
}
