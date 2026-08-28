import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workbenchDirectory = path.resolve(scriptDirectory, "..");
const sourceDirectory = path.join(workbenchDirectory, "dist", "client");
const targetDirectory = path.join(
  workbenchDirectory,
  "skill-package",
  "assets",
  "workbench",
);

await rm(targetDirectory, { recursive: true, force: true });
await mkdir(targetDirectory, { recursive: true });
await cp(sourceDirectory, targetDirectory, { recursive: true });

console.log(`Synced Skill assets to ${targetDirectory}`);
