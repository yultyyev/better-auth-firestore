# Release Process

## How Versioning Works

Semantic-release automatically determines version bumps based on your commit messages using **Conventional Commits**.

### Version Bump Rules:

- `feat:` → **Minor** version bump (1.0.0 → 1.1.0)
  - Example: `feat: add user filtering`
  
- `fix:` → **Patch** version bump (1.0.0 → 1.0.1)
  - Example: `fix: correct timestamp conversion`
  
- `BREAKING CHANGE:` or `!` → **Major** version bump (1.0.0 → 2.0.0)
  - Example: `feat!: change API interface` 
  - Or in footer: `BREAKING CHANGE: renamed adapter config`

- No releasable changes → No version bump (skip release)

### Release Workflow:

1. **Commit** with conventional commit format:
   ```bash
   git commit -m "feat: add new feature"
   ```

2. **Push to `main` branch**:
   ```bash
   git push origin main
   ```

3. **GitHub Actions automatically**:
   - Runs tests and linting
   - Builds the package
   - Runs semantic-release which:
     - Analyzes commits since last release
     - Determines new version
     - Updates `package.json` version
     - Generates/updates `CHANGELOG.md`
     - Publishes to npm
     - Creates GitHub release
     - Commits version bump and changelog back to repo

### Example Commit Messages:

```bash
# Minor version (1.0.0 → 1.1.0)
feat: add session caching

# Patch version (1.0.0 → 1.0.1)  
fix: handle null timestamps correctly

# Major version (1.0.0 → 2.0.0)
feat!: rename adapter config option
# or
feat: new API
BREAKING CHANGE: removes old adapter() function

# No release (docs, refactor without breaking)
docs: update README
chore: update dependencies
refactor: remove unused code
```

### Release Branches:

- `main` → Stable releases (1.0.0, 1.1.0, 2.0.0, etc.)
- `next` → Pre-releases (1.1.0-alpha.1, 1.1.0-alpha.2, etc.)

### ⚠️ Important: Force Pushing

**Avoid force pushing to `main` or `next` branches** after semantic-release has created tags:

- Force pushing can rewrite commit history, causing tags to point to wrong commits
- If you must force push, delete any affected tags first:
  ```bash
  git push origin :refs/tags/v1.0.0  # Delete tag
  ```
- Better: Use `--force-with-lease` to prevent accidental history rewrites
- Best: Avoid force pushing on release branches entirely

