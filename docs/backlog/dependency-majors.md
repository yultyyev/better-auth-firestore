# Dependency majors not yet taken

Left out of the 2026-10-17 `chore(deps)` bump, which stayed within current majors.
No package was held back inside its major.

## Library (`package.json`)

- `@semantic-release/changelog` 6.0.3 → 7.0.0
- `firebase-admin` (dev) 13.10.0 → 14.5.0 — the `>=13` peer range already admits 14
- `typescript` (dev) 5.9.3 → 7.0.2 — CI already typechecks and builds under 5, 6 and 7
- `vitest` 4.1.12 → 5.0.5

## Example (`examples/minimal/package.json`)

- `@types/node` 20.19.43 → 26.6.5
- `eslint` 9.39.5 → 10.13.0
- `firebase-admin` 13.10.0 → 14.5.0
- `typescript` 5.9.3 → 7.0.2
