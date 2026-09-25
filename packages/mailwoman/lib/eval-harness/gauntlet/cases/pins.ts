/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measures, checks, and updates the regression-corpus pins in `load.test.ts` without loading a model or gazetteer.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { resolvePath } from "path-ts"

import { ablationBoardID } from "#eval-harness/gauntlet/ablation"
import { loadRegressionCases, regressionCorpusHash } from "#eval-harness/gauntlet/cases/load"

/**
 * Values that `load.test.ts` pins, keyed by the constant names in that file.
 */
export interface BoardPins {
	CORPUS_SIZE: number
	CORPUS_HASH: string
	BOARD_ID: string
}

/**
 * Repository-relative path of the test file that holds the pinned constants.
 */
export const PIN_TEST_PATH = "packages/mailwoman/test/unit/eval-harness/gauntlet/cases/load.test.ts"

/**
 * Measures the pins from the committed corpus with the same loaders that the pin test uses.
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
 * Reads the pinned constants from the test file's source.
 *
 * @throws When a constant is missing or appears more than once.
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
 * Returns the test source with the three constant lines set to `pins` and every other byte unchanged.
 *
 * It calls {@link readCommittedPins} first, so it throws on a malformed file
 * instead of rewriting part of it.
 */
export function writeCommittedPins(testText: string, pins: BoardPins): string {
	readCommittedPins(testText)

	return testText
		.replace(PIN_PATTERNS.CORPUS_SIZE, `const CORPUS_SIZE = ${pins.CORPUS_SIZE}`)
		.replace(PIN_PATTERNS.CORPUS_HASH, `const CORPUS_HASH = ${stringifyJSON(pins.CORPUS_HASH)}`)
		.replace(PIN_PATTERNS.BOARD_ID, `const BOARD_ID = ${stringifyJSON(pins.BOARD_ID)}`)
}

/**
 * Measured and committed pins with the names of those that differ.
 */
export interface PinCheck {
	measured: BoardPins
	committed: BoardPins
	/**
	 * Names of the pins whose measured and committed values differ.
	 * It is empty when every pin matches.
	 */
	stale: Array<keyof BoardPins>
}

/**
 * Compares the measured pins against the committed constants.
 */
export async function checkBoardPins(): Promise<PinCheck> {
	const measured = await measureBoardPins()
	const testPath = resolvePath(repoRootPath(), PIN_TEST_PATH)
	const committed = readCommittedPins(await readLocalTextFile(testPath))
	const stale = (Object.keys(measured) as Array<keyof BoardPins>).filter((key) => measured[key] !== committed[key])

	return { measured, committed, stale }
}

/**
 * Writes the measured values into the committed constants and then checks them again.
 *
 * @returns The follow-up check.
 * A non-empty `stale` list means the file changed during the update.
 */
export async function updateBoardPins(): Promise<PinCheck> {
	const path = resolvePath(repoRootPath(), PIN_TEST_PATH)
	const measured = await measureBoardPins()

	await writeLocalFile(writeCommittedPins(await readLocalTextFile(path), measured), path)

	return checkBoardPins()
}
