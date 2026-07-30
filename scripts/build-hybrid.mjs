import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(".");
const outputRoot = path.join(projectRoot, "dist");
const privateRoot = path.join(projectRoot, "private-runtime");

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
    else if (entry.isFile()) await cp(sourcePath, destinationPath);
  }
}

await rm(outputRoot, { recursive: true, force: true });
await run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"]);
await copyTree(privateRoot, outputRoot);
console.log("TypeScript core and recovered private runtime built into dist/.");
