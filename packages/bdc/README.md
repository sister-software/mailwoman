# @mailwoman/bdc

FCC Broadband Data Collection (BDC) availability data — fetch, parse, and ingest provider data, and the `bdc.db` layer reader. See the implementation plan at `.superpowers/sdd/2026-07-30-bdc-2a-plan/` for the spec. This workspace is a **data provider** — it reads/ingests raw BDC data and produces a queryable spatial layer; it is not part of the address parser itself.

## CostQuest Fabric boundary

The BDC Fabric (the BSL `location_id` → rooftop point/parcel map) is CostQuest-licensed. This workspace never ingests, ships, or derives data from the Fabric: `location_id` is carried only as an opaque join key that a licensed user may join against their own Fabric copy. All spatial work happens at census-block granularity plus mailwoman's own address spine.
