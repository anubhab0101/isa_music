#!/usr/bin/env node
/**
 * Master E2E & Tiered Test Suite Runner for ISA Music
 *
 * Runs all test tiers:
 * - Acceptance Criteria Tests (tests/acceptance/*.test.js)
 * - Tier 1: Feature Coverage (tests/tier1_features/*.test.js)
 * - Tier 2: Boundary & Corner Cases (tests/tier2_boundaries/*.test.js)
 * - Tier 3: Cross-Feature Combinations (tests/tier3_combinations/*.test.js)
 * - Tier 4: Real-World Workloads (tests/tier4_workloads/*.test.js)
 *
 * Usage:
 *   node tests/run_all.js                 # Run all tiers
 *   node tests/run_all.js --acceptance    # Run acceptance criteria only
 *   node tests/run_all.js --tier 1        # Run Tier 1 only
 *   TEST_MOCK_SERVER=true node tests/run_all.js  # Contract verification mode
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT_DIR = path.resolve(__dirname, '..');
const TESTS_DIR = path.resolve(__dirname);

const TIERS = [
  { name: 'Acceptance Criteria', dir: path.join(TESTS_DIR, 'acceptance'), flag: '--acceptance' },
  { name: 'Tier 1: Feature Coverage', dir: path.join(TESTS_DIR, 'tier1_features'), flag: '--tier1' },
  { name: 'Tier 2: Boundary & Corner Cases', dir: path.join(TESTS_DIR, 'tier2_boundaries'), flag: '--tier2' },
  { name: 'Tier 3: Cross-Feature Combinations', dir: path.join(TESTS_DIR, 'tier3_combinations'), flag: '--tier3' },
  { name: 'Tier 4: Real-World Workloads', dir: path.join(TESTS_DIR, 'tier4_workloads'), flag: '--tier4' }
];

const args = process.argv.slice(2);
let selectedTiers = TIERS;

if (args.includes('--acceptance')) {
  selectedTiers = TIERS.filter(t => t.flag === '--acceptance');
} else if (args.includes('--tier') || args.includes('-t')) {
  const tierIndex = args.indexOf('--tier') !== -1 ? args.indexOf('--tier') + 1 : args.indexOf('-t') + 1;
  const tierNum = args[tierIndex];
  selectedTiers = TIERS.filter(t => t.name.startsWith(`Tier ${tierNum}:`));
}

console.log('======================================================================');
console.log('  ISA Music - Comprehensive E2E & Tiered Test Suite Runner');
console.log('======================================================================');
console.log(`Execution Mode: ${process.env.TEST_MOCK_SERVER === 'true' ? 'MOCK / CONTRACT VERIFICATION' : 'LIVE / INTEGRATION'}`);
console.log(`Target Directory: ${ROOT_DIR}`);
console.log('----------------------------------------------------------------------\n');

let totalTestsRun = 0;
let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const resultsSummary = [];

for (const tier of selectedTiers) {
  if (!fs.existsSync(tier.dir)) continue;

  const testFiles = fs.readdirSync(tier.dir).filter(f => f.endsWith('.test.js'));
  console.log(`\n>>> [${tier.name}] (${testFiles.length} suites)`);

  for (const file of testFiles) {
    const fullPath = path.join(tier.dir, file);
    const relPath = path.relative(ROOT_DIR, fullPath);

    process.stdout.write(`  Running: ${file.padEnd(40)} ... `);

    const env = { ...process.env };
    const res = spawnSync(process.execPath, ['--test', fullPath], {
      env,
      encoding: 'utf8',
      cwd: ROOT_DIR
    });

    const output = (res.stdout || '') + (res.stderr || '');
    const isPass = res.status === 0;

    // Parse counts from TAP or spec output if available
    const passMatch = output.match(/pass\s+(\d+)/);
    const failMatch = output.match(/fail\s+(\d+)/);
    const skipMatch = output.match(/skipped\s+(\d+)/);

    const passes = passMatch ? parseInt(passMatch[1], 10) : (isPass ? 1 : 0);
    const fails = failMatch ? parseInt(failMatch[1], 10) : (isPass ? 0 : 1);
    const skips = skipMatch ? parseInt(skipMatch[1], 10) : 0;

    totalTestsRun += (passes + fails + skips);
    totalPassed += passes;
    totalFailed += fails;
    totalSkipped += skips;

    if (isPass) {
      console.log(`\x1b[32mPASS\x1b[0m (${passes} passed${skips > 0 ? `, ${skips} skipped` : ''})`);
      resultsSummary.push({ tier: tier.name, suite: file, status: 'PASS', passes, fails, skips });
    } else {
      console.log(`\x1b[31mFAIL\x1b[0m (${fails} failed, ${passes} passed)`);
      resultsSummary.push({ tier: tier.name, suite: file, status: 'FAIL', passes, fails, skips, errorOutput: output });
    }
  }
}

console.log('\n======================================================================');
console.log('  TEST EXECUTION SUMMARY');
console.log('======================================================================');
console.log(`Total Assertions/Tests: ${totalTestsRun}`);
console.log(`  Passed:  \x1b[32m${totalPassed}\x1b[0m`);
console.log(`  Failed:  \x1b[31m${totalFailed}\x1b[0m`);
console.log(`  Skipped: \x1b[33m${totalSkipped}\x1b[0m`);
console.log('----------------------------------------------------------------------');

const failedSuites = resultsSummary.filter(r => r.status === 'FAIL');
if (failedSuites.length > 0) {
  console.log('\nDetailed Failures / Discovered Defects:');
  for (const item of failedSuites) {
    console.log(`\n--- [${item.tier}] ${item.suite} ---`);
    // Print lines containing error/fail details
    const lines = (item.errorOutput || '').split('\n');
    const relevant = lines.filter(l => l.includes('AssertionError') || l.includes('FAIL') || l.includes('✖') || l.includes('Error:'));
    console.log(relevant.slice(0, 10).join('\n'));
  }
  console.log('\nResult: FAILED');
  process.exitCode = 1;
} else {
  console.log('\nResult: \x1b[32mALL TESTS PASSED\x1b[0m');
  process.exitCode = 0;
}
