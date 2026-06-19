"use strict";

// ─── Plugin lifecycle ────────────────────────────────────────────────────────

var _plugin = null;

function startup({ id, version, resourceURI, rootURI }) {
  // onMainWindowLoad fires after Zotero is fully initialised
}

function onMainWindowLoad({ window }) {
  _plugin = new ZotFlowAutoSync();
  _plugin.startup().catch(e => Zotero.logError(e));
}

function onMainWindowUnload({ window }) {}

function shutdown() {
  _plugin?.shutdown();
  _plugin = null;
}

function install() {}
function uninstall() {}

// ─── Core plugin ─────────────────────────────────────────────────────────────

class ZotFlowAutoSync {
  constructor() {
    this._notifierID = null;
    this._pending = new Map(); // itemID → timeout handle
    this._vaultPath = null;
    this._settings = null;
    this.DEBOUNCE_MS = 1500;
  }

  // ── Startup / shutdown ────────────────────────────────────────────────────

  async startup() {
    this._vaultPath = await this._resolveVaultPath();
    if (!this._vaultPath) {
      Zotero.log(
        "[ZotFlowAutoSync] No vault path set. " +
        "Set extensions.zotflow-autosync.vaultPath in the Config Editor " +
        "(Edit → Preferences → Advanced → Config Editor)."
      );
      return;
    }
    this._noteFolder = this._resolveNoteFolder();

    this._notifierID = Zotero.Notifier.registerObserver(
      { notify: this._onNotify.bind(this) },
      ["item"],
      "ZotFlowAutoSync"
    );

    Zotero.log("[ZotFlowAutoSync] Started. Vault: " + this._vaultPath +
               "  Folder: " + this._noteFolder);
  }

  shutdown() {
    if (this._notifierID) {
      Zotero.Notifier.unregisterObserver(this._notifierID);
      this._notifierID = null;
    }
    for (const t of this._pending.values()) clearTimeout(t);
    this._pending.clear();
    Zotero.log("[ZotFlowAutoSync] Shutdown.");
  }

  // ── Init helpers ──────────────────────────────────────────────────────────

  // Pref keys
  static PREF_VAULT   = "extensions.zotflow-autosync.vaultPath";
  static PREF_FOLDER  = "extensions.zotflow-autosync.noteFolder";
  static DEFAULT_FOLDER = "archive/@";

  async _resolveVaultPath() {
    let path = Zotero.Prefs.get(ZotFlowAutoSync.PREF_VAULT, true) || "";
    if (!path) {
      path = (await this._discoverVaultPath()) || "";
      if (path) Zotero.log("[ZotFlowAutoSync] Vault auto-discovered: " + path);
    }
    // Always write so the key appears in Config Editor (Edit → Preferences → Advanced → Config Editor)
    Zotero.Prefs.set(ZotFlowAutoSync.PREF_VAULT, path, true);
    return path || null;
  }

  async _discoverVaultPath() {
    // Obsidian writes a registry file in a platform-specific location.
    // We try known paths; on Linux/Windows this will simply not find a file
    // and return null cleanly.
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const candidates = [
      // macOS
      PathUtils.join(home, "Library", "Application Support", "obsidian", "obsidian.json"),
      // Linux
      PathUtils.join(home, ".config", "obsidian", "obsidian.json"),
      // Windows (APPDATA via env — falls back to null if undefined)
      Services.env.get("APPDATA")
        ? PathUtils.join(Services.env.get("APPDATA"), "obsidian", "obsidian.json")
        : null,
    ].filter(Boolean);

    for (const cfgPath of candidates) {
      try {
        const raw = await IOUtils.readUTF8(cfgPath);
        const cfg = JSON.parse(raw);
        const vaults = Object.values(cfg.vaults || {});
        const active = vaults.find(v => v.open) || vaults[0];
        if (active?.path) return active.path;
      } catch (_) {
        // not found on this platform, try next
      }
    }
    return null;
  }

  _resolveNoteFolder() {
    let folder = Zotero.Prefs.get(ZotFlowAutoSync.PREF_FOLDER, true) || "";
    if (!folder) folder = ZotFlowAutoSync.DEFAULT_FOLDER;
    // Always write so the key appears in Config Editor
    Zotero.Prefs.set(ZotFlowAutoSync.PREF_FOLDER, folder, true);
    return folder;
  }

  // ── Notifier ──────────────────────────────────────────────────────────────

  _onNotify(event, type, ids, _extraData) {
    if (type !== "item" || !["add", "modify"].includes(event)) return;

    for (const id of ids) {
      if (this._pending.has(id)) clearTimeout(this._pending.get(id));
      const t = setTimeout(() => {
        this._pending.delete(id);
        this._handleChange(id).catch(e =>
          Zotero.log("[ZotFlowAutoSync] Error on item " + id + ": " + e)
        );
      }, this.DEBOUNCE_MS);
      this._pending.set(id, t);
    }
  }

  async _handleChange(itemID) {
    const item = Zotero.Items.get(itemID);
    if (!item) return;

    let sourceItem = null;

    if (item.isAnnotation()) {
      // Annotation → Attachment → Regular item
      const attach = Zotero.Items.get(item.parentItemID);
      if (!attach?.parentItemID) return;
      sourceItem = Zotero.Items.get(attach.parentItemID);
    } else if (item.isNote() && item.parentItemID) {
      const parent = Zotero.Items.get(item.parentItemID);
      if (parent?.isRegularItem()) sourceItem = parent;
    } else if (item.isAttachment() && item.parentItemID) {
      sourceItem = Zotero.Items.get(item.parentItemID);
    } else if (item.isRegularItem()) {
      sourceItem = item;
    }

    if (!sourceItem?.isRegularItem()) return;
    await this._updateFile(sourceItem);
  }

