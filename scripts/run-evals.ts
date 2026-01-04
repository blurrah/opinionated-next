#!/usr/bin/env bun

/**
 * Run next-evals-oss in our project environment
 *
 * 1. Fetches eval prompt + tests from next-evals-oss
 * 2. Runs the task in THIS project (with our full stack)
 * 3. Runs our lint (Biome) + eval tests
 * 4. Reports results to compare against public baseline
 *
 * Modes:
 * - Default: First-shot evaluation (no feedback loop)
 * - --full: Full-stack with d3k feedback loop (retry on errors)
 */

import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const EVALS_REPO = "https://github.com/vercel/next-evals-oss.git";
const EVALS_CACHE = join(import.meta.dirname, "../.evals-cache");
const PROJECT_ROOT = join(import.meta.dirname, "..");
const D3K_LOGS_DIR = join(homedir(), ".d3k/logs");
const MAX_FULL_ATTEMPTS = 3;

interface EvalResult {
  name: string;
  build: boolean;
  lint: boolean;
  tests: boolean;
  duration: number;
  attempts: number;
  mode: "first-shot" | "full";
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

// ─────────────────────────────────────────────────────────────────────────────
// D3K Feedback Loop Helpers
// ─────────────────────────────────────────────────────────────────────────────

let d3kProcess: ReturnType<typeof Bun.spawn> | null = null;

async function startD3k(): Promise<void> {
  console.log("\n🌐 Starting d3k dev server...");

  // Clear old logs
  await $`rm -rf ${D3K_LOGS_DIR}/*`.quiet().nothrow();

  d3kProcess = Bun.spawn(
    ["bun", "x", "dev3000@0.0.128", "--disable-mcp-configs", "all"],
    {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  // Wait for server to be ready (check for port 3000)
  let attempts = 0;
  while (attempts < 30) {
    try {
      const res = await fetch("http://localhost:3000", { method: "HEAD" });
      if (res.ok || res.status === 404) {
        console.log("  ✅ d3k server ready");
        return;
      }
    } catch {
      // Not ready yet
    }
    await Bun.sleep(1000);
    attempts++;
  }
  throw new Error("d3k server failed to start within 30s");
}

async function stopD3k(): Promise<void> {
  if (d3kProcess) {
    console.log("\n🛑 Stopping d3k server...");
    d3kProcess.kill();
    d3kProcess = null;
    // Give it a moment to clean up
    await Bun.sleep(500);
  }
}

function getD3kErrors(): string | null {
  if (!existsSync(D3K_LOGS_DIR)) return null;

  try {
    const logFiles = Bun.spawnSync(["ls", "-t", D3K_LOGS_DIR])
      .stdout.toString()
      .trim()
      .split("\n")
      .filter(Boolean);

    if (logFiles.length === 0) return null;

    // Read the most recent log file
    const latestLog = join(D3K_LOGS_DIR, logFiles[0]);
    const logContent = readFileSync(latestLog, "utf-8");

    // Look for errors in the log
    const errorPatterns = [
      /Error:/gi,
      /Unhandled Runtime Error/gi,
      /TypeError:/gi,
      /ReferenceError:/gi,
      /SyntaxError:/gi,
      /Build Error/gi,
      /Failed to compile/gi,
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(logContent)) {
        // Extract relevant error context (last 50 lines or so)
        const lines = logContent.split("\n");
        const relevantLines = lines.slice(-50).join("\n");
        return relevantLines;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function getD3kScreenshot(): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:24678/screenshot");
    if (!res.ok) return null;

    const screenshotPath = join(PROJECT_ROOT, ".debug/screenshot.png");
    mkdirSync(join(PROJECT_ROOT, ".debug"), { recursive: true });
    await Bun.write(screenshotPath, await res.arrayBuffer());
    return screenshotPath;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Eval Runners
// ─────────────────────────────────────────────────────────────────────────────

async function runEval(evalName: string, debug: boolean): Promise<EvalResult> {
  const startTime = Date.now();
  const result: EvalResult = {
    name: evalName,
    build: false,
    lint: false,
    tests: false,
    duration: 0,
    attempts: 1,
    mode: "first-shot",
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

IMPORTANT: Do not run npm, pnpm, yarn, bun, or any package manager commands. Dependencies have already been installed. Do not run build, test, or dev server commands. Just write the code files. DO NOT ask any followup questions either.

This is the opinionated-next project. Use the existing project structure:
- Use Biome for linting (not ESLint)
- Use explicit file extensions in imports (.ts for TypeScript, .tsx for TSX/JSX files)
- Use subpath imports (#/) only when importing from src/ directory`;

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
      await $`cd ${PROJECT_ROOT} && bun add -d vitest @testing-library/react jsdom`
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

async function runEvalFull(
  evalName: string,
  debug: boolean
): Promise<EvalResult> {
  const startTime = Date.now();
  const result: EvalResult = {
    name: evalName,
    build: false,
    lint: false,
    tests: false,
    duration: 0,
    attempts: 0,
    mode: "full",
  };

  const basePrompt = getEvalPrompt(evalName);
  const testFiles = getEvalTestFiles(evalName);

  console.log(`\n📝 Prompt: ${basePrompt.substring(0, 100)}...`);
  console.log(`📋 Test files: ${testFiles.length}`);
  console.log(
    `🔄 Mode: Full-stack with d3k feedback (max ${MAX_FULL_ATTEMPTS} attempts)`
  );

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

    // Copy stub files
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
      if (stubFile.includes(".test.")) continue;
      const relativePath = stubFile.replace(inputDir + "/", "");
      const destPath = join(PROJECT_ROOT, relativePath);
      if (!existsSync(destPath)) {
        const destDir = join(destPath, "..");
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }
        cpSync(stubFile, destPath);
        console.log(`  Copied stub: ${relativePath}`);
      }
    }

    // Start d3k for feedback loop
    await startD3k();

    let feedbackContext = "";

    // Retry loop
    for (let attempt = 1; attempt <= MAX_FULL_ATTEMPTS; attempt++) {
      result.attempts = attempt;
      console.log(`\n${"─".repeat(40)}`);
      console.log(`🔁 Attempt ${attempt}/${MAX_FULL_ATTEMPTS}`);
      console.log("─".repeat(40));

      // Build prompt with feedback if available
      let claudePrompt = `${basePrompt}

IMPORTANT: Do not run npm, pnpm, yarn, bun, or any package manager commands. Dependencies have already been installed. Do not run build, test, or dev server commands. Just write the code files. DO NOT ask any followup questions either.

This is the opinionated-next project. Use the existing project structure:
- Use Biome for linting (not ESLint)
- Use explicit file extensions in imports (.ts for TypeScript, .tsx for TSX/JSX files)
- Use subpath imports (#/) only when importing from src/ directory`;

      if (feedbackContext) {
        claudePrompt += `

PREVIOUS ATTEMPT FAILED. Here's the error from the browser/build:
${feedbackContext}

Please fix the issue and try again.`;
      }

      // Run Claude Code
      console.log("\n🤖 Running Claude Code...");
      const claudeResult =
        await $`cd ${PROJECT_ROOT} && claude --print --dangerously-skip-permissions ${claudePrompt}`
          .quiet()
          .nothrow();

      if (debug) {
        console.log("\n📝 Claude output:");
        console.log(claudeResult.stdout.toString());
      }

      // Wait a moment for d3k to pick up changes
      await Bun.sleep(2000);

      // Check for browser errors
      const browserErrors = getD3kErrors();
      if (browserErrors && debug) {
        console.log("\n🌐 Browser errors detected:");
        console.log(browserErrors.substring(0, 500));
      }

      // Run build
      console.log("\n🔨 Running build...");
      const buildResult = await $`cd ${PROJECT_ROOT} && bun run build`
        .quiet()
        .nothrow();
      result.build = buildResult.exitCode === 0;
      console.log(result.build ? "  ✅ Build passed" : "  ❌ Build failed");

      if (!result.build) {
        feedbackContext = `Build failed:\n${buildResult.stderr.toString()}\n${buildResult.stdout.toString()}`;
        if (attempt < MAX_FULL_ATTEMPTS) continue;
      }

      // Run lint
      console.log("🔍 Running lint...");
      const lintResult = await $`cd ${PROJECT_ROOT} && bun x ultracite check`
        .quiet()
        .nothrow();
      result.lint = lintResult.exitCode === 0;
      console.log(result.lint ? "  ✅ Lint passed" : "  ❌ Lint failed");

      if (!result.lint) {
        feedbackContext = `Lint failed:\n${lintResult.stderr.toString()}\n${lintResult.stdout.toString()}`;
        if (attempt < MAX_FULL_ATTEMPTS) continue;
      }

      // Run tests
      if (testFiles.length > 0) {
        console.log("🧪 Running tests...");
        await $`cd ${PROJECT_ROOT} && bun add -d vitest @testing-library/react jsdom`
          .quiet()
          .nothrow();

        const testPaths = testFiles.map((f) => f.replace(inputDir + "/", ""));
        console.log(`  Running: ${testPaths.join(", ")}`);

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

        if (!result.tests) {
          // Include browser errors in feedback if available
          const allErrors = [testStdout, testStderr];
          if (browserErrors) {
            allErrors.push(`\nBrowser console errors:\n${browserErrors}`);
          }
          feedbackContext = `Tests failed:\n${allErrors.join("\n")}`;
          if (attempt < MAX_FULL_ATTEMPTS) continue;
        }
      } else {
        result.tests = true;
        console.log("  ⏭️  No tests to run");
      }

      // If we got here and everything passed, we're done!
      if (result.build && result.lint && result.tests) {
        console.log(`\n✨ Passed on attempt ${attempt}!`);
        break;
      }
    }
  } catch (err) {
    result.error = String(err);
    console.error(`\n❌ Error: ${err}`);
  } finally {
    // Stop d3k
    await stopD3k();

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
  const isFullMode = results.some((r) => r.mode === "full");

  console.log("\n" + "═".repeat(88));
  console.log(
    `📊 Results ${isFullMode ? "(Full Mode with d3k)" : "(First-Shot)"}`
  );
  console.log("═".repeat(88));

  if (isFullMode) {
    console.log(
      "| Eval                           | Result | Build | Lint | Tests | Tries | Time   |"
    );
    console.log(
      "|--------------------------------|--------|-------|------|-------|-------|--------|"
    );
  } else {
    console.log(
      "| Eval                           | Result | Build | Lint | Tests | Time   |"
    );
    console.log(
      "|--------------------------------|--------|-------|------|-------|--------|"
    );
  }

  for (const r of results) {
    const passed = r.build && r.lint && r.tests;
    const status = passed ? "✅ PASS" : "❌ FAIL";
    const build = r.build ? "✅" : "❌";
    const lint = r.lint ? "✅" : "❌";
    const tests = r.tests ? "✅" : "❌";
    const time = `${r.duration.toFixed(1)}s`;

    if (isFullMode) {
      const tries = `${r.attempts}/${MAX_FULL_ATTEMPTS}`;
      console.log(
        `| ${r.name.padEnd(30)} | ${status} | ${build}    | ${lint}   | ${tests}    | ${tries.padStart(5)} | ${time.padStart(6)} |`
      );
    } else {
      console.log(
        `| ${r.name.padEnd(30)} | ${status} | ${build}    | ${lint}   | ${tests}    | ${time.padStart(6)} |`
      );
    }
  }
  console.log("═".repeat(88));

  // Summary statistics
  const buildPass = results.filter((r) => r.build).length;
  const lintPass = results.filter((r) => r.lint).length;
  const testPass = results.filter((r) => r.tests).length;
  const total = results.length;

  const pct = (n: number) => ((n / total) * 100).toFixed(0);
  console.log(
    `\n📈 Summary (B/L/T): ${buildPass}/${lintPass}/${testPass} of ${total} (${pct(buildPass)}%/${pct(lintPass)}%/${pct(testPass)}%)`
  );

  if (isFullMode) {
    const avgAttempts =
      results.reduce((sum, r) => sum + r.attempts, 0) / results.length;
    console.log(`🔁 Average attempts: ${avgAttempts.toFixed(1)}`);
  }

  const passed = results.filter((r) => r.build && r.lint && r.tests).length;
  console.log(`✨ ${passed}/${total} evals passed (${pct(passed)}%)`);
}

function writeJsonResults(results: EvalResult[], outputPath: string): void {
  const jsonResults = results.map((r) => ({
    evalPath: r.name,
    mode: r.mode,
    result: {
      success: r.build && r.lint && r.tests,
      buildSuccess: r.build,
      lintSuccess: r.lint,
      testSuccess: r.tests,
      attempts: r.attempts,
      duration: Math.round(r.duration * 1000),
      error: r.error,
    },
  }));

  Bun.write(outputPath, JSON.stringify(jsonResults, null, 2));
  console.log(`\n📄 Results written to ${outputPath}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runAll = args.includes("--all");
  const debug = args.includes("--debug");
  const fullMode = args.includes("--full");
  const outputIdx = args.indexOf("--output");
  const outputFile = outputIdx !== -1 ? args[outputIdx + 1] : null;

  // Find eval name (positional arg that's not a flag or flag value)
  let evalName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      // Skip flag values
      if (arg === "--output") i++;
      continue;
    }
    evalName = arg;
    break;
  }

  await fetchEvals();

  const evals = listEvals();
  console.log(`📦 Found ${evals.length} evals`);

  if (!(runAll || evalName)) {
    console.log("\nUsage:");
    console.log(
      "  bun run evals <eval-name>    Run specific eval (first-shot)"
    );
    console.log("  bun run evals --all          Run all evals");
    console.log(
      "  bun run evals --full         Full-stack mode with d3k feedback loop"
    );
    console.log("  bun run evals --debug        Show verbose output");
    console.log("  bun run evals --output FILE  Write JSON results to file");
    console.log("\nAvailable evals:");
    for (const e of evals.slice(0, 10)) {
      console.log(`  ${e}`);
    }
    console.log(`  ... and ${evals.length - 10} more`);
    return;
  }

  const evalsToRun = runAll ? evals : [evalName!];
  const results: EvalResult[] = [];

  console.log(
    `\n🎯 Mode: ${fullMode ? "Full-stack (d3k feedback)" : "First-shot"}`
  );

  for (const name of evalsToRun) {
    console.log("\n" + "─".repeat(80));
    console.log(`🚀 Running eval: ${name}`);
    console.log("─".repeat(80));

    const result = fullMode
      ? await runEvalFull(name, debug)
      : await runEval(name, debug);
    results.push(result);
  }

  printResults(results);

  if (outputFile) {
    writeJsonResults(results, outputFile);
  }
}

main().catch(console.error);
