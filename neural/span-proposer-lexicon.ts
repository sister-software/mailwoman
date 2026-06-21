/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Codex-backed lexicon for the Stage 2.7 span proposer (`@mailwoman/core/pipeline`'s
 *   `proposeSpans`). Core stays codex-free; this module assembles the proposer's designator
 *   vocabulary from the provenance-tracked `@mailwoman/codex` tables — USPS Pub-28 C2 secondary
 *   unit designators, USPS PO-box designators, Australia Post AMAS delivery types, NZ Post ADV358
 *   delivery-service types. Which systems are loaded conditions the proposer's locale-dependent
 *   readings (the AU/NZ `Flat 2/14` split exists only when those tables are present).
 *
 *   No entry here is hand-invented (the provenance-first rule): every token/pattern derives
 *   from a codex table row. AU `MS` (Mail Service) and the identifier-less counter types (CARE PO,
 *   CMA, CPA, Counter Delivery, Poste Restante) are excluded from the mid-text SCAN regex — a bare
 *   two-letter designator with no required number is exactly the false-positive shape ("Ms Smith")
 *   the AU matcher special-cases; the scan keeps only number-carrying forms.
 */

import { au, nz, us, type SystemCode } from "@mailwoman/codex"
import type { SpanProposerLexicon } from "@mailwoman/core/pipeline"

/**
 * USPS Pub-28 C2 canonicals whose designator is DESCRIPTIVE rather than addressing ("Building A"
 * describes the building; "Suite 9" addresses a unit). Inside a bracketed group, these read as
 * annotation content (gold convention 2 of the punctuation-stress eval).
 */
const WEAK_CANONICALS: ReadonlySet<string> = new Set([
	"BUILDING",
	"FRONT",
	"REAR",
	"SIDE",
	"UPPER",
	"LOWER",
	"KEY",
	"STOP",
])

/** USPS canonicals that name a LEVEL of the building rather than a numbered unit on it. */
const LEVEL_CANONICALS: ReadonlySet<string> = new Set(["FLOOR", "BASEMENT", "PENTHOUSE", "LOBBY"])

/** AU/NZ delivery types excluded from the scan regex (no required number / two-letter ambiguity). */
const SCAN_EXCLUDED_DELIVERY: ReadonlySet<string> = new Set([
	"MS",
	"CARE PO",
	"CMA",
	"CPA",
	"Counter Delivery",
	"Poste Restante",
])

/**
 * Convert one designator phrase from a codex table into a scan-pattern fragment. Short alphabetic
 * words (≤ 3 chars: "PO", "GPO", "RMB") are treated as initialisms with optional periods/spacing —
 * the punctuation AMAS tells mailers to strip but deliverable mail still carries ("P.O. Box",
 * "R.M.B 4600"). Longer words match literally with flexible whitespace.
 */
function phraseToPattern(phrase: string): string {
	return phrase
		.trim()
		.split(/\s+/)
		.map((word) =>
			/^[A-Za-z]{1,3}$/.test(word) && word.toLowerCase() !== "box" && word.toLowerCase() !== "bag"
				? word
						.split("")
						.map((ch) => `${ch}\\.?`)
						.join("\\s*")
				: word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		)
		.join("\\s+")
}

/**
 * Build the span-proposer lexicon from the codex tables of the requested systems. Defaults to every
 * system with designator tables in the codex today. The result is pure data — safe to share across
 * parses.
 */
export function buildCodexSpanLexicon(systems: readonly SystemCode[] = ["us", "au", "nz"]): SpanProposerLexicon {
	const sys = new Set<string>(systems)
	const unitDesignators = new Set<string>()
	const levelDesignators = new Set<string>()
	const weakDesignators = new Set<string>()
	const deliveryPhrases = new Set<string>()

	if (sys.has("us")) {
		for (const canonical of Object.keys(us.US_UNIT_DESIGNATOR_VARIANTS)) {
			const variants = [canonical, ...us.US_UNIT_DESIGNATOR_VARIANTS[canonical as us.UsUnitDesignator]]
			const target = LEVEL_CANONICALS.has(canonical) ? levelDesignators : unitDesignators
			for (const v of variants) {
				target.add(v.toLowerCase())
				if (WEAK_CANONICALS.has(canonical)) weakDesignators.add(v.toLowerCase())
			}
		}
		for (const phrase of us.US_PO_BOX_DESIGNATORS) deliveryPhrases.add(phrase)
	}
	if (sys.has("au")) {
		for (const row of au.AU_DELIVERY_SERVICE_DESIGNATORS) {
			if (SCAN_EXCLUDED_DELIVERY.has(row.abbreviation)) continue
			if (!row.requiresNumber) continue
			deliveryPhrases.add(row.abbreviation)
			deliveryPhrases.add(row.name)
		}
	}
	if (sys.has("nz")) {
		for (const row of nz.NZ_DELIVERY_SERVICE_TYPES) {
			if (SCAN_EXCLUDED_DELIVERY.has(row.type)) continue
			if (row.identifier === "not-used") continue
			deliveryPhrases.add(row.type)
		}
	}

	// Longest-first so "GPO Box" beats "Box", "Private Bag" beats "Bag".
	const alternatives = [...deliveryPhrases].sort((a, b) => b.length - a.length).map(phraseToPattern)
	const deliveryService =
		alternatives.length > 0
			? new RegExp(String.raw`\b(?:${alternatives.join("|")})\s*#?\s*([A-Za-z]?\d[\dA-Za-z-]*)\b`, "gi")
			: undefined

	return {
		systems: sys,
		unitDesignators,
		levelDesignators,
		weakDesignators,
		...(deliveryService ? { deliveryService } : {}),
	}
}
