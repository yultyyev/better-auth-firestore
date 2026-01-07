#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const packageJsonPath = join(rootDir, 'package.json');

// Check for dry-run flag
const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');

// Get current branch/HEAD
let originalRef = 'main';
try {
  originalRef = execSync('git rev-parse --abbrev-ref HEAD', { 
    encoding: 'utf8', 
    cwd: rootDir 
  }).trim();
  if (originalRef === 'HEAD') {
    // We're in detached HEAD state, get the commit hash
    originalRef = execSync('git rev-parse HEAD', { 
      encoding: 'utf8', 
      cwd: rootDir 
    }).trim();
  }
} catch (error) {
  console.warn('Could not determine current git ref, defaulting to main');
  originalRef = 'main';
}

console.log(`Current git ref: ${originalRef}`);
console.log('Stashing local changes...\n');

// Stash any uncommitted changes
let hasStash = false;
try {
  const status = execSync('git status --porcelain', { encoding: 'utf8', cwd: rootDir }).trim();
  if (status) {
    execSync('git stash push -m "Temporary stash for unscoped publish"', { stdio: 'pipe', cwd: rootDir });
    hasStash = true;
    console.log('✅ Stashed local changes\n');
  }
} catch (error) {
  // Ignore if stash fails
}

console.log('Checking out v1.0.0 tag...\n');

let originalVersion = '0.0.0-development';
try {
  // Checkout v1.0.0 tag
  execSync('git checkout v1.0.0', { stdio: 'inherit', cwd: rootDir });

  // Read package.json from v1.0.0
  let pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const originalName = pkg.name;
  originalVersion = pkg.version;

  console.log(`Package at v1.0.0: ${originalName}@${originalVersion}`);
  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be published\n');
  } else {
    console.log('Publishing unscoped version...\n');
  }

  // Temporarily change to unscoped name and set version to 1.0.0
  pkg.name = 'better-auth-firestore';
  pkg.version = '1.0.0';
  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');

  console.log('Building package...');
  execSync('pnpm run build', { stdio: 'inherit', cwd: rootDir });

  if (isDryRun) {
    console.log('\n🔍 Dry run: Would publish to npm...');
    execSync('npm publish --access public --dry-run', { stdio: 'inherit', cwd: rootDir });
    console.log('\n✅ Dry run completed successfully');
  } else {
    console.log('\nPublishing to npm...');
    execSync('npm publish --access public', { stdio: 'inherit', cwd: rootDir });
    console.log('\n✅ Successfully published better-auth-firestore@1.0.0');
  }
} catch (error) {
  console.error('\n❌ Error during publish:', error.message);
  throw error;
} finally {
  // Restore original package.json (if we modified it) before checking out
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (pkg.name === 'better-auth-firestore') {
      // Restore original name and version from the tag
      pkg.name = '@yultyyev/better-auth-firestore';
      pkg.version = originalVersion;
      writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
    }
  } catch (error) {
    // Ignore errors in cleanup
  }

  // Discard any changes to package.json before checking out
  try {
    execSync('git checkout -- package.json', { stdio: 'pipe', cwd: rootDir });
  } catch (error) {
    // Ignore if git checkout fails
  }

  // Checkout back to original branch
  console.log(`\nChecking out back to ${originalRef}...`);
  try {
    execSync(`git checkout ${originalRef}`, { stdio: 'inherit', cwd: rootDir });
    
    // Restore stashed changes if any
    if (hasStash) {
      console.log('Restoring stashed changes...');
      try {
        execSync('git stash pop', { stdio: 'pipe', cwd: rootDir });
        console.log('✅ Restored stashed changes');
      } catch (error) {
        console.warn('⚠️  Could not restore stashed changes (may have conflicts)');
      }
    }
    
    console.log('✅ Restored original git state');
  } catch (error) {
    console.error(`⚠️  Warning: Could not checkout back to ${originalRef}`);
    console.error('Please manually checkout your branch.');
  }
}

