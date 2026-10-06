# Verification — 2026-10-04

## Full browser acceptance gate — 2026-10-06

The standard workflow now also runs `npx playwright test --config playwright.import.config.ts` against its built, telemetry-disabled FakeRest demo. The complete flow includes cancel-without-write, duplicate/invalid classification, deselection, two creations, downloaded six-row results and a repeat preview that marks created contacts as existing. Mobile verification covers the real contact list; upstream mobile has no import-review control.

Local build and TypeScript checks passed. The final full-browser scenario passed, then passed two consecutive fresh-context repetitions (20.1 seconds total). The harness captures the dialog directly: full-page screenshots can resize responsive layouts and are inappropriate inside this modal workflow. No application behavior or provider implementation was altered to pass the test.

CI uploads JUnit, screenshots, video, downloaded results and failure traces under `contact-import-browser-evidence` for 14 days. Hosted success must be checked on the actual commit; this paragraph records local evidence only.

## Historical baseline

Environment: Windows, Node 24.15.0, npm 11.12.1. Upstream baseline `b23289b46734d796e74edd3ef224cbf23792ff82`; lockfile installation, no live Supabase project.

| Check | Observed result |
| --- | --- |
| Contact import suites, real Chromium | PASS — 5 files / 55 tests after the final date-validation change |
| TypeScript typecheck | PASS |
| ESLint on changed application files | PASS; upstream ESLint ignore-file deprecation warning |
| Demo build | PASS; upstream large-chunk and Tailwind sourcemap warnings |
| Manual browser demonstration | 6 synthetic records → 2 created, 4 skipped, 0 requiring checking |
| Wider upstream application suite before the final extra calendar-date case | 223 passed, 4 failed, 1 skipped |

The four failures in the wider run are in the unchanged `getContactAvatar.test.ts`. That suite still uses real `fetch` for Gravatar URLs and its results depend on external image responses. The import suites all passed. This is not an all-project green test result; no production correctness is inferred from it.

New coverage includes malformed/unknown headers, size bounds, case-insensitive in-file duplicates, collisions across email types, existing/multiple/conflicting records, missing identity, invalid dates including calendar rollover, phone prefixes, stale snapshot recheck, no automatic retry, stop-after-current-record, no contact/company/tag writes during preview/cancel, and repeat-import skip behavior.

Limits: no live Supabase verification, no multi-user transaction/lock, no global uniqueness assurance, no rollback of company/tag creation if a contact fails, no production load test. Snapshot scans see only records available to the current account. The original importer remains alongside the new review workflow.

Upstream automation files were moved to inert documentation. The active workflow only installs, tests, typechecks and builds. It does not deploy, message upstream maintainers or use paid AI services.
