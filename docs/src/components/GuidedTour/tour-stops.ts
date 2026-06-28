/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tour-stop definitions for the GuidedTour component. Each stop is a real failure mode drawn from
 *   the eval discipline and addresses-that-break-geocoders documentation.
 */

export type PipelineStage =
	| "tokenizer"
	| "kind-classifier"
	| "rule-classifiers"
	| "neural-classifier"
	| "CRF-decoder"
	| "solver"
	| "resolver"
	| "parser"

export type StatusBadge = "expected" | "improved" | "resolved" | "known-issue"

export interface TourStop {
	id: number
	title: string
	address: string
	description: string
	diagnosis: string
	pipelineStage: PipelineStage
	/** The stage label shown in the badge (shorter, UI-friendly). */
	pipelineStageLabel: string
	statusBadge: StatusBadge
	/** Short doc citation for the source. */
	sourceDoc: string
}

/**
 * The 9 guided-tour stops. Each exercises a documented failure mode from `addresses-that-break-geocoders.mdx` or
 * `eval-discipline.mdx`, mapped to the pipeline stage most responsible for handling it.
 */
export const TOUR_STOPS: TourStop[] = [
	{
		id: 1,
		title: "Ambiguous locality",
		address: "Paris, TX",
		description:
			'"Paris" could mean France or Texas. Without a region signal, even a correct parse can resolve to the wrong side of the Atlantic.',
		diagnosis:
			'The parser correctly extracts "Paris" as locality and "TX" as region. The resolver uses the region to constrain candidate search — Paris, Texas wins because "TX" matches even though Paris, France has a higher population. If the region were absent, the population prior would pick Paris, France.',
		pipelineStage: "resolver",
		pipelineStageLabel: "Resolver",
		statusBadge: "improved",
		sourceDoc: "addresses-that-break-geocoders.mdx §1",
	},
	{
		id: 2,
		title: "Repeated admin names",
		address: "New York, New York",
		description:
			"Both the locality AND the state share the same string. Regex parsers often deduplicate and drop the second occurrence.",
		diagnosis:
			'Mailwoman emits B-locality I-locality , B-region I-region — two distinct spans on the same token sequence. The solver expects spans, not unique strings, so both "New York" instances survive. A naïve string-deduplication parser would lose one.',
		pipelineStage: "neural-classifier",
		pipelineStageLabel: "Neural classifier",
		statusBadge: "resolved",
		sourceDoc: "addresses-that-break-geocoders.mdx §2",
	},
	{
		id: 3,
		title: "Tokenization trap",
		address: "12 1/2 Main St",
		description:
			"Fractional house numbers and whitespace quirks that break regex-based house-number classifiers expecting \\d+.",
		diagnosis:
			'The subword tokenizer does not require numeric tokens — it can split "12", "1/2", "Main", "St" into subwords and let the neural classifier learn that this pattern is a house_number + street span. A regex classifier expecting ^\\d+$ would miss the fractional part entirely.',
		pipelineStage: "tokenizer",
		pipelineStageLabel: "Tokenizer",
		statusBadge: "improved",
		sourceDoc: "addresses-that-break-geocoders.mdx §3",
	},
	{
		id: 4,
		title: "Street/locality collision",
		address: "New York, New York Steakhouse, Las Vegas, NV",
		description:
			'A famous place-name inside a venue name. Dictionary classifiers fire on "New York" as a locality candidate, but it\'s part of the restaurant name.',
		diagnosis:
			'The transformer encoder sees the full sentence: "New York" followed by "Steakhouse" → venue span; "Las Vegas" preceded by comma + followed by "NV" → locality span. Rule classifiers can\'t make this distinction — they need surrounding context. This is the canonical case for why a neural encoder matters.',
		pipelineStage: "neural-classifier",
		pipelineStageLabel: "Neural classifier",
		statusBadge: "improved",
		sourceDoc: "addresses-that-break-geocoders.mdx §4",
	},
	{
		id: 5,
		title: "Numeric chaos",
		address: "221B Baker St",
		description:
			"A house number with a trailing letter — 221B. Naïve ^\\d+$ regex classifiers drop the suffix or reject the token entirely.",
		diagnosis:
			'The rule classifiers emit proposals with confidence; the solver picks self-consistent combinations. If the rule classifier emits "221" as house_number and "B" as unit, the solver can merge or choose. The neural classifier can also learn that "221B" is a single house_number span from training examples like "10A Main St".',
		pipelineStage: "rule-classifiers",
		pipelineStageLabel: "Rule classifiers",
		statusBadge: "improved",
		sourceDoc: "addresses-that-break-geocoders.mdx §5",
	},
	{
		id: 6,
		title: "Non-Latin script",
		address: "ul. Łódzka 12, Łódź",
		description:
			"Polish diacritics and accented characters that break ASCII-assuming tokenizers and normalisation pipelines.",
		diagnosis:
			"The byte-fallback tokenizer encodes unknown characters at the byte level, so the pipeline does not crash on Ł or ź. But the model was trained on en-US + fr-FR data — it has no signal to label Polish tokens. The parse will complete but most components will be empty. Per-locale weights (pl-PL) are needed for accuracy.",
		pipelineStage: "tokenizer",
		pipelineStageLabel: "Tokenizer",
		statusBadge: "known-issue",
		sourceDoc: "addresses-that-break-geocoders.mdx §6",
	},
	{
		id: 7,
		title: "Language-switch hybrid",
		address: "Calle Ocho Street",
		description:
			'Mixed Spanish/English street name. "Calle" is a Spanish street prefix; "Street" is an English suffix. Neither-language-only classifiers get confused.',
		diagnosis:
			"The neural classifier sees the full string and can learn that [street-prefix] [proper-noun] [street-suffix] is a single street span regardless of language. However, this requires training examples in the corpus — today's en-US + fr-FR coverage does not include Spanish/English hybrids.",
		pipelineStage: "neural-classifier",
		pipelineStageLabel: "Neural classifier",
		statusBadge: "known-issue",
		sourceDoc: "addresses-that-break-geocoders.mdx §7",
	},
	{
		id: 8,
		title: "Administrative nightmare",
		address: "Springfield",
		description:
			"41 Springfields in the US alone. No disambiguating context means even a perfect parse can't pick the right one.",
		diagnosis:
			'The parser extracts "Springfield" as locality. The resolver returns a candidate list ranked by population — Springfield, MO (~170K) wins but may not be what the user wanted. There is no honest fix without more context (IP geolocation, user-supplied region). The honest answer is a candidate list, not a single confident point.',
		pipelineStage: "resolver",
		pipelineStageLabel: "Resolver",
		statusBadge: "expected",
		sourceDoc: "addresses-that-break-geocoders.mdx §8",
	},
	{
		id: 9,
		title: "Mid-position postcode",
		address: "Paris 75008",
		description:
			"Postcode in the middle of the address instead of the end. Training-distribution bias can cause empty predictions when the positional pattern shifts.",
		diagnosis:
			'In v0.4.0, 65% of postcode false-negatives were empty predictions on mid-position postcodes. The NAD downweight removed "postcode-first" patterns from training — the model learned to tag mid-position numeric tokens as house_number. This is a training-data distribution problem, not an architecture problem. The fix: bump NAD weight or synthesize component-order permutations.',
		pipelineStage: "neural-classifier",
		pipelineStageLabel: "Neural classifier",
		statusBadge: "improved",
		sourceDoc: "eval-discipline.mdx §Pattern 2",
	},
]
