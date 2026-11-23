// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Rewrites the US address layer's terms table in `docs/engineering/reference/layer-interface.mdx`
 *   from the join the data BOM, `mailwoman doctor` and `NOTICE.txt` read.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/us/address-coverage/layer-terms-table.run.ts \
 *   --layer-version <version> [--root <layer root>] [--check]
 *
 *   The table counts the version's sources and records by the deciding register row's basis
 *   and what its terms page held, with each group's obligation class.
 *   It replaces the text between the `layer-terms-table:begin` and `layer-terms-table:end` comments.
 *
 *   The page is run through oxfmt, the repository formatter, before it is compared or written,
 *   so a write needs no separate format pass and `--check` passes on a formatted page.
 *   `--check` exits 1 when the committed table differs from the generated one,
 *   and leaves the file unchanged.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { resolvePackageCommand } from "@mailwoman/core/module/package-command"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { runFileSync } from "@mailwoman/core/scripting/process"

import { describeMixedAddressLayer, localLayerFileReader, type MixedLayerSource } from "#data/terms/mixed-layer"

const { values } = parseArguments({
	options: { "layer-version": { type: "string" }, root: { type: "string" }, check: { type: "boolean" } },
})

const version = values["layer-version"]

if (!version) throw new Error("--layer-version is required")

const DOC = repoRootPath("docs", "engineering", "reference", "layer-interface.mdx")
const BEGIN = "{/* layer-terms-table:begin */}"
const END = "{/* layer-terms-table:end */}"

const description = await describeMixedAddressLayer({
	license: "LicenseRef-US-Mixed",
	version,
	read: localLayerFileReader(values.root ?? dataRootPath("db")),
})

/**
 * The group a source is counted under: its deciding row's basis and what that row's terms page held.
 */
const groupOf = (source: MixedLayerSource) => `${source.basis}\u0000${source.statement ?? ""}`

const groups = new Map<
	string,
	{ basis: string; statement: string; sources: number; records: number; classes: Set<string> }
>()

for (const source of description.sources) {
	const key = groupOf(source)

	const group = groups.get(key) ?? {
		basis: source.basis,
		statement: source.statement ?? "",
		sources: 0,
		records: 0,
		classes: new Set<string>(),
	}

	group.sources++
	group.records += source.records
	group.classes.add(source.obligationClass)
	groups.set(key, group)
}

const number = (value: number) => value.toLocaleString("en-US")

const rows = [...groups.values()].toSorted((a, b) => b.records - a.records)

const table = [
	`Generated from \`addresses/us/${version}\` (${number(description.regions)} regions) by`,
	"`packages/mailwoman/tools/dev-tools/us/address-coverage/layer-terms-table.run.ts`.",
	"",
	"| Basis | Terms page | Sources | Records | Obligation classes |",
	"| --- | --- | ---: | ---: | --- |",
	...rows.map(
		(row) =>
			`| \`${row.basis}\` | ${row.statement ? `\`${row.statement}\`` : "none read"} | ${number(row.sources)} | ${number(row.records)} | ${[...row.classes].toSorted().join(", ")} |`
	),
	`| all | | ${number(description.sources.length)} | ${number(description.records)} | |`,
].join("\n")

const text = await readLocalTextFile(DOC)
const start = text.indexOf(BEGIN)
const end = text.indexOf(END)

if (start === -1 || end < start) throw new Error(`${DOC.toString()} holds no ${BEGIN} … ${END} block`)

// The committed page is the formatter's output, so the generated page is formatted before it's compared or written.
const oxfmt = await resolvePackageCommand(pathToFileURL(repoRootPath("package.json")).href, "oxfmt", "oxfmt")

const next = runFileSync(oxfmt.file, [...oxfmt.argv, `--stdin-filepath=${DOC.toString()}`], {
	cwd: repoRootPath(),
	input: `${text.slice(0, start + BEGIN.length)}\n\n${table}\n\n${text.slice(end)}`,
})

if (values.check) {
	if (next !== text) {
		console.error(`${DOC.toString()}: the terms table differs from addresses/us/${version}`)

		process.exitCode = 1
	}
} else {
	await writeLocalTextFile(next, DOC)

	console.log(`wrote ${rows.length} groups over ${number(description.sources.length)} sources to ${DOC.toString()}`)
}
