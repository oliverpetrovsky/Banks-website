# Handoff — 2026-11-14

## Current Request
The user asked to change Round 1 bank-money settlements from 10-year decades to 25-year periods, then requested three Bloodlines improvements: distinct Wheel outcomes per team, no growth on uninvested cash, and return ranges visible beside investment options. They asked for this handoff before the context/token limit.

## Round 1: Source Work Done
The tracked source is partially converted to four 25-year periods per 100-year era:

- `server.js` now validates a `period` company field containing four consecutive 25-year ranges per era.
- Settlement compounds idle Round 1 cash at 4% for 25 years, pays company interest for 25 years, processes up to 25 scheduled loan installments, and returns company principal after period four of each era.
- Fast-forward now skips through the first three periods of Era 3 and leaves period four open. Skipped companies are marked uninvested; pending loan requests expire.
- Banking save schema is v2. An untouched v1 save is migrated; a save with financial activity is rejected with a clear reset/backup error rather than reinterpreted.
- `data/test.json` and `final-site/data/test.json` were reassigned to four 25-year periods per era. `README.md` documents the new cadence.
- Root `admin.html`, `admin.js`, and `team.js` have period-oriented labels and endpoints.

## Validation Done
- Root source scripts pass `node --check`.
- The synthetic fixture validated as three eras with four periods each.
- A temporary-server smoke test passed: banking setup accepted the fixture; fast-forward ran 11 settlements to Era 3 period four; a 19-year active loan was repaid at the first 25-year checkpoint; a pending request expired; the final period remained open.
- This smoke test used `/tmp` stores only; no event store was changed.

## Important Incomplete Work
1. `final-site/` is Git-ignored and is not in sync. `final-site/server.js`, `final-site/admin.js`, `final-site/team.js`, and `final-site/bloodlines-engine.js` differ from root. Sync all of these before considering the deploy copy usable. `final-site/admin.html`, `app.css`, `README.md`, and `data/test.json` were matching at the last comparison, but recheck.
2. The real event company dataset must be converted to the new `period` field with exactly four consecutive 25-year periods per era. Existing production data may still use the old `decade` field. Do not edit or overwrite the private event dataset without inspection/backups.
3. The old-save guard has not been integration-tested. Test both an untouched v1 store (should migrate) and a progressed v1 store (should reject without altering it).
4. Round 1 fast-forward was tested on root source, not on `final-site`.
5. Root `admin.html` still has one stale paragraph saying “active decade” (search output at `admin.html` around the auction instructions); update it to “active 25-year period.”

## Bloodlines Follow-Ups Not Implemented Yet
- Wheel currently picks a random event independently with replacement. Proposed behavior: shuffle the seven existing event types and deal without replacement until all seven have been used, then reshuffle; prevent the cycle boundary from repeating the last event. More than seven teams means repeats are inevitable. Store the order privately per sub-round and do not expose future events to teams.
- Bloodlines cash has no idle-cash interest. `processYear` changes cash through salary, equity dividends, household expenses, loan repayment, FD maturity, insurance, and Wheel events. The user may be seeing salary/dividend/FD cashflows, not interest. Explain this distinction; only alter those cashflows if they explicitly want them removed.
- Return ranges currently appear in the participant market/returns panel, but the latest request asks for them directly beside each investment choice. Update `team.js` investment selector option labels to include the participant-visible range (`9%` for 9–9, `12-15%` for a span); never expose actual returns.

## Existing Bloodlines Work To Preserve
The prior task added admin-set displayed return ranges plus private actual annual returns, editable numeric percentage-point shifts on news, and server-side price changes using actual return plus cumulative news shifts. Participants receive only shifted ranges; admins see actuals. It also added “assume no allocation/reallocation” handling. Root and deploy Bloodlines engine/UI copies may currently differ, so compare before editing and sync deliberately.

## Render / Secret Data Notes
- Root `render.yaml` is configured as the event deployment with `/var/data` persistence and secret-file paths; `final-site/` is ignored by Git.
- The real event market file is still missing. `data/bloodlines-test-market.json` is test-only.
- A previous smoke check found `final-site/data/real-company-list.json` does not satisfy the Round 1 company schema. Validate the real file before upload.
- Never expose or commit `initial-team-access-codes.csv`, secret company/market files, or credentials. Replace the previously exposed admin password before hosting.

## Resume Instructions
Start with `git status --short`, compare root and `final-site` copies, and inspect current files before applying patches. Do not reset/revert the worktree. Finish root period UI wording, test the migration guard, sync `final-site`, then implement and test the three Bloodlines follow-ups. Keep all test stores under `/tmp`.
