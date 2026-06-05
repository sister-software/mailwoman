/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The 101 French départements (96 metropolitan including Corsica's 2A/2B, plus the 5 overseas DOM),
 *   each mapped to its région.
 *
 *   The département is the load-bearing admin unit for French postal geography: a code postal's first
 *   two digits ARE the département number (see `code-postal.ts`), and the région is derived from
 *   the département. This table is therefore the hinge between `code-postal.ts` and `region.ts`.
 */

import type { FrenchRegionCode } from "./region.js"

/** Per-département record: code (2-digit, or `2A`/`2B`, or 3-digit DOM) + name + its région. */
export interface DepartementInfo {
	/** Département code: `01`–`95` (metropolitan), `2A`/`2B` (Corsica), or `971`–`976` (overseas). */
	code: string
	/** French name (e.g. `Bouches-du-Rhône`). */
	name: string
	/** The ISO 3166-2:FR code of the région this département belongs to. */
	region: FrenchRegionCode
}

/** Département code → info. 96 metropolitan (incl. 2A/2B) + 5 overseas = 101. */
export const FR_DEPARTEMENTS = {
	"01": { code: "01", name: "Ain", region: "ARA" },
	"02": { code: "02", name: "Aisne", region: "HDF" },
	"03": { code: "03", name: "Allier", region: "ARA" },
	"04": { code: "04", name: "Alpes-de-Haute-Provence", region: "PAC" },
	"05": { code: "05", name: "Hautes-Alpes", region: "PAC" },
	"06": { code: "06", name: "Alpes-Maritimes", region: "PAC" },
	"07": { code: "07", name: "Ardèche", region: "ARA" },
	"08": { code: "08", name: "Ardennes", region: "GES" },
	"09": { code: "09", name: "Ariège", region: "OCC" },
	"10": { code: "10", name: "Aube", region: "GES" },
	"11": { code: "11", name: "Aude", region: "OCC" },
	"12": { code: "12", name: "Aveyron", region: "OCC" },
	"13": { code: "13", name: "Bouches-du-Rhône", region: "PAC" },
	"14": { code: "14", name: "Calvados", region: "NOR" },
	"15": { code: "15", name: "Cantal", region: "ARA" },
	"16": { code: "16", name: "Charente", region: "NAQ" },
	"17": { code: "17", name: "Charente-Maritime", region: "NAQ" },
	"18": { code: "18", name: "Cher", region: "CVL" },
	"19": { code: "19", name: "Corrèze", region: "NAQ" },
	"2A": { code: "2A", name: "Corse-du-Sud", region: "COR" },
	"2B": { code: "2B", name: "Haute-Corse", region: "COR" },
	"21": { code: "21", name: "Côte-d'Or", region: "BFC" },
	"22": { code: "22", name: "Côtes-d'Armor", region: "BRE" },
	"23": { code: "23", name: "Creuse", region: "NAQ" },
	"24": { code: "24", name: "Dordogne", region: "NAQ" },
	"25": { code: "25", name: "Doubs", region: "BFC" },
	"26": { code: "26", name: "Drôme", region: "ARA" },
	"27": { code: "27", name: "Eure", region: "NOR" },
	"28": { code: "28", name: "Eure-et-Loir", region: "CVL" },
	"29": { code: "29", name: "Finistère", region: "BRE" },
	"30": { code: "30", name: "Gard", region: "OCC" },
	"31": { code: "31", name: "Haute-Garonne", region: "OCC" },
	"32": { code: "32", name: "Gers", region: "OCC" },
	"33": { code: "33", name: "Gironde", region: "NAQ" },
	"34": { code: "34", name: "Hérault", region: "OCC" },
	"35": { code: "35", name: "Ille-et-Vilaine", region: "BRE" },
	"36": { code: "36", name: "Indre", region: "CVL" },
	"37": { code: "37", name: "Indre-et-Loire", region: "CVL" },
	"38": { code: "38", name: "Isère", region: "ARA" },
	"39": { code: "39", name: "Jura", region: "BFC" },
	"40": { code: "40", name: "Landes", region: "NAQ" },
	"41": { code: "41", name: "Loir-et-Cher", region: "CVL" },
	"42": { code: "42", name: "Loire", region: "ARA" },
	"43": { code: "43", name: "Haute-Loire", region: "ARA" },
	"44": { code: "44", name: "Loire-Atlantique", region: "PDL" },
	"45": { code: "45", name: "Loiret", region: "CVL" },
	"46": { code: "46", name: "Lot", region: "OCC" },
	"47": { code: "47", name: "Lot-et-Garonne", region: "NAQ" },
	"48": { code: "48", name: "Lozère", region: "OCC" },
	"49": { code: "49", name: "Maine-et-Loire", region: "PDL" },
	"50": { code: "50", name: "Manche", region: "NOR" },
	"51": { code: "51", name: "Marne", region: "GES" },
	"52": { code: "52", name: "Haute-Marne", region: "GES" },
	"53": { code: "53", name: "Mayenne", region: "PDL" },
	"54": { code: "54", name: "Meurthe-et-Moselle", region: "GES" },
	"55": { code: "55", name: "Meuse", region: "GES" },
	"56": { code: "56", name: "Morbihan", region: "BRE" },
	"57": { code: "57", name: "Moselle", region: "GES" },
	"58": { code: "58", name: "Nièvre", region: "BFC" },
	"59": { code: "59", name: "Nord", region: "HDF" },
	"60": { code: "60", name: "Oise", region: "HDF" },
	"61": { code: "61", name: "Orne", region: "NOR" },
	"62": { code: "62", name: "Pas-de-Calais", region: "HDF" },
	"63": { code: "63", name: "Puy-de-Dôme", region: "ARA" },
	"64": { code: "64", name: "Pyrénées-Atlantiques", region: "NAQ" },
	"65": { code: "65", name: "Hautes-Pyrénées", region: "OCC" },
	"66": { code: "66", name: "Pyrénées-Orientales", region: "OCC" },
	"67": { code: "67", name: "Bas-Rhin", region: "GES" },
	"68": { code: "68", name: "Haut-Rhin", region: "GES" },
	"69": { code: "69", name: "Rhône", region: "ARA" },
	"70": { code: "70", name: "Haute-Saône", region: "BFC" },
	"71": { code: "71", name: "Saône-et-Loire", region: "BFC" },
	"72": { code: "72", name: "Sarthe", region: "PDL" },
	"73": { code: "73", name: "Savoie", region: "ARA" },
	"74": { code: "74", name: "Haute-Savoie", region: "ARA" },
	"75": { code: "75", name: "Paris", region: "IDF" },
	"76": { code: "76", name: "Seine-Maritime", region: "NOR" },
	"77": { code: "77", name: "Seine-et-Marne", region: "IDF" },
	"78": { code: "78", name: "Yvelines", region: "IDF" },
	"79": { code: "79", name: "Deux-Sèvres", region: "NAQ" },
	"80": { code: "80", name: "Somme", region: "HDF" },
	"81": { code: "81", name: "Tarn", region: "OCC" },
	"82": { code: "82", name: "Tarn-et-Garonne", region: "OCC" },
	"83": { code: "83", name: "Var", region: "PAC" },
	"84": { code: "84", name: "Vaucluse", region: "PAC" },
	"85": { code: "85", name: "Vendée", region: "PDL" },
	"86": { code: "86", name: "Vienne", region: "NAQ" },
	"87": { code: "87", name: "Haute-Vienne", region: "NAQ" },
	"88": { code: "88", name: "Vosges", region: "GES" },
	"89": { code: "89", name: "Yonne", region: "BFC" },
	"90": { code: "90", name: "Territoire de Belfort", region: "BFC" },
	"91": { code: "91", name: "Essonne", region: "IDF" },
	"92": { code: "92", name: "Hauts-de-Seine", region: "IDF" },
	"93": { code: "93", name: "Seine-Saint-Denis", region: "IDF" },
	"94": { code: "94", name: "Val-de-Marne", region: "IDF" },
	"95": { code: "95", name: "Val-d'Oise", region: "IDF" },
	"971": { code: "971", name: "Guadeloupe", region: "GUA" },
	"972": { code: "972", name: "Martinique", region: "MTQ" },
	"973": { code: "973", name: "Guyane", region: "GUF" },
	"974": { code: "974", name: "La Réunion", region: "LRE" },
	"976": { code: "976", name: "Mayotte", region: "MAY" },
} as const satisfies Record<string, DepartementInfo>

/** A French département code (`01`–`95`, `2A`/`2B`, or `971`–`976`). */
export type DepartementCode = keyof typeof FR_DEPARTEMENTS

/**
 * Look up a département by code (case-insensitive for the Corsica `2A`/`2B` letters); null if
 * unknown.
 */
export function departementInfo(code: string | null | undefined): DepartementInfo | null {
	if (!code || typeof code !== "string") return null
	const key = code.trim().toUpperCase()
	return (FR_DEPARTEMENTS as Record<string, DepartementInfo>)[key] ?? null
}
