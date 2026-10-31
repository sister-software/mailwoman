# Data installation, layer selection, and package ownership

Date: 2026-10-28. Status: proposed design. No implementation or data migration performed.

This iteration supplements `layer-paths-plan.md`. It replaces that plan's proposed package boundaries,
customer workflow, activation mechanism, and migration order. Its host inventory remains a historical
record: the disk counts and sizes have not been measured again for this iteration.

## 1. Start with the customer workflow

Mailwoman should let a customer start with parsing, add place resolution, and then improve precision
for selected countries or regions. Each step should work through the installed `mailwoman` CLI.
Customers should not need a checkout, internal package paths, symlink commands, or knowledge of GDAL
to install a published database. Building from source is a separate, explicit operation with its own
prerequisite check.

Observed precedents:

- `docs/articles/developers/get-started/ten-minute-trial.mdx` introduces `setup` and the candidate download.
- `docs/articles/developers/tutorials/improve-geocode-precision.mdx` adds one jurisdiction through
  `data pull us --only dc`, then repeats the same geocode to show its new resolution tier.
- `docs/articles/developers/tutorials/full-planet-build.mdx` introduces local builds, but its OSM route
  requires internal scripts and a checkout. That is the workflow this design should replace.
- `packages/mailwoman/cli/setup/plan.ts` already selects relevant bundles by country and prints pull
  commands. `cli/commands/setup.tsx` deliberately delegates downloads to `data pull`.

These documents contain historical versions, paths, and publication claims. They establish the intended
progression. They describe planned remote availability. Implementation must verify published artifacts separately.

Keep these existing commands as the starting experience:

```sh
mailwoman setup --countries US
mailwoman data pull candidate --dry-run
mailwoman data pull candidate
mailwoman data pull us --only dc --dry-run
mailwoman data pull us --only dc
mailwoman data status
mailwoman geocode "1275 Pennsylvania Ave NW, Washington, DC 20004" --format text
```

Extend `setup` to explain what works now, which requested capabilities are unavailable, and the next
smallest installation. Do not recommend every global bundle merely because it has global scope.
Separate parser dependencies, place resolution, rooftop lookup, interpolation, and optional overlays.
Report an unreadable installation as an error with its path. The existing catch that treats an inventory
failure as an empty installation must not survive the new workflow.

`data pull` remains an installation command for published artifacts. It must never silently launch a
source build when no download exists. Offer a source build as a separate next step, with disk and tool
requirements. A customer who declines it retains the capabilities already installed.

## 2. Organize code by responsibility and country-specific policy by country

A source can span the planet while its interpretation varies by jurisdiction. These are separate
dimensions. One OSM extractor can serve every country without centralizing country-specific rules.

| Owner                          | Responsibility                                                                  | Excluded responsibility                                  |
| ------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `codex/lib/<cc>/`              | Postal conventions, country-specific normalization choices, reference data      | Download URLs, OSM extract selection, installed datasets |
| `corpus/lib/<cc>/`             | National-source adapters and country-specific training transformations          | Database selection for serving                           |
| `corpus/lib/adapters/osm/`     | Shared conversion of OSM observations into corpus rows                          | PBF acquisition or active geocoding-source selection     |
| `osm/lib/`                     | OSM-specific types and reusable interpretation code                             | Generic address-point schema ownership                   |
| `osm/sdk/`                     | OSM acquisition and extraction                                                  | Corpus admission policy or customer workflow             |
| `osm/tools/`                   | Builds and maintenance using OSM inputs                                         | Runtime geocode imports                                  |
| `core/layers/`                 | Shared manifest and artifact identity declarations and validation               | Source registry, download UI, reader selection policy    |
| `resolver-wof-sqlite/lib/`     | Current SQLite readers, shared address-point schema and role-specific providers | Source acquisition                                       |
| `mailwoman/lib/data/`          | Installation planning, catalog, activation, status, migration                   | OSM tag interpretation                                   |
| `mailwoman/cli/commands/data/` | Arguments, progress, diagnostics, and presentation                              | A second implementation of installation or selection     |

The resolver package is the proposed initial home for the schema because it already owns the common
address-point reader. Before moving it, measure added runtime dependencies and shipped bytes for its
builders. If importing it adds unrelated resolver code, propose a narrowly scoped schema owner
with that measurement. Do not create a general utilities package to avoid making this decision.

Keep `@mailwoman/osm` as a source integration package. Remove its generic schema and serving selection
responsibilities as consumers migrate, but retain its OSM-specific library APIs where they still have
callers. The original proposal to make entire source packages build-only is broader than necessary.

