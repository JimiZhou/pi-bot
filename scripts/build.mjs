import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(".");
const outputRoot = path.join(projectRoot, "dist");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile() && !entry.name.endsWith(".map")) await cp(sourcePath, destinationPath);
  }
}

await rm(outputRoot, { recursive: true, force: true });
await run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"]);
await copyTree(path.join(projectRoot, "src/admin"), path.join(outputRoot, "admin"));
console.log("TypeScript core and generic admin runtime built into dist/.");
