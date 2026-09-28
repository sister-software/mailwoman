/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Report, per surface, the gazetteer bias each FST arm hands the decoder: `applyBias` collapses
 *   accepting entries to the max importance per BIO tag, so a place's per-place ranking is invisible
 *   and only the four placetypes that reach a tag matter, while `miss` is absence and a printed
 *   `0` is a scored zero.
 */

import { pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { collapseFSTBias } from "@mailwoman/neural/fst-prior"
import { normalizeTokens, deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { PathBuilder } from "path-ts"

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		locale: { type: "string", default: "en-us" },
		/**
		 * Print every accepting entry at full precision rather than the per-tag max,
		 * to tell agreement from agreement at four decimal places.
		 */
		raw: { type: "boolean", default: false },
	},
})

/**
 * The arms, by the artifact each is: `pop` fell back to population because its source DB
 * has no `place_importance` table, while `imp` carries the real Wikipedia join.
 */
const ARMS: Record<string, PathBuilder> = {
	pop: wofDatabasePath("fst-per-locale"),
	imp: wofDatabasePath("fst-staging-2026-08-05-importance-fanoutfix"),
}

const matchers = new Map<string, unknown>()

for (const [arm, dir] of Object.entries(ARMS)) {
	const path = dir(`fst-${values.locale}.bin`)

	if (!(await pathExists(path))) {
		console.error(`[${arm}] no fst-${values.locale}.bin in ${dir} — skipping this arm`)

		continue
	}

	matchers.set(arm, deserializeFST(await readLocalBuffer(path)))
}

if (!positionals.length) throw new Error("no surfaces given — pass one or more place-name surfaces to probe")

for (const surface of positionals) {
	const cells: string[] = []

	for (const [arm, m] of matchers) {
		const match = (m as { walk(t: string[]): { stateID: number; accepted: boolean } | null }).walk(
			normalizeTokens(surface)
		)

		if (!match?.accepted) {
			cells.push(`${arm}=MISS`)

			continue
		}

		const entries = (
			m as { accepting(id: number): Array<{ wofID: number; placetype: string; importance: number }> }
		).accepting(match.stateID)

		if (values.raw) {
			cells.push(`${arm}=[${entries.map((e) => `${e.wofID}/${e.placetype}:${e.importance}`).join(" ")}]`)

			continue
		}

		const byTag = collapseFSTBias(entries, normalizeTokens(surface))

		cells.push(
			byTag.size
				? `${arm}=[${[...byTag].map(([t, v]) => `${t}:${v.toFixed(4)}`).join(",")}] n=${entries.length}`
				: `${arm}=[no BIO-mapped placetype] n=${entries.length}`
		)
	}

	console.log(`${surface}\t${cells.join("\t")}`)
}
