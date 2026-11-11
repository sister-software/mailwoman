/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import ts from "typescript"
import { describe, expect, test } from "vitest"

import { importTimeEffects, pureAnnotatedEffects, sideEffectsCheck } from "#repo-health/checks/side-effects"
import { collectRepoContext } from "#repo-health/index"

const FILE = "packages/postcode/lib/shapes.ts"

function parse(text: string): ts.SourceFile {
	return ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true)
}

describe("importTimeEffects", () => {
	test("reports each kind of statement that runs when the module is evaluated", () => {
		const effects = importTimeEffects(
			parse(`
				import "./styles.css"
				import { readLocalJSONFile } from "@mailwoman/core/fs/readers"

				window.addEventListener("message", () => {})
				const table = await readLocalJSONFile("table.json")
				const unsubscribe = store.subscribe(() => {})
				class Registry { static { Registry.ready = true } }
				for (const entry of entries) seen.add(entry)
			`),
			FILE
		)

		expect(effects.map((effect) => [effect.line, effect.what.split(":")[0]])).toEqual([
			[2, `imports "./styles.css" for its effects`],
			[5, "runs a statement at module scope"],
			[6, "awaits at module scope"],
			[7, "registers a listener at module scope"],
			[8, "runs a class static block"],
			[9, "runs a statement at module scope"],
		])
	})

	test("passes declarations, values computed at module scope, own-state writes and a main-module guard", () => {
		const effects = importTimeEffects(
			parse(`
				"use client"
				import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
				import type { Shape } from "#types"

				export const SHAPES = new Set(Object.keys({ a: 1 }))
				export const Context = createContext(null)
				Context.displayName = "Context"

				export async function loadShapes(): Promise<Shape[]> {
					return readLocalJSONFile("shapes.json")
				}

				export class Matcher {
					static readonly empty = new Map()
					readonly table = new Map()
				}

				if (import.meta.main) {
					await loadShapes()
				}
			`),
			FILE
		)

		expect(effects).toEqual([])
	})
})

describe("pureAnnotatedEffects", () => {
	test("reports a pure annotation on an effect-interface call and passes one on a constructor", () => {
		const found = pureAnnotatedEffects(
			parse(`
				import { readLocalTextFile } from "@mailwoman/core/fs/readers"

				const text = /* @__PURE__ */ readLocalTextFile("notes.txt")
				const names = /* @__PURE__ */ new Set(["a", "b"])
			`),
			FILE
		)

		expect(found.map((entry) => entry.line)).toEqual([4])
	})
})

describe("sideEffectsCheck", () => {
	test("reports nothing on the current tree", async () => {
		await expect(sideEffectsCheck.run(await collectRepoContext())).resolves.toEqual([])
	})
})
