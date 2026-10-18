/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares each staged weights package's graph with its card's address-system table before a release packs it.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { assertAddressSystemWidth, parseAddressSystemTable } from "@mailwoman/neural/address-system"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * Returns one problem per staged weights package whose `address_system_logits`
 * width differs from its card's `address_systems.count`.
 *
 * A package without a `model.onnx`, a card without the table, or a graph without the
 * head is skipped, because the runtime loader admits all three.
 */
export async function auditAddressSystemWidths(
	stagingRoot: PathBuilderLike,
	workspaces: readonly string[]
): Promise<string[]> {
	const problems: string[] = []

	for (const workspace of workspaces) {
		const directory = PathBuilder.from(stagingRoot)(workspace)
		const modelPath = directory("model.onnx")
		const cardPath = directory("model-card.json")

		if (!(await pathExists(modelPath)) || !(await pathExists(cardPath))) continue

		const card = await readLocalJSONFile<{ address_systems?: unknown }>(cardPath)
		const table = parseAddressSystemTable(card.address_systems, cardPath.toString())

		if (!table) continue

		const runner = await ONNXRunner.create(modelPath, {})

		try {
			assertAddressSystemWidth(table, await runner.outputWidth("address_system_logits"), cardPath.toString())
		} catch (error) {
			problems.push(`${workspace}: ${(error as Error).message}`)
		}
	}

	return problems
}
