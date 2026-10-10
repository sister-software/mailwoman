import { buildBDCDatabase } from "@mailwoman/bdc/sdk/build-bdc"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { createFilerFamilyTable, createFilerManifestTable, type FilerDatabase } from "@mailwoman/filer/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { resolvePath } from "path-ts"
import { expect, it } from "vitest"

it("completes BDC and filer queries before closing their connections", async () => {
	await using directory = await temporaryDirectory("mcp-query-lifetime-")
	const bdcPath = directory.path("bdc.db")
	const filerPath = directory.path("filer.db")

	await buildBDCDatabase({
		rows: [],
		out: bdcPath,
		asOfDate: "2026-07-30",
		buildSHA: "fixture",
		blockCentroids: () => null,
	})

	{
		using db = new DatabaseClient<FilerDatabase>(filerPath)

		await createFilerManifestTable(db)
		await createFilerFamilyTable(db)

		await db
			.insertInto("filer_manifest")
			.values({
				name: "filer",
				version: "fixture",
				schema_version: 2,
				source: "fixture",
				source_vintage: "2026-Q1",
				build_cmd: "test",
				build_sha: "fixture",
				created_at: "2026-01-01T00:00:00Z",
			})
			.execute()
	}

	await using resources = new AsyncDisposableStack()
	const client = new Client({ name: "query-lifetime-test", version: "1.0.0" })

	resources.defer(() => client.close())

	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [resolvePath(import.meta.dirname, "main.ts")],
		})
	)

	const bdc = await client.callTool({
		name: "mailwoman_bdc_filing_landscape",
		arguments: { database_path: bdcPath.toString(), geoids: ["999999999999999"] },
	})

	expect(bdc.isError, stringifyJSON(bdc)).not.toBe(true)

	const filer = await client.callTool({
		name: "mailwoman_filer_family",
		arguments: { database_path: filerPath.toString(), node_id: "frn:0001111111" },
	})

	expect(filer.isError, stringifyJSON(filer)).not.toBe(true)
	const content = filer.content as Array<{ type: "text"; text: string }>

	expect(parseJSONStrict(content[0]!.text)).toEqual([])
})
