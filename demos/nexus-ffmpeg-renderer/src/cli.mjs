import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderManifest } from "./renderer.mjs";

async function main() {
  const [manifestFile, assetMapFile, assetRoot, outputFile] = process.argv.slice(2);
  if (!manifestFile || !assetMapFile || !assetRoot || !outputFile) {
    console.error("Usage: node src/cli.mjs <manifest.json> <asset-map.json> <asset-directory> <output.mp4>");
    process.exitCode = 2;
    return;
  }
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const assetMap = JSON.parse(await readFile(assetMapFile, "utf8"));
  const outputPath = path.resolve(outputFile);
  const result = await renderManifest({ manifest, assetMap, assetRoot, outputPath });
  console.log(JSON.stringify({ status: "render_completed", ...result }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "render_failed", error: error.message }, null, 2));
  process.exitCode = 1;
});