Proposed country organization within OSM:

```text
packages/osm/
  lib/<cc>/extraction-policy.ts   # source-specific country rules, when needed
  sdk/extract.ts                 # shared extraction implementation
  sdk/extract/boundary.ts
  sdk/geofabrik/                 # publisher region identifiers and acquisition
  tools/                        # build orchestration
```

An extraction policy can select boundary levels and clipping inputs. It cannot assert that every
address in the country exists in OSM. The Geofabrik region registry records publisher regions and
their relationship to countries. Country policy references those identities rather than copying URLs.
One region may supply several countries. Acquire it once and record each derived country's clipping
operation separately. Never force a multi-country input into a fabricated single-country source identity.

Codex stores a normalization rule only if it is a postal convention independent of OSM. OSM-specific
`admin_level` choices stay in OSM. Corpus rendering and source admission stay in corpus. This placement
rule should determine each move, rather than a blanket instruction to put country tables in codex.

## 3. Separate available, installed, and active data

An artifact is one immutable build identified by a digest. A role describes its reader interface, such
as address points. A scope describes where it can be considered, such as a country or subdivision.
Source identity records where its observations came from. These fields have different purposes.

Use three records:

1. The available-data registry describes downloadable artifacts and source-build recipes. It includes
   capabilities, jurisdictions, dependencies, access requirements, checksums, and known sizes.
2. The artifact manifest describes what a particular downloaded or built file contains, including its
   schema version, source lineage, normalization version, observed countries, and coverage evidence.
3. The active selection records which installed artifacts the resolver uses and their explicit order.

A manifest validates an artifact. It cannot decide whether a customer selected that artifact. An
installed file also must not activate itself merely because a directory scan discovered it.

Prefer one versioned active-selection document with an atomic replacement over independently changing
symlinks for each role. This supports related artifacts being activated together and does not require
customers' filesystems to support symlinks. Artifact files remain immutable. A session reads one
selection generation and retains it until reload. Validate the replacement completely before switching.
Concurrent activations must use a lock or compare the generation they started from.

The catalog takes a data root and a selection generation. It resolves artifact IDs to validated paths
and reports missing, corrupt, unsupported, or refused artifacts distinctly. Generic catalog code does
not open role-specific lookup handles. Each provider owns their opening and disposal.

Allow multiple installed sources for the same role and scope. Preserve the current selection order
in the first migration. Do not collapse BAN and OSM into a single pointer and call that equivalent:
source ordering and fallback after an unsuccessful lookup require an explicit policy and tests.
Likewise, a subdivision miss falling through to a national source is a behavior change to evaluate.

Country coverage, geographic extent, and completeness remain separate. A list of observed countries
does not establish exhaustive coverage. The absence of coverage evidence cannot support a negative answer.
Define normalization requirements per role. A postcode layer must not acquire a street-locale
requirement merely because address-point layers need one.

## 4. Keep storage an implementation detail

Retain the original separation of acquired inputs, derived intermediates, and serving artifacts:

```text
<data-root>/
  src/<source>/<release>/
  derived/<recipe>/<build-id>/
  db/<role>/<artifact-id>/
  active.json
```

This is a proposed layout. The command interface is specified separately. Source inputs follow publisher identity. Derived
outputs follow the recipe. Artifacts used at runtime follow reader role. Country remains manifest metadata
and an installation selector. No filename parsing supplies missing manifest fields.

Support artifact sets, including FST files, rather than assuming every served resource is SQLite.
SQLite artifacts embed the shared manifest. Non-SQLite artifacts need an equivalent validated manifest.
An artifact-set manifest binds related files by digest and schema compatibility.

Stage installation on the destination filesystem before the final rename. A temporary directory on
another mount does not provide atomic installation. Budget space for the download, expansion, build
intermediates where relevant, and retained active version. Report unknown estimates explicitly.

## 5. Extend the CLI without creating a competing layer command family

The following commands are proposed additions that the CLI does not yet accept:

| Command                                          | Responsibility                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `mailwoman data build <recipe> --countries <cc>` | Plan and execute a source build, including acquisition through the same CLI |
| `mailwoman data activate <installation-id>`      | Activate a validated installation or restore a retained one                 |
| `mailwoman data migrate --dry-run`               | Explain the legacy paths and metadata requiring migration                   |
| `mailwoman data prune --dry-run`                 | List unreferenced artifacts and reclaimable bytes                           |

