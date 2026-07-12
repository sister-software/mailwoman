/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The client-generation pipeline behind `mailwoman clients generate`: emit all four surfaces'
 *   OpenAPI documents (both flavors), generate a Python package and a Rust crate from them, then
 *   VERIFY both actually build. Everything is one-directional and local — nothing generated here is
 *   committed; `clients-build/` is gitignored. This is the local proof the gated CI job (Phase 5 Task
 *   4) replays on dispatch.
 *
 *   Salvaged from the superseded `origin/feat/api-clients` branch (unmerged, left in place; see
 *   `docs/articles/api.mdx` "Client libraries"): the package/crate name (`mailwoman-client` on both
 *   PyPI and crates.io), the Python module layout (`mailwoman_client.{photon,nominatim,libpostal}`,
 *   now with a fourth `mailwoman` module for the native `/v1/*` surface), and the Rust crate pattern
 *   (progenitor `generate_api!` per vendored spec + thin `*_local()`/`*_hosted()` constructors in
 *   `src/lib.rs`). What's NEW here: specs come from the emitters (`mailwoman openapi`,
 *   `mailwoman-{photon,nominatim,libpostal} openapi`), not a checked-in `openapi.yaml`; the Rust
 *   vendor step reads the emitter's own `--flavor 3.0` diet instead of the old `downgrade-spec.py`
 *   down-convert (openapiv3, which progenitor depends on, only understands 3.0.x); and the client
 *   version syncs to `mailwoman/package.json` (the salvaged `PUBLISHING.md` versioned the clients
 *   independently of the npm workspaces — this pipeline ties them together instead, since all four
 *   `@mailwoman/*` surface packages already release in lockstep at the same version).
 *
 *   Phase order (each step's failure aborts the rest — later phases consume earlier artifacts):
 *   compile-check → emit 8 specs → python generate ×4 → assemble python package → assemble rust
 *   crate → (unless `skipVerify`) `uv build` + wheel import-check → `cargo check --examples`.
 *   `--examples` is deliberately stronger than the bare `cargo check` the task asked for: the
 *   salvaged `examples/basic.rs` had drifted against the current spec (a prior progenitor run
 *   synthesized a `SearchQ` newtype + `NonZeroU64` limit that no longer exist — the current spec's
 *   `q`/`limit` are unconstrained, so progenitor now emits plain `Option<&str>`/`Option<i64>`); folding
 *   `--examples` into the receipted verify step means that class of drift fails the gate instead of
 *   rotting silently in a file nobody compiles.
 */

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { childEnv } from "@mailwoman/core/scripting/utils"
import { repoRootPath } from "@mailwoman/core/utils"

import type { Check } from "../cli-kit/index.ts"

/**
 * The four surfaces every emitter + generated client covers. Order matches the salvaged README's table, mailwoman last
 * (the new fourth module).
 */
export const CLIENT_SURFACES = ["photon", "nominatim", "libpostal", "mailwoman"] as const
export type ClientSurface = (typeof CLIENT_SURFACES)[number]

/**
 * OpenAPI flavors the emitters print. 3.1 is the published document; 3.0 is progenitor's diet (openapiv3 only
 * understands 3.0.x).
 */
const FLAVORS = ["3.1", "3.0"] as const
type Flavor = (typeof FLAVORS)[number]

/** Every surface's compiled CLI entry point, relative to the repo root — the emitters this pipeline shells out to. */
function emitterCLIPath(surface: ClientSurface): string {
	return repoRootPath(surface, "out", "cli.js")
}

/**
 * The two repo-root license files (verified present: `LICENSE.md` — AGPL-3.0-only + a Commercial-License pointer — and
 * `COMMERCIAL-LICENSE.md` — the full commercial agreement text) that every generated package's SPDX expression
 * (`AGPL-3.0-only OR LicenseRef-Commercial`) references. Both artifacts must carry both files verbatim: an AGPL
 * conveyance requires the license text to travel with the source, and `LicenseRef-Commercial` is meaningless without
 * the referenced text alongside it.
 */
const LICENSE_FILENAMES = ["LICENSE.md", "COMMERCIAL-LICENSE.md"] as const

/** Copy the repo-root license files into `destDir` (a package/crate root) — shared by the Python + Rust assembly steps. */
function copyLicenseFiles(destDir: string): void {
	for (const filename of LICENSE_FILENAMES) {
		copyFileSync(repoRootPath(filename), join(destDir, filename))
	}
}

/** Absolute paths to each surface's emitted document, per flavor. */
export interface SpecPaths {
	v31: Record<ClientSurface, string>
	v30: Record<ClientSurface, string>
}

/** Everything a completed (or partially completed, on early abort) run produced. */
export interface GenerateClientsReceipt {
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

export interface GenerateClientsOptions {
	/** Output root. Default `<repo>/clients-build` (gitignored). */
	outDir?: string
	/**
	 * Skip `uv build`/import-check + `cargo check --examples` (dev only — an unverified pipeline must never be trusted as
	 * a release proof).
	 */
	skipVerify?: boolean
	onPhase?: (phase: string, detail?: string) => void
}

export interface GenerateClientsResult {
	ok: boolean
	checks: Check[]
	receipt: GenerateClientsReceipt
}

/**
 * A guidance-grade failure — caught by the per-step try/catch below, so only its `message` (not the stack) surfaces in
 * the check list.
 */
function fail(message: string): never {
	throw new Error(message)
}

/**
 * Run a child process with inherited stdio (the `publish-hf.ts` convention — the child's own output IS the progress
 * log) and throw on nonzero exit or a launch failure (e.g. the binary isn't installed).
 */
function run(cmd: string, args: string[], options: { cwd?: string } = {}): void {
	console.error(`  $ ${cmd} ${args.join(" ")}${options.cwd ? `  (in ${options.cwd})` : ""}`)
	const r = spawnSync(cmd, args, { stdio: "inherit", env: childEnv(), cwd: options.cwd })

	if (r.error) {
		fail(`${cmd} ${args.join(" ")} → failed to launch: ${r.error.message}`)
	}

	if (r.status !== 0) {
		fail(`${cmd} ${args.join(" ")} → exit ${r.status}`)
	}
}

/**
 * The version every generated client syncs to — `mailwoman/package.json`, the same version the four surface packages
 * (`api`, `libpostal`, `photon`, `nominatim`) already release at in lockstep.
 */
function readMailwomanVersion(): string {
	const pkg = JSON.parse(readFileSync(repoRootPath("mailwoman", "package.json"), "utf8")) as { version: string }

	return pkg.version
}

/**
 * Verify each emitter's compiled CLI exists — the emitters run compiled (route-table introspection over a stub engine),
 * not from source.
 */
function checkCompiled(): void {
	const missing = CLIENT_SURFACES.filter((surface) => !existsSync(emitterCLIPath(surface)))

	if (missing.length > 0) {
		fail(
			`out/cli.js missing for: ${missing.join(", ")} — run \`yarn compile\` first (client generation reads the compiled openapi emitters, not source)`
		)
	}
}

/** Emit all 8 documents (4 surfaces × 2 flavors) into `<outDir>/specs/`. */
function emitSpecs(specsDir: string, phase: (p: string, d?: string) => void): SpecPaths {
	mkdirSync(specsDir, { recursive: true })

	const v31 = {} as Record<ClientSurface, string>
	const v30 = {} as Record<ClientSurface, string>

	for (const surface of CLIENT_SURFACES) {
		const cli = emitterCLIPath(surface)

		for (const flavor of FLAVORS) {
			const out = join(specsDir, `${surface}-${flavor}.json`)

			phase("emit-spec", `${surface} ${flavor} → ${out}`)
			run("node", [cli, "openapi", "--flavor", flavor, "--out", out])
			;(flavor === "3.1" ? v31 : v30)[surface] = out
		}
	}

	return { v31, v30 }
}

/**
 * Run `openapi-python-client generate` once per surface, into `mailwoman_client/<surface>/` — the sibling-subpackage
 * layout the salvaged README documented (fully relative imports, so the four compose under one distributable with no
 * post-processing).
 */
function generatePythonModules(specPaths: SpecPaths, pythonDir: string, phase: (p: string, d?: string) => void): void {
	const packageDir = join(pythonDir, "mailwoman_client")
	mkdirSync(packageDir, { recursive: true })

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
			join(packageDir, surface),
			"--overwrite",
		])
	}

	// The generator drops a .ruff_cache under each output dir (salvaged README precedent) — remove it.
	for (const surface of CLIENT_SURFACES) {
		rmSync(join(packageDir, surface, ".ruff_cache"), { recursive: true, force: true })
	}
}

