"use strict";

var _plugin = null;

var PREF_VAULT = "extensions.zotflow-autosync.vaultPath";
var PREF_FOLDER = "extensions.zotflow-autosync.noteFolder";
var DEFAULT_FOLDER = "archive/@";

function install() {}
function uninstall() {}
function onMainWindowLoad({ window }) {}
function onMainWindowUnload({ window }) {}

function startup({ id, version, resourceURI, rootURI }) {
  Zotero.log("[ZotFlowAutoSync] startup called");
  Zotero.initializationPromise.then(function() {
    Zotero.log("[ZotFlowAutoSync] Zotero ready, initialising plugin");
    _plugin = new ZotFlowAutoSync();
    return _plugin.init();
  }).catch(function(e) {
    Zotero.log("[ZotFlowAutoSync] init error: " + e);
  });
}

function shutdown() {
  if (_plugin) {
    _plugin.destroy();
    _plugin = null;
  }
}

function ZotFlowAutoSync() {
  this._notifierID = null;
  this._pending = {};
  this._vaultPath = null;
  this._noteFolder = null;
  this.DEBOUNCE_MS = 1500;
}

ZotFlowAutoSync.prototype.init = async function() {
  this._vaultPath = await this._resolveVaultPath();
  if (!this._vaultPath) {
    Zotero.log(
      "[ZotFlowAutoSync] No vault path configured. " +
      "Open Edit → Preferences → Advanced → Config Editor " +
      "and set extensions.zotflow-autosync.vaultPath"
    );
    return;
  }
  this._noteFolder = this._resolveNoteFolder();
  this._notifierID = Zotero.Notifier.registerObserver(
    { notify: this._onNotify.bind(this) },
    ["item"],
    "ZotFlowAutoSync"
  );
  Zotero.log("[ZotFlowAutoSync] started. vault=" + this._vaultPath +
             " folder=" + this._noteFolder);
};

ZotFlowAutoSync.prototype.destroy = function() {
  if (this._notifierID) {
    Zotero.Notifier.unregisterObserver(this._notifierID);
    this._notifierID = null;
  }
  var keys = Object.keys(this._pending);
  for (var i = 0; i < keys.length; i++) clearTimeout(this._pending[keys[i]]);
  this._pending = {};
  Zotero.log("[ZotFlowAutoSync] shutdown");
};

ZotFlowAutoSync.prototype._resolveVaultPath = async function() {
  var stored = Zotero.Prefs.get(PREF_VAULT, true) || "";
  if (!stored) {
    stored = (await this._discoverVaultPath()) || "";
    if (stored) Zotero.log("[ZotFlowAutoSync] vault auto-discovered: " + stored);
  }
  Zotero.Prefs.set(PREF_VAULT, stored, true);
  return stored || null;
};

ZotFlowAutoSync.prototype._discoverVaultPath = async function() {
  var home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  var candidates = [
    PathUtils.join(home, "Library", "Application Support", "obsidian", "obsidian.json"),
    PathUtils.join(home, ".config", "obsidian", "obsidian.json"),
  ];
  var appdata = Services.env.get("APPDATA");
  if (appdata) candidates.push(PathUtils.join(appdata, "obsidian", "obsidian.json"));

  for (var i = 0; i < candidates.length; i++) {
    try {
      var raw = await IOUtils.readUTF8(candidates[i]);
      var cfg = JSON.parse(raw);
      var vaults = Object.values(cfg.vaults || {});
      var active = vaults.find(function(v) { return v.open; }) || vaults[0];
      if (active && active.path) return active.path;
    } catch (_) {}
  }
  return null;
};

ZotFlowAutoSync.prototype._resolveNoteFolder = function() {
  var folder = Zotero.Prefs.get(PREF_FOLDER, true) || "";
  if (!folder) folder = DEFAULT_FOLDER;
  Zotero.Prefs.set(PREF_FOLDER, folder, true);
  return folder;
};

ZotFlowAutoSync.prototype._onNotify = function(event, type, ids, _extraData) {
  if (type !== "item" || (event !== "add" && event !== "modify")) return;
  var self = this;
  for (var i = 0; i < ids.length; i++) {
    (function(id) {
      if (self._pending[id]) clearTimeout(self._pending[id]);
      self._pending[id] = setTimeout(function() {
        delete self._pending[id];
        self._handleChange(id).catch(function(e) {
          Zotero.log("[ZotFlowAutoSync] error on item " + id + ": " + e);
        });
      }, self.DEBOUNCE_MS);
    })(ids[i]);
  }
};

ZotFlowAutoSync.prototype._handleChange = async function(itemID) {
  var item = Zotero.Items.get(itemID);
  if (!item) return;

  var sourceItem = null;
  if (item.isAnnotation()) {
    var attach = Zotero.Items.get(item.parentItemID);
    if (!attach || !attach.parentItemID) return;
    sourceItem = Zotero.Items.get(attach.parentItemID);
  } else if (item.isNote() && item.parentItemID) {
    var parent = Zotero.Items.get(item.parentItemID);
    if (parent && parent.isRegularItem()) sourceItem = parent;
  } else if (item.isAttachment() && item.parentItemID) {
    sourceItem = Zotero.Items.get(item.parentItemID);
  } else if (item.isRegularItem()) {
    sourceItem = item;
  }

  if (!sourceItem || !sourceItem.isRegularItem()) return;
  await this._updateFile(sourceItem);
};

