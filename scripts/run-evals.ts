#!/usr/bin/env bun

/**
 * Run next-evals-oss in our project environment
 *
 * 1. Fetches eval prompt + tests from next-evals-oss
 * 2. Runs the task in THIS project (with our full stack)
 * 3. Runs our lint (Biome) + eval tests
 * 4. Reports results to compare against public baseline
 */

import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const EVALS_REPO = "https://github.com/vercel/next-evals-oss.git";
const EVALS_CACHE = join(import.meta.dirname, "../.evals-cache");
const PROJECT_ROOT = join(import.meta.dirname, "..");

interface EvalResult {
  name: string;
  build: boolean;
  lint: boolean;
  tests: boolean;
  duration: number;
  error?: string;
}

async function fetchEvals(): Promise<void> {
  console.log("🔄 Fetching latest next-evals-oss...");

  if (existsSync(EVALS_CACHE)) {
    await $`cd ${EVALS_CACHE} && git pull --ff-only`.quiet();
  } else {
    await $`git clone --depth 1 ${EVALS_REPO} ${EVALS_CACHE}`.quiet();
  }
}

function listEvals(): string[] {
  const evalsDir = join(EVALS_CACHE, "evals");
  if (!existsSync(evalsDir)) return [];

  const entries = Bun.spawnSync(["ls", evalsDir]).stdout.toString().trim();
  return entries.split("\n").filter((e) => /^\d{3}-/.test(e));
}

function getEvalPrompt(evalName: string): string {
  const promptPath = join(EVALS_CACHE, "evals", evalName, "prompt.md");
  if (!existsSync(promptPath)) {
    throw new Error(`Eval ${evalName} not found`);
  }
  return readFileSync(promptPath, "utf-8").trim();
}

function getEvalTestFiles(evalName: string): string[] {
  const inputDir = join(EVALS_CACHE, "evals", evalName, "input");
  if (!existsSync(inputDir)) return [];

  // Find all test files
  const result = Bun.spawnSync(["find", inputDir, "-name", "*.test.*"]);
  return result.stdout.toString().trim().split("\n").filter(Boolean);
}

async function runEval(evalName: string, debug: boolean): Promise<EvalResult> {
  const startTime = Date.now();
  const result: EvalResult = {
    name: evalName,
    build: false,
    lint: false,
    tests: false,
    duration: 0,
  };

  const prompt = getEvalPrompt(evalName);
  const testFiles = getEvalTestFiles(evalName);

  console.log(`\n📝 Prompt: ${prompt.substring(0, 100)}...`);
  console.log(`📋 Test files: ${testFiles.length}`);

  // Stash any current changes
  console.log("\n💾 Stashing current changes...");
  await $`cd ${PROJECT_ROOT} && git stash --include-untracked`
    .quiet()
    .nothrow();

  try {
    // Copy test files to our project
    const inputDir = join(EVALS_CACHE, "evals", evalName, "input");
    for (const testFile of testFiles) {
      const relativePath = testFile.replace(inputDir + "/", "");
      const destPath = join(PROJECT_ROOT, relativePath);
      const destDir = join(destPath, "..");
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
      }
      cpSync(testFile, destPath);
      console.log(`  Copied: ${relativePath}`);
    }

    // Also copy any stub files that need to be modified
    const stubFiles = Bun.spawnSync([
      "find",
      inputDir,
      "-name",
      "*.tsx",
      "-o",
      "-name",
      "*.ts",
    ]);
    for (const stubFile of stubFiles.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)) {
      if (stubFile.includes(".test.")) continue; // Skip test files
      const relativePath = stubFile.replace(inputDir + "/", "");
      const destPath = join(PROJECT_ROOT, relativePath);
      // Only copy if it doesn't exist (don't overwrite our files)
      if (!existsSync(destPath)) {
        const destDir = join(destPath, "..");
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }
        cpSync(stubFile, destPath);
        console.log(`  Copied stub: ${relativePath}`);
      }
    }

    // Run Claude Code with the prompt
    console.log("\n🤖 Running Claude Code...");
    const claudePrompt = `${prompt}

IMPORTANT: This is the opinionated-next project. Use the existing project structure.
- Use Biome for linting (not ESLint)
- Use explicit .ts extensions in imports
- Use subpath imports (#/) when importing from src/
Do not run any package manager or build commands.`;

    const claudeResult =
      await $`cd ${PROJECT_ROOT} && claude --print --dangerously-skip-permissions ${claudePrompt}`
        .quiet()
        .nothrow();

    if (debug) {
      console.log("\n📝 Claude output:");
      console.log(claudeResult.stdout.toString());
    }

    // Run build
    console.log("\n🔨 Running build...");
    const buildResult = await $`cd ${PROJECT_ROOT} && bun run build`
      .quiet()
      .nothrow();
    result.build = buildResult.exitCode === 0;
    console.log(result.build ? "  ✅ Build passed" : "  ❌ Build failed");

    if (!result.build && debug) {
      console.log("\n📋 Build output:");
      console.log(buildResult.stdout.toString());
      console.log(buildResult.stderr.toString());
    }

    // Run lint
    console.log("🔍 Running lint...");
    const lintResult = await $`cd ${PROJECT_ROOT} && bun x ultracite check`
      .quiet()
      .nothrow();
    result.lint = lintResult.exitCode === 0;
    console.log(result.lint ? "  ✅ Lint passed" : "  ❌ Lint failed");

    if (!result.lint && debug) {
      console.log("\n📋 Lint output:");
      console.log(lintResult.stdout.toString());
      console.log(lintResult.stderr.toString());
    }

    // Run tests
    if (testFiles.length > 0) {
      console.log("🧪 Running tests...");
      // Install vitest if needed
      await $`cd ${PROJECT_ROOT} && bun add -d vitest @testing-library/react`
        .quiet()
        .nothrow();

      // Get relative paths for the copied test files
      const inputDir = join(EVALS_CACHE, "evals", evalName, "input");
      const testPaths = testFiles.map((f) => f.replace(inputDir + "/", ""));
      console.log(`  Running: ${testPaths.join(", ")}`);

      // Use Bun.spawn to properly pass test paths as arguments
      const testProc = Bun.spawn(
        ["bun", "vitest", "run", ...testPaths, "--reporter=verbose"],
        {
          cwd: PROJECT_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      await testProc.exited;
      const testStdout = await new Response(testProc.stdout).text();
      const testStderr = await new Response(testProc.stderr).text();
      result.tests = testProc.exitCode === 0;
      console.log(result.tests ? "  ✅ Tests passed" : "  ❌ Tests failed");

      if (!result.tests && debug) {
        console.log("\n📋 Test output:");
        console.log(testStdout);
        console.log(testStderr);
      }
    } else {
      result.tests = true; // No tests to run
      console.log("  ⏭️  No tests to run");
    }
  } catch (err) {
    result.error = String(err);
    console.error(`\n❌ Error: ${err}`);
  } finally {
    // Restore original state
    console.log("\n🔄 Restoring original state...");
    await $`cd ${PROJECT_ROOT} && git checkout -- .`.quiet().nothrow();
    await $`cd ${PROJECT_ROOT} && git clean -fd`.quiet().nothrow();
    await $`cd ${PROJECT_ROOT} && git stash pop`.quiet().nothrow();
  }

  result.duration = (Date.now() - startTime) / 1000;
  return result;
}

