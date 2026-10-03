import { beforeEach, describe, expect, it, vi } from "vitest"

import type { RepoContext } from "#check"

const mocks = vi.hoisted(() => ({ resolveCommand: vi.fn(), run: vi.fn() }))

vi.mock("@mailwoman/core/module/package-command", () => ({ resolvePackageCommand: mocks.resolveCommand }))
vi.mock("@mailwoman/core/process", async (importOriginal) => ({
	...(await importOriginal<typeof import("@mailwoman/core/process")>()),
	runFile: mocks.run,
}))

const context: RepoContext = {
	repoRoot: "/checkout with spaces",
	trackedFiles: ["packages/a/tsconfig.test.json"],
}

beforeEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
	mocks.resolveCommand.mockReset().mockResolvedValue({ file: process.execPath, argv: ["/nested compiler/bin/tsc"] })
	mocks.run.mockReset().mockResolvedValue({ stdout: "", stderr: "" })
})

describe("typecheckTestsCheck", () => {
	it("resolves the compiler from the target checkout and passes paths as individual arguments", async () => {
		const { typecheckTestsCheck } = await import("#checks/typecheck-tests")

		expect(await typecheckTestsCheck.run(context)).toEqual([])
		expect(mocks.resolveCommand).toHaveBeenCalledWith(
			"file:///checkout%20with%20spaces/package.json",
			"@typescript/native",
			"tsc"
		)
		expect(mocks.run).toHaveBeenCalledWith(
			process.execPath,
			["/nested compiler/bin/tsc", "-p", "packages/a/tsconfig.test.json", "--noEmit", "--pretty", "false"],
			{ cwd: context.repoRoot }
		)
	})

	it("reports a compiler-resolution failure before attempting to launch it", async () => {
		mocks.resolveCommand.mockRejectedValue(new Error("compiler package missing"))
		const { typecheckTestsCheck } = await import("#checks/typecheck-tests")
		const diagnostics = await typecheckTestsCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]).toMatchObject({ severity: "error", file: "package.json" })
		expect(diagnostics[0]?.message).toContain("compiler package missing")
		expect(mocks.run).not.toHaveBeenCalled()
	})

	it("reports launch failures even when stdout and stderr are empty", async () => {
		mocks.run.mockRejectedValue(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT", stdout: "", stderr: "" }))
		const { typecheckTestsCheck } = await import("#checks/typecheck-tests")
		const diagnostics = await typecheckTestsCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toContain("spawn ENOENT")
		expect(diagnostics[0]?.severity).toBe("error")
	})

	it("reports TypeScript diagnostics written to stderr", async () => {
		const line = "value.ts(1,1): error TS2322: Type mismatch."

		mocks.run.mockRejectedValue(Object.assign(new Error("exit 2"), { code: 2, stdout: "", stderr: line }))
		const { typecheckTestsCheck } = await import("#checks/typecheck-tests")

		expect(await typecheckTestsCheck.run(context)).toEqual([{ severity: "error", message: line, file: "packages/a" }])
	})

	it("reports nonzero exits without TypeScript diagnostics and preserves stderr", async () => {
		mocks.run.mockRejectedValue(
			Object.assign(new Error("exit 1"), { code: 1, stdout: "", stderr: "launcher could not load TypeScript" })
		)
		const { typecheckTestsCheck } = await import("#checks/typecheck-tests")
		const diagnostics = await typecheckTestsCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.details).toEqual(["launcher could not load TypeScript"])
	})

	it("reports interrupted processes even when they emitted a TypeScript diagnostic", async () => {
		mocks.run.mockRejectedValue(
			Object.assign(new Error("terminated"), {
				code: null,
				signal: "SIGTERM",
				stdout: "error TS1000: partial output",
				stderr: "",
			})
		)
		const { typecheckTestsCheck } = await import("#checks/typecheck-tests")
		const diagnostics = await typecheckTestsCheck.run(context)

		expect(diagnostics).toHaveLength(2)
		expect(diagnostics[1]?.message).toContain("terminated")
	})
})
