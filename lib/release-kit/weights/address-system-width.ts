// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Compares each staged weights package's graph with its card's address-system table
 *   before a release packs it.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { assertAddressSystemWidth, parseAddressSystemTable } from "@mailwoman/neural/labels/address-system"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { readAddressSystemRegistry } from "@mailwoman/neural/tools/address-system-registry"
import { addressSystemCard } from "mailwoman/tools/release-tools/package/weights"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * Gives a candidate's derived card the address-system table of the candidate's own head, in place.
 *
 * The table describes the graph's `address_system_logits` output, so a candidate trained on more
 * systems than the published model takes the committed registry's table at its head's width,
 * as `package/weights.run.ts` writes it, and the card's `candidate` block records the replacement.
 * A card without the table, a graph without the head, or a table already the
 * head's width leaves the card as it is.
 *
 * @returns The head's width when the table was replaced, else `null`.
 * @throws When the head's width differs from the table's and no address-system registry is committed.
 */
export async function fitAddressSystemTable(
	card: Record<string, unknown>,
	graphPath: PathBuilderLike,
	cardPath: string
): Promise<number | null> {
	const table = parseAddressSystemTable(card["address_systems"], cardPath)

	if (!table) return null

	const runner = await ONNXRunner.create(graphPath, {})
	const width = await runner.outputWidth("address_system_logits")

	// A graph without the head is one the runtime loader admits with any table, as the width audit does.
	if (width == null || width === table.count) return null

	const registry = await readAddressSystemRegistry()

	if (!registry) throw new Error(`the candidate's head is ${width} wide and no address-system registry is committed`)

	card["address_systems"] = addressSystemCard(registry, width)

	card["candidate"] = {
		...(card["candidate"] as Record<string, unknown> | undefined),
		address_systems: {
			$comment: `The graph's head is ${width} wide and the published card's table ${table.count}, so the table is the committed registry's.`,
			registry: "packages/trainer/data/address_systems.json",
			count: width,
		},
	}

	return width
}

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
