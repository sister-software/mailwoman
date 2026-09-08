/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import {
	affectedDeployTargets,
	DEPLOY_TARGETS,
	selectDeployTargets,
	workspaceOfPath,
} from "@mailwoman/release-kit/deploy/targets"
import { describe, expect, it } from "vitest"

const DIRS = new Map([
	["@mailwoman/core", "packages/core"],
	["@mailwoman/react", "packages/react"],
	["@mailwoman/earth", "packages/earth"],
	["@mailwoman/planetary", "packages/planetary"],
	["@mailwoman/tile-worker", "packages/tile-worker"],
	["@mailwoman/license-worker", "packages/license-worker"],
	["@mailwoman/docs", "docs"],
])

const CLOSURES = new Map([
	["tiles", new Set(["@mailwoman/tile-worker", "@mailwoman/core"])],
	["license", new Set(["@mailwoman/license-worker", "@mailwoman/core"])],
	["earth", new Set(["@mailwoman/earth", "@mailwoman/react", "@mailwoman/core"])],
	["moon", new Set(["@mailwoman/planetary", "@mailwoman/react", "@mailwoman/core"])],
	["mars", new Set(["@mailwoman/planetary", "@mailwoman/react", "@mailwoman/core"])],
] as const)

const ids = (changed: string[]) => selectDeployTargets(changed, CLOSURES, DIRS).map(({ target }) => target.id)

describe("workspaceOfPath", () => {
	it("names the workspace by the longest directory prefix, and null outside every workspace", () => {
		expect(workspaceOfPath(DIRS, "packages/core/lib/git.ts")).toBe("@mailwoman/core")
		expect(workspaceOfPath(DIRS, "docs/src/pages/index.tsx")).toBe("@mailwoman/docs")
		expect(workspaceOfPath(DIRS, "packages/corelike/lib/x.ts")).toBeNull()
		expect(workspaceOfPath(DIRS, "corpus-python/src/train.py")).toBeNull()
		expect(workspaceOfPath(DIRS, "README.md")).toBeNull()
	})
})

describe("selectDeployTargets", () => {
	it("a change inside one app reaches that app only", () => {
		expect(ids(["packages/earth/lib/App.tsx"])).toEqual(["earth"])
		expect(ids(["packages/planetary/lib/App.tsx"])).toEqual(["moon", "mars"])
	})

	it("a change in a shared dependency reaches every target whose closure carries it", () => {
		expect(ids(["packages/react/lib/map/MapCanvas.tsx"])).toEqual(["earth", "moon", "mars"])
		expect(ids(["packages/core/lib/git.ts"])).toEqual(["tiles", "license", "earth", "moon", "mars"])
	})

	it("a root build file reaches everything, and says which file", () => {
		const selections = selectDeployTargets(["yarn.lock"], CLOSURES, DIRS)

		expect(selections.map(({ target }) => target.id)).toEqual(["tiles", "license", "earth", "moon", "mars"])
		expect(selections[0]?.reasons).toEqual(["yarn.lock"])
	})

	it("a docs, python or record change reaches nothing", () => {
		expect(ids(["docs/src/pages/index.tsx", "corpus-python/src/train.py", "AGENTS.md"])).toEqual([])
	})

	it("reasons name the changed workspaces in the closure, not the changed files", () => {
		const [earth] = selectDeployTargets(["packages/react/lib/a.ts", "packages/react/lib/b.ts"], CLOSURES, DIRS)

		expect(earth?.target.id).toBe("earth")
		expect(earth?.reasons).toEqual(["@mailwoman/react"])
	})
})

describe("the target table against the checkout", () => {
	it("every target names a workspace in the root array, and its closure reaches core", async () => {
		const root = String(repoRootPath())

		const all = await affectedDeployTargets(root, ["packages/core/package.json"])

		expect(all.map(({ target }) => target.id)).toEqual(DEPLOY_TARGETS.map((target) => target.id))
	})

	it("a planetary change deploys the two bodies and nothing else", async () => {
		const root = String(repoRootPath())

		const selections = await affectedDeployTargets(root, ["packages/planetary/lib/routes.ts"])

		expect(selections.map(({ target }) => target.id)).toEqual(["moon", "mars"])
	})
})