function printResults(results: EvalResult[]): void {
  console.log("\n" + "═".repeat(80));
  console.log("📊 Results");
  console.log("═".repeat(80));
  console.log(
    "| Eval                           | Result | Build | Lint | Tests | Time   |"
  );
  console.log(
    "|--------------------------------|--------|-------|------|-------|--------|"
  );

  for (const r of results) {
    const passed = r.build && r.lint && r.tests;
    const status = passed ? "✅ PASS" : "❌ FAIL";
    const build = r.build ? "✅" : "❌";
    const lint = r.lint ? "✅" : "❌";
    const tests = r.tests ? "✅" : "❌";
    const time = `${r.duration.toFixed(1)}s`;
    console.log(
      `| ${r.name.padEnd(30)} | ${status} | ${build}    | ${lint}   | ${tests}    | ${time.padStart(6)} |`
    );
  }
  console.log("═".repeat(80));

  const passed = results.filter((r) => r.build && r.lint && r.tests).length;
  console.log(`\n✨ ${passed}/${results.length} evals passed`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runAll = args.includes("--all");
  const debug = args.includes("--debug");
  const evalName = args.find((a) => !a.startsWith("--"));

  await fetchEvals();

  const evals = listEvals();
  console.log(`📦 Found ${evals.length} evals`);

  if (!(runAll || evalName)) {
    console.log("\nUsage:");
    console.log("  bun run evals <eval-name>    Run specific eval");
    console.log("  bun run evals --all          Run all evals");
    console.log("  bun run evals --debug        Show verbose output");
    console.log("\nAvailable evals:");
    for (const e of evals.slice(0, 10)) {
      console.log(`  ${e}`);
    }
    console.log(`  ... and ${evals.length - 10} more`);
    return;
  }

  const evalsToRun = runAll ? evals : [evalName!];
  const results: EvalResult[] = [];

  for (const name of evalsToRun) {
    console.log("\n" + "─".repeat(80));
    console.log(`🚀 Running eval: ${name}`);
    console.log("─".repeat(80));

    const result = await runEval(name, debug);
    results.push(result);
  }

  printResults(results);
}

main().catch(console.error);
