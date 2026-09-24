/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measure, check, and update the committed corpus pins without loading a model or gazetteer.
 *   Check mode compares corpus measurements with committed constants; update mode changes only
 *   those constants, preserving the pin test's history comments.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
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
 * Read the committed constants out of the pin test's source.
 *
 * @throws When a constant is missing or duplicated.
 * A reshaped test file needs a human rather than a guess.
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
 * Rewrite exactly the three constant lines to `pins`, leaving every other byte —
 * the dated history comments above each constant included — untouched.
 *
 * Validates via {@link readCommittedPins} first, so a reshaped file refuses
 * instead of being partially rewritten.
 */
export function writeCommittedPins(testText: string, pins: BoardPins): string {
	readCommittedPins(testText)

	return testText
		.replace(PIN_PATTERNS.CORPUS_SIZE, `const CORPUS_SIZE = ${pins.CORPUS_SIZE}`)
		.replace(PIN_PATTERNS.CORPUS_HASH, `const CORPUS_HASH = ${stringifyJSON(pins.CORPUS_HASH)}`)
		.replace(PIN_PATTERNS.BOARD_ID, `const BOARD_ID = ${stringifyJSON(pins.BOARD_ID)}`)
}

export interface PinCheck {
	measured: BoardPins
	committed: BoardPins
	/**
	 * The pin names whose measured and committed values differ.
	 *
	 * Empty = the pins hold.
	 */
	stale: Array<keyof BoardPins>
}

/**
 * Compare the measured pins against the committed constants.
 */
export async function checkBoardPins(): Promise<PinCheck> {
	const measured = await measureBoardPins()
	const testPath = resolvePath(repoRootPath(), PIN_TEST_PATH)
	const committed = readCommittedPins(await readLocalTextFile(testPath))
	const stale = (Object.keys(measured) as Array<keyof BoardPins>).filter((key) => measured[key] !== committed[key])

	return { measured, committed, stale }
}

/**
 * Rewrite the committed constants to the measured values, then re-check.
 *
 * @returns The verifying check, whose `stale` must be empty.
 * A non-empty result after an update means the file reshaped under us.
 */
export async function updateBoardPins(): Promise<PinCheck> {
	const path = resolvePath(repoRootPath(), PIN_TEST_PATH)
	const measured = await measureBoardPins()

	await writeLocalFile(writeCommittedPins(await readLocalTextFile(path), measured), path)

	return checkBoardPins()
}
