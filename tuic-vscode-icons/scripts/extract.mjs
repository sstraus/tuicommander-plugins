#!/usr/bin/env node
/**
 * Extract icon mappings from vscode-icons source into a compact JSON + bundled SVGs.
 *
 * Usage: node scripts/extract.mjs /path/to/vscode-icons-clone
 *
 * Outputs:
 *   - icon-map.json: extension/filename/folder → icon name mapping
 *   - icon-data.js: all SVGs as inline strings keyed by icon name
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";

const vsiconsRoot = process.argv[2];
if (!vsiconsRoot) {
  console.error("Usage: node scripts/extract.mjs /path/to/vscode-icons-clone");
  process.exit(1);
}

const extFile = readFileSync(join(vsiconsRoot, "src/iconsManifest/supportedExtensions.ts"), "utf8");
const folderFile = readFileSync(join(vsiconsRoot, "src/iconsManifest/supportedFolders.ts"), "utf8");

// ---- Parse file extensions ----
// Each entry looks like: { icon: 'typescript', extensions: ['ts', 'tsx'], ... }
// or { icon: 'docker', extensions: ['dockerfile'], filename: true, ... }
const fileExtensions = {};
const fileNames = {};

// Match icon entries: { icon: '...', extensions: [...], ... }
const extRegex = /\{\s*icon:\s*'([^']+)'[\s\S]*?extensions:\s*\[([^\]]*)\][\s\S]*?\}/g;
let match;
while ((match = extRegex.exec(extFile)) !== null) {
  const iconName = match[1];
  const extensions = match[2].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, "")) ?? [];

  // Check if this is a filename match
  const entryText = match[0];
  const isFilename = /filename:\s*true/.test(entryText);
  const isDisabled = /disabled:\s*true/.test(entryText);

  if (isDisabled) continue;

  for (const ext of extensions) {
    if (isFilename) {
      fileNames[ext.toLowerCase()] = `file_type_${iconName}`;
    } else {
      fileExtensions[ext.toLowerCase()] = `file_type_${iconName}`;
    }
  }

  // Also check filenamesGlob for exact filename matches
  const fnGlobMatch = entryText.match(/filenamesGlob:\s*\[([^\]]*)\]/);
  if (fnGlobMatch) {
    const fnames = fnGlobMatch[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, "")) ?? [];
    for (const fn of fnames) {
      fileNames[fn.toLowerCase()] = `file_type_${iconName}`;
    }
  }
}

// ---- Parse folder names ----
const folderNames = {};
const folderRegex = /\{\s*icon:\s*'([^']+)'[\s\S]*?extensions:\s*\[([^\]]*)\][\s\S]*?\}/g;
while ((match = folderRegex.exec(folderFile)) !== null) {
  const iconName = match[1];
  const names = match[2].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, "")) ?? [];
  const entryText = match[0];
  const isDisabled = /disabled:\s*true/.test(entryText);
  if (isDisabled) continue;

  for (const name of names) {
    folderNames[name.toLowerCase()] = `folder_type_${iconName}`;
  }
}

const iconMap = {
  fileExtensions,
  fileNames,
  folderNames,
  defaultFile: "default_file",
  defaultFolder: "default_folder",
};

console.log(`Extracted: ${Object.keys(fileExtensions).length} file extensions, ${Object.keys(fileNames).length} filenames, ${Object.keys(folderNames).length} folder names`);

// ---- Bundle SVGs ----
const iconsDir = join(vsiconsRoot, "icons");
const svgFiles = readdirSync(iconsDir).filter(f => f.endsWith(".svg"));
const icons = {};
const referencedIcons = new Set([
  ...Object.values(fileExtensions),
  ...Object.values(fileNames),
  ...Object.values(folderNames),
  "default_file",
  "default_folder",
  "default_folder_opened",
]);

for (const svgFile of svgFiles) {
  const name = basename(svgFile, ".svg");
  // Only include referenced icons (saves space)
  if (referencedIcons.has(name)) {
    const svg = readFileSync(join(iconsDir, svgFile), "utf8").trim();
    icons[name] = svg;
  }
}

console.log(`Bundled: ${Object.keys(icons).length} SVG icons (of ${svgFiles.length} total)`);

// ---- Write outputs ----
const outDir = join(import.meta.dirname, "..");
writeFileSync(join(outDir, "icon-map.json"), JSON.stringify(iconMap, null, 2));
writeFileSync(
  join(outDir, "icon-data.js"),
  `// Auto-generated from vscode-icons. Do not edit.\n// Icons: CC BY-SA 4.0 — https://github.com/vscode-icons/vscode-icons\nexport const ICONS = ${JSON.stringify(icons)};\n`
);

console.log(`Written: icon-map.json, icon-data.js`);
