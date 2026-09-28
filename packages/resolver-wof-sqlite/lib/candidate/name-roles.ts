/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pass 3c of the candidate build — the `name_role` detectors and the thresholds they are judged by.
 */

import { isOfficialLanguage } from "@mailwoman/codex/country"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"

import { isOwnNameVariant } from "#candidate/own-name"
import type { PlaceAttrs } from "#candidate/place-attrs"
import type { CandidateDatabase } from "#candidate/schema"
import type { WOFDatabase } from "#schema"
import { normalizeLocalityForKey } from "#street/normalize"

/**
 * Key-count threshold for the gloss anomaly detector; a legitimate famous place is
 * separated by the prominence check rather than this number alone.
 */
export const GLOSS_KEY_THRESHOLD = 50

/**
 * Placetypes the gloss detector never flags: a country or region legitimately carries
 * a name in every language, so key volume carries no signal there.
 */
export const GLOSS_EXCLUDED_PLACETYPES: ReadonlySet<string> = new Set([
	"country",
	"dependency",
	"disputed",
	"empire",
	"macroregion",
	"region",
	"macrocounty",
	"county",
])

/**
 * Stamp `name_role` on non-primary rows: `abbr` by provenance, `variant` by
 * own-name verdict, then `gloss` by key-volume anomaly.
 *
 * @returns The stamp counts plus the census the prototype exists to report:
 * how much of the ≥-threshold key tail carries any role.
 */