  // ── File update ───────────────────────────────────────────────────────────

  async _updateFile(sourceItem) {
    const filePath = this._resolveFilePath(sourceItem);
    if (!filePath) return;
    if (!(await IOUtils.exists(filePath))) return; // never create; only update

    try {
      const existing = await IOUtils.readUTF8(filePath);
      const updated = await this._rerender(sourceItem, existing);
      if (updated !== existing) {
        await IOUtils.writeUTF8(filePath, updated);
        Zotero.log("[ZotFlowAutoSync] Updated: " + filePath);
      }
    } catch (e) {
      Zotero.log("[ZotFlowAutoSync] Write error (" + filePath + "): " + e);
    }
  }

  _resolveFilePath(item) {
    const citeKey = this._citeKey(item);
    const folder = PathUtils.join(this._vaultPath, this._noteFolder);
    return PathUtils.join(folder, "@" + citeKey + ".md");
  }

  _citeKey(item) {
    // Prefer Better BibTeX if installed
    try {
      if (typeof Zotero.BetterBibTeX !== "undefined") {
        const entry = Zotero.BetterBibTeX.KeyManager.get(item.id);
        if (entry?.citekey) return entry.citekey;
      }
    } catch (_) {}

    // Fall back to parsing the Extra field
    const extra = item.getField("extra") || "";
    const m = extra.match(/^(?:Citation Key|bibtex):\s*(\S+)/im);
    if (m) return m[1];

    // Last resort: raw Zotero item key
    return item.key;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  async _rerender(sourceItem, existing) {
    // Read the web-API library ID from the existing frontmatter so we don't
    // have to convert local library IDs to Zotero user/group IDs.
    const libIDMatch = existing.match(/^library-id:\s*["']?(\d+)["']?/m);
    const libraryID = libIDMatch ? libIDMatch[1] : "";

    // Split the file at the ## Annotations header. Everything before it
    // (frontmatter + notes) is preserved verbatim except for date-modified.
    const splitAt = existing.search(/\n## Annotations(?:\s*\n)/);
    const bodyBefore =
      (splitAt >= 0 ? existing.slice(0, splitAt) : existing).replace(/\s+$/, "");

    // Extract user-written annotation comments from the current file so we
    // can re-embed them even if Zotero's annotationComment field is empty
    // (i.e. the user edited the comment in Obsidian but hasn't synced back).
    const savedComments = this._extractSavedComments(existing);

    // Gather sorted annotations from all file attachments
    const attachmentIDs = sourceItem.getAttachments();
    let annoBlocks = "";

    for (const aid of attachmentIDs) {
      const attach = Zotero.Items.get(aid);
      if (!attach?.isFileAttachment()) continue;

      const annos = (attach.getAnnotations() || [])
        .slice()
        .sort((a, b) =>
          (a.annotationSortIndex || "").localeCompare(b.annotationSortIndex || "")
        );

      for (const anno of annos) {
        annoBlocks += this._renderAnno(anno, attach, libraryID, savedComments);
      }
    }

    // Update date-modified timestamp
    const now = new Date().toISOString().slice(0, 19);
    const updatedBefore = bodyBefore.replace(
      /^(date-modified:\s*).*$/m,
      `$1"${now}"`
    );

    if (annoBlocks) {
      return updatedBefore + "\n\n## Annotations\n" + annoBlocks + "\n";
    }
    return updatedBefore + "\n";
  }

  _extractSavedComments(content) {
    const map = new Map();
    // Markers appear inside blockquotes: "> <!-- ZF_ANNO_BEG_KEY -->"
    const re = />?\s*<!-- ZF_ANNO_BEG_(\w+) -->\n([\s\S]*?)>?\s*<!-- ZF_ANNO_END_\1 -->/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const key = m[1];
      const text = m[2]
        .split("\n")
        .map(l => l.replace(/^>\s?/, ""))
        .join("\n")
        .trim();
      if (text) map.set(key, text);
    }
    return map;
  }

  _renderAnno(anno, attach, libraryID, savedComments) {
    const type = anno.annotationType || "highlight";
    const color = anno.annotationColor || "#000000";
    const key = anno.key;
    const text = (anno.annotationText || "").trim();
    // Zotero's own comment takes precedence; fall back to what's already in
    // the Obsidian file (the user may have typed it there before syncing back).
    const comment = (anno.annotationComment || "").trim() || savedComments.get(key) || "";
    const pageLabel = anno.annotationPageLabel;

    const filename = attach.attachmentFilename || attach.getField("title") || "";
    const nav = encodeURIComponent(JSON.stringify({ annotationID: key }));
    const pageRef = pageLabel ? `, p.${pageLabel}` : "";
    const url =
      `obsidian://zotflow?type=open-attachment` +
      `&libraryID=${libraryID}&key=${attach.key}&navigation=${nav}`;

    let block = `\n> [!zotflow-${type}-${color}] [${filename}${pageRef}](${url})\n`;

    if (type !== "image" && type !== "ink") {
      if (text) {
        block += `\n> > ${text.replace(/\n/g, "\n> > ")}\n`;
      }
    }

    if (comment) {
      block += `\n>\n> <!-- ZF_ANNO_BEG_${key} -->\n`;
      block += comment.split("\n").map(l => `> ${l}`).join("\n") + "\n";
      block += `> <!-- ZF_ANNO_END_${key} -->\n`;
    }

    block += `\n^${key}\n`;
    return block;
  }
}
