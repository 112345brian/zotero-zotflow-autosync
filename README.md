# ZotFlow Auto-Sync

A Zotero 7 plugin that automatically updates your [ZotFlow](https://github.com/duanxianpi/zotflow) Obsidian vault files the moment you add or edit an annotation in Zotero — no manual sync required.

## The problem

ZotFlow pulls your Zotero annotations into Obsidian on demand, but only when you explicitly trigger a sync. This plugin sits inside Zotero and pushes changes to your vault in real time, event-driven, with no polling.

## How it works

- Registers a `Zotero.Notifier` listener on startup
- When any annotation is created or modified, fires after a 1.5 s debounce
- Finds the corresponding vault file via Better BibTeX citekey (falls back to the `extra` field, then the raw Zotero key)
- Preserves everything before `## Annotations` — your literature notes, `ZF_NOTE` blocks, frontmatter — and regenerates only the annotations section
- Re-embeds any `ZF_ANNO_BEG/END` comments you've written in Obsidian that haven't been synced back to Zotero yet
- Only updates **existing** files; ZotFlow still handles first-time creation

Zotero's annotations are the source of truth. When you later run ZotFlow's manual sync, it will re-render from the same data and produce identical content.

## Requirements

- Zotero 7
- [ZotFlow](https://github.com/duanxianpi/zotflow) Obsidian plugin (already configured and synced at least once per item)
- [Better BibTeX](https://retorque.re/zotero-better-bibtex/) (recommended, for stable citekey-based filenames)

## Installation

1. Download `zotflow-autosync.xpi` from the [latest release](https://github.com/112345brian/zotero-zotflow-autosync/releases/latest)
2. In Zotero: **Tools → Add-ons → gear icon → Install Add-on From File…**
3. Select the downloaded XPI and restart Zotero

Confirm it appears in **Tools → Add-ons** as *ZotFlow Auto-Sync*.

## Updating

Repeat the installation steps with the new XPI from the releases page.

## Notes

- The plugin reads your Obsidian vault path from `~/Library/Application Support/obsidian/obsidian.json` automatically
- It reads ZotFlow's configured `sourceNoteFolder` from your vault's `data.json`; defaults to `archive/@` if unreadable
- Zotero debug output is logged under the tag `[ZotFlowAutoSync]` (open via **Help → Debug Output Logging**)
