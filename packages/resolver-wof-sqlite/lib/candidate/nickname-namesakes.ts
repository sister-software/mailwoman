// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The candidate build's nickname refusal: a colloquial or unclassified name doesn't become an
 *   alias row when a populated place holds the same key by a real name.
 */

import { GEONAMES_ID_BASE, OVERTURE_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"

import type { PlaceAttrs } from "#candidate/place-attrs"
import type { CandidateDatabase } from "#candidate/schema"
import type { WOFDatabase } from "#schema"
import { normalizeLocalityForKey, withoutApostropheLikeMarks } from "#street/normalize"

/**
 * The WOF name kinds that name a place without being its name: a colloquial name
 * (`Motor City`, `T.O.`) and an unclassified one.
 * An unclassified name is mostly a code (`DE`, `AP`, `GTA`).
 */
const NICKNAME_KINDS: readonly string[] = ["colloquial", "unknown"]

/**
 * The keys a name stages as alias rows: its key, and its mark-free form when that differs.
 */
function stagedKeys(name: string): string[] {
	const k = normalizeLocalityForKey(name)

	if (!k) return []
	const free = withoutApostropheLikeMarks(k)

	return free && free !== k ? [k, free] : [k]
}

/**
 * Deletes the alias rows a place holds only through a colloquial or unclassified name,
 * when another place with a population holds the same key by any other name.
 *
 * The candidate ranks a key's rows by population, so a nickname of a large place outranks
 * every smaller place whose own name the nickname spells: `T.O.` and `To.`
 * (Toronto) over Tó, `Garden City` (Victoria) over each Garden City, `DE` (Germany) over Delaware's `DE`.
 *
 * A namesake without a population ranks last under any populated holder, so a nickname whose
 * only namesakes are unpopulated stays: `Motor City` keeps Detroit over Motor City, California.
 * A nickname that several places share also stays when no other place holds its key
 * by a real name (`The Windy City` for Chicago and Wellington).
 *
 * Runs on `cand_stage` after the primaries, aliases and abbreviations are staged,
 * and before the postcode extracts.
 * A postcode row stores no population.
 *
 * @returns The count of alias rows deleted, and of distinct keys they held.
 */
export function refuseNicknamesOfNamesakes(
	src: DatabaseClient<WOFDatabase>,
	out: DatabaseClient<CandidateDatabase>,
	attrs: Map<number, PlaceAttrs>
): { rows: number; keys: number } {
	if (!tableExists(src, "names")) return { rows: 0, keys: 0 }

	const kinds = NICKNAME_KINDS.map(() => "?").join(", ")
	const nicknameKeys = new Map<number, Set<string>>()

	for (const r of src.prepare(`SELECT id, name FROM names WHERE privateuse IN (${kinds})`).iterate(...NICKNAME_KINDS)) {
		const id = Number(r.id)

		if (!attrs.has(id)) continue
		let keys = nicknameKeys.get(id)

		if (!keys) {
			keys = new Set()
			nicknameKeys.set(id, keys)
		}

		for (const k of stagedKeys(String(r.name ?? ""))) {
			keys.add(k)
		}
	}

	if (!nicknameKeys.size) return { rows: 0, keys: 0 }

	// A key the place also holds by a real name belongs to that name's row and is never refused.
	const realNames = src.prepare(`SELECT name FROM names WHERE id = ? AND privateuse NOT IN (${kinds})`)
	const abbrs = tableExists(src, "place_abbr") ? src.prepare("SELECT abbr FROM place_abbr WHERE id = ?") : null

	const ownKeys = (id: number): string[] => [
		...stagedKeys(attrs.get(id)?.name ?? ""),
		...realNames.all(id, ...NICKNAME_KINDS).flatMap((r) => stagedKeys(String(r.name ?? ""))),
		...(abbrs?.all(id).flatMap((r) => stagedKeys(String(r.abbr ?? ""))) ?? []),
	]

	out.exec(
		"CREATE TEMP TABLE nickname_key (spr_id INTEGER NOT NULL, name_key TEXT NOT NULL, PRIMARY KEY (spr_id, name_key)) WITHOUT ROWID"
	)

	const insNickname = out.prepare("INSERT OR IGNORE INTO nickname_key VALUES (?, ?)")
	out.exec("BEGIN")

	for (const [id, keys] of nicknameKeys) {
		for (const k of ownKeys(id)) {
			keys.delete(k)
		}

		for (const k of keys) {
			insNickname.run(id, k)
		}
	}

	out.exec("COMMIT")

	out.exec("CREATE INDEX temp.nickname_key_by_key ON nickname_key (name_key)")
	out.exec("CREATE TEMP TABLE namesake_key (name_key TEXT PRIMARY KEY) WITHOUT ROWID")

	// An Overture division is never a namesake.
	// The gazetteer is a Collective Database whose Overture Divisions part is ODbL, and a WOF
	// or GeoNames alias refused because of a division's row would be that part altering the rest.
	// The Overture step writes no nickname kind on a division, so no Overture
	// row holds a nickname to refuse either.
	out.exec(
		`INSERT OR IGNORE INTO namesake_key
		 SELECT cs.name_key FROM cand_stage cs
		 WHERE cs.population > 0
			AND NOT (cs.spr_id >= ${OVERTURE_ID_BASE} AND cs.spr_id < ${GEONAMES_ID_BASE})
			AND cs.name_key IN (SELECT name_key FROM nickname_key)
			AND NOT EXISTS (SELECT 1 FROM nickname_key nk WHERE nk.spr_id = cs.spr_id AND nk.name_key = cs.name_key)`
	)

	const keys = Number(out.prepare("SELECT count(*) AS n FROM namesake_key").get()!["n"])

	const rows = Number(
		out
			.prepare(
				`DELETE FROM cand_stage
				 WHERE is_primary = 0
					AND name_key IN (SELECT name_key FROM namesake_key)
					AND EXISTS (SELECT 1 FROM nickname_key nk WHERE nk.spr_id = cand_stage.spr_id AND nk.name_key = cand_stage.name_key)`
			)
			.run().changes
	)

	out.exec("DROP TABLE namesake_key")
	out.exec("DROP TABLE nickname_key")

	return { rows, keys }
}
