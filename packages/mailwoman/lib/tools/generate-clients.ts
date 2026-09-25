import { pathExists } from "@mailwoman/core/fs/readers"
import {
	copyFileTo,
	makeDirectories,
	removePathIfPresent,
	writeLocalFile,
	writeLocalTextFile,
} from "@mailwoman/core/fs/writers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { workspacePath, repoRootPathBuilder } from "@mailwoman/core/paths"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import type { Check } from "#cli-kit"
import { readMailwomanVersion } from "#cli/kit/metadata"
import { runProcessOrFail } from "#cli/kit/shared"

/**
 * The HTTP surfaces that each get an emitted OpenAPI spec and a generated Python and Rust client.
 */
export const CLIENT_SURFACES = ["photon", "nominatim", "libpostal", "mailwoman"] as const

type ClientSurface = (typeof CLIENT_SURFACES)[number]

const FLAVORS = ["3.1", "3.0"] as const

/**
 * Resolves a surface's compiled CLI entry point from its `package.json` `bin`,
 * which is the OpenAPI emitter this pipeline runs.
 *
 * Reading `bin` rather than a literal emit path keeps it correct when a workspace's build layout moves.
 */
export async function emitterCLIPath(surface: ClientSurface): Promise<string> {
	const { bin } = await readPackageJSON<{ bin?: string | Record<string, string> }>(
		workspacePath(surface, "package.json")
	)

	const entry = typeof bin === "string" ? bin : bin?.[surface]

	if (!entry) {
		throw new Error(`${surface}: package.json declares no \`bin\` for the OpenAPI emitter to run`)
	}

	return workspacePath(surface, entry)
}

const LICENSE_FILENAMES = ["LICENSE.md", "COMMERCIAL-LICENSE.md"] as const

async function copyLicenseFiles(destDir: PathBuilder): Promise<void> {
	for (const filename of LICENSE_FILENAMES) {
		await copyFileTo(repoRootPathBuilder(filename), destDir(filename))
	}
}

interface SpecPaths {
	v31: Record<ClientSurface, string>
	v30: Record<ClientSurface, string>
}

interface GenerateClientsReceipt {
	version: string
	outDir: string
	specsDir: string
	pythonDir: string
	rustDir: string
	specs: SpecPaths | null
	pythonWheel: string | null
	pythonSdist: string | null
	elapsedSeconds: number
}

/**
 * Options for {@link generateClients}; `outDir` defaults to `clients-build/` at the
 * repo root, and `skipVerify` skips the Python and Rust build checks.
 */
export interface GenerateClientsOptions {
	/**
	 * The output root, which defaults to the gitignored `clients-build/` at the repo root.
	 */
	outDir?: PathBuilderLike

