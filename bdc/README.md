# @mailwoman/bdc

FCC Broadband Data Collection (BDC) availability data — fetch, parse, and ingest provider data, and the `bdc.db` layer reader. See the implementation plan at `.superpowers/sdd/2026-07-30-bdc-2a-plan/` for the spec. This workspace is a **data provider** — it reads/ingests raw BDC data and produces a queryable spatial layer; it is not part of the address parser itself.
