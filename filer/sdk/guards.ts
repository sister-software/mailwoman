/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared validation guards for filer.db writers (pulled out of `build-filer.ts`). Before
 *   this move, `cluster-filers.ts` reached into `build-filer.ts` for {@linkcode assertISODate} (the
 *   builder's own module docstring called this out as a rule with "one implementation, no drift between
 *   the two files") — a writer importing another writer's whole module just to borrow a guard is a
 *   coupling that gets worse with every new filer.db writer this phase adds. This module is the neutral
 *   home every writer imports the guard from instead.
 *
 *   The export's name and behavior are unchanged from the pre-move implementation — this is a
 *   relocation, not a rewrite.
 */

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validates `value` is an ISO `YYYY-MM-DD` date before it is written into a `valid_from` (or `valid_to`) column —
 * applied at every site in `build-filer.ts` and `cluster-filers.ts` (and any future filer.db writer) that writes either
 * temporal column. One implementation, shared, so the rule can't drift between writers.
 *
 * `valid_from` participates in every downstream `asOf`-scoped predicate (`filer-lookup.ts`'s `valid_from <= asOf`) as a
 * plain STRING comparison — correct only when every value compared is drawn from the same ISO-sortable `YYYY-MM-DD`
 * scheme. `source_vintage` is free to stay a human vintage LABEL (`"2026-Q2"`, `"2026-cluster-v1"`) — that plurality is
 * exactly what the column is for (decision 7) — but that same label is NOT safe to also write into `valid_from`:
 * `"2026-Q2"` sorts lexicographically ABOVE any real ISO date this century (the ASCII code for `"Q"` is greater than
 * every digit's), so an edge dated that way would silently fail `valid_from <= asOf` at every real-world `asOf`, and
 * `filerLookup` would report the identifier crosswalk as EMPTY against a filer.db that actually has the data (reviewer
 * probe, `build-filer.ts`'s final 3a review: a fully populated filer.db built with `sourceVintage: "2026-Q2"` returned
 * `identifiers: []`/`primary_frn: null`).
 *
 * Thrown, not coerced: there is no honest way to turn a whole-file vintage label into a per-edge date without
 * fabricating one. The caller must supply a real ISO date through a field dedicated to that purpose
 * (`BuildFilerOptions.validFrom`, `ClusterFilersOptions.validFrom`) instead of relying on this function (or any other)
 * to guess one from a label.
 */
export function assertISODate(value: string, context: string): string {
	if (!ISO_DATE_PATTERN.test(value)) {
		throw new Error(
			`buildFilerDatabase: malformed ${context} — ${JSON.stringify(value)} is not an ISO YYYY-MM-DD date. ` +
				`valid_from/valid_to must always be ISO-sortable dates (decision 7 / gate 1's asOf predicate is a ` +
				`plain string comparison over them) — a vintage LABEL like "2026-Q2" sorts lexicographically ABOVE ` +
				`any real ISO date and would silently break every asOf-scoped read against the edge it's written to.`
		)
	}

	return value
}