	/**
	 * Whether to skip the Python and Rust build checks, which makes the output unfit as a release proof.
	 */
	skipVerify?: boolean
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * The outcome of {@link generateClients}: one check per pipeline step, stopping at
 * the first failure, plus a receipt of what was written.
 */
export interface GenerateClientsResult {
	ok: boolean
	checks: Check[]
	receipt: GenerateClientsReceipt
}

function fail(message: string): never {
	throw new Error(message)
}

function run(cmd: string, args: string[], options: { cwd?: PathBuilderLike } = {}): void {
	runProcessOrFail(cmd, args, { ...options, echo: true })
}

async function checkCompiled(): Promise<void> {
	const missing: string[] = []

	for (const surface of CLIENT_SURFACES) {
		if (!(await pathExists(await emitterCLIPath(surface)))) {
			missing.push(surface)
		}
	}

	if (missing.length) {
		fail(
			`compiled emitter missing for: ${missing.join(", ")} — run \`yarn compile\` first (client generation reads the compiled openapi emitters rather than source)`
		)
	}
}

async function emitSpecs(specsDir: PathBuilder, phase: (p: string, d?: string) => void): Promise<SpecPaths> {
	await makeDirectories(specsDir)

	const v31 = {} as Record<ClientSurface, string>
	const v30 = {} as Record<ClientSurface, string>

	for (const surface of CLIENT_SURFACES) {
		const cli = await emitterCLIPath(surface)

		for (const flavor of FLAVORS) {
			const out = specsDir(`${surface}-${flavor}.json`).toString()

			phase("emit-spec", `${surface} ${flavor} → ${out}`)

			run("node", [cli, "openapi", "--flavor", flavor, "--out", out])
			;(flavor === "3.1" ? v31 : v30)[surface] = out
		}
	}

	return { v31, v30 }
}

async function generatePythonModules(
	specPaths: SpecPaths,
	pythonDir: PathBuilder,
	phase: (p: string, d?: string) => void
): Promise<void> {
	const packageDir = pythonDir("mailwoman_client")
	await makeDirectories(packageDir)

	for (const surface of CLIENT_SURFACES) {
		phase("python-generate", surface)

		run("uvx", [
			"openapi-python-client@0.29",
			"generate",
			"--path",
			specPaths.v31[surface],
			"--meta",
			"none",
			"--output-path",
			packageDir(surface).toString(),
			"--overwrite",
		])
	}

	for (const surface of CLIENT_SURFACES) {
		await removePathIfPresent(packageDir(surface, ".ruff_cache"))
	}
}

/**
 * Renders the `pyproject.toml` for the `mailwoman-client` Python package at `version`.
 */
export function pythonPyproject(version: string): string {
	return `[project]
name = "mailwoman-client"
version = "${version}"
description = "Typed Python clients for Mailwoman's Photon / Nominatim / libpostal drop-in geocoding APIs and native /v1/* surface, generated from their OpenAPI specs."
readme = "README.md"
# A plain spdx expression string rather than the { text = "…" } table — setuptools >= 77 deprecates the
# table form (a build-time warning that would otherwise show up in every receipt).
license = "AGPL-3.0-only OR LicenseRef-Commercial"
# Explicit PEP 639 \`license-files\` (setuptools' default \`licen[CS]E*\` glob only catches LICENSE.md rather than commercial-LICENSE.md — the "LicenseRef-Commercial" half of the spdx expression above would ship
# unreferenced without this). Both files are copied into this package root by copyLicenseFiles() during
# assembly; setuptools stages them under the wheel's dist-info/licenses/ and the sdist root.
license-files = ["LICENSE.md", "COMMERCIAL-LICENSE.md"]
requires-python = ">=3.10"
authors = [{ name = "Sister Software", email = "contact@sister.software" }]
keywords = ["geocoding", "photon", "nominatim", "libpostal", "openapi", "mailwoman", "address"]

# The generated code (mailwoman_client/{photon,nominatim,libpostal,mailwoman}) needs only httpx (the
# transport) + attrs (the models). Pins mirror openapi-python-client's own runtime floor.
dependencies = ["httpx>=0.23,<0.29", "attrs>=22.2.0"]

classifiers = [
	"Development Status :: 4 - Beta",
	"Intended Audience :: Developers",
	# No "License :: OSI Approved :: …" classifier alongside the spdx \`license\` expression above —
	# setuptools >= 77 hard-errors on that combination (PEP 639: license classifiers are superseded
	# by license expressions). The spdx string is the single source of truth.
	"Operating System :: OS Independent",
	"Programming Language :: Python :: 3",
	"Programming Language :: Python :: 3.10",
	"Programming Language :: Python :: 3.11",
	"Programming Language :: Python :: 3.12",
	"Programming Language :: Python :: 3.13",
	"Topic :: Scientific/Engineering :: GIS",
	"Topic :: Software Development :: Libraries :: Python Modules",
	"Typing :: Typed",
]

[project.urls]
Homepage = "https://mailwoman.ai"
Documentation = "https://mailwoman.ai/docs"
Repository = "https://github.com/sister-software/mailwoman"
Issues = "https://github.com/sister-software/mailwoman/issues"

[project.optional-dependencies]
dev = ["pytest>=7.0", "ruff==0.15.20"]

[build-system]
# >=77: the first release with PEP 639 \`license-files\` + the plain-string spdx \`license\` expression
# above stabilized (pre-77 either ignores license-files or warns on the spdx string form).
requires = ["setuptools>=77", "wheel"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["mailwoman_client*"]

[tool.setuptools.package-data]
# Ship the PEP 561 marker so consumers' type-checkers see the generated types.
mailwoman_client = ["py.typed"]

# Ruff — the Python analog of the repo's oxlint + oxfmt setup.
[tool.ruff]
line-length = 120
target-version = "py310"
src = ["mailwoman_client"]
# The four drop-in subpackages are generated verbatim by openapi-python-client (which runs its own
# ruff pass) and are overwritten on regen — don't lint/format them as hand-maintained code.
extend-exclude = [
	"mailwoman_client/photon",
	"mailwoman_client/nominatim",
	"mailwoman_client/libpostal",
	"mailwoman_client/mailwoman",
]

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]
ignore = ["E501"]

[tool.ruff.format]
docstring-code-format = true
`
}

/**
 * Renders the hand-written `mailwoman_client/__init__.py`, which wraps each generated
 * subpackage in a client class with a default `base_url`.
 */
export function pythonInitPy(): string {
	return `"""mailwoman-client — typed Python clients for Mailwoman's drop-in geocoding APIs + the native /v1/* surface.

Mailwoman ships three HTTP drop-ins — a Photon-compatible autocomplete API, a Nominatim-compatible
geocoding API, and a libpostal-compatible parse/expand API — plus its own native \`/v1/*\` surface
(\`mailwoman serve\`). This package bundles a typed client for each, **generated from their published
OpenAPI specs** with \`openapi-python-client\`, under one distributable (\`mailwoman_client.photon\`,
\`mailwoman_client.nominatim\`, \`mailwoman_client.libpostal\`, \`mailwoman_client.mailwoman\`).

The four subpackages are generated verbatim — do not hand-edit them (they are overwritten on regen;
see \`mailwoman clients generate\`). Everything in this module is the thin, hand-written ergonomics
layer over that generated code: friendly client classes with a sensible default \`base_url\`.

Quick start against the hosted Photon trial endpoint, which needs no local server:

    from mailwoman_client import PhotonClient
    from mailwoman_client.photon.api.geocoding import search

    client = PhotonClient.hosted()          # https://photon.mailwoman.ai
    fc = search.sync(client=client, q="berlin", limit=3)
    for feature in fc.features:
        print(feature.properties.name, feature.geometry.coordinates)

Self-hosting (\`npx @mailwoman/photon serve\`, or \`mailwoman serve\` for the native surface)? Every
client defaults to its local \`serve\` port, so \`PhotonClient()\` / \`NominatimClient()\` /
\`LibpostalClient()\` / \`MailwomanClient()\` just work against a localhost server. Point elsewhere with
\`base_url="http://…"\`.
"""

from .libpostal.client import Client as _LibpostalBase
from .mailwoman.client import Client as _MailwomanBase
from .nominatim.client import Client as _NominatimBase
from .photon.client import Client as _PhotonBase

__all__ = (
    "PhotonClient",
    "NominatimClient",
    "LibpostalClient",
    "MailwomanClient",
    "PHOTON_HOSTED_BASE_URL",
)

#: The hosted public Photon trial endpoint (conservative rate limits). Only Photon has a hosted
#: trial; the other three surfaces are self-host only.
PHOTON_HOSTED_BASE_URL = "https://photon.mailwoman.ai"

class PhotonClient(_PhotonBase):
    """Client for the Photon-compatible autocomplete / reverse geocoding API (\`/api\`, \`/reverse\`).

    Defaults to the local \`npx @mailwoman/photon serve\` port (2322). Use :meth:\`hosted\` for the
    public trial endpoint, or pass \`base_url=\` for anything else. Call it with the generated
    endpoint functions, e.g. \`mailwoman_client.photon.api.geocoding.search.sync(client=client, q=…)\`.
    """

    DEFAULT_BASE_URL = "http://127.0.0.1:2322"

    def __init__(self, base_url: str | None = None, **kwargs) -> None:
        super().__init__(base_url=base_url or self.DEFAULT_BASE_URL, **kwargs)

    @classmethod
    def hosted(cls, **kwargs) -> "PhotonClient":
        """Return a client pointed at the hosted public trial endpoint (:data:\`PHOTON_HOSTED_BASE_URL\`)."""
        return cls(base_url=PHOTON_HOSTED_BASE_URL, **kwargs)

class NominatimClient(_NominatimBase):
    """Client for the Nominatim-compatible geocoding API (\`/search\`, \`/reverse\`, \`/lookup\`, \`/status\`).

    Defaults to the local \`npx @mailwoman/nominatim serve\` port (8080). Pass \`base_url=\` to point
    elsewhere. Self-host only — there is no hosted public endpoint.
    """

    DEFAULT_BASE_URL = "http://127.0.0.1:8080"

    def __init__(self, base_url: str | None = None, **kwargs) -> None:
        super().__init__(base_url=base_url or self.DEFAULT_BASE_URL, **kwargs)

class LibpostalClient(_LibpostalBase):
    """Client for the libpostal-compatible parse / expand API (\`/parse\`, \`/expand\`).

    Defaults to the local \`npx @mailwoman/libpostal serve\` port (8081). Pass \`base_url=\` to point
    elsewhere. Self-host only — there is no hosted public endpoint.
    """

    DEFAULT_BASE_URL = "http://127.0.0.1:8081"

    def __init__(self, base_url: str | None = None, **kwargs) -> None:
        super().__init__(base_url=base_url or self.DEFAULT_BASE_URL, **kwargs)

class MailwomanClient(_MailwomanBase):
    """Client for the native Mailwoman \`/v1/*\` surface (\`/v1/parse\`, \`/v1/geocode\`, \`/v1/batch\`,
    \`/v1/resolve\`, \`/v1/format\`).

    Defaults to the local \`mailwoman serve\` port (3000). Pass \`base_url=\` to point elsewhere.
    Self-host only — there is no hosted public endpoint.
    """

    DEFAULT_BASE_URL = "http://127.0.0.1:3000"

    def __init__(self, base_url: str | None = None, **kwargs) -> None:
        super().__init__(base_url=base_url or self.DEFAULT_BASE_URL, **kwargs)
`
}

function pythonReadme(): string {
	const lines = [
		"# mailwoman-client (Python)",
		"",
		"Typed Python clients for [Mailwoman](https://mailwoman.ai)'s HTTP surfaces —",
		"**generated from their published OpenAPI specs** and bundled under one distributable:",
		"",
		"| Subpackage                   | Surface           | Endpoints                                                            |",
		"| ----------------------------- | ------------------ | --------------------------------------------------------------------------- |",
		"| `mailwoman_client.photon`    | Photon drop-in    | `/api`, `/reverse`                                                   |",
		"| `mailwoman_client.nominatim` | Nominatim drop-in | `/search`, `/reverse`, `/lookup`, `/status`                          |",
		"| `mailwoman_client.libpostal` | libpostal drop-in | `/parse`, `/expand`                                                  |",
		"| `mailwoman_client.mailwoman` | Native surface    | `/v1/parse`, `/v1/geocode`, `/v1/batch`, `/v1/resolve`, `/v1/format` |",
		"",
		"The four subpackages are generated verbatim by [`openapi-python-client`](https://github.com/openapi-generators/openapi-python-client)",
		"(it runs its own `ruff` pass) and are **overwritten on regen** — do not hand-edit them. The",
		"only hand-written code is the thin ergonomics layer in `mailwoman_client/__init__.py`:",
		"`PhotonClient` / `NominatimClient` / `LibpostalClient` / `MailwomanClient`, each with a",
		"sensible default `base_url`. Regenerate with `mailwoman clients generate` (see the repo's",
		'`docs/articles/api.mdx` "Client libraries" section) — nothing here is hand-maintained.',
		"",
		"**Not yet published.** This package is built and verified on every `mailwoman clients generate`",
		"run; publishing to PyPI happens from the conditional CI job once the operator provisions a PyPI",
		"account (see the repo's `RELEASING.md`).",
		"",
		"## Install",
		"",
		"```bash",
		"pip install mailwoman-client",
		"```",
		"",
		"Requires Python 3.10+. The only runtime dependencies are `httpx` and `attrs`.",
		"",
		"## Usage",
		"",
		"Forward-geocode against the hosted Photon trial endpoint (`https://photon.mailwoman.ai`), which",
		"needs no local server:",
		"",
		"```python",
		"from mailwoman_client import PhotonClient",
		"from mailwoman_client.photon.api.geocoding import search",
		"",
		'client = PhotonClient.hosted()  # or PhotonClient(base_url="http://127.0.0.1:2322") to self-host',
		'result = search.sync(client=client, q="berlin", limit=3)',
		"",
		"for feature in result.features:",
		"    lon, lat = feature.geometry.coordinates",
		"    props = feature.properties",
		"    print(f\"{props.name} ({props.type_}) — {lat:.4f}, {lon:.4f} [{props.country or '?'}]\")",
		"```",
		"",
		"### Self-hosting",
		"",
		"`PhotonClient()`, `NominatimClient()`, `LibpostalClient()`, and `MailwomanClient()` default to",
		"their local `serve` ports (2322 / 8080 / 8081 / 3000), so they work out of the box against a",
		"self-hosted server (`npx @mailwoman/photon serve`, `mailwoman serve`, etc.). Only Photon has a",
		"hosted public trial endpoint. Point anywhere with `base_url=`.",
		"",
		"### Async",
		"",
		"Every endpoint module also exposes an `asyncio` coroutine alongside `sync`:",
		"",
		"```python",
		'result = await search.asyncio(client=client, q="berlin", limit=3)',
		"```",
		"",
		"## License",
		"",
		"AGPL-3.0-only OR LicenseRef-Commercial (see the [repository](https://github.com/sister-software/mailwoman)).",
		"",
	]

	return lines.join("\n")
}

async function assemblePythonPackage(
	pythonDir: PathBuilder,
	version: string,
	phase: (p: string, d?: string) => void
): Promise<void> {
	phase("python-assemble", pythonDir.toString())
	await writeLocalFile(pythonPyproject(version), pythonDir("pyproject.toml"))
	await writeLocalFile(pythonReadme(), pythonDir("README.md"))
	await writeLocalFile(pythonInitPy(), pythonDir("mailwoman_client", "__init__.py"))
	await writeLocalTextFile("", pythonDir("mailwoman_client", "py.typed"))

	await copyLicenseFiles(pythonDir)
}

async function verifyPython(
	pythonDir: PathBuilder,
	phase: (p: string, d?: string) => void
): Promise<{ wheel: string; sdist: string }> {
	const distDir = pythonDir("dist")

	phase("python-build", pythonDir.toString())
	await removePathIfPresent(distDir)
	run("uv", ["build"], { cwd: pythonDir })

	const entries = (await pathExists(distDir))
		? await Globerator.from("*", { cwd: distDir, absolute: false }).toArray()
		: []

	const wheel = entries.find((f) => f.endsWith(".whl"))
	const sdist = entries.find((f) => f.endsWith(".tar.gz"))

	if (!wheel) {
		fail(`uv build did not produce a .whl under ${distDir}`)
	}

	if (!sdist) {
		fail(`uv build did not produce a .tar.gz under ${distDir}`)
	}

	const wheelPath = distDir(wheel).toString()

	phase("python-import-check", wheelPath)

	run("uv", [
		"run",
		"--no-project",
		"--with",
		wheelPath,
		"python",
		"-c",
		"import mailwoman_client as m; assert all([m.PhotonClient, m.NominatimClient, m.LibpostalClient, m.MailwomanClient]); print('mailwoman_client import OK:', m.__all__)",
	])

	return { wheel: wheelPath, sdist: distDir(sdist).toString() }
}

/**
 * Renders the `Cargo.toml` for the `mailwoman-client` Rust crate at `version`.
 */
export function rustCargoToml(version: string): string {
	return `[package]
name = "mailwoman-client"
version = "${version}"
edition = "2021"
rust-version = "1.82"
description = "Typed Rust clients for Mailwoman's Photon / Nominatim / libpostal drop-in geocoding APIs and native /v1/* surface, generated from their OpenAPI specs."
license = "AGPL-3.0-only OR LicenseRef-Commercial"
repository = "https://github.com/sister-software/mailwoman"
homepage = "https://mailwoman.ai"
documentation = "https://docs.rs/mailwoman-client"
readme = "README.md"
keywords = ["geocoding", "photon", "nominatim", "libpostal", "openapi"]
categories = ["api-bindings", "science::geo"]
# The vendored specs + the src are all that ship; nothing else is needed to build. LICENSE.md +
# commercial-LICENSE.md are copied into the crate root by copyLicenseFiles() during assembly — Cargo's
# packager only ships files this list names, so both must be listed explicitly (the \`license\` field
# above is metadata only; it doesn't embed the referenced text).
include = ["src/**/*", "openapi/*.json", "examples/**/*", "README.md", "LICENSE.md", "COMMERCIAL-LICENSE.md"]

[dependencies]
# progenitor's generate_api! proc-macro synthesizes the client at compile time from the vendored
# spec (the 3.0.3 "diet" flavor — openapiv3 only understands 3.0.x); the generated code calls into
# progenitor::progenitor_client (re-exported by progenitor, so no separate progenitor-client dep).
# reqwest must match the version progenitor 0.14 uses (0.13) — a second reqwest in the graph makes
# the generated client fail to typecheck.
progenitor = "0.14"
# rustls (not native-tls) so the crate builds without a system OpenSSL / pkg-config — portable for
# consumers and CI. default-features=false drops the native-tls default.
reqwest = { version = "0.13", default-features = false, features = ["json", "stream", "rustls"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
futures-core = "0.3"
bytes = "1"

[dev-dependencies]
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
`
}

/**
 * Renders the crate's `src/lib.rs`, which generates one module per surface from
 * its vendored OpenAPI 3.0 spec at compile time.
 */
export function rustLibRs(): string {
	const lines = [
		"//! Typed Rust clients for Mailwoman's four HTTP surfaces — the three drop-in geocoding APIs",
		"//! plus the native `/v1/*` surface `mailwoman serve` ships.",
		"//!",
		"//! Each submodule is generated at compile time by [`progenitor`]'s `generate_api!` proc-macro",
		'//! from the OpenAPI 3.0.3 document (the "diet" flavor — progenitor\'s `openapiv3` dependency',
		"//! only understands 3.0.x) vendored under `openapi/` — nothing here is hand-written except the",
		"//! thin default-`base_url` constructors below. Regenerate with `mailwoman clients generate`;",
		"//! there is no code to hand-edit. See `examples/basic.rs` for a runnable call.",
		"",
		"/// Photon-compatible autocomplete / reverse geocoding client (`/api`, `/reverse`).",
		"pub mod photon {",
		'    progenitor::generate_api!("openapi/photon.json");',
		"}",
		"",
		"/// Nominatim-compatible geocoding client (`/search`, `/reverse`, `/lookup`, `/status`).",
		"pub mod nominatim {",
		'    progenitor::generate_api!("openapi/nominatim.json");',
		"}",
		"",
		"/// libpostal-compatible parse / expand client (`/parse`, `/expand`).",
		"pub mod libpostal {",
		'    progenitor::generate_api!("openapi/libpostal.json");',
		"}",
		"",
		"/// The native Mailwoman client (`/v1/parse`, `/v1/geocode`, `/v1/batch`, `/v1/resolve`, `/v1/format`).",
		"pub mod mailwoman {",
		'    progenitor::generate_api!("openapi/mailwoman.json");',
		"}",
		"",
		"/// The hosted public Photon trial endpoint (conservative rate limits). Only Photon has a",
		"/// hosted trial; the other three surfaces are self-host only.",
		'pub const PHOTON_HOSTED_BASE_URL: &str = "https://photon.mailwoman.ai";',
		"",
		"/// Default local `npx @mailwoman/photon serve` base URL.",
		'pub const PHOTON_LOCAL_BASE_URL: &str = "http://127.0.0.1:2322";',
		"/// Default local `npx @mailwoman/nominatim serve` base URL.",
		'pub const NOMINATIM_LOCAL_BASE_URL: &str = "http://127.0.0.1:8080";',
		"/// Default local `npx @mailwoman/libpostal serve` base URL.",
		'pub const LIBPOSTAL_LOCAL_BASE_URL: &str = "http://127.0.0.1:8081";',
		"/// Default local `mailwoman serve` base URL.",
		'pub const MAILWOMAN_LOCAL_BASE_URL: &str = "http://127.0.0.1:3000";',
		"",
		"/// A Photon client pointed at the hosted public trial endpoint ([`PHOTON_HOSTED_BASE_URL`]).",
		"pub fn photon_hosted() -> photon::Client {",
		"    photon::Client::new(PHOTON_HOSTED_BASE_URL)",
		"}",
		"",
		"/// A Photon client pointed at a local `serve` server ([`PHOTON_LOCAL_BASE_URL`]).",
		"pub fn photon_local() -> photon::Client {",
		"    photon::Client::new(PHOTON_LOCAL_BASE_URL)",
		"}",
		"",
		"/// A Nominatim client pointed at a local `serve` server ([`NOMINATIM_LOCAL_BASE_URL`]).",
		"pub fn nominatim_local() -> nominatim::Client {",
		"    nominatim::Client::new(NOMINATIM_LOCAL_BASE_URL)",
		"}",
		"",
		"/// A libpostal client pointed at a local `serve` server ([`LIBPOSTAL_LOCAL_BASE_URL`]).",
		"pub fn libpostal_local() -> libpostal::Client {",
		"    libpostal::Client::new(LIBPOSTAL_LOCAL_BASE_URL)",
		"}",
		"",
		"/// A Mailwoman client pointed at a local `mailwoman serve` server ([`MAILWOMAN_LOCAL_BASE_URL`]).",
		"pub fn mailwoman_local() -> mailwoman::Client {",
		"    mailwoman::Client::new(MAILWOMAN_LOCAL_BASE_URL)",
		"}",
		"",
	]

	return lines.join("\n")
}

function rustReadme(): string {
	const lines = [
		"# mailwoman-client (Rust)",
		"",
		"Typed Rust clients for [Mailwoman](https://mailwoman.ai)'s HTTP surfaces,",
		"**generated at compile time** by [`progenitor`](https://github.com/oxidecomputer/progenitor)",
		"from their OpenAPI specs, exposed as four modules of one crate:",
		"",
		"| Module                          | Surface           | Endpoints                                                            |",
		"| -------------------------------- | ------------------ | --------------------------------------------------------------------------- |",
		"| `mailwoman_client::photon`      | Photon drop-in    | `/api`, `/reverse`                                                   |",
		"| `mailwoman_client::nominatim`   | Nominatim drop-in | `/search`, `/reverse`, `/lookup`, `/status`                          |",
		"| `mailwoman_client::libpostal`   | libpostal drop-in | `/parse`, `/expand`                                                  |",
		"| `mailwoman_client::mailwoman`   | Native surface    | `/v1/parse`, `/v1/geocode`, `/v1/batch`, `/v1/resolve`, `/v1/format` |",
		"",
		"Each module runs `progenitor::generate_api!` over a vendored spec under `openapi/`. The only",
		"hand-written code is the thin constructor layer in `src/lib.rs` (`photon_hosted()`,",
		"`photon_local()`, `nominatim_local()`, `libpostal_local()`, `mailwoman_local()` — clients",
		"pre-pointed at the hosted trial or the local `serve` ports). Regenerate with",
		"`mailwoman clients generate` — nothing here is hand-maintained.",
		"",
		"**Not yet published.** This crate is assembled and `cargo check`ed on every",
		"`mailwoman clients generate` run; publishing to crates.io happens from the conditional CI job once",
		"the operator provisions a crates.io account (see the repo's `RELEASING.md`).",
		"",
		"> **Note on the spec version.** progenitor parses OpenAPI via the `openapiv3` crate, which",
		"> only understands 3.0.x. Mailwoman's published specs are 3.1; the vendored `openapi/*.json`",
		"> are the 3.0.3 diet each surface's own `openapi --flavor 3.0` emits — not a hand-downgrade.",
		"",
		"## Add it",
		"",
		"```toml",
		"[dependencies]",
		'mailwoman-client = "0"',
		'tokio = { version = "1", features = ["macros", "rt-multi-thread"] }',
		"```",
		"",
		"The transport is `reqwest` with **rustls** (no system OpenSSL). rustls' default crypto provider",
		"is `aws-lc-rs`, which builds a small C library — a C compiler and CMake must be on the build host.",
		"",
		"## Usage",
		"",
		"```rust",
		"use mailwoman_client::photon::types::PhotonResponse;",
		"",
		"#[tokio::main]",
		"async fn main() -> Result<(), Box<dyn std::error::Error>> {",
		"    let client = mailwoman_client::photon_hosted(); // https://photon.mailwoman.ai",
		"",
		"    let response = client",
		'        .search(None, None, None, None, Some(3), None, None, Some("berlin"))',
		"        .await?;",
		"",
		"    if let PhotonResponse::StampedPhotonFeatureCollection(fc) = response.into_inner() {",
		"        for feature in &fc.features {",
		'            println!("{:?}", feature.properties);',
		"        }",
		"    }",
		"    Ok(())",
		"}",
		"```",
		"",
		"`cargo run --example basic` runs exactly this (hits the hosted Photon trial endpoint).",
		"",
		"### Self-hosting",
		"",
		"`photon_local()` / `nominatim_local()` / `libpostal_local()` / `mailwoman_local()` point at the",
		"local `serve` ports (2322 / 8080 / 8081 / 3000). For any other host, construct the module",
		'client directly: `mailwoman_client::nominatim::Client::new("http://…")`. Only Photon has a',
		"hosted public trial endpoint.",
		"",
		"## License",
		"",
		"AGPL-3.0-only OR LicenseRef-Commercial (see the [repository](https://github.com/sister-software/mailwoman)).",
		"",
	]

	return lines.join("\n")
}

function rustExample(): string {
	return `//! Forward-geocode "berlin" against the hosted Photon trial endpoint and print the top 3 hits.
//!
//! Run: \`cargo run --example basic\` (hits https://photon.mailwoman.ai).

use mailwoman_client::photon::types::PhotonResponse;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = mailwoman_client::photon_hosted();

    let response = client
        .search(None, None, None, None, Some(3), None, None, Some("berlin"))
        .await?;

    let features = match response.into_inner() {
        PhotonResponse::StampedPhotonFeatureCollection(fc) => fc.features,
        PhotonResponse::Array(_) => unreachable!("GeoJSON is the default; JSON-LD needs format=jsonld"),
    };

    for feature in &features {
        let coords = &feature.geometry.coordinates; // [lon, lat]
        let props = &feature.properties;
        let name = props.name.as_deref().unwrap_or("?");
        println!("{name} — {:.4}, {:.4}", coords[1], coords[0]);
    }

    Ok(())
}
`
}

async function assembleRustCrate(
	specPaths: SpecPaths,
	rustDir: PathBuilder,
	version: string,
	phase: (p: string, d?: string) => void
): Promise<void> {
	phase("rust-assemble", rustDir.toString())
	const openapiDir = rustDir("openapi")
	await makeDirectories(openapiDir)
	await makeDirectories(rustDir("src"))
	await makeDirectories(rustDir("examples"))

	for (const surface of CLIENT_SURFACES) {
		await copyFileTo(specPaths.v30[surface], openapiDir(`${surface}.json`))
	}

	await writeLocalFile(rustCargoToml(version), rustDir("Cargo.toml"))
	await writeLocalFile(rustLibRs(), rustDir("src", "lib.rs"))
	await writeLocalFile(rustReadme(), rustDir("README.md"))
	await writeLocalFile(rustExample(), rustDir("examples", "basic.rs"))

	await copyLicenseFiles(rustDir)
}

function verifyRust(rustDir: PathBuilder, phase: (p: string, d?: string) => void): void {
	phase("cargo-check", rustDir.toString())
	run("cargo", ["check", "--examples"], { cwd: rustDir })
}

/**
 * Emits every surface's OpenAPI specs, generates and assembles the Python package
 * and Rust crate, then build-checks both unless `skipVerify` is set.
 */
export async function generateClients(opts: GenerateClientsOptions = {}): Promise<GenerateClientsResult> {
	const t0 = performance.now()
	const phase = opts.onPhase ?? (() => {})
	const outDir = PathBuilder.from(opts.outDir ?? repoRootPathBuilder("clients-build"))
	const specsDir = outDir("specs")
	const pythonDir = outDir("python")
	const rustDir = outDir("rust")
	const version = await readMailwomanVersion()

	let specPaths: SpecPaths | null = null
	let pythonWheel: string | null = null
	let pythonSdist: string | null = null

	const steps: Array<{ check: string; run: () => Promise<string | void> }> = [
		{
			check: "compile-check: each surface's declared bin is compiled (mailwoman, libpostal, photon, nominatim)",
			run: async () => {
				await checkCompiled()
			},
		},
		{
			check: "emit 8 specs (4 surfaces × 3.1 + 3.0) → clients-build/specs/",
			run: async () => {
				await removePathIfPresent(outDir)
				await makeDirectories(outDir)
				specPaths = await emitSpecs(specsDir, phase)

				return specsDir.toString()
			},
		},
		{
			check: "python generate ×4 (uvx openapi-python-client@0.29)",
			run: async () => {
				await generatePythonModules(specPaths!, pythonDir, phase)
			},
		},
		{
			check: "assemble python package (pyproject.toml, README.md, __init__.py — salvaged layout)",
			run: async () => {
				await assemblePythonPackage(pythonDir, version, phase)

				return pythonDir.toString()
			},
		},
		{
			check: "assemble rust crate (Cargo.toml, src/lib.rs, vendored 3.0 specs — salvaged layout)",
			run: async () => {
				await assembleRustCrate(specPaths!, rustDir, version, phase)

				return rustDir.toString()
			},
		},
	]

	if (!opts.skipVerify) {
		steps.push(
			{
				check: "python: uv build + import-check wheel",
				run: async () => {
					const built = await verifyPython(pythonDir, phase)
					pythonWheel = built.wheel
					pythonSdist = built.sdist

					return built.wheel
				},
			},
			{
				check: "rust: cargo check --examples",
				run: async () => {
					verifyRust(rustDir, phase)
				},
			}
		)
	}

	const checks: Check[] = []

	for (const step of steps) {
		try {
			const detail = await step.run()
			checks.push({ ok: true, check: step.check, detail: detail || undefined })
		} catch (error) {
			checks.push({ ok: false, check: step.check, detail: error instanceof Error ? error.message : String(error) })

			break
		}
	}

	if (opts.skipVerify) {
		checks.push({ ok: true, check: "verify skipped (--skip-verify)" })
	}

	const receipt: GenerateClientsReceipt = {
		version,
		outDir: outDir.toString(),
		specsDir: specsDir.toString(),
		pythonDir: pythonDir.toString(),
		rustDir: rustDir.toString(),
		specs: specPaths,
		pythonWheel,
		pythonSdist,
		elapsedSeconds: (performance.now() - t0) / 1000,
	}

	return { ok: checks.every((c) => c.ok), checks, receipt }
}