Extend existing `data sources`, `data coverage`, `data inventory`, `data bom`, and `data status` rather
than duplicating them under `layer list`. Add country and capability filtering to the shared planner.
Preserve existing bundle names and `--only` behavior initially. Introduce exact jurisdiction selectors
explicitly, and substring matching stays as it is.

The pull and build paths share this operation sequence:

1. Resolve the request and dependencies into a concrete plan.
2. Report source, capability, scope, access requirements, download bytes, disk requirements, and
   whether activation would replace a selected source. Dry-run performs no data writes. Document
   separately whether registry refresh needs network access.
3. Acquire inputs with progress, checksums, cancellation, and resumable state where supported.
4. Build if explicitly requested, preserving input receipts and derivation lineage.
5. Validate artifact integrity, reader compatibility, manifests, and applicable obligation refusals.
6. Install immutable artifacts and activate the complete requested installation atomically.
7. Print the installed capabilities and a concrete next command.

Re-running the same request reuses verified completed work. A partial transfer is never reported as
installed. A failed upgrade leaves the previous selection usable. A local build may stop before
activation for evaluation. Build dependencies are checked before large downloads. Explain missing
tools through the CLI rather than exposing package-internal script paths.

An npm integration package enables code. Data selection is a separate step. A published bundle or an
explicitly activated local build selects data. Both paths enforce the same configured obligation
refusals and keep access entitlements separate from source-license metadata.

## 6. Migrate one complete customer path before moving the host inventory

| Stage | Work                                                                           | Acceptance evidence                                                                                                                 |
| ----- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| A     | Specify identities, role requirements, active selection, and installation plan | Fixtures represent national, subdivision, multi-country, overlapping-source, and non-SQLite artifacts                               |
| B     | Implement published candidate installation through the existing CLI            | An empty data root reaches a working geocode. Interruption and retry leave valid state                                              |
| C     | Add one regional precision bundle                                              | A DC pull changes available precision without downloading all US regions. A repeated pull reuses verified files                     |
| D     | Move shared schema ownership and introduce the catalog behind existing readers | Dependency audit, typecheck, affected workspace tests, and fixed-artifact output comparison                                         |
| E     | Add the OSM source-build recipe and country policies                           | One small extract reaches a validated local installation using only public CLI commands. A multi-country fixture reuses acquisition |
| F     | Add legacy migration and change reader defaults                                | Dry-run identifies every selected artifact. Migration preserves selected sources and enables rollback                               |
| G     | Update tutorials and remove obsolete internal entry points                     | Published-package installation tests execute documented commands without a checkout                                                 |
| H     | Expand data availability and evaluate new source policies                      | Separate per-country evidence and the repository's applicable release evaluation                                                    |

Do not begin with bulk host moves. Inventory the files the actual readers select, distinguish those
from dormant files, and preserve input receipts before migration. Unknown source metadata remains
unknown. A new manifest must not manufacture vintage, license, or checksum evidence.

Migration may register validated legacy files temporarily without renaming them. Remove legacy
reader branches after migration is supported and documented. Preserve released receipts and historical
paths as records. A repository-wide zero-match search is not an appropriate acceptance criterion.

The cleanup operation is separate from migration. It never deletes active generations, rollback generations, in-use
artifacts, and inputs referenced by retained derivations. No file is deleted merely because its name
looks older. Retention defaults need a documented policy before deletion is enabled.

## 7. Keep source-quality experiments separate

The original plan's missing-street buckets describe source observations. They establish no threshold
for choosing PBF versus Photon. Do not make 10% or 30% a production selector without evidence that
the threshold predicts the intended result across the relevant population.

Keep the Photon comparison as a separate experiment. Its result must identify exact inputs and
versions, matching evaluation addresses, added and lost matches, and the distinction between mapped
tags and inferred street associations. A Photon derivation must retain Photon in its lineage even
when the underlying source is OSM. Record MD5 and SHA-256 in separate typed fields. The original
plan's 32-character MD5 cannot populate a SHA-256 field.

A generic normalization strategy is also a separate behavior decision. Record its algorithm version
and measure query/build agreement and coordinate outcomes before making it the default for newly
served countries. More installed rows alone do not establish better geocoding.

## 8. Verification and documentation requirements

Test clean installation, incremental installation, interrupted transfer, corrupted input, unavailable
artifact, unsupported schema, refused obligations, failed activation, concurrent activation, rollback,
and non-default data roots. A snapshot test of printed commands alone does not establish installation.
Use a small local registry and fixture artifacts for repeatable integration tests. Run the documented
published-artifact path separately before release.

