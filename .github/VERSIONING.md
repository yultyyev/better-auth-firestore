# Semantic Release Versioning

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

- No releaseable changes → No version bump (skip release)

### First Release:

Since this is the first release, a `feat:` commit will create **v1.0.0**.

### Workflow:

1. **You commit** with conventional commit format:
   ```bash
   git commit -m "feat: initial Firestore adapter"
   ```

2. **Push to `main` branch**:
   ```bash
   git push origin main
   ```

3. **GitHub Actions automatically**:
   - Runs tests
   - Builds the package
   - Runs semantic-release which:
     - Analyzes commits since last release (or initial commit)
     - Determines new version (e.g., 1.0.0 for first `feat:`)
     - Updates `package.json` version
     - Generates/updates `CHANGELOG.md`
     - Publishes to npm
     - Creates GitHub release
     - Commits version bump and changelog back to repo

4. **Done!** Package is on npm 🎉

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
```

### Release Branches:

- `main` → Stable releases (1.0.0, 1.1.0, 2.0.0, etc.)
- `next` → Pre-releases (1.1.0-alpha.1, 1.1.0-alpha.2, etc.)

