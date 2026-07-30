import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const sourceRoot = path.resolve("src-recovered");
const outputRoot = path.resolve("dist");

async function copyJavaScript(relative = "") {
  const sourceDir = path.join(sourceRoot, relative);
  const outputDir = path.join(outputRoot, relative);
  await mkdir(outputDir, { recursive: true });

  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      await copyJavaScript(child);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      await cp(path.join(sourceRoot, child), path.join(outputRoot, child));
    }
  }
}

await copyJavaScript();
console.log("Recovered JavaScript sources copied to dist/.");
