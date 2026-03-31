#!/usr/bin/env node
/**
 * Prune icon-map.json and icon-data.js to keep only icons relevant to
 * a developer/AI/shell tool. Removes Office, Adobe, game-dev, media editing,
 * and other clearly non-dev formats.
 *
 * Usage: node scripts/prune.mjs [--dry-run]
 *
 * Reads icon-map.json + icon-data.js from the plugin root and writes
 * pruned versions in-place (unless --dry-run).
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

const dryRun = process.argv.includes("--dry-run");
const root = join(import.meta.dirname, "..");

// ---- Blocklists: things clearly irrelevant for a dev/AI/shell tool ----

// File extensions to REMOVE
const removeExtensions = new Set([
  // Microsoft Office
  "accdb", "accda", "accdc", "accde", "accdp", "accdr", "accdt", "accdu",
  "ade", "adp", "laccdb", "ldb", "mam", "maq", "mdw", "mdb",
  "doc", "docm", "docx", "dot", "dotm", "dotx",
  "xls", "xlsb", "xlsm", "xlsx", "xsf", "xsn", "xlf", "xliff",
  "ppt", "pptm", "pptx", "ppa", "ppam", "pps", "ppsm", "ppsx",
  "potm", "potx", "slddc", "sldm", "sldx", "slx",
  "one", "onepkg", "onetoc", "onetoc2",
  "msg", "oft", "pst", "mst",
  "pub", // MS Publisher (not ssh pub key — those are just "id_rsa.pub" filename)
  "vbhtml",
  // LibreOffice / OpenDocument
  "odb", "odf", "odg", "odp", "ods", "odt",
  "otb", "otg", "otm", "otp", "ots", "ott",
  "fods",
  // Adobe / Design
  "ai", "psd", "eps", "fla", "swf", "xfl",
  "sketch", "fig", "xcf",
  "ase", "aseprite",
  // Affinity
  "af", "aftemplate", "afdesign", "affinitydesigner",
  "afphoto", "affinityphoto", "afpub", "affinitypublisher",
  // 3D / Game assets
  "blend", "fbx", "glb", "gltf", "stl",
  "unity", "godot", "gd.uid", "tscn", "tres", "pck",
  "gmx", "yy", "yyp",
  "n64", "z64", "mca", "mcmeta", "vvvvvv",
  // Fonts (devs see them, but never in a terminal file browser)
  "otf", "ttf", "eot", "woff", "woff2", "sfd", "pfa", "pfb", "fnt",
  // Video
  "smv",
  // Print / eBook
  "epub",
  // Proprietary / niche
  "bcmx", "ibc", "infopathxml",
  "key", // Keynote
  "qvd", "qvw", // QlikView
  "rwd",
  "xtp2", "wll",
  // Windows-specific
  "reg", "lnk", "mum", "psmdcp",
  "format.ps1xml", "types.ps1xml",
  // Misc irrelevant
  "puz", // puzzles
  "pcd", // photo CD
  "spe", // spectral data
  // WeChat mini-program
  "wxml", "wxss",
  // Obsolete / exotic / unidentifiable
  "dal", "dta", "fba", "ocrec", "crec", "mex", "mexn", "mexrs6",
  "ripple", "sst", "tlg", "u", "ua", "rt", "noc", "mx", "mx3",
  "master", "pa", "exp", "pyowo", "🔥",
  // Haxe
  "hxp",
  // Imba
  "imba", "imba2",
  // Vala
  "vala", "vapi",
  // VS extensions
  "vsix", "vsixmanifest",
  // Paket (.NET package manager)
  "paket.references", "paket.template",
  // Dart/Flutter code-gen
  "freezed.dart", "g.dart",
  // PHP legacy variants (keep .phtml, .phar)
  "php1", "php2", "php3", "php4", "php5", "php6", "phps", "phpsa", "phpt",
  // .NET niche (keep csproj, sln, xaml)
  "ascx", "njsproj", "slnf", "slnx", "storyboard", "xib", "xcodeproj",
  // Elixir template variants (keep .eex)
  "heex", "phoenix-heex", "html-heex",
  // Bitmap formats rarely browsed in terminal
  "bmp", "tiff", "heic",
  // V lang
  "vyi", "vash", "vento", "vto",
]);

// Filename patterns to REMOVE (exact matches on lowercase)
const removeFileNames = new Set([
  // Affinity / design tool configs (not found in dev repos)
  // Game dev
  "dune", "dune-project", "dune-workspace",
  // Niche framework configs nobody uses in AI/shell context
  "aurelia.json",
  "ember-cli",
  ".ember-cli",
  "fuse.js",
  ".emakerfile",
  "emakefile",
  ".front-commerce.js",
  "front-commerce.config.ts",
  ".sailsrc",
  ".sequelizerc",
  "ionic.config.json",
  "ionic.project",
  "vagrantfile",
  "vapor.yml",
  "wpml-config.xml",
  ".bithoundrc",
  ".boringignore",
  "config.codekit", "config.codekit2", "config.codekit3",
  ".config.codekit", ".config.codekit2", ".config.codekit3",
  ".solidarity", ".solidarity.json",
  "publiccode.yml",
  ".flooignore",
  ".weblate", ".weblate.ini", "weblate", "weblate.ini",
  ".bzrignore", ".mtn-ignore", ".p4ignore", ".svnignore",
  ".cvsignore", ".hgignore", ".tfignore",
  // Mediawiki
  "mediawiki",
  // Flutter
  ".flutter-plugins", ".flutter-plugins-dependencies",
  // Haxe
  "haxelib.json",
]);

// Folder names to REMOVE
const removeFolderNames = new Set([
  // Game dev
  ".godot", "godot", ".minecraft",
  // Mobile native
  "android", "ios", "flutter", ".expo", ".expo-shared",
  "dart", ".dart_tool",
  "bloc", "blocs", "cubit", "cubits",
  // Niche
  "mediawiki",
  ".vagrant", "vagrant",
  "arango", "arangodb",
  "haxe_libraries",
  // Haxe
  ".haxelib",
  "gulpfile.babel.coffee", "gulpfile.babel.js", "gulpfile.babel.ts",
  "gulpfile.coffee", "gulpfile.js", "gulpfile.ts",
  // Windows-specific
  "win32", "windows",
  // Duplicate/rarely seen
  ".mjml", "mjml",
]);

// ---- Load current data ----
const iconMap = JSON.parse(readFileSync(join(root, "icon-map.json"), "utf8"));

const before = {
  ext: Object.keys(iconMap.fileExtensions).length,
  fn: Object.keys(iconMap.fileNames).length,
  fld: Object.keys(iconMap.folderNames).length,
};

// ---- Prune ----
for (const ext of removeExtensions) {
  delete iconMap.fileExtensions[ext];
}
for (const fn of removeFileNames) {
  delete iconMap.fileNames[fn];
}
for (const fld of removeFolderNames) {
  delete iconMap.folderNames[fld];
}

const after = {
  ext: Object.keys(iconMap.fileExtensions).length,
  fn: Object.keys(iconMap.fileNames).length,
  fld: Object.keys(iconMap.folderNames).length,
};

console.log(`Extensions: ${before.ext} → ${after.ext} (removed ${before.ext - after.ext})`);
console.log(`Filenames:  ${before.fn} → ${after.fn} (removed ${before.fn - after.fn})`);
console.log(`Folders:    ${before.fld} → ${after.fld} (removed ${before.fld - after.fld})`);

// ---- Compute referenced icons and prune icon-data ----
const referencedIcons = new Set([
  ...Object.values(iconMap.fileExtensions),
  ...Object.values(iconMap.fileNames),
  ...Object.values(iconMap.folderNames),
  iconMap.defaultFile,
  iconMap.defaultFolder,
  "default_folder_opened",
]);

// Load icon-data.js — it exports ICONS as a big object
const iconDataSrc = readFileSync(join(root, "icon-data.js"), "utf8");
// Extract the JSON blob from: export const ICONS = {...};
const jsonStart = iconDataSrc.indexOf("{");
const jsonEnd = iconDataSrc.lastIndexOf("}") + 1;
const allIcons = JSON.parse(iconDataSrc.slice(jsonStart, jsonEnd));

// Cap: replace SVGs larger than MAX_ICON_KB with the default file/folder icon.
// Bloated SVGs (lerna=215KB, composer=95KB) aren't worth the payload for a
// terminal file browser — a generic icon is fine.
const MAX_ICON_BYTES = 15 * 1024;
let capped = 0;

const prunedIcons = {};
for (const [name, svg] of Object.entries(allIcons)) {
  if (!referencedIcons.has(name)) continue;
  if (svg.length > MAX_ICON_BYTES && name !== "default_file" && name !== "default_folder" && name !== "default_folder_opened") {
    capped++;
    // Don't include — resolveFileIcon will fall through to default
    continue;
  }
  prunedIcons[name] = svg;
}

// Remove map entries that point to capped (missing) icons so they fall back to default
for (const [ext, icon] of Object.entries(iconMap.fileExtensions)) {
  if (!prunedIcons[icon]) delete iconMap.fileExtensions[ext];
}
for (const [fn, icon] of Object.entries(iconMap.fileNames)) {
  if (!prunedIcons[icon]) delete iconMap.fileNames[fn];
}
for (const [fld, icon] of Object.entries(iconMap.folderNames)) {
  if (!prunedIcons[icon]) delete iconMap.folderNames[fld];
}

const iconsBefore = Object.keys(allIcons).length;
const iconsAfter = Object.keys(prunedIcons).length;
console.log(`Icons:      ${iconsBefore} → ${iconsAfter} (removed ${iconsBefore - iconsAfter}, ${capped} capped for size)`);

// ---- Optimize all SVGs with svgo (batch via temp directory) ----
const tmpDir = join(root, ".svgo-tmp");
mkdirSync(tmpDir, { recursive: true });

// Write each SVG to a temp file
for (const [name, svg] of Object.entries(prunedIcons)) {
  writeFileSync(join(tmpDir, `${name}.svg`), svg);
}

console.log(`\nOptimizing ${iconsAfter} SVGs with svgo...`);
try {
  execFileSync("npx", ["-y", "svgo", "--multipass", "-f", tmpDir, "-o", tmpDir], {
    stdio: "pipe",
    timeout: 120_000,
  });
} catch (e) {
  console.error("svgo failed:", e.stderr?.toString() ?? e.message);
}

// Read back optimized SVGs
let savedBytes = 0;
for (const name of Object.keys(prunedIcons)) {
  const optimized = readFileSync(join(tmpDir, `${name}.svg`), "utf8").trim();
  const saved = prunedIcons[name].length - optimized.length;
  if (saved > 0) savedBytes += saved;
  prunedIcons[name] = optimized;
}

// Cleanup
rmSync(tmpDir, { recursive: true, force: true });
console.log(`SVGO saved: ${(savedBytes / 1024).toFixed(0)} KB across ${iconsAfter} icons`);

const mapJson = JSON.stringify(iconMap, null, 2);
const dataJs =
  `// Auto-generated from vscode-icons. Do not edit.\n` +
  `// Icons: CC BY-SA 4.0 — https://github.com/vscode-icons/vscode-icons\n` +
  `export const ICONS = ${JSON.stringify(prunedIcons)};\n`;

const sizeBefore = readFileSync(join(root, "icon-data.js"), "utf8").length;
const sizeAfter = dataJs.length;
console.log(`\nicon-data.js: ${(sizeBefore / 1024).toFixed(0)} KB → ${(sizeAfter / 1024).toFixed(0)} KB (${((1 - sizeAfter / sizeBefore) * 100).toFixed(0)}% smaller)`);

if (dryRun) {
  console.log("\n[dry-run] No files written.");
} else {
  writeFileSync(join(root, "icon-map.json"), mapJson);
  writeFileSync(join(root, "icon-data.js"), dataJs);
  console.log("\nWritten: icon-map.json, icon-data.js");
}
