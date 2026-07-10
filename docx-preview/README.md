# DOCX Preview

Preview Microsoft Word `.docx` and `.dotx` files in TUICommander using Mammoth.js.

## Features

- Opens `.docx` and `.dotx` files through the file preview plugin hook
- Converts document content to clean HTML with Mammoth.js
- Embeds document images as data URLs when Mammoth can read them
- Shows Mammoth conversion notes and warnings in the panel
- Provides a raw-text view and an Edit button for opening the source file

## Notes

Mammoth focuses on semantic conversion rather than Word-compatible layout. It is good for reading document contents, headings, tables, lists, links, notes, comments, and embedded images, but it does not reproduce page geometry exactly.

## Capabilities

- `ui:file-preview`
- `ui:panel`
- `fs:read`

Mammoth.js 1.12.0 is vendored under `vendor/` with its BSD-2-Clause license.
