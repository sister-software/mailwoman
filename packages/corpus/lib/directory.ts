/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The one place a corpus version becomes a directory name.
 *
 *   Three writers composed `corpus-v${version}` independently, so a `--corpus-version` value already
 *   carrying the prefix produced `corpus-vv0.7.0-de-holdout` on disk and 695 files were re-stamped to
 *   repair it. The CLI now refuses such a value through `isCorpusVersion`, and this function is the
 *   other half: one composer, so a later change to the layout moves one line.
 */

import { stringifyJSON } from "@mailwoman/core/json"

/**
 * The directory name a corpus version is written under.
 *
 * @param corpusVersion The version by itself, without the `corpus-v` prefix.
 * @throws When the version already includes the prefix.
 * The same name composition yields `corpus-vv…`.
 */
export function corpusDirectoryName(corpusVersion: string): string {
	if (corpusVersion.startsWith("v")) {
		throw new Error(
			`corpusDirectoryName: ${stringifyJSON(corpusVersion)} already carries a leading "v". Composing the ` +
				`name would yield "corpus-v${corpusVersion}". Pass the version alone, as "0.7.0-de-holdout".`
		)
	}

	return `corpus-v${corpusVersion}`
}
