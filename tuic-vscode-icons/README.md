# tuic-vscode-icons

File and folder icon theme plugin for TUICommander, based on icons from the [vscode-icons](https://github.com/vscode-icons/vscode-icons) project.

## What it does

Provides `resolveFileIcon` via the `ui:file-icons` plugin capability. The file browser uses it to display context-appropriate SVG icons next to filenames and folders.

## Icon set

The original vscode-icons project ships 1500+ icons covering every file format imaginable. That's overkill for a terminal/AI coding tool, so the icon set has been **pruned to ~615 icons** focused on what developers actually encounter:

- Programming languages (TypeScript, Python, Rust, Go, Java, C/C++, Ruby, etc.)
- Config and build files (package.json, Cargo.toml, Makefile, Dockerfile, tsconfig, etc.)
- DevOps and infrastructure (Terraform, Kubernetes, Docker, CI/CD configs)
- Web technologies (HTML, CSS, SCSS, SVG, WASM)
- Data formats (JSON, YAML, TOML, XML, SQL, GraphQL, CSV, Protobuf)
- Documentation (Markdown, PDF, plain text, reStructuredText)
- Version control and CI (.gitignore, GitHub Actions, GitLab CI)
- AI/coding tool configs (.claude, .cursor, .copilot, mcp.json, agents.md)
- Shell and scripting (bash, zsh, fish, PowerShell, awk)
- Archives (zip, tar, gz)
- Certificates and security (pem, crt, p12)

**Removed categories** (fall back to the generic file/folder icon):

- Microsoft Office formats (docx, xlsx, pptx, Access, etc.)
- Adobe and design tools (Photoshop, Illustrator, Sketch, Affinity, etc.)
- Game development (Unity, Godot, GameMaker, Minecraft)
- Font files (otf, ttf, woff, eot)
- Niche/legacy formats (QlikView, MediaWiki, Fitbit, etc.)

Additionally, icons larger than 15 KB (e.g. Lerna at 215 KB, Composer at 95 KB) are excluded — a generic icon is preferable to a single SVG that weighs more than hundreds of others combined.

All remaining SVGs are optimized with [svgo](https://github.com/svg/svgo) (multipass).

**Result:** `icon-data.js` went from 2.2 MB to 1.0 MB (53% smaller).

## Files

| File | Purpose |
|---|---|
| `main.js` | Plugin entry point — registers the icon provider |
| `manifest.json` | Plugin metadata and capabilities |
| `icon-map.json` | Extension/filename/folder to icon name mapping |
| `icon-data.js` | Inline SVG strings keyed by icon name |
| `scripts/extract.mjs` | Extracts icons from a vscode-icons clone |
| `scripts/prune.mjs` | Prunes and optimizes the icon set for TUICommander |

## Regenerating icons

To update from a newer vscode-icons release:

```bash
# 1. Extract full set from vscode-icons clone
node scripts/extract.mjs /path/to/vscode-icons-clone

# 2. Prune to dev-relevant icons and optimize with svgo
node scripts/prune.mjs

# Dry run to preview changes without writing:
node scripts/prune.mjs --dry-run
```

## License

- **Code:** MIT
- **Icons:** [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) (from vscode-icons)
