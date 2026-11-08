/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Each case builds a project directory with its own `package.json`, so the search for the nearest project
 *   stops there rather than at a checkout above the temporary root.
 */

import { type TemporaryDirectory, temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { afterEach, describe, expect, test, vi } from "vitest"

import { pathListDelimiter, resolveMailwomanCommand } from "#cli/kit/invocation"

interface ProjectShape {
	lockfile?: string
	installed?: boolean
}

async function project(root: TemporaryDirectory, shape: ProjectShape) {
	const directory = root.path("project").toString()

	await makeDirectories(root.path("project", "sub"))
	await writeLocalTextFile("{}", root.path("project", "package.json"))

	if (shape.lockfile) {
		await writeLocalTextFile("", root.path("project", shape.lockfile))
	}

	if (shape.installed) {
		await makeDirectories(root.path("project", "node_modules", ".bin"))
		await writeLocalTextFile("", root.path("project", "node_modules", ".bin", "mailwoman"))
	}

	return directory
}

describe("resolveMailwomanCommand", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	test("answers npx when npx started the process, although npx put its bin on PATH", async () => {
		await using root = await temporaryDirectory()
		const cwd = await project(root, {})

		await makeDirectories(root.path("npx-cache"))
		await writeLocalTextFile("", root.path("npx-cache", "mailwoman"))
		vi.stubEnv("PATH", root.path("npx-cache").toString())
		vi.stubEnv("npm_config_user_agent", "npm/10.8.0 node/v22.11.0 darwin arm64 workspaces/false")

		await expect(resolveMailwomanCommand(cwd)).resolves.toBe("npx mailwoman")
	})

	test("answers the runner's prefix when that runner started the process in a project that installs the package", async () => {
		await using root = await temporaryDirectory()
		const cwd = await project(root, { lockfile: "yarn.lock", installed: true })

		vi.stubEnv("PATH", "")
		vi.stubEnv("npm_config_user_agent", "yarn/4.5.0 npm/? node/v22.11.0 linux x64")

		await expect(resolveMailwomanCommand(`${cwd}/sub`)).resolves.toBe("yarn mailwoman")
	})

	test("answers mailwoman when a mailwoman executable is on PATH and no runner started the process", async () => {
		await using root = await temporaryDirectory()
		const cwd = await project(root, {})

		await makeDirectories(root.path("bin"))
		await writeLocalTextFile("", root.path("bin", "mailwoman"))
		vi.stubEnv("PATH", root.path("bin").toString())
		vi.stubEnv("npm_config_user_agent", "")

		await expect(resolveMailwomanCommand(cwd)).resolves.toBe("mailwoman")
	})

	test("passes over a PATH entry that names a file, as a shell does", async () => {
		await using root = await temporaryDirectory()
		const cwd = await project(root, {})

		await makeDirectories(root.path("bin"))
		await writeLocalTextFile("", root.path("env"))
		await writeLocalTextFile("", root.path("bin", "mailwoman"))
		vi.stubEnv("PATH", [root.path("env").toString(), root.path("bin").toString()].join(pathListDelimiter()))
		vi.stubEnv("npm_config_user_agent", "")

		await expect(resolveMailwomanCommand(cwd)).resolves.toBe("mailwoman")
	})

	test("reads the nearest project's lockfile when neither PATH nor a runner decides", async () => {
		await using root = await temporaryDirectory()
		const cwd = await project(root, { lockfile: "pnpm-lock.yaml", installed: true })

		vi.stubEnv("PATH", "")
		vi.stubEnv("npm_config_user_agent", "")

		await expect(resolveMailwomanCommand(cwd)).resolves.toBe("pnpm exec mailwoman")
	})

	test("answers npx for a project that does not install the package", async () => {
		await using root = await temporaryDirectory()
		const cwd = await project(root, { lockfile: "yarn.lock" })

		vi.stubEnv("PATH", "")
		vi.stubEnv("npm_config_user_agent", "")

		await expect(resolveMailwomanCommand(cwd)).resolves.toBe("npx mailwoman")
	})
})
