/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Report, per surface, the gazetteer bias each FST arm hands the decoder. This is the curation
 *   instrument behind the hard-slice board (`build-hard-slice-board.run.ts` calls the same collapse) and
 *   the first thing to reach for when an arm comparison moves and you need to know whether the FST
 *   could have caused it.
 *
 *   WHAT IT PRINTS, and why that is the right quantity. `neural/fst-prior.ts`'s `applyBias` does not use
 *   the accepting entries individually: it collapses them to `max(importance)` PER BIO TAG, and only
 *   four placetypes reach a tag at all (`PLACETYPE_TO_BIO` — country / region / locality / postalcode).
 *   A `localadmin`, `county`, `borough` or `neighbourhood` entry is walked, deduped, and then dropped
 *   without ever touching the emission matrix. So the per-place ranking INSIDE a name — the thing the
 *   Saint-Denis pair is about — is invisible to the decoder; only the max is not. Printing anything else
 *   would overstate what an importance swap can do here.
 *
 *   `MISS` means the FST does not accept the surface at all: the gazetteer has nothing to say, which is
 *   ABSENCE and not a zero bias. A printed `0` means the FST DOES know the surface and scores it zero.
 *   The two are different facts and the output keeps them apart.
 *
 *   Usage: node packages/mailwoman/dev-tools/probe-fst-bias.run.ts [--locale en-us] [--raw] <surface>...
 */

import { pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { dataRootPath } from "@mailwoman/core/utils"
import { collapseFSTBias } from "@mailwoman/neural/fst-prior"
import { normalizeTokens } from "@mailwoman/resolver-wof-sqlite/fst-matcher"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"

const { values, positionals } = parseArguments({
	allowPositionals: true,
	options: {
		locale: { type: "string", default: "en-us" },
		/**
		 * Print every accepting entry at full precision instead of the per-tag max — how you tell "the arms agree" from
		 * "the arms agree to four decimal places".
		 */
		raw: { type: "boolean", default: false },
	},
})

/**
 * The arms, by the artifact each one is. `pop` fell back to population because its source DB has no `place_importance`
 * table; `imp` carries the real Wikipedia join. Both stamps are readable in the binaries' provenance tails.
 */
const ARMS: Record<string, string> = {
	pop: String(dataRootPath("wof", "fst-per-locale")),
	imp: String(dataRootPath("wof", "fst-staging-2026-08-05-importance-fanoutfix")),
}

const matchers = new Map<string, unknown>()

for (const [arm, dir] of Object.entries(ARMS)) {
	const path = `${dir}/fst-${values.locale}.bin`

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