For selection changes, compare identical input addresses and identical artifact bytes before and
after the migration. Report expected and observed outputs together and list every difference. A few
successful examples do not establish parity across source overlap and fallback conditions.

Implementation must run the repository-required compile, copy-weights, lint, typecheck, and affected
workspace tests. This planning iteration ran none of those checks because it changes no executable code.

Rewrite the first-run and precision tutorials around the public CLI. Keep the full source-build
tutorial as an advanced progression with explicit prerequisites. Generate command syntax from the
command specifications where supported. Verify every example against the released CLI, and label
unpublished commands as proposed until they ship.

The first implementation should deliver stages A–C: a clean installation and one incremental precision
upgrade through the existing CLI. The large host migration and planetary build expansion follow after
that customer path and its failure recovery have been tested.

## 9. Implementation plan and working checklist

All items below are pending. This section plans implementation. It does not authorize downloads,
large builds, publication, or changes to the active host data. When implementation begins, use the
`task-intake` skill to create the tracking issue and mirror these tasks. Keep this document as the
design reference and record implementation status in that issue. Before release, move the accepted
design into durable engineering documentation because the scratchpad is ignored by Git.

### 9.1 Establish interfaces and compatibility fixtures

This work precedes changes to readers or installation destinations.

- [ ] Read the nearest instructions for each affected workspace and find existing artifact, checksum,
      download, locking, and atomic-write helpers before introducing declarations or implementations.
- [ ] Trace `data pull`, bundle status, setup, BOM, doctor, and geocode selection to their shared
      readers. Record which existing interfaces can be extended and which must be retired.
- [ ] Define artifact identity, artifact-set membership, role schema versions, normalization identity,
      installation identity, and active-selection generation. Specify required fields per role.
- [ ] Define available-data entries separately from installed manifests. Record dependency and
      compatibility requirements without embedding CLI presentation in either schema.
- [ ] Define ordered source selection and the exact meaning of an absent layer, an unsuccessful
      lookup, an unreadable artifact, and an obligation refusal. Preserve existing behavior initially.
- [ ] Specify the active-selection document, atomic replacement, concurrent update handling, reload,
      and rollback. Decide how running sessions keep pruning from deleting their artifacts.
- [ ] Add fixtures for candidate data, DC address points and interpolation, overlapping national
      sources, a multi-country source, and a non-SQLite artifact set. Fixtures must exercise actual readers.
- [ ] Measure runtime dependencies and shipped bytes before choosing the shared schema's final home.
      Record the result and resolve that placement before moving exports.

Completion criterion: the interfaces describe each fixture without deriving identity from filenames,
and tests reject missing required metadata, incompatible artifact sets, and invalid selections.

### 9.2 Deliver published installation through the existing CLI

This work depends on the interfaces in §9.1. Keep the current published registry format readable
while producers and consumers migrate. Document when compatibility can be removed.

- [ ] Extract or extend the shared installation planner under `mailwoman/lib/data/`. Make `setup`,
      `data pull --dry-run`, and execution consume the same concrete plan.
- [ ] Include dependencies, expected bytes, destination, available disk estimate, access requirements,
      and activation changes. Distinguish estimates from verified sizes and unknown sizes.
- [ ] Implement receipt-backed acquisition and validation using existing download helpers. Resume
      only when the remote identity and local partial state still match. Otherwise explain the restart.
- [ ] Install candidate data into an immutable artifact location and activate it only after validation.
- [ ] Add the regional US installation using exact artifact dependencies while preserving existing
      bundle names and `--only` matching semantics.
- [ ] Make repeated pulls verify and reuse completed artifacts. Keep cancellation and transfer errors
      separate from a successful no-op.
- [ ] Test failure before activation, failure during selection replacement, and concurrent installers.
      The previous active generation must remain readable in each failed-upgrade case.
- [ ] Run the clean candidate installation and DC increment through a temporary data root using a
      local fixture registry. Verify geocoding through the installed selection as well as file existence.

Completion criterion: the stage B and C workflows in §6 run through public commands, recover from an
interrupted installation, and require no hand-written paths or environment overrides beyond an
optional data-root choice.

### 9.3 Make setup and diagnostics describe the same installation

This work depends on the shared planner and catalog. It can be reviewed separately from source builds.

