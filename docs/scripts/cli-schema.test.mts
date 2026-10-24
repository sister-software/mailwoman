/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The command reader returns the same tree whatever order the filesystem lists a directory's
 *   entries, and a directory beside a command file of the same name keeps that command in the tree.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { afterEach, describe, expect, it } from "vitest"

import { readCommands } from "./cli-schema.mts"

function commandModule(name: string): string {
	const spec = stringifyJSON({ name, description: `The ${name} command.` })

	return [`export const spec = ${spec}`, "export default function run() {}", ""].join("\n")
}

const HELPER_MODULE = "export function helper() {\n\treturn 1\n}\n"

let scratch: TemporaryDirectory | null = null

afterEach(async () => {
	await scratch?.[Symbol.asyncDispose]()
	scratch = null
})

describe("readCommands", () => {
	it("keeps a command whose sibling directory holds only helper modules", async () => {
		scratch = await temporaryDirectory("mailwoman-cli-schema-")
		await makeDirectories(scratch.path("license"))
		await writeLocalTextFile(commandModule("license"), scratch.path("license.mjs"))
		await writeLocalTextFile(HELPER_MODULE, scratch.path("license", "attribution.mjs"))

		const commands = await readCommands(scratch.path)
		const license = commands.get("license")

		expect([...commands.keys()]).toEqual(["license"])
		expect(license?.spec?.name).toBe("license")
		expect(license?.component).toBeTypeOf("function")
		expect(license?.commands).toBeNull()
	})

	it("attaches a sibling directory's commands to the command of the same name", async () => {
		scratch = await temporaryDirectory("mailwoman-cli-schema-")
		await makeDirectories(scratch.path("corpus"))
		await writeLocalTextFile(commandModule("corpus"), scratch.path("corpus.mjs"))
		await writeLocalTextFile(commandModule("build"), scratch.path("corpus", "build.mjs"))
		await writeLocalTextFile(HELPER_MODULE, scratch.path("corpus", "shared.mjs"))

		const commands = await readCommands(scratch.path)
		const corpus = commands.get("corpus")

		expect([...commands.keys()]).toEqual(["corpus"])
		expect(corpus?.spec?.name).toBe("corpus")
		expect(corpus?.component).toBeTypeOf("function")
		expect([...(corpus?.commands?.keys() ?? [])]).toEqual(["build"])
	})

	it("ignores a directory that declares no command", async () => {
		scratch = await temporaryDirectory("mailwoman-cli-schema-")
		await makeDirectories(scratch.path("shared"))
		await writeLocalTextFile(HELPER_MODULE, scratch.path("shared", "format.mjs"))
		await writeLocalTextFile(commandModule("parse"), scratch.path("parse.mjs"))

		const commands = await readCommands(scratch.path)

		expect([...commands.keys()]).toEqual(["parse"])
	})

	it("lists commands in name order", async () => {
		scratch = await temporaryDirectory("mailwoman-cli-schema-")
		await makeDirectories(scratch.path("wof"))
		await writeLocalTextFile(commandModule("serve"), scratch.path("serve.mjs"))
		await writeLocalTextFile(commandModule("parse"), scratch.path("parse.mjs"))
		await writeLocalTextFile(commandModule("wof-build"), scratch.path("wof", "build.mjs"))

		const commands = await readCommands(scratch.path)

		expect([...commands.keys()]).toEqual(["parse", "serve", "wof-build"])
	})
})
