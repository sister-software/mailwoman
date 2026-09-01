/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The board-pin contract as a script API (#1895): measure the committed corpus's three pins, read
 *   the constants the pin test carries, compare them, and rewrite exactly those constants. The Ink
 *   command (`mailwoman eval pins`) formats this; the admin-merge wrapper and the cheap CI check
 *   call it directly. Loads ONLY the committed JSONL — no model, no gazetteer, no warm engine —
 *   measured at ~2 s on the 651-row corpus.
 *
 *   The committed constants stay a deliberate review regression check: check mode compares MEASURED against
 *   COMMITTED, never deriving both sides from the live corpus, and update mode rewrites only the
 *   three constant lines so the pin test's dated history comments survive byte-identically.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"

import { ablationBoardID } from "#eval-harness/gauntlet/ablation"
import { loadRegressionCases, regressionCorpusHash } from "#eval-harness/gauntlet/cases/load"

/**
 * The three values `load.test.ts` pins, under the names it pins them as.
 */
export interface BoardPins {
	CORPUS_SIZE: number
	CORPUS_HASH: string
	BOARD_ID: string
}

/**
 * Where the committed pins live — the pin test itself.
 */
export const PIN_TEST_PATH = "packages/mailwoman/test/unit/eval-harness/gauntlet/cases/load.test.ts"

/**
 * Measure the pins from the committed corpus — the same loaders the pin test asserts with.
 */
export async function measureBoardPins(): Promise<BoardPins> {
	const cases = await loadRegressionCases()

	return {
		CORPUS_SIZE: cases.length,
		CORPUS_HASH: regressionCorpusHash(cases),
		BOARD_ID: ablationBoardID(cases),
	}
}

const PIN_PATTERNS: Record<keyof BoardPins, RegExp> = {
	CORPUS_SIZE: /^const CORPUS_SIZE = (\d+)$/m,
	CORPUS_HASH: /^const CORPUS_HASH = "([0-9a-f]{64})"$/m,
	BOARD_ID: /^const BOARD_ID = "(gauntlet-regression@\d+:[0-9a-f]+)"$/m,
}

/**
 * Read the committed constants out of the pin test's source. Throws when a constant is missing or duplicated — a
 * reshaped test file needs a human, not a guess.
 */
export function readCommittedPins(testText: string): BoardPins {
	const read = (key: keyof BoardPins): string => {
		const matches = [...testText.matchAll(new RegExp(PIN_PATTERNS[key].source, "gm"))]

		if (matches.length !== 1) {
			throw new Error(`${PIN_TEST_PATH} carries ${matches.length} \`const ${key} = …\` lines — expected exactly one.`)
		}

		return matches[0]![1]!
	}

	return {
		CORPUS_SIZE: Number(read("CORPUS_SIZE")),
		CORPUS_HASH: read("CORPUS_HASH"),
		BOARD_ID: read("BOARD_ID"),
	}
}

/**
 * Rewrite exactly the three constant lines to `pins`, leaving every other byte — the dated history comments above each
 * constant included — untouched. Validates via {@link readCommittedPins} first, so a reshaped file refuses instead of
 * being partially rewritten.
 */
export function writeCommittedPins(testText: string, pins: BoardPins): string {
	readCommittedPins(testText)

	return testText
		.replace(PIN_PATTERNS.CORPUS_SIZE, `const CORPUS_SIZE = ${pins.CORPUS_SIZE}`)
		.replace(PIN_PATTERNS.CORPUS_HASH, `const CORPUS_HASH = ${JSON.stringify(pins.CORPUS_HASH)}`)
		.replace(PIN_PATTERNS.BOARD_ID, `const BOARD_ID = ${JSON.stringify(pins.BOARD_ID)}`)
}

export interface PinCheck {
	measured: BoardPins
	committed: BoardPins
	/**
	 * The pin names whose measured and committed values differ. Empty = the pins hold.
	 */
	stale: Array<keyof BoardPins>
}

/**
 * Compare the measured pins against the committed constants.
 */
export async function checkBoardPins(): Promise<PinCheck> {
	const measured = await measureBoardPins()
	const testPath = resolvePath(String(repoRootPath()), PIN_TEST_PATH)
	const committed = readCommittedPins(await readLocalTextFile(testPath))
	const stale = (Object.keys(measured) as Array<keyof BoardPins>).filter((key) => measured[key] !== committed[key])

	return { measured, committed, stale }
}

/**
 * Rewrite the committed constants to the measured values, then re-check. Returns the verifying check, whose `stale`
 * must be empty — a non-empty result after an update means the file reshaped under us.
 */
export async function updateBoardPins(): Promise<PinCheck> {
	const path = resolvePath(String(repoRootPath()), PIN_TEST_PATH)
	const measured = await measureBoardPins()

	await writeLocalFile(writeCommittedPins(await readLocalTextFile(path), measured), path)

	return checkBoardPins()
}
