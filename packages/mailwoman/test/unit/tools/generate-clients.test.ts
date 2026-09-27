import { pathExists } from "@mailwoman/core/fs/readers"
import {
	CLIENT_SURFACES,
	pythonInitPy,
	pythonPyproject,
	rustCargoToml,
	rustLibRs,
} from "mailwoman/tools/generate-clients"
import { expect, test } from "vitest"

test("CLIENT_SURFACES is the fixed four-surface set (three drop-ins + the native mailwoman module)", () => {
	expect(CLIENT_SURFACES).toEqual(["photon", "nominatim", "libpostal", "mailwoman"])
})

test("pythonPyproject interpolates the given version and names the mailwoman-client package", () => {
	const toml = pythonPyproject("5.10.1")

	expect(toml).toContain('name = "mailwoman-client"')
	expect(toml).toContain('version = "5.10.1"')

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
	expect(source).toContain('DEFAULT_BASE_URL = "http://127.0.0.1:3000"')
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

	expect(source).toContain("pub fn mailwoman_local() -> mailwoman::Client {")
	expect(source).not.toContain("mailwoman_hosted")
})

test("emitterCLIPath resolves every surface to the compiled bin its manifest declares", async () => {
	const { sep } = await import("path-ts")
	const { emitterCLIPath } = await import("mailwoman/tools/generate-clients")

	for (const surface of CLIENT_SURFACES) {
		const cli = await emitterCLIPath(surface)

		expect(cli.split(sep)).toContain("packages")
		expect(cli.split(sep)).toContain(surface)

		expect(await pathExists(cli), `${surface}: ${cli} does not exist — run \`yarn compile\``).toBe(true)
	}
})
