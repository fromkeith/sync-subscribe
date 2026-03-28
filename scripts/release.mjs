#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const bump = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('Usage: node scripts/release.mjs [patch|minor|major]');
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

function bumpVersion(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Find all publishable packages (have a name that isn't private)
const packagesDir = resolve(root, 'packages');
const pkgJsonPaths = readdirSync(packagesDir)
  .filter((dir) => statSync(resolve(packagesDir, dir)).isDirectory())
  .map((dir) => resolve(packagesDir, dir, 'package.json'))
  .filter((p) => {
    try { return !JSON.parse(readFileSync(p, 'utf8')).private; } catch { return false; }
  });

// Bump each package.json
let newVersion;
for (const pkgPath of pkgJsonPaths) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = bumpVersion(pkg.version, bump);
  newVersion = pkg.version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${pkg.name} → ${pkg.version}`);
}

// Stage, commit, tag
const pkgFiles = pkgJsonPaths.map((p) => p.replace(root + '\\', '').replace(root + '/', '')).join(' ');
run(`git add ${pkgFiles}`);
run(`git commit -m "chore: release v${newVersion}"`);
run(`git tag v${newVersion}`);

console.log(`\nTagged v${newVersion}. To publish, run:`);
console.log('  git push origin master --tags');
