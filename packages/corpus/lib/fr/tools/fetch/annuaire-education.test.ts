/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { silentLogger } from "@mailwoman/core/logging"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	ANNUAIRE_EDUCATION_API_URL,
	ANNUAIRE_EDUCATION_FILENAME,
	type AnnuaireExportManifest,
	annuaireEducationInputPath,
	annuaireExportURL,
	annuaireOverseasFilter,
	countJSONLines,
	downloadAnnuaireEducation,
	readAnnuaireCatalog,
} from "#fr/tools/fetch/annuaire-education"
import { writeManifest } from "#tools/fetch/download"

function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "fr-annuaire test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

/**
 * The catalog record's `metas.default` fields the fetcher reads, as the API answered them on 2026-10-03.
 */
const CATALOG = {
	metas: {
		default: {
			modified: "2026-10-03T05:01:16.662000+00:00",
			license: "Licence Ouverte v2.0 (Etalab)",
			license_url: "http://www.etalab.gouv.fr/wp-content/uploads/2017/04/ETALAB-Licence-Ouverte-v2.0.pdf",
			publisher: "DNE - Ministère de l'Education Nationale",
			records_count: 68_564,
		},
	},
}

describe("annuaireExportURL", () => {
	it("asks the export for the eleven overseas departments as JSON Lines", () => {
		expect(annuaireOverseasFilter()).toBe(
			'code_departement in ("971","972","973","974","975","976","977","978","986","987","988")'
		)

		expect(annuaireExportURL()).toBe(
			`${ANNUAIRE_EDUCATION_API_URL}/exports/jsonl?where=${encodeURIComponent(annuaireOverseasFilter())}`
		)
	})
})

describe("countJSONLines", () => {
	it("counts records and ignores a trailing newline and blank lines", async () => {
		await using scratch = await temporaryDirectory("mailwoman-fr-annuaire-count-")

		const count = async (text: string) => {
			await writeLocalFile(text, scratch.path("export.jsonl"))

			return countJSONLines(scratch.path("export.jsonl"))
		}

		expect(await count('{"a":1}\n{"a":2}\n')).toBe(2)
		expect(await count('{"a":1}\n\n{"a":2}')).toBe(2)
		expect(await count("")).toBe(0)
	})
})

describe("readAnnuaireCatalog", () => {
	it("reads the modification date and the license", async () => {
		await using client = stubClient([{ body: CATALOG }])

		expect(await readAnnuaireCatalog(client)).toEqual({
			modified: "2026-10-03T05:01:16.662000+00:00",
			license: "Licence Ouverte v2.0 (Etalab)",
			licenseURL: "http://www.etalab.gouv.fr/wp-content/uploads/2017/04/ETALAB-Licence-Ouverte-v2.0.pdf",
		})
	})

	it("raises on a record with no modification date rather than reading every run as current", async () => {
		await using client = stubClient([{ body: { metas: { default: {} } } }])

		await expect(readAnnuaireCatalog(client)).rejects.toThrow(/modified/)
	})
})

describe("downloadAnnuaireEducation", () => {
	it("makes no transfer when the catalog's modification date matches the manifest", async () => {
		await using scratch = await temporaryDirectory("mailwoman-fr-annuaire-current-")
		await using client = stubClient([{ body: CATALOG }])

		const path = scratch.path(ANNUAIRE_EDUCATION_FILENAME)
		const text = '{"code_departement":"986"}\n'

		await writeLocalFile(text, path)

		const recorded: AnnuaireExportManifest = {
			source_url: annuaireExportURL(),
			downloaded_at: "2026-10-03T14:00:33.156Z",
			filename: ANNUAIRE_EDUCATION_FILENAME,
			sha256: await sha256File(path),
			bytes: Buffer.byteLength(text),
			dataset_modified: CATALOG.metas.default.modified,
			dataset_license: CATALOG.metas.default.license,
			dataset_license_url: CATALOG.metas.default.license_url,
			records: 1,
		}

		await writeManifest(scratch.path("MANIFEST.json"), { source: "fr-annuaire-education-overseas", files: [recorded] })

		const summary = await downloadAnnuaireEducation(client, { outputDir: scratch.path })

		expect(summary).toEqual({ fetched: 0, skipped: 1, failed: 0, failedCodes: [] })
		expect(client.calls).toEqual([ANNUAIRE_EDUCATION_API_URL])
	})
})

describe("annuaireEducationInputPath", () => {
	it("answers the export file the adapter reads", () => {
		expect(annuaireEducationInputPath(PathBuilder.from("/tmp/sources")).toString()).toBe(
			`/tmp/sources/fr-annuaire-education-overseas/${ANNUAIRE_EDUCATION_FILENAME}`
		)
	})
})