ZotFlowAutoSync.prototype._updateFile = async function(sourceItem) {
  var filePath = this._resolveFilePath(sourceItem);
  if (!filePath) return;
  if (!(await IOUtils.exists(filePath))) return;
  try {
    var existing = await IOUtils.readUTF8(filePath);
    var updated = await this._rerender(sourceItem, existing);
    if (updated !== existing) {
      await IOUtils.writeUTF8(filePath, updated);
      Zotero.log("[ZotFlowAutoSync] updated: " + filePath);
    }
  } catch (e) {
    Zotero.log("[ZotFlowAutoSync] write error (" + filePath + "): " + e);
  }
};

ZotFlowAutoSync.prototype._resolveFilePath = function(item) {
  var citeKey = this._citeKey(item);
  var folder = PathUtils.join(this._vaultPath, this._noteFolder);
  return PathUtils.join(folder, "@" + citeKey + ".md");
};

ZotFlowAutoSync.prototype._citeKey = function(item) {
  try {
    if (typeof Zotero.BetterBibTeX !== "undefined") {
      var entry = Zotero.BetterBibTeX.KeyManager.get(item.id);
      if (entry && entry.citekey) return entry.citekey;
    }
  } catch (_) {}
  var extra = item.getField("extra") || "";
  var m = extra.match(/^(?:Citation Key|bibtex):\s*(\S+)/im);
  if (m) return m[1];
  return item.key;
};

ZotFlowAutoSync.prototype._rerender = async function(sourceItem, existing) {
  var libIDMatch = existing.match(/^library-id:\s*["']?(\d+)["']?/m);
  var libraryID = libIDMatch ? libIDMatch[1] : "";

  var splitAt = existing.search(/\n## Annotations(?:\s*\n)/);
  var bodyBefore = (splitAt >= 0 ? existing.slice(0, splitAt) : existing).replace(/\s+$/, "");
  var savedComments = this._extractSavedComments(existing);

  var attachmentIDs = sourceItem.getAttachments();
  var annoBlocks = "";

  for (var i = 0; i < attachmentIDs.length; i++) {
    var attach = Zotero.Items.get(attachmentIDs[i]);
    if (!attach || !attach.isFileAttachment()) continue;
    var annos = (attach.getAnnotations() || []).slice().sort(function(a, b) {
      return (a.annotationSortIndex || "").localeCompare(b.annotationSortIndex || "");
    });
    for (var j = 0; j < annos.length; j++) {
      annoBlocks += this._renderAnno(annos[j], attach, libraryID, savedComments);
    }
  }

  var now = new Date().toISOString().slice(0, 19);
  var updatedBefore = bodyBefore.replace(/^(date-modified:\s*).*$/m, '$1"' + now + '"');

  if (annoBlocks) return updatedBefore + "\n\n## Annotations\n" + annoBlocks + "\n";
  return updatedBefore + "\n";
};

ZotFlowAutoSync.prototype._extractSavedComments = function(content) {
  var map = new Map();
  var re = />?\s*<!-- ZF_ANNO_BEG_(\w+) -->\n([\s\S]*?)>?\s*<!-- ZF_ANNO_END_\1 -->/g;
  var m;
  while ((m = re.exec(content)) !== null) {
    var text = m[2].split("\n").map(function(l) { return l.replace(/^>\s?/, ""); }).join("\n").trim();
    if (text) map.set(m[1], text);
  }
  return map;
};

ZotFlowAutoSync.prototype._renderAnno = function(anno, attach, libraryID, savedComments) {
  var type = anno.annotationType || "highlight";
  var color = anno.annotationColor || "#000000";
  var key = anno.key;
  var text = (anno.annotationText || "").trim();
  var comment = (anno.annotationComment || "").trim() || savedComments.get(key) || "";
  var pageLabel = anno.annotationPageLabel;
  var filename = attach.attachmentFilename || attach.getField("title") || "";
  var nav = encodeURIComponent(JSON.stringify({ annotationID: key }));
  var pageRef = pageLabel ? ", p." + pageLabel : "";
  var url = "obsidian://zotflow?type=open-attachment" +
    "&libraryID=" + libraryID + "&key=" + attach.key + "&navigation=" + nav;

  var block = "\n> [!zotflow-" + type + "-" + color + "] [" + filename + pageRef + "](" + url + ")\n";
  if (type !== "image" && type !== "ink" && text) {
    block += "\n> > " + text.replace(/\n/g, "\n> > ") + "\n";
  }
  if (comment) {
    block += "\n>\n> <!-- ZF_ANNO_BEG_" + key + " -->\n";
    block += comment.split("\n").map(function(l) { return "> " + l; }).join("\n") + "\n";
    block += "> <!-- ZF_ANNO_END_" + key + " -->\n";
  }
  block += "\n^" + key + "\n";
  return block;
};