export function stampNameRoles(ctx: {
	src: DatabaseClient<WOFDatabase>
	out: DatabaseClient<CandidateDatabase>
	attrs: Map<number, PlaceAttrs>
	keyCounts: Map<number, number>
	glossThreshold: number
	ptcodes: Map<string, number>
	ccodes: Map<string, number>
	progress: (phase: string, message: string) => void
}): { roleGloss: number; roleAbbr: number; roleVariant: number; keyTailPlaces: number; keyTailWithRole: number } {
	const { src, out, attrs, keyCounts, glossThreshold, progress } = ctx
	progress("roles", "stamping name roles (gloss anomaly + abbr provenance)")

	const ptNameByID = new Map([...ctx.ptcodes].map(([placetype, id]) => [id, placetype]))
	const iso2ByCID = new Map([...ctx.ccodes].map(([code, id]) => [id, code]))

	let keyTailPlaces = 0
	const glossSids: number[] = []

	for (const [sid, count] of keyCounts) {
		if (count < glossThreshold) continue

		keyTailPlaces++
		const a = attrs.get(sid)

		if (!a) continue

		if (GLOSS_EXCLUDED_PLACETYPES.has(ptNameByID.get(a.ptid) ?? "")) continue

		if ((a.pop ?? 0) > 0 || a.imp != null) continue
		glossSids.push(sid)
	}

	out.exec(
		"CREATE TEMP TABLE role_key (spr_id INTEGER NOT NULL, name_key TEXT NOT NULL, PRIMARY KEY (spr_id, name_key)) WITHOUT ROWID"
	)

	const insRoleKey = out.prepare("INSERT OR IGNORE INTO role_key VALUES (?, ?)")

	// Zero abbr stamps from a skipped detector is a different fact from zero variants found.
	const hasSourceNames = tableExists(src, "names")

	if (hasSourceNames) {
		out.exec("BEGIN")

		// WOF's abbreviation/short name kinds qualify by kind alone; everything else
		// qualifies as a variant in an official language.
		for (const r of src
			.prepare("SELECT id, name, language FROM names WHERE privateuse = 'variant' OR language IN ('abbr', 'short')")
			.iterate()) {
			const a = attrs.get(Number(r.id))

			if (!a) continue
			const language = String(r.language ?? "")

			if (language !== "abbr" && language !== "short") {
				const iso2 = iso2ByCID.get(a.cid) ?? "??"

				if (language !== "eng" && !isOfficialLanguage(iso2, language)) continue
			}

			const k = normalizeLocalityForKey(String(r.name ?? ""))

			if (!k || k === a.pkey) continue
			insRoleKey.run(Number(r.id), k)
		}

		out.exec("COMMIT")
	} else {
		progress("roles", "source carries no `names` table — abbr detector skipped (gloss still runs)")
	}

	// Stamp order is precedence: abbr first, then the own-name variant verdict, then gloss fills what neither claimed.
	const roleAbbr = Number(
		out
			.prepare(
				`UPDATE cand_stage SET name_role = 'abbr'
				 WHERE is_primary = 0 AND EXISTS (
					SELECT 1 FROM role_key rk WHERE rk.spr_id = cand_stage.spr_id AND rk.name_key = cand_stage.name_key)`
			)
			.run().changes
	)

	// Runs before gloss on purpose: the place's own name is not a translation,
	// and an uncovered script answers no-verdict.
	out.exec(
		"CREATE TEMP TABLE variant_key (spr_id INTEGER NOT NULL, name_key TEXT NOT NULL, PRIMARY KEY (spr_id, name_key)) WITHOUT ROWID"
	)

	const insVariantKey = out.prepare("INSERT OR IGNORE INTO variant_key VALUES (?, ?)")
	let variantScanned = 0

	out.exec("BEGIN")

	for (const r of out
		.prepare("SELECT DISTINCT spr_id, name_key FROM cand_stage WHERE is_primary = 0 AND name_role IS NULL")
		.iterate()) {
		variantScanned++
		const a = attrs.get(Number(r.spr_id))

		if (!a?.pkey) continue

		if (isOwnNameVariant(String(a.pkey), String(r.name_key))) {
			insVariantKey.run(Number(r.spr_id), String(r.name_key))
		}
	}

	out.exec("COMMIT")

	const roleVariant = Number(
		out
			.prepare(
				`UPDATE cand_stage SET name_role = 'variant'
				 WHERE is_primary = 0 AND name_role IS NULL AND EXISTS (
					SELECT 1 FROM variant_key vk WHERE vk.spr_id = cand_stage.spr_id AND vk.name_key = cand_stage.name_key)`
			)
			.run().changes
	)

	out.exec("DROP TABLE variant_key")

	progress(
		"roles",
		`variant: ${roleVariant.toLocaleString()} of ${variantScanned.toLocaleString()} unstamped alias keys are own-name variants`
	)

	out.exec("CREATE TEMP TABLE role_place (spr_id INTEGER PRIMARY KEY) WITHOUT ROWID")
	out.exec("CREATE TEMP TABLE key_tail (spr_id INTEGER PRIMARY KEY) WITHOUT ROWID")
	const insRolePlace = out.prepare("INSERT OR IGNORE INTO role_place VALUES (?)")
	const insKeyTail = out.prepare("INSERT OR IGNORE INTO key_tail VALUES (?)")
	out.exec("BEGIN")

	for (const sid of glossSids) {
		insRolePlace.run(sid)
	}

	for (const [sid, count] of keyCounts) {
		if (count >= glossThreshold) {
			insKeyTail.run(sid)
		}
	}

	out.exec("COMMIT")

	const roleGloss = Number(
		out
			.prepare(
				`UPDATE cand_stage SET name_role = 'gloss'
				 WHERE is_primary = 0 AND name_role IS NULL AND spr_id IN (SELECT spr_id FROM role_place)`
			)
			.run().changes
	)

	const keyTailWithRole = Number(
		out
			.prepare(
				`SELECT count(DISTINCT spr_id) AS n FROM cand_stage
				 WHERE name_role IS NOT NULL AND spr_id IN (SELECT spr_id FROM key_tail)`
			)
			.get()!["n"]
	)

	out.exec("DROP TABLE role_key")
	out.exec("DROP TABLE role_place")
	out.exec("DROP TABLE key_tail")

	progress(
		"roles",
		`${roleAbbr.toLocaleString()} abbr + ${roleGloss.toLocaleString()} gloss rows stamped; ` +
			`key tail (>= ${glossThreshold} keys): ${keyTailWithRole.toLocaleString()} of ${keyTailPlaces.toLocaleString()} places carry a role`
	)

	return { roleGloss, roleAbbr, roleVariant, keyTailPlaces, keyTailWithRole }
}
