# Pending migrations (not applied anywhere)

Files here are **outside** `supabase/migrations`, so `supabase db push` and
`supabase db start` never apply them. The local test scripts
(`scripts/db-test-local.sh`, `scripts/scan-e2e-local.sh`) apply them to a
temporary local database only.

- `20261016000008_fact_extraction.sql`: Stage B + C (customer facts). Built and
  tested on synthetic data. Moves to `supabase/migrations/` only after explicit
  approval to apply it to the hosted database.
- `tests/008_fact_extraction.test.sql`: its pgTAP tests (moves to
  `supabase/tests/` with it).
- Rollback: `supabase/rollback/20261016000008_fact_extraction.down.sql`.