- [ ] Replace setup's catch-all inventory fallback with a diagnostic that identifies the unreadable
      input. An installation read failure must not print every tier as uninstalled.
- [ ] Show current capabilities and a scoped next action. Keep parsing usable without installing
      geocoding or overlay data, and distinguish model installation from geographic data installation.
- [ ] Update `data status`, `inventory`, `bom`, `coverage`, and doctor to use the catalog rather than
      independent directory scans and filename lists for active data.
- [ ] Report installed-but-inactive artifacts separately from active artifacts and failed installations.
- [ ] Distinguish unavailable data, insufficient access, refused obligations, missing dependencies,
      unsupported schemas, and corruption in both human output and structured command results.
- [ ] Test interactive and non-interactive setup against identical installation states. Check the
      documented next command executes against the fixture registry.

Completion criterion: setup, status, BOM, doctor, and the resolver agree on the active generation and
its artifacts. Each reports uncertainty or failure without translating it into an empty installation.

### 9.4 Migrate runtime readers and package ownership

This work depends on §9.1–9.3. Capture the current selection and outputs before changing providers.

- [ ] Move the generic address-point schema to the owner selected in §9.1. Rewrite imports directly.
      Add no cross-package forwarding exports.
- [ ] Separate the source-independent catalog from role-specific lookup providers and their handles.
- [ ] Migrate candidate and address-point readers first, then interpolation, street centroids, WOF
      extracts, overlays, and non-SQLite resources. Record the remaining legacy readers explicitly.
- [ ] Preserve current source precedence and fallback behavior for the initial migration. Keep any
      proposed behavior change in a separately evaluated change.
- [ ] Update Nominatim and Photon entry points, autocomplete, and evaluation consumers to read the
      same selection. Test custom data roots and reload while an earlier session remains open.
- [ ] Remove provider country maps only after build manifests and country policies supply their
      required information. Refuse unsupported normalization versions instead of choosing a default.
- [ ] Compare outputs with fixed artifact bytes for national, subdivision, overlapping-source, and
      missing-layer cases. Attach the full difference list, including an empty list when none differ.
- [ ] Run dependency checks and the affected workspace suites before retiring old providers.

Completion criterion: all migrated consumers select the same artifacts from one active generation,
and measured output differences are either absent or explicitly reviewed as behavior changes.

### 9.5 Add source acquisition and OSM builds through the CLI

This work depends on the installer and shared reader interfaces. Begin with a small reproducible
extract. Planetary acquisition is outside this implementation step.

- [ ] Register an OSM build recipe with required tools, source inputs, outputs, and supported scopes.
- [ ] Place publisher region mappings in the Geofabrik acquisition code and country-specific extraction
      policy under `osm/lib/<cc>/`. Keep postal conventions in codex and training transformations in corpus.
- [ ] Expose planning, prerequisite checks, acquisition, extraction, validation, and optional activation
      through `mailwoman data build`, with no dependency on a repository checkout.
- [ ] Reuse one acquired regional PBF across country derivations. Record clipping geometry identity,
      extraction-policy version, source digest, and builder version in each output's lineage.
- [ ] Preserve mapped fields separately from derived fields. Keep the shared corpus adapter's input
      interface stable or migrate its producer and consumer together.
- [ ] Test cancellation and restart at acquisition and build boundaries. A completed extraction must
      not be reused after its inputs or policy change.
- [ ] Test the packaged CLI with the optional OSM integration both present and absent. Report missing
      build support before downloading inputs. Published-layer installation must not require GDAL.

Completion criterion: a customer can build and inspect a small OSM layer entirely through public CLI
commands. Activation uses the same validation and selection mechanism as a published download.

### 9.6 Migrate existing installations and add retention

This work depends on migrated readers and tested rollback. Run the migration planner before making
host changes. The historical inventory in the original plan is not a current migration receipt.

- [ ] Implement read-only migration discovery using the readers that currently select files. Include
      explicit overrides, external paths, hard links, symlinks, and WAL state.
- [ ] Classify each artifact as directly importable, requiring a rebuilt or copied manifest, requiring
      a source rebuild, or blocked on unknown provenance. State the reason for each classification.
- [ ] Emit a concrete dry-run plan with source and destination paths, required bytes, selection changes,
      and rollback details. Preserve historical receipts rather than rewriting them in place.
- [ ] Make migration resumable and test it against fixtures representing legacy layouts. Keep the old
      active generation usable until every required replacement is validated.
- [ ] Re-inventory the host immediately before an approved migration and verify its preconditions,
      including active jobs and open database files.
