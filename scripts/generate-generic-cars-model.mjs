import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputFile = resolve(
  workspaceRoot,
  "static/20x_generic_cars_gltf/scene.gltf",
);
const outputFile = resolve(
  workspaceRoot,
  "src/lib/racing/components/models/GenericCarsPack.svelte",
);
const fallbackOutputFile = resolve(workspaceRoot, "scene.svelte");

mkdirSync(dirname(outputFile), { recursive: true });

execFileSync(
  "npx",
  [
    "--yes",
    "@threlte/gltf@latest",
    inputFile,
    "--output",
    outputFile,
    "--types",
    "--keepnames",
    "--isolated",
    "--root",
    "/20x_generic_cars_gltf/",
  ],
  {
    cwd: workspaceRoot,
    stdio: "inherit",
  },
);

// The current CLI version sometimes ignores an absolute --output path and writes
// `scene.svelte` into the current working directory. Normalize that case so the
// generated component always lands where the app expects it.
if (!existsSync(outputFile) && existsSync(fallbackOutputFile)) {
  renameSync(fallbackOutputFile, outputFile);
}