export function pythonPyproject(version: string): string {
	return `[project]
name = "mailwoman-client"
version = "${version}"
description = "Typed Python clients for Mailwoman's Photon / Nominatim / libpostal drop-in geocoding APIs and native /v1/* surface, generated from their OpenAPI specs."
readme = "README.md"
# A plain SPDX expression string, not the { text = "…" } table — setuptools >= 77 deprecates the
# table form (a build-time warning that would otherwise show up in every receipt).
license = "AGPL-3.0-only OR LicenseRef-Commercial"
# Explicit PEP 639 \`license-files\` (setuptools' default \`LICEN[CS]E*\` glob only catches LICENSE.md,
# not COMMERCIAL-LICENSE.md — the "LicenseRef-Commercial" half of the SPDX expression above would ship
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
	# No "License :: OSI Approved :: …" classifier alongside the SPDX \`license\` expression above —
	# setuptools >= 77 hard-errors on that combination (PEP 639: license classifiers are superseded
	# by license expressions). The SPDX string is the single source of truth.
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
Homepage = "https://mailwoman.sister.software"
Documentation = "https://mailwoman.sister.software/docs"
Repository = "https://github.com/sister-software/mailwoman"
Issues = "https://github.com/sister-software/mailwoman/issues"

[project.optional-dependencies]
dev = ["pytest>=7.0", "ruff==0.15.20"]

[build-system]
# >=77: the first release with PEP 639 \`license-files\` + the plain-string SPDX \`license\` expression
# above stabilized (pre-77 either ignores license-files or warns on the SPDX string form).
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
# The four drop-in subpackages are GENERATED verbatim by openapi-python-client (which runs its own
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

Quick start (hosted Photon trial endpoint, no local server needed):

    from mailwoman_client import PhotonClient
    from mailwoman_client.photon.api.geocoding import search

    client = PhotonClient.hosted()          # https://photon.sister.software
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
PHOTON_HOSTED_BASE_URL = "https://photon.sister.software"


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
		"Typed Python clients for [Mailwoman](https://mailwoman.sister.software)'s HTTP surfaces —",
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
		"run; publishing to PyPI happens from the gated CI job once the operator provisions a PyPI",
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
		"Forward-geocode against the hosted Photon trial endpoint (`https://photon.sister.software`, no",
		"local server needed):",
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

/**
 * Write the pyproject.toml + README.md + `mailwoman_client/__init__.py` + `py.typed` + license texts — the salvaged
 * layout, adapted for the fourth `mailwoman` module. No `examples/` dir: the salvaged `search_berlin.py` example wasn't
 * wired into either `[tool.setuptools.packages.find]` (wheel) or a MANIFEST.in (sdist), so it was silently dropped from
 * both built artifacts. The README's own "Usage" section already carries the same snippet inline, so it isn't lost —
 * just not duplicated as a file that never shipped.
 */
function assemblePythonPackage(pythonDir: string, version: string, phase: (p: string, d?: string) => void): void {
	phase("python-assemble", pythonDir)
	writeFileSync(join(pythonDir, "pyproject.toml"), pythonPyproject(version))
	writeFileSync(join(pythonDir, "README.md"), pythonReadme())
	writeFileSync(join(pythonDir, "mailwoman_client", "__init__.py"), pythonInitPy())
	writeFileSync(join(pythonDir, "mailwoman_client", "py.typed"), "")
	// AGPL conveyance + the LicenseRef-Commercial target (see license-files above): copied into the package root,
	// not the mailwoman_client/ subpackage, matching where setuptools looks relative to pyproject.toml.
	copyLicenseFiles(pythonDir)
}

/**
 * `uv build` the assembled package, then import-check the built wheel in an ephemeral env (`--no-project` so `uv run`
 * doesn't treat `pythonDir` itself as the active project).
 */
function verifyPython(pythonDir: string, phase: (p: string, d?: string) => void): { wheel: string; sdist: string } {
	phase("python-build", pythonDir)
	rmSync(join(pythonDir, "dist"), { recursive: true, force: true })
	run("uv", ["build"], { cwd: pythonDir })

	const distDir = join(pythonDir, "dist")
	const entries = existsSync(distDir) ? readdirSync(distDir) : []
	const wheel = entries.find((f) => f.endsWith(".whl"))
	const sdist = entries.find((f) => f.endsWith(".tar.gz"))

	if (!wheel) {
		fail(`uv build did not produce a .whl under ${distDir}`)
	}

	if (!sdist) {
		fail(`uv build did not produce a .tar.gz under ${distDir}`)
	}

	const wheelPath = join(distDir, wheel)

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

	return { wheel: wheelPath, sdist: join(distDir, sdist) }
}

export function rustCargoToml(version: string): string {
	return `[package]
name = "mailwoman-client"
version = "${version}"
edition = "2021"
rust-version = "1.82"
description = "Typed Rust clients for Mailwoman's Photon / Nominatim / libpostal drop-in geocoding APIs and native /v1/* surface, generated from their OpenAPI specs."
license = "AGPL-3.0-only OR LicenseRef-Commercial"
repository = "https://github.com/sister-software/mailwoman"
homepage = "https://mailwoman.sister.software"
documentation = "https://docs.rs/mailwoman-client"
readme = "README.md"
keywords = ["geocoding", "photon", "nominatim", "libpostal", "openapi"]
categories = ["api-bindings", "science::geo"]
# The vendored specs + the src are all that ship; nothing else is needed to build. LICENSE.md +
# COMMERCIAL-LICENSE.md are copied into the crate root by copyLicenseFiles() during assembly — Cargo's
# packager only ships files this list names, so both must be listed explicitly (the \`license\` field
# above is metadata only; it doesn't embed the referenced text).
include = ["src/**/*", "openapi/*.json", "examples/**/*", "README.md", "LICENSE.md", "COMMERCIAL-LICENSE.md"]

[dependencies]
# progenitor's generate_api! proc-macro synthesizes the client at compile time from the vendored
# spec (the 3.0.3 "diet" flavor — openapiv3 only understands 3.0.x); the generated code calls into
# progenitor::progenitor_client (re-exported by progenitor, so no separate progenitor-client dep).
# reqwest MUST match the version progenitor 0.14 uses (0.13) — a second reqwest in the graph makes
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
		'pub const PHOTON_HOSTED_BASE_URL: &str = "https://photon.sister.software";',
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
		"Typed Rust clients for [Mailwoman](https://mailwoman.sister.software)'s HTTP surfaces,",
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
		"`mailwoman clients generate` run; publishing to crates.io happens from the gated CI job once",
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
		"    let client = mailwoman_client::photon_hosted(); // https://photon.sister.software",
		"",
		"    let response = client",
		'        .search(None, None, None, None, Some(3), None, None, Some("berlin"))',
		"        .await?;",
		"",
		"    if let PhotonResponse::PhotonFeatureCollection(fc) = response.into_inner() {",
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
//! Run: \`cargo run --example basic\` (hits https://photon.sister.software).

use mailwoman_client::photon::types::PhotonResponse;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = mailwoman_client::photon_hosted();

    let response = client
        .search(None, None, None, None, Some(3), None, None, Some("berlin"))
        .await?;

    let features = match response.into_inner() {
        PhotonResponse::PhotonFeatureCollection(fc) => fc.features,
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

/**
 * Vendor the 3.0 specs + write Cargo.toml/src/lib.rs/README.md/examples/basic.rs + the license texts — the salvaged
 * crate pattern, adapted for the fourth `mailwoman` module.
 */
function assembleRustCrate(
	specPaths: SpecPaths,
	rustDir: string,
	version: string,
	phase: (p: string, d?: string) => void
): void {
	phase("rust-assemble", rustDir)
	const openapiDir = join(rustDir, "openapi")
	mkdirSync(openapiDir, { recursive: true })
	mkdirSync(join(rustDir, "src"), { recursive: true })
	mkdirSync(join(rustDir, "examples"), { recursive: true })

	for (const surface of CLIENT_SURFACES) {
		copyFileSync(specPaths.v30[surface], join(openapiDir, `${surface}.json`))
	}

	writeFileSync(join(rustDir, "Cargo.toml"), rustCargoToml(version))
	writeFileSync(join(rustDir, "src", "lib.rs"), rustLibRs())
	writeFileSync(join(rustDir, "README.md"), rustReadme())
	writeFileSync(join(rustDir, "examples", "basic.rs"), rustExample())
	// AGPL conveyance + the LicenseRef-Commercial target (see the Cargo.toml `include` list above).
	copyLicenseFiles(rustDir)
}

/**
 * `cargo check --examples` — stronger than a bare `cargo check` (which skips example targets by default) so
 * `examples/basic.rs` is verified against the CURRENT vendored spec on every run. See the module docstring for why this
 * matters: the salvaged example had already drifted once.
 */
function verifyRust(rustDir: string, phase: (p: string, d?: string) => void): void {
	phase("cargo-check", rustDir)
	run("cargo", ["check", "--examples"], { cwd: rustDir })
}

/** Run the full pipeline. See the module docstring for the phase order and the `--examples` verify note. */
export async function generateClients(opts: GenerateClientsOptions = {}): Promise<GenerateClientsResult> {
	const t0 = performance.now()
	const phase = opts.onPhase ?? (() => {})
	const outDir = opts.outDir ?? repoRootPath("clients-build")
	const specsDir = join(outDir, "specs")
	const pythonDir = join(outDir, "python")
	const rustDir = join(outDir, "rust")
	const version = readMailwomanVersion()

	let specPaths: SpecPaths | null = null
	let pythonWheel: string | null = null
	let pythonSdist: string | null = null

	const steps: Array<{ check: string; run: () => string | void }> = [
		{
			check: "compile-check: out/cli.js present (mailwoman, libpostal, photon, nominatim)",
			run: () => {
				checkCompiled()
			},
		},
		{
			check: "emit 8 specs (4 surfaces × 3.1 + 3.0) → clients-build/specs/",
			run: () => {
				// A stale artifact from a prior version must never linger under a fresh run.
				rmSync(outDir, { recursive: true, force: true })
				mkdirSync(outDir, { recursive: true })
				specPaths = emitSpecs(specsDir, phase)

				return specsDir
			},
		},
		{
			check: "python generate ×4 (uvx openapi-python-client@0.29)",
			run: () => {
				generatePythonModules(specPaths!, pythonDir, phase)
			},
		},
		{
			check: "assemble python package (pyproject.toml, README.md, __init__.py — salvaged layout)",
			run: () => {
				assemblePythonPackage(pythonDir, version, phase)

				return pythonDir
			},
		},
		{
			check: "assemble rust crate (Cargo.toml, src/lib.rs, vendored 3.0 specs — salvaged layout)",
			run: () => {
				assembleRustCrate(specPaths!, rustDir, version, phase)

				return rustDir
			},
		},
	]

	if (!opts.skipVerify) {
		steps.push(
			{
				check: "python: uv build + import-check wheel",
				run: () => {
					const built = verifyPython(pythonDir, phase)
					pythonWheel = built.wheel
					pythonSdist = built.sdist

					return built.wheel
				},
			},
			{
				check: "rust: cargo check --examples",
				run: () => {
					verifyRust(rustDir, phase)
				},
			}
		)
	}

	const checks: Check[] = []

	for (const step of steps) {
		try {
			const detail = step.run()
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
		outDir,
		specsDir,
		pythonDir,
		rustDir,
		specs: specPaths,
		pythonWheel,
		pythonSdist,
		elapsedSeconds: (performance.now() - t0) / 1000,
	}

	return { ok: checks.every((c) => c.ok), checks, receipt }
}
