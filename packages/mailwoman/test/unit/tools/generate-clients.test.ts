import { pathExists } from "@mailwoman/core/fs/readers"
import {
	CLIENT_SURFACES,
	pythonInitPy,
	pythonPyproject,
	rustCargoToml,
	rustLibRs,
} from "mailwoman/tools/generate-clients"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cheap unit coverage for `generate-clients.ts`'s pure logic ONLY — the surface list + the
 *   template-string builders (pyproject.toml, `__init__.py`, Cargo.toml, `lib.rs`). The pipeline
 *   itself (`generateClients`) is spawn-heavy end to end (node CLIs, `uvx`, `uv build`, `cargo
 *   check`) — that's covered by an actual local run and by the client-generation CI job, not
 *   re-simulated here with mocks. What IS worth pinning cheaply:
 *   that the four-surface list stays in sync, and that the generated file templates actually
 *   interpolate the version and name every module — a typo here (e.g. forgetting the `mailwoman`
 *   module in `lib.rs`) would silently ship a three-surface client.
 */
import { expect, test } from "vitest"

test("CLIENT_SURFACES is the fixed four-surface set (three drop-ins + the native mailwoman module)", () => {
	expect(CLIENT_SURFACES).toEqual(["photon", "nominatim", "libpostal", "mailwoman"])
})

test("pythonPyproject interpolates the given version and names the mailwoman-client package", () => {
	const toml = pythonPyproject("5.10.1")

	expect(toml).toContain('name = "mailwoman-client"')
	expect(toml).toContain('version = "5.10.1"')

	// The four generated subpackages must all be carved out of the ruff pass — a missed entry here
	// means ruff lints/reformats GENERATED code as if it were hand-maintained.
	for (const surface of CLIENT_SURFACES) {
		expect(toml).toContain(`mailwoman_client/${surface}`)
	}
})

test("pythonInitPy defines an ergonomics class for every surface", () => {
	const source = pythonInitPy()

	expect(source).toContain("class PhotonClient(_PhotonBase):")
	expect(source).toContain("class NominatimClient(_NominatimBase):")
	expect(source).toContain("class LibpostalClient(_LibpostalBase):")
	expect(source).toContain("class MailwomanClient(_MailwomanBase):")
	expect(source).toContain('DEFAULT_BASE_URL = "http://127.0.0.1:3000"') // mailwoman serve's default port
})

test("rustCargoToml interpolates the given version and names the mailwoman-client crate", () => {
	const toml = rustCargoToml("5.10.1")

	expect(toml).toContain('name = "mailwoman-client"')
	expect(toml).toContain('version = "5.10.1"')
	expect(toml).toContain('progenitor = "0.14"')
})

test("rustLibRs declares a generate_api! module + a *_local() constructor for every surface", () => {
	const source = rustLibRs()

	for (const surface of CLIENT_SURFACES) {
		expect(source).toContain(`pub mod ${surface} {`)
		expect(source).toContain(`progenitor::generate_api!("openapi/${surface}.json");`)
	}

	// mailwoman has no hosted trial (self-host only, unlike photon) — local() only, no hosted().
	expect(source).toContain("pub fn mailwoman_local() -> mailwoman::Client {")
	expect(source).not.toContain("mailwoman_hosted")
})

test("emitterCLIPath resolves every surface inside its real workspace, from repository root", async () => {
	const { sep } = await import("path-ts")
	const { dirname, join } = await import("path-ts")
	const { emitterCLIPath } = await import("mailwoman/tools/generate-clients")

	for (const surface of CLIENT_SURFACES) {
		const cli = emitterCLIPath(surface)
		const expectedTail = join("packages", surface, "out", "cli.js")
		const manifest = join(dirname(dirname(cli)), "package.json")

		// The compiled entry lives under packages/<workspace>/out/ — the shape the 2026-08-14 regroup
		// established. The pre-regroup resolution treated the workspace name as a repo-root segment,
		// so a clean successful compile still read every emitter as missing.
		expect(cli.split(sep)).toContain("packages")
		expect(cli.endsWith(expectedTail)).toBe(true)

		// Tie the resolution to the real tree: the workspace directory the path claims must exist,
		// so the NEXT layout move fails here loudly instead of inside a red release job.
		expect(await pathExists(manifest)).toBe(true)
	}
})
