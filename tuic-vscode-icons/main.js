/**
 * tuic-vscode-icons — File icon theme plugin for TUICommander.
 *
 * Icons from vscode-icons (https://github.com/vscode-icons/vscode-icons)
 * Code: MIT License
 * Icons: Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA 4.0)
 */

import { ICONS } from "./icon-data.js";
import iconMap from "./icon-map.json" with { type: "json" };

let disposable = null;

export default {
  id: "tuic-vscode-icons",

  onload(host) {
    host.log("info", `Loaded ${Object.keys(ICONS).length} file icons`);

    disposable = host.registerFileIconProvider({
      resolveFileIcon(name, isDir) {
        if (isDir) {
          const folderIcon = iconMap.folderNames[name.toLowerCase()];
          const svg = ICONS[folderIcon] ?? ICONS[iconMap.defaultFolder];
          return svg ?? null;
        }

        // Try exact filename first (e.g. "Dockerfile", ".gitignore")
        const exactIcon = iconMap.fileNames[name.toLowerCase()];
        if (exactIcon && ICONS[exactIcon]) return ICONS[exactIcon];

        // Then by extension
        const dotIdx = name.lastIndexOf(".");
        if (dotIdx > 0) {
          const ext = name.slice(dotIdx + 1).toLowerCase();
          const extIcon = iconMap.fileExtensions[ext];
          if (extIcon && ICONS[extIcon]) return ICONS[extIcon];
        }

        // Default file icon
        return ICONS[iconMap.defaultFile] ?? null;
      },
    });
  },

  onunload() {
    disposable?.dispose();
    disposable = null;
  },
};