- [ ] Define retained generations and source-input retention before implementing deletion. Prune must
      keep in-use artifacts and inputs referenced by retained derivations.
- [ ] Test prune dry-run and execution against the same selection snapshot, including a concurrent
      activation. Reject deletion when the referenced state changed during planning.

Completion criterion: an existing installation migrates without a source-selection change, supports
rollback, and reports every unresolved artifact. Destructive cleanup remains a separate operation.

## 10. Documentation changes

Documentation ships with the implementation it describes. Examples for unreleased commands remain
labeled as proposals. Historical receipts retain their original text.

| Document                                                           | Required change                                                                                             | Verification                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `docs/articles/developers/get-started/install-and-first-parse.mdx` | Separate parser installation from optional geographic data. Link to setup                                   | Run from a clean published-package installation                    |
| `docs/articles/developers/get-started/ten-minute-trial.mdx`        | Show setup, candidate installation, current status, and the next scoped upgrade                             | Execute every command in a temporary data root                     |
| `docs/articles/developers/tutorials/improve-geocode-precision.mdx` | Retain the one-region progression. Explain availability and fallback from actual installed artifacts        | Repeat the full-address examples before and after installation     |
| `docs/articles/developers/tutorials/full-planet-build.mdx`         | Replace internal OSM scripts with public source-build commands. Distinguish downloads from builds           | Run the small-extract route from packaged code                     |
| `docs/articles/developers/tutorials/build-the-us-dataset.mdx`      | Align source-build outputs, installation, and activation with the shared lifecycle                          | Build a fixture and load it through the shared reader              |
| `docs/articles/developers/how-to/keep-data-fresh.mdx`              | Explain upgrade planning, interruption recovery, retained versions, rollback, and pruning                   | Exercise upgrade failure and rollback examples                     |
| `docs/articles/developers/status.mdx`                              | Separate published availability, local-build support, installed capability, and evaluated coverage          | Check against the registry and cited evaluation evidence           |
| `docs/engineering/reference/layer-interface.mdx`                   | Specify artifact identity, role requirements, normalization versions, artifact sets, and coverage semantics | Match schema tests and reader validation                           |
| `docs/engineering/reference/workspaces.mdx`                        | Record final package ownership and any workspace changes                                                    | Regenerate or validate through the repository's existing mechanism |
| `packages/osm` and affected package READMEs                        | Describe source integration ownership and public CLI usage. Remove obsolete operational paths               | Check exports and packaged CLI examples                            |

- [ ] Add a durable engineering design document for the catalog, active-selection format, installation
      lifecycle, and migration. Link it from the layer interface reference.
- [ ] Add a migration guide with prerequisites, dry-run interpretation, unknown-provenance handling,
      rollback, and separately documented cleanup.
- [ ] Update existing command reference generation or reference pages for changed options and new
      commands. Search active docs for internal-script instructions and obsolete path requirements.
- [ ] Review help text and error messages alongside the tutorials so each failure gives an executable
      next step when one exists. Do not invent a repair command for unsupported or unknown data.
- [ ] Record changed customer behavior and migration requirements in the release notes.

## 11. Implementation completion criteria

The implementation is complete only when all applicable checks below have evidence linked from the
tracking issue. The first published-installation increment does not complete the migration
or source-build work.

- [ ] Clean setup, published candidate installation, and one regional precision upgrade work through
      the packaged CLI without a checkout.
- [ ] Source builds use the CLI and share installation validation without adding build dependencies
      to the ordinary published-download path.
- [ ] Runtime readers and diagnostics agree on the active generation, including non-default roots.
- [ ] Failed transfers, invalid artifacts, failed upgrades, and concurrent activation preserve a usable
      previous installation. Rollback has been exercised.
- [ ] Country rules, source extraction, corpus transformations, and generic readers have the owners
      defined in the accepted design, with no new library imports from `sdk/` or `tools/`.
- [ ] Legacy migration has a tested dry-run, resumable execution, and explicit unresolved cases.
- [ ] Source-selection or normalization changes have the repository-required evaluation evidence.
- [ ] Documentation examples match the release being shipped and run against its packaged CLI.
- [ ] Required compile, copy-weights, lint, typecheck, and affected workspace tests have run. Record
      command exit statuses and distinguish lint errors from warnings.
- [ ] The durable design, migration guide, release notes, and tracking issue identify any deliberately
      deferred work. Deferred acceptance criteria remain open rather than being marked complete.
