# Nexus salvage survey — full-repo reuse inventory

2026-07-30. Operator-requested housekeeping sweep of `/home/lab/Projects/isp-nexus/universe` (AGPL,
operator sole author, relicense-by-copy approved) covering the directories the BDC 2a recon never
surveyed. Companion to the 2a salvage map in `2026-07-20-bdc-plausibility-design.md` §5. Purpose:
avoid re-implementation in tracks 2b/2c/C5/C6/B.

## Reuse candidates

| Source                                                  | What it is                                                                                                                                                                                                                                             | Serves                                                              | Effort          | Gotchas                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| `sync/experiments/pluck-att.ts` + `fcc/labels/index.ts` | Working scraper against AT&T's Broadband Facts label API + LLM extraction into a full Zod `BroadbandLabelSchema` (price, speed, caps, fees, contract terms — the FCC nutrition-label spec); `fcc/labels` parses `unique_plan_id` (F/M + FRN + plan id) | **C5** — real plan/pricing data, previously unmapped on the roadmap | M               | Hardcoded OpenAI assistant id; generalize before use                     |
| `sdk/llm/{assistant,openai}.ts` (~230 L)                | Thin OpenAI client + assistant-thread helper used by pluck-att                                                                                                                                                                                         | C5 extraction                                                       | S               | No caching/rate limits                                                   |
| `sync/scripts/registrations.ts`                         | Working BDC-provider-CSV × Form-499 join via FRN, upserting Organizations                                                                                                                                                                              | **2c** provider registry                                            | S-M             | Depends on already-mapped org models; `csv`, `deepmerge-ts`, `fast-glob` |
| `sync/scripts/sifi-cities.ts`                           | Headless-browser scraper of a competitor's (SiFi) city-availability claims                                                                                                                                                                             | C6-adjacent competitive intel                                       | S (as template) | Site-specific; the pattern is the value                                  |
| `schema/sdk/generator.ts`                               | Bespoke TS-compiler-API → JSON Schema generator                                                                                                                                                                                                        | B-track, maybe                                                      | M               | Check `api-kit/openapi.ts` first — likely already solved simpler         |
| `mailwoman/sdk/google/GoogleGeocoder.ts`                | Google geocoder client w/ HTTP cache                                                                                                                                                                                                                   | Cross-check tooling only                                            | M               | Conflicts with product positioning; TypeORM cache layer; low priority    |
| `api/routes/geolocation.ts`                             | CF-Worker `request.cf` approximate-location route                                                                                                                                                                                                      | C5 signup UX pattern                                                | S               | Workers-specific                                                         |

## Confirmed greenfield (nothing to salvage)

- **C6 eyeball-carrier DB**: zero BGP/PeeringDB/ASN/RouteViews code anywhere in Nexus.
- **Subsidy data** (CAF/RDOF), **ECFS/ULS**: zero hits — matches the 2a spec's "genuinely new work" note.
- **SMS / "1-800-INTERNET"**: never implemented in Nexus; the concept has no code.
- **Fabric ingestion**: `sync/fcc/fabric/data-source.ts` is a commented-out TypeORM stub, not a head start — and Fabric ingestion is forbidden anyway (2a spec §2.2).

## ⚠️ Stale-twin hazard — do not "sync from Nexus"

Nexus's `cartographer/`, `spatial/`, `tiger/`, and `core/` are the **stale ancestors** of mailwoman's
same-named workspaces: same filenames, same author, but mailwoman's copies are strictly ahead
(enum→const refactor, `.ts` import extensions, added coverage/tests). `path-ts/` is likewise the
pre-fork source (v1.0.0 AGPL) of the published package mailwoman depends on (v2.1.0 MIT). An agent
that "syncs the newer-looking one" from Nexus would regress mailwoman. Never port these
directions; the 2a salvage rule ("never duplicate functionality mailwoman already has") applies
with extra force to the twins.

## Superseded (skip list)

`pelias/*` and `mailwoman/sdk/pelias/*` (superseded by mailwoman's nominatim/photon drop-ins);
`mailwoman/sdk/openvenues/*` (superseded by `libpostal/`); `mailwoman/postal/*` + contacts/postal
SDKs (superseded by resolver/formatter/address-id); `browser/` (48-line DOM helper); `vaxis/`
(VS Code geodata viewer, dev tooling); `site/` (old Docusaurus site); `api/` CF-Worker tile/R2
routes (different runtime, aside from the geolocation pattern above).
