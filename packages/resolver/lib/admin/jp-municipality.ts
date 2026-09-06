/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A compound Japanese municipality split into the two units the gazetteer keys separately.
 *
 *   The JP model tags `神戸市西区` (city + ward) and `猿島郡五霞町` (county + town) as ONE `municipality` span, which is
 *   the postal form, and WOF keys the city, the ward and the town — never the compound. Probed whole, the span misses
 *   and the coordinate falls to the prefecture centroid (25–52 km on the JP board). Probed as its trailing unit
 *   UNSCOPED it does worse: a bare `西区` resolves a namesake ward in another city (Kobe's answered Fukuoka's, 407 km;
 *   251 of 300 rows against 271 whole). The split is therefore consumed by the resolver walk as a SCOPED pair: the
 *   head resolves first, the tail probes as its child, and a namesake outside the head is not admissible.
 */

export interface CompoundMunicipality {
	/**
	 * The containing unit: the city (`神戸市`) or the county (`猿島郡`).
	 */
	head: string
	/**
	 * The contained unit: the ward (`西区`) or the town / village (`五霞町`).
	 */
	tail: string
	shape: "city_ward" | "county_town"
}

const CITY_WARD = /^(.+?市)(.+区)$/u
const COUNTY_TOWN = /^(.+?郡)(.+[町村])$/u

/**
 * The head and tail of a compound municipality, or null for a plain one (`都城市`, `千代田区`, `東村山市`).
 */
export function compoundMunicipality(value: string): CompoundMunicipality | null {
	const trimmed = value.trim()
	const cityWard = CITY_WARD.exec(trimmed)

	if (cityWard) {
		return { head: cityWard[1]!, tail: cityWard[2]!, shape: "city_ward" }
	}

	const countyTown = COUNTY_TOWN.exec(trimmed)

	if (countyTown) {
		return { head: countyTown[1]!, tail: countyTown[2]!, shape: "county_town" }
	}

	return null
}

/**
 * One probe of the gazetteer as the walk makes it: `value` under `scope`, with the parent fallback allowed or withheld.
 */
export type CompoundMunicipalityProbe<Place, Pick extends { top: Place; metadata?: Record<string, unknown> }> = (
	value: string,
	scope: Place | null,
	parentFallback: boolean
) => Promise<Pick | null>

function stamp<Pick extends { metadata?: Record<string, unknown> }>(
	pick: Pick | null,
	split: CompoundMunicipality,
	answered: "head" | "tail"
): Pick | null {
	return pick ? { ...pick, metadata: { ...pick.metadata, municipality_split: { ...split, answered } } } : null
}

/**
 * A compound municipality probed as a SCOPED pair after the whole span missed: the head under the node's own parent
 * with the walk's ordinary fallback, then the tail as the head's child with the parent fallback WITHHELD, so a namesake
 * ward or town outside the head is never admissible — including one the backend re-admits through its own region-scope
 * fallback (`regionScopeMiss`). A county head usually has no key; the tail then probes under the parent the walk
 * already holds. Answers the tail when it hits, else the head, else null. Two probes at most, each drawn from the
 * caller's budget (`hasBudget`).
 */
export async function resolveCompoundMunicipality<
	Place extends { regionScopeMiss?: boolean },
	Pick extends { top: Place; metadata?: Record<string, unknown> },
>(
	value: string,
	parent: Place | null,
	hasBudget: () => boolean,
	probe: CompoundMunicipalityProbe<Place, Pick>
): Promise<Pick | null> {
	const split = compoundMunicipality(value)

	if (!split || !hasBudget()) return null

	const head = await probe(split.head, parent, true)

	if (!hasBudget()) return stamp(head, split, "head")

	const tail = await probe(split.tail, head?.top ?? parent, false)

	if (tail && !tail.top.regionScopeMiss) return stamp(tail, split, "tail")

	return stamp(head, split, "head")
}
