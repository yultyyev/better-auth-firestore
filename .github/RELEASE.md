# Release Process

Releases are automated via **semantic-release** on every push to `main`. The version bump is determined solely by the **git commit messages** that land on `main`.

## PR title → version bump (squash merge)

With **Squash and merge** (recommended), GitHub uses the **PR title** as the squash commit subject. So the PR title controls the release:

| PR title prefix | Result |
|-----------------|--------|
| `feat: …` | **minor** bump |
| `fix: …` / `fix(scope): …` | **patch** bump |
| `chore(deps): …` / `chore(security): …` | **patch** bump (custom rule) |
| `feat!: …` or commit footer `BREAKING CHANGE:` | **major** bump |
| `docs:` / `ci:` / `test:` / `chore:` / `refactor:` | **no release** |

> With **Merge commit** or **Rebase and merge** the PR title is ignored — individual branch commit messages are used instead.

## Branches

- `main` → stable releases (`1.0.0`, `1.1.0`, …)
- `next` → pre-releases (`1.1.0-alpha.1`, …)
