#!/usr/bin/env node

import { execSync } from 'child_process';

const deprecationMessage = "Package deprecated. Please use 'better-auth-firestore' instead. See https://github.com/yultyyev/better-auth-firestore for migration details.";

console.log('Deprecating @yultyyev/better-auth-firestore...\n');

try {
  execSync(
    `npm deprecate @yultyyev/better-auth-firestore "${deprecationMessage}"`,
    { stdio: 'inherit' }
  );
  console.log('\n✅ Successfully deprecated @yultyyev/better-auth-firestore');
} catch (error) {
  console.error('\n❌ Error deprecating package:', error.message);
  throw error;
}

