/**
 * Title-case an ALL-CAPS GB place/street string (#690 — all-caps is OOD for the model). PPD ships every field
 * upper-case; the model trains on natural casing. Particles (upon, super, next, …) stay lowercase mid-name, both
 * between words and between hyphen segments. Each apostrophe-separated segment is capitalized on its own (D'Arcy,
 * James'), except a bare trailing possessive 's, which stays lowercase (BISHOP'S → Bishop's).
 */
const GB_PARTICLES = new Set([
	"upon",
	"on",
	"under",
	"in",
	"by",
	"the",
	"le",
	"la",
	"de",
	"cum",
	"next",
	"with",
	"over",
	"at",
	"super",
	"sub",
	"and",
	"of",
	"y",
	"en",
])

function caseWord(word: string, isFirst: boolean): string {
	if (!word) return word
	const lower = word.toLowerCase()

	if (!isFirst && GB_PARTICLES.has(lower)) return lower

	// Capitalize the first letter of each apostrophe-separated segment, except possessive 's.
	return lower
		.split("'")
		.map((segment, idx) => {
			if (!segment) return segment

			// Don't capitalize a trailing bare possessive 's
			if (idx > 0 && segment === "s") return segment

			// Capitalize the first letter of this segment
			return segment[0]!.toUpperCase() + segment.slice(1)
		})
		.join("'")
}

export function titleCaseGB(value: string): string {
	value = value.trim()
	let wordIndex = 0

	return value
		.split(/\s+/)
		.map((token) => {
			const cased = token
				.split("-")
				.map((seg, segIndex) => caseWord(seg, wordIndex === 0 && segIndex === 0))
				.join("-")
			wordIndex += 1

			return cased
		})
		.join(" ")
		.trim()
}
