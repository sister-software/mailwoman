/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Spain's co-official languages by province — the languages a person in that province writes an address in beside
 *   Castilian. The Constitution (art. 3.2) makes each community's Statute of Autonomy the instrument that declares a
 *   co-official language, so the table follows the statutes:
 *
 *   - Catalan (`cat`): the Statute of Catalonia (2006, art. 6) for Barcelona, Girona, Lleida and Tarragona; the Statute
 *     of the Balearic Islands (2007, art. 4); and the Statute of the Valencian Community (2006, art. 6) for Alicante,
 *     Castellón and Valencia, whose Valencian the Who's On First names table files under `cat`.
 *   - Occitan (`oci`, Aranese): the Statute of Catalonia (2006, art. 6.5) makes it official throughout Catalonia.
 *   - Galician (`glg`): the Statute of Galicia (1981, art. 5) for A Coruña, Lugo, Ourense and Pontevedra.
 *   - Basque (`eus`): the Statute of the Basque Country (1979, art. 6) for Álava, Biscay and Gipuzkoa; the Foral Law
 *     18/1986 of Navarre for its Basque-speaking zone.
 *
 *   Asturian and Aragonese are protected by their statutes and not co-official, so Asturias, Huesca, Teruel and Zaragoza
 *   carry no entry. Ceuta, Melilla and the province-less territories carry none.
 *
 *   WHY A TABLE AND NOT THE GAZETTEER. Who's On First stores a preferred name for a province in many languages, and for
 *   a language not spoken there the "preferred name" is often the AUTONOMOUS COMMUNITY's: Zamora's Catalan preferred
 *   name is `Castella i Lleó`, Seville's Asturian one is `Andalucía`, Ourense's Occitan one is `Galícia`. Reading every
 *   language's name as a surface of the province would teach those pairs. The statute says which languages a province's
 *   addresses are written in; this table carries that answer, keyed by the province's Castilian name as the gazetteer
 *   spells it in its `spa` preferred form.
 */

/**
 * ISO 639-3 codes of the co-official languages of each Spanish province that has one, keyed by the province's Castilian
 * name (the `spa` preferred name in the Who's On First names table).
 */
export const ES_PROVINCE_CO_OFFICIAL_LANGUAGES: ReadonlyMap<string, readonly string[]> = new Map([
	// Catalonia: Catalan and Aranese Occitan (Statute of Catalonia 2006, art. 6).
	["Barcelona", ["cat", "oci"]],
	["Girona", ["cat", "oci"]],
	["Lleida", ["cat", "oci"]],
	["Tarragona", ["cat", "oci"]],
	// Balearic Islands: Catalan (Statute 2007, art. 4).
	["Islas Baleares", ["cat"]],
	// Valencian Community: Valencian, filed as `cat` (Statute 2006, art. 6).
	["Alicante", ["cat"]],
	["Castellón", ["cat"]],
	["Valencia", ["cat"]],
	// Galicia: Galician (Statute 1981, art. 5).
	["La Coruña", ["glg"]],
	["Lugo", ["glg"]],
	["Orense", ["glg"]],
	["Pontevedra", ["glg"]],
	// Basque Country: Basque (Statute 1979, art. 6); Navarre: Basque in its Basque-speaking zone (Foral Law 18/1986).
	["Álava", ["eus"]],
	["Vizcaya", ["eus"]],
	["Guipúzcoa", ["eus"]],
	["Navarra", ["eus"]],
])

/**
 * The co-official languages of a Spanish province, by its Castilian name; empty for a province with none.
 */
export function coOfficialLanguagesForProvince(castilianName: string): readonly string[] {
	return ES_PROVINCE_CO_OFFICIAL_LANGUAGES.get(castilianName.trim()) ?? []
}
