import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REPO = "vercel/next.js";
const BRANCH = "canary";
const DOCS_PATH = "docs";
const OUTPUT_DIR = ".claude/docs/nextjs";

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
  });
}

async function downloadAndExtractDocs(): Promise<void> {
  const tarballUrl = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz`;
  const tempDir = ".claude/docs/.tmp";
  const tarballPath = `${tempDir}/next.tar.gz`;
  const extractedDir = `${tempDir}/next.js-${BRANCH}`;

  console.log(`Fetching Next.js docs from ${REPO}@${BRANCH}...`);

  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch tarball: ${response.statusText}`);
  }

  await writeFile(tarballPath, Buffer.from(await response.arrayBuffer()));

  console.log("Extracting docs...");

  await runCommand("tar", ["-xzf", tarballPath, "-C", tempDir]);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const docsSourceDir = `${extractedDir}/${DOCS_PATH}`;
  const entries = await readdir(docsSourceDir);

  for (const entry of entries) {
    await runCommand("mv", [join(docsSourceDir, entry), OUTPUT_DIR]);
  }

  await rm(tempDir, { recursive: true, force: true });

  const timestamp = new Date().toISOString();
  await writeFile(join(OUTPUT_DIR, ".last-updated"), timestamp);

  console.log(`Done! Docs updated at ${timestamp}`);
}

downloadAndExtractDocs().catch((error) => {
  console.error("Failed to update docs:", error);
  process.exit(1);
});
