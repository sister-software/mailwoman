/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   @file The Wikidata leg of the sub-venue lexicon — turning the designator-label SPARQL payload into
 *   surfaces.
 *
 *   Reads an already-parsed payload rather than issuing a query: the acquisition lives in
 *   `fetch/wikidata-subvenue.ts`, and keeping the conversion a pure function of parsed input is what
 *   lets the builder stay deterministic and testable with no network and no fixture on disk.
 *
 *   Wikidata gives a CONCEPT NAME per language, not a designator as addressed. Q849706's Spanish label
 *   is `terminal aeroportuaria`; the addressed form is `Terminal`. So every surface produced here lands
 *   `curated: false`, and the head-noun derivation is what proposes the addressed form from it.
 */

import { normalizeSurface } from "./surfaces.ts"
import { CONCEPT_QIDS, type SubVenueSurface } from "./table.ts"

/**
 * The SPARQL results envelope, narrowed to the columns the designator-label query produces.
 */
interface SPARQLBinding {
	item?: { value: string }
	lang?: { value: string }
	label?: { value: string }
	kind?: { value: string }
}

interface SPARQLEnvelope {
	results?: { bindings?: SPARQLBinding[] }
}

/**
 * Turn the Wikidata designator-label payload into surfaces.
 *
 * A row is dropped when its language tag is empty (an untagged literal, which Wikidata occasionally carries), when the
 * QID maps to no designator in {@link CONCEPT_QIDS}, or when the normalized phrase is empty. Everything that survives
 * lands `curated: false` — see the module docstring.
 */
export function surfacesFromWikidata(
	payload: unknown,
	conceptQIDs: Readonly<Record<string, string>> = CONCEPT_QIDS
): SubVenueSurface[] {
	const byQID = new Map(Object.entries(conceptQIDs).map(([id, qid]) => [qid, id]))
	const envelope = payload as SPARQLEnvelope
	const seen = new Set<string>()
	const out: SubVenueSurface[] = []

	for (const binding of envelope.results?.bindings ?? []) {
		const qid = binding.item?.value?.split("/").pop()
		const recordID = qid ? byQID.get(qid) : undefined
		const lang = binding.lang?.value
		const raw = binding.label?.value

		if (!recordID || !lang || !raw) continue

		const phrase = normalizeSurface(raw)

		if (!phrase) continue

		const source = binding.kind?.value === "alt" ? "wikidata:alt" : "wikidata:label"
		// A concept can carry the same string as both a label and an alias, and across dialect subtags
		// (`zh`, `zh-cn`, `zh-hans` all say 航站楼). Key the dedupe on the tuple that identifies a row.
		const key = `${phrase}\0${recordID}\0${lang}\0${source}`

		if (seen.has(key)) continue
		seen.add(key)

		out.push({
			phrase,
			recordID,
			recordKind: "designator",
			lang,
			region: "",
			source,
			curated: false,
			observations: 0,
			context: {},
		})
	}

	return out
}
