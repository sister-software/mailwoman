/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pass 3c of the candidate build — the `name_role` detectors and the cuts they are judged by.
 */

import type { DatabaseSync } from "node:sqlite"

import { isOfficialLanguage } from "@mailwoman/codex/country"

import { normalizeLocalityForKey } from "../street-normalize.ts"
import type { PlaceAttrs } from "./place-attrs.ts"

/**
 * Key-count cut for the gloss anomaly detector (#1730) — the sweep's own boundary: 4,000 places carried >= 50 keys, and
 * a legitimate famous place at that count (New York, 176 keys) is separated by the PROMINENCE gate, never by this
 * number alone.
 */
export const GLOSS_KEY_THRESHOLD = 50

/**
 * Placetypes the gloss detector never flags. A country or region legitimately carries a name in every language — that
 * is what an exonym set IS — so key volume discriminates nothing there. The detector's population is the non-admin
 * tail, where a place named by a common noun ("Poisson", "Sunday") accumulating 200+ translations is a
 * machine-translated gloss set, not fame.
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
 * Pass 3c — the #1730 name-role prototype: two independent detectors over the staged rows, WRITE-ONLY in this
 * generation (no ranking consumer; the rank penalty is its own D-rule-gated step with the `gloss_key` board as
 * tripwire). Both stamp `is_primary = 0` rows only — a place's canonical name and the `place_abbr` region abbreviations
 * are never a gloss or a variant.
 *
 * - `gloss` is ANOMALY-based, and stamps only the certain core: key volume at/over the threshold + a non-admin placetype
 *
 *   - NO measured prominence (population absent AND importance unmeasured). Provenance cannot separate a gloss from an
 *     exonym — WOF imported both as `x_preferred` — and prominence is what rescues New York/Paris.
 * - `abbr` is PROVENANCE-based — the #936 signal: a WOF `variant` name in one of the country's official languages (or
 *   English), measured there at a 13× key-collision rate. A source without a `names` table (fixture-scale admin DBs)
 *   skips this detector loudly.
 *
 * Returns the stamp counts plus the census the prototype exists to report: how much of the ≥-threshold key tail carries
 * any role.
 */
export function stampNameRoles(ctx: {
	src: DatabaseSync
	out: DatabaseSync
	attrs: Map<number, PlaceAttrs>
	keyCounts: Map<number, number>
	glossThreshold: number
	ptcodes: Map<string, number>
	ccodes: Map<string, number>
	progress: (phase: string, message: string) => void
}): { roleGloss: number; roleAbbr: number; keyTailPlaces: number; keyTailWithRole: number } {
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

		if (a.pop > 0 || a.imp != null) continue
		glossSids.push(sid)
	}

	out.exec(
		"CREATE TEMP TABLE role_key (spr_id INTEGER NOT NULL, name_key TEXT NOT NULL, PRIMARY KEY (spr_id, name_key)) WITHOUT ROWID"
	)

	const insRoleKey = out.prepare("INSERT OR IGNORE INTO role_key VALUES (?, ?)")

	// Zero abbr stamps from a skipped detector is a different fact from zero variants found.
	const hasSourceNames =
		src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='names'").get() !== undefined

	if (hasSourceNames) {
		out.exec("BEGIN")

		// Two provenance routes into the same stamp: WOF's abbreviation/short name KINDS arrive in the
		// LANGUAGE column ('abbr'/'short' — 280 rows, measured 2026-08-18, Toledo's 'TO' among them) and
		// qualify by kind alone; everything else qualifies as a variant in an official language.
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

	// Stamp order is precedence: the provenance-based abbr first, then gloss fills what abbr did not claim.
	const roleAbbr = Number(
		out
			.prepare(
				`UPDATE cand_stage SET name_role = 'abbr'
				 WHERE is_primary = 0 AND EXISTS (
					SELECT 1 FROM role_key rk WHERE rk.spr_id = cand_stage.spr_id AND rk.name_key = cand_stage.name_key)`
			)
			.run().changes
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

	return { roleGloss, roleAbbr, keyTailPlaces, keyTailWithRole }
}
