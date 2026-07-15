---
sidebar_title: Software Bill of Materials
title: Software Bill of Materials (SBOM)
sidebar_position: 5
hide_footer: true
---

# Software Bill of Materials (SBOM)

A Software Bill of Materials is a machine-readable inventory of everything a package ships and
depends on — every transitive dependency, its version, and its license. We publish one for each
[release](../releases.mdx) of the `mailwoman` package in **both** of the open SBOM standards, so downstream teams can
run their own supply-chain, license, and vulnerability tooling against Mailwoman without taking our
word for anything.

## Published artifacts

These document the production dependency closure of the top-level [`mailwoman`](https://www.npmjs.com/package/mailwoman)
package as published to npm — concrete versions, 389 transitive dependencies, development-only
dependencies excluded (consumers never install those).

| Standard      | Spec version | File                                                                                                 |
| ------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| **SPDX**      | 2.3          | [`mailwoman-5.10.1.spdx.json`](pathname:///sbom/mailwoman-5.10.1.spdx.json) (`dataLicense: CC0-1.0`) |
| **CycloneDX** | 1.5          | [`mailwoman-5.10.1.cdx.json`](pathname:///sbom/mailwoman-5.10.1.cdx.json)                            |

Both files are generated with the built-in `npm sbom` command (npm ≥ 9.5) — no third-party
tooling in the trust path.

## Standards adherence

We validate these files against each standard's reference tooling on every regeneration. The
commands and their results:

**SPDX** — validated with the SPDX project's own reference library,
[`spdx-tools`](https://pypi.org/project/spdx-tools/) (`pyspdxtools`, v0.8.5):

```console
$ uvx --from spdx-tools pyspdxtools -i docs/static/sbom/mailwoman-5.10.1.spdx.json
$ echo $?
0
```

A zero exit with no reported issues is a clean pass.

**CycloneDX** — validated with the official
[`cyclonedx-cli`](https://github.com/CycloneDX/cyclonedx-cli) (v0.27.2) against the CycloneDX 1.5
JSON schema:

```console
$ cyclonedx-cli validate --input-file docs/static/sbom/mailwoman-5.10.1.cdx.json --fail-on-errors
BOM validated successfully.
```

## Regenerating

A single script produces and normalizes both files:

```console
$ node scripts/generate-sbom.ts            # documents the mailwoman version in this repo
$ node scripts/generate-sbom.ts --version 5.10.1
```

The generator packs the published tarball, installs its production closure, and runs `npm sbom` for
each format, writing to `docs/static/sbom/`. It applies two small normalizations to npm's SPDX output
so it passes the SPDX reference validator: the `created` timestamp is truncated to whole seconds
(SPDX 2.3 forbids fractional seconds) and `_` in an SPDXID is rewritten to `-` (the SPDXID character
set is letters, numbers, `.`, and `-`). See the header of
[`scripts/generate-sbom.ts`](https://github.com/sister-software/mailwoman/blob/main/scripts/generate-sbom.ts)
for the full rationale.

Future releases regenerate these artifacts as a post-publish step; the version-stamped filenames mean
each release keeps its own SBOM rather than overwriting the last.
