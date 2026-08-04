/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Drift gate for the generated CLI reference (`generate-cli-reference.ts`). Three things are
 *   asserted, and each fails for a different reason:
 *
 *   1. Two known commands render exactly as snapshotted. A flag added, removed, renamed or
 *      re-defaulted on `doctor` or `data pull` fails here with the diff in the message. `doctor`
 *      pins the smallest shape (one boolean flag, no arguments); `data pull` pins the rest of the
 *      grammar in one command — a variadic required argument, a `--no-`-free boolean pair, an
 *      optional string, and a description carrying a `$VARIABLE`.
 *   2. The COMMITTED page equals a fresh render. This is the one that catches a flag changed
 *      anywhere in the documented surface without a regenerate, which no per-command snapshot can
 *      see.
 *   3. The render is a pure function of the surface — same input, same bytes, and no host path or
 *      timestamp anywhere in the output.
 *
 *   The walk reads `mailwoman/out/commands`, so `yarn compile` is a prerequisite. That is already
 *   true of every CI test leg (each runs `yarn compile` before `vitest`), and a missing tree throws
 *   with that instruction rather than skipping — a silently-skipped drift gate is not a gate.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"

import { beforeAll, describe, expect, it } from "vitest"

import {
	collectCLISurface,
	COMMANDS_DIRECTORY,
	escapeCell,
	OUTPUT_PATH,
	renderCLIReference,
	renderDefault,
	renderTable,
	type CLISurface,
} from "./generate-cli-reference.ts"

/**
 * Pull one command's rendered section out of the whole page, so a snapshot pins that command rather than the page.
 */
function sectionFor(page: string, commandPath: string): string {
	const heading = `### \`mailwoman ${commandPath}\``
	const start = page.indexOf(heading)

	expect(start, `no section for \`${commandPath}\` in the rendered page`).toBeGreaterThan(-1)
	const next = page.indexOf("\n#", start + heading.length)

	return page.slice(start, next === -1 ? undefined : next).trimEnd()
}

describe("generate-cli-reference", () => {
	let surface: CLISurface
	let page: string

	beforeAll(async () => {
		if (!existsSync(COMMANDS_DIRECTORY)) {
			throw new Error(`${COMMANDS_DIRECTORY} is missing — run \`yarn compile\` before the test suite`)
		}

		surface = await collectCLISurface()
		page = renderCLIReference(surface)
	}, 60_000)

	it("renders `mailwoman doctor` exactly", () => {
		expect(sectionFor(page, "doctor")).toMatchInlineSnapshot(`
			"### \`mailwoman doctor\`

			\`\`\`
			mailwoman doctor [options]
			\`\`\`

			| Flag     | Type    | Default | Description                                                                                                                                                                                                                        |
			| -------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
			| \`--json\` | boolean | \`false\` | Emit the report as JSON instead of a checklist: &#123; checks: [&#123; id, label, status, detail, fix?, core &#125;], exitCode &#125; — a superset of &#123; id, status, detail, fix? &#125; (label + core aid machine consumers). |"
		`)
	})

	it("renders `mailwoman data pull` exactly", () => {
		expect(sectionFor(page, "data pull")).toMatchInlineSnapshot(`
			"### \`mailwoman data pull\`

			\`\`\`
			mailwoman data pull [options] <bundle...>
			\`\`\`

			| Argument      | Required | Description                                    |
			| ------------- | -------- | ---------------------------------------------- |
			| \`<bundle...>\` | Yes      | Bundle name(s) to pull: candidate, poi, fr, us |

			| Flag                      | Type    | Default | Description                                                                                        |
			| ------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------- |
			| \`--dry-run\`               | boolean | \`false\` | Print the download plan; touch no network and write nothing                                        |
			| \`--only [only]\`           | string  | —       | Only pull artifacts whose remote/local path or state slug contains this substring (e.g. --only nh) |
			| \`--force\`                 | boolean | \`false\` | Re-download even when a local copy already appears present                                         |
			| \`--data-root [data-root]\` | string  | —       | Override the data root for this pull (default: $MAILWOMAN_DATA_ROOT or the built-in default)       |"
		`)
	})

	it("matches the committed page", async () => {
		const committed = await readFile(OUTPUT_PATH, "utf8")

		expect(
			committed,
			"docs/articles/developers/reference/cli.mdx is stale — run `node docs/scripts/generate-cli-reference.ts`"
		).toBe(page)
	})

	it("renders deterministically and leaks no host path or timestamp", () => {
		expect(renderCLIReference(surface)).toBe(page)

		// A default that resolves from the environment is suppressed rather than printed, so the
		// generating machine's data root can never reach a published page.
		expect(page).not.toContain("/mnt/")
		expect(page).not.toContain("/home/")
		expect(page).toContain("environment-dependent")
		expect(page).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
	})

	it("names every command group, documented or not", () => {
		const groups = new Set([
			...surface.documented.map((group) => group.name),
			...surface.undocumented.map((group) => group.name),
		])

		const documentedCount = surface.documented.reduce((total, group) => total + group.commands.length, 0)
		const undocumentedCount = surface.undocumented.reduce((total, group) => total + group.commandCount, 0)

		expect(documentedCount + undocumentedCount).toBe(surface.totalCommands)
		expect(groups.has("")).toBe(true)
		expect(surface.documented.map((group) => group.name)).toEqual(["", "data", "skill", "clients", "registry"])
	})
})

describe("renderDefault", () => {
	it("suppresses an absolute path", () => {
		expect(renderDefault("/mnt/playpen/mailwoman-data")).toBe("environment-dependent")
	})

	it("renders scalars and arrays as inline code, and no default as an em dash", () => {
		expect(renderDefault(undefined)).toBe("—")
		expect(renderDefault(false)).toBe("`false`")
		expect(renderDefault(0.9)).toBe("`0.9`")
		expect(renderDefault("en-US")).toBe("`en-US`")
		expect(renderDefault([])).toBe("`[]`")
	})
})

describe("escapeCell", () => {
	it("neutralizes every character MDX or the table would read as syntax", () => {
		expect(escapeCell("<component>=<mode>")).toBe("&lt;component&gt;=&lt;mode&gt;")
		expect(escapeCell("{ id, status }")).toBe("&#123; id, status &#125;")
		expect(escapeCell("a | b")).toBe("a \\| b")
		expect(escapeCell("R*Tree")).toBe("R\\*Tree")
		expect(escapeCell("line\nbreak")).toBe("line break")
	})
})

describe("renderTable", () => {
	it("pads every cell to its column width, the shape oxfmt normalizes to", () => {
		expect(renderTable(["A", "Long header"], [["x", "y"]])).toBe(
			["| A   | Long header |", "| --- | ----------- |", "| x   | y           |"].join("\n")
		)
	})
})
