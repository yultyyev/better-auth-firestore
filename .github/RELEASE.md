# Release Process

Releases are automated via **semantic-release** on every push to `main`. The version bump is determined solely by the **git commit messages** that land on `main`.

## What ends up in the release notes

There is no committed `CHANGELOG.md` (the repo does not run `@semantic-release/git`), so the **GitHub Release** is the durable changelog. semantic-release builds it from the **subject line** of every `feat:` / `fix:` / `perf:` commit since the last tag — commit **bodies never render**, and `docs:` / `ci:` / `chore:` / `test:` / `refactor:` commits are hidden. Two consequences:

- Put the **user-facing impact** in the subject (`fix: make require("better-auth-firestore") work on Node >= 22.12`), not the implementation (`fix: point the CommonJS entry at the built ESM bundle`). Keep the deeper explanation in the body and the README.
- Operational steps that do not fit a subject (a data migration, an index that can be deleted) belong in the README; append them to the GitHub Release body after it is published if they matter to upgraders.

## PR title → version bump (squash merge)

With **Squash and merge**, GitHub uses the **PR title** as the squash commit subject. So the PR title controls the release — use it when the PR is one logical change. When a PR carries several release-worthy commits (a stacked integration branch), prefer **Rebase and merge** so every commit subject gets its own line in the notes; the bump is still the highest type among them. With squash, the PR title controls the release:

| PR title prefix | Result |
|-----------------|--------|
| `feat: …` | **minor** bump |
| `fix: …` / `fix(scope): …` | **patch** bump |
| `chore(security): …` | **patch** bump (custom rule) |
| `feat!: …` or commit footer `BREAKING CHANGE:` | **major** bump |
| `docs:` / `ci:` / `test:` / `chore:` / `chore(deps):` / `refactor:` | **no release** |

> With **Merge commit** or **Rebase and merge** the PR title is ignored — individual branch commit messages are used instead.

## Branches

- `main` → stable releases (`1.0.0`, `1.1.0`, …)
- `next` → pre-releases (`1.1.0-alpha.1`, …)
