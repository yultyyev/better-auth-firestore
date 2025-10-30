# npm Publishing Setup

## Recommended: Trusted Publishers (OIDC) - No Token Required! ✅

GitHub Actions supports npm Trusted Publishers natively. This is the **recommended approach** as it:
- ✅ Eliminates token rotation (tokens expire after 7-90 days)
- ✅ No secrets to manage
- ✅ Automatic provenance attestation
- ✅ More secure (temporary, job-specific credentials)

### Setup Steps:

1. Go to https://www.npmjs.com/settings/YOUR_USERNAME/verified-publishers
2. Click "Add GitHub Actions workflow"
3. Enter your GitHub username/organization: `yultyyev`
4. Enter repository: `better-auth-firestore`
5. Enter workflow file: `.github/workflows/release.yml`
6. Click "Add"

That's it! No `NPM_TOKEN` secret needed. The workflow is already configured with `id-token: write` permission.

---

## Alternative: Granular Access Token (if Trusted Publishers doesn't work)

If you need to use a token (e.g., for older npm tooling or if Trusted Publishers has issues):

### Step-by-Step Token Creation:

1. Go to https://www.npmjs.com/settings/YOUR_USERNAME/tokens
2. Click "Generate New Token" → **"Generate New Granular Access Token"**

3. Fill out the form you're seeing:

   **General Section:**
   - **Token name** (required): `better-auth-firestore-ci`
   - **Description** (optional): `CI/CD token for automated releases`
   - **Expiration** (required): 
     - Maximum allowed: **90 days** (new npm security limit)
     - Recommended: Choose 30-60 days for regular rotation
     - Example: Pick a date like `November 28, 2025`
   - **Allowed IP ranges**: Leave empty (GitHub Actions uses dynamic IPs, so CIDR restriction won't work)

   **Packages and scopes Section:**
   - Click to expand and select your package
   - Find and select: **`better-auth-firestore`**
   - For this package, set permissions:
     - ✅ **Read packages** - Required to check package existence
     - ✅ **Write packages** - Required to publish new versions
   - Make sure both permissions are checked

   **Organizations Section:**
   - If your package is under a personal account (not an org): Leave as "Provide no access to organizations"
   - Only add organizations if your package belongs to one

4. Check the **Summary** section:
   - Should show: "Write access to: better-auth-firestore" (or similar)
   - Verify expiration date is correct

5. Click **"Generate Token"**

6. **⚠️ IMPORTANT**: Copy the token immediately (starts with `npm_...`). You'll only see it once!

7. Add token to GitHub Secrets:
   - Go to: `https://github.com/yultyyev/better-auth-firestore/settings/secrets/actions`
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: Paste the token
   - Click "Add secret"

**Note**: Set a calendar reminder to rotate this token before it expires (every 30-90 days).

---

## Why Not Classic Tokens?

According to [npm's security announcement](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/):
- Classic tokens will be **revoked by mid-November 2025**
- They lack granular permissions
- Higher security risk if compromised

