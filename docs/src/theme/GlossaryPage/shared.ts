export interface GlossaryTerm {
	term: string
	abbreviation?: string
	definition: string
	aliases?: string[]
	relatedTerms?: string[]
	tags?: string[]
	id?: string
}

export interface GlossaryData {
	title?: string
	description?: string
	terms: GlossaryTerm[]
}

// Collect all unique tags from the term set
export const ALL_TAGS = [
	"neural",
	"training",
	"tokenizer",
	"staged-pipeline",
	"resolver",
	"geocoding",
	"corpus",
	"street",
	"locality",
	"postcode",
	"region",
	"country",
	"venue",
	"intersection",
	"infrastructure",
	"concepts",
	"record-matching",
	"eval",
	"data-source",
	"en-us",
	"fr-fr",
	"ja-jp",
	"international",
	"multilingual",
	"non-latin",
] as const

export type Tag = (typeof ALL_TAGS)[number]

export const TAG_LABELS: Record<Tag, string> = {
	neural: "Neural",
	training: "Training",
	tokenizer: "Tokenizer",
	"staged-pipeline": "Pipeline",
	resolver: "Resolver",
	geocoding: "Geocoding",
	corpus: "Corpus",
	street: "Street",
	locality: "Locality",
	postcode: "Postcode",
	region: "Region",
	country: "Country",
	venue: "Venue",
	intersection: "Intersection",
	infrastructure: "Infrastructure",
	concepts: "Concepts",
	"record-matching": "Matching",
	eval: "Eval",
	"data-source": "Data",
	"en-us": "US",
	"fr-fr": "France",
	"ja-jp": "Japan",
	international: "Intl",
	multilingual: "Multilingual",
	"non-latin": "Non-Latin",
}

export function getPresentTags(terms: GlossaryTerm[]): Tag[] {
	const present = new Set<Tag>()

	for (const term of terms) {
		for (const tag of term.tags || []) {
			if (ALL_TAGS.includes(tag as Tag)) {
				present.add(tag as Tag)
			}
		}
	}

	return ALL_TAGS.filter((t) => present.has(t))
}

export function groupTermsByLetter(terms: GlossaryTerm[]) {
	const grouped: Record<string, GlossaryTerm[]> = {}

	for (const term of terms) {
		const firstLetter = term.term.charAt(0).toUpperCase()

		if (!grouped[firstLetter]) {
			grouped[firstLetter] = []
		}
		grouped[firstLetter].push(term)
	}

	for (const letter of Object.keys(grouped)) {
		grouped[letter].sort((a, b) => a.term.localeCompare(b.term))
	}

	return grouped
}
