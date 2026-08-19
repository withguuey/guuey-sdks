# Smoke / live e2e

The operator-run live end-to-end gate for this package (scaffold → dev →
deploy → verify against a real environment) is maintained in the guuey
platform's private operations runbooks — it carries environment-specific
operator detail that does not belong in a public tree.

Automated smokes that ARE in this package: `scripts/scaffold-smoke.mjs`
(every template scaffolds + builds clean; runs in CI) and
`scripts/verdaccio-smoke.mjs` (publish-and-consume against a local
registry).
