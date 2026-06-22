import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "supersearch");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "icons"), { recursive: true });

const shared = {
  bundle: true,
  target: "chrome105",
  logLevel: "info",
};

await esbuild.build({
  ...shared,
  entryPoints: [join(root, "src", "background.ts")],
  outfile: join(out, "background.js"),
  format: "iife",
});

await esbuild.build({
  ...shared,
  entryPoints: [join(root, "src", "content", "index.ts")],
  outfile: join(out, "content.js"),
  format: "iife",
});

await esbuild.build({
  ...shared,
  entryPoints: [join(root, "src", "options.ts")],
  outfile: join(out, "options.js"),
  format: "iife",
});

cpSync(join(root, "manifest.json"), join(out, "manifest.json"));
cpSync(join(root, "content.css"), join(out, "content.css"));
cpSync(join(root, "options.html"), join(out, "options.html"));
cpSync(join(root, "icons"), join(out, "icons"), { recursive: true });

console.log(`Built: ${out}`);
