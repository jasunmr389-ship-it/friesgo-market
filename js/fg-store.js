/**
 * FriesGo Global - IndexedDB Authoritative Local Persistence & Snapshot Engine (Phase 1 T05/T06)
 * Single Source of Truth for:
 *   1. `leads`: Active & Soft-Deleted CRM leads (no 50/500 cap truncation; stable `id`/`tlId`/`quoteId`)
 *   2. `snapshots`: Transactional pre-destructive snapshots with 1-click rollback
 *   3. `compliance_logs`: Order-bound 6-step pre-shipment export compliance records
 *   4. `meta`: Schema version guard & idempotent migration audit record
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./fg-core.js"));
  } else {
    root.FG_STORE = factory(root.FG_CORE);
  }
})(typeof self !== "undefined" ? self : this, function (FG_CORE) {
  "use strict";

  var DB_NAME = "friesgo_crm_db";
  var DB_VERSION = 1;
  var APP_SCHEMA_VERSION = 1;
  var MAX_AUTO_SNAPSHOTS = 10;
  var BUS_NAME = "friesgo_crm_bus";

  var _dbPromise = null;
  var _tabId = FG_CORE.genStableId("tab");
  var _bus = null;
  var _changeListeners = [];
  var _readOnlyHigherSchema = false;

  var api = {
    DB_NAME: DB_NAME,
    APP_SCHEMA_VERSION: APP_SCHEMA_VERSION,
    tabId: _tabId,
    _simulateFailure: false,
    isReadOnlyHigherSchema: function () { return _readOnlyHigherSchema; }
  };

  function initBus() {
    if (_bus || typeof BroadcastChannel === "undefined") return;
    try {
      _bus = new BroadcastChannel(BUS_NAME);
      _bus.onmessage = function (ev) {
        var msg = ev && ev.data;
        if (!msg || msg.tabId === _tabId) return;
        for (var i = 0; i < _changeListeners.length; i++) {
          try { _changeListeners[i](msg); } catch (_) {}
        }
      };
    } catch (_) {}
  }

  function broadcastChange(reason, extra) {
    initBus();
    if (!_bus) return;
    try {
      _bus.postMessage(Object.assign({
        type: "crm_changed",
        tabId: _tabId,
        reason: reason || "update",
        at: Date.now()
      }, extra || {}));
    } catch (_) {}
  }

  api.onRemoteChange = function (fn) {
    initBus();
    if (typeof fn === "function") _changeListeners.push(fn);
  };

  function openDb() {
    if (api._simulateFailure) {
      return Promise.reject(new Error("Simulated IndexedDB storage failure"));
    }
    if (_dbPromise) return _dbPromise;
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("当前浏览器环境不支持 IndexedDB 本地数据库"));
    }
    _dbPromise = new Promise(function (resolve, reject) {
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("leads")) {
          var ls = db.createObjectStore("leads", { keyPath: "id" });
          ls.createIndex("by_country", "country", { unique: false });
          ls.createIndex("by_deletedAt", "deletedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("snapshots")) {
          db.createObjectStore("snapshots", { keyPath: "snapId" });
        }
        if (!db.objectStoreNames.contains("compliance_logs")) {
          db.createObjectStore("compliance_logs", { keyPath: "logId" });
        }
      };
      req.onsuccess = function (ev) {
        var db = ev.target.result;
        db.onversionchange = function () {
          db.close();
          _dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = function () {
        _dbPromise = null;
        reject(req.error || new Error("IndexedDB 打开失败"));
      };
      req.onblocked = function () {
        _dbPromise = null;
        reject(new Error("IndexedDB 升级被其他未关闭标签页阻塞"));
      };
    });
    return _dbPromise;
  }

  function runTx(storeNames, mode, workFn) {
    if (api._simulateFailure) {
      return Promise.reject(new Error("Simulated IndexedDB transaction failure"));
    }
    if (mode === "readwrite" && _readOnlyHigherSchema) {
      return Promise.reject(new Error("检测到更高版本的数据结构，已启用只读保护以防止回滚代码覆盖新数据"));
    }
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try {
          tx = db.transaction(storeNames, mode);
        } catch (err) {
          reject(err);
          return;
        }
        var resultHolder = null;
        var settled = false;
        tx.oncomplete = function () {
          if (!settled) {
            settled = true;
            resolve(resultHolder);
          }
        };
        tx.onerror = function () {
          if (!settled) {
            settled = true;
            reject(tx.error || new Error("IndexedDB 事务写入失败"));
          }
        };
        tx.onabort = function () {
          if (!settled) {
            settled = true;
            reject(tx.error || new Error("IndexedDB 事务已中止（可能磁盘配额不足）"));
          }
        };
        try {
          workFn(tx, function (val) { resultHolder = val; });
        } catch (err) {
          try { tx.abort(); } catch (_) {}
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
      });
    });
  }

  function ensureTimelineAndQuoteIds(lead) {
    var norm = FG_CORE.normalizeLeadForStore(lead);
    norm.timeline = (norm.timeline || []).map(function (t) {
      var item = Object.assign({}, t);
      if (!item.tlId && item.id) item.tlId = item.id;
      if (!item.id && item.tlId) item.id = item.tlId;
      if (!item.ts && item.at) item.ts = item.at;
      if (!item.at && item.ts) item.at = item.ts;
      if (!item.txt && item.result) item.txt = item.result;
      if (!item.result && item.txt) item.result = item.txt;
      return item;
    });
    return norm;
  }

  function countNested(leadsArr) {
    var active = 0, deleted = 0, timelines = 0, quotes = 0;
    (leadsArr || []).forEach(function (l) {
      if (!l) return;
      if (l.deletedAt) deleted++; else active++;
      if (Array.isArray(l.timeline)) timelines += l.timeline.length;
      if (Array.isArray(l.quotes)) quotes += l.quotes.length;
    });
    return { active: active, deleted: deleted, timelines: timelines, quotes: quotes };
  }

  /**
   * Initialize IndexedDB & run idempotent lossless migration from legacy localStorage if needed.
   */
  api.init = function (opts) {
    var o = opts || {};
    initBus();

    // Check localStorage schema guard first
    try {
      var guardRaw = localStorage.getItem("friesgo_schema_guard");
      if (guardRaw) {
        var guard = JSON.parse(guardRaw);
        if (guard && Number(guard.version) > APP_SCHEMA_VERSION) {
          _readOnlyHigherSchema = true;
        }
      }
    } catch (_) {}

    return runTx(["meta", "leads"], "readonly", function (tx, setRes) {
      var metaReq = tx.objectStore("meta").get("schema");
      var allReq = tx.objectStore("leads").getAll();
      metaReq.onsuccess = function () {
        allReq.onsuccess = function () {
          setRes({
            schema: metaReq.result || null,
            leads: allReq.result || []
          });
        };
      };
    }).then(function (initial) {
      if (initial.schema && Number(initial.schema.version) > APP_SCHEMA_VERSION) {
        _readOnlyHigherSchema = true;
        return api.loadState();
      }
      if (initial.schema && initial.schema.migratedAt) {
        // Already migrated idempotently; ensure legacy full-data localStorage keys are cleaned up if still lingering
        try {
          if (localStorage.getItem("friesgo_leads_v2")) {
            if (!localStorage.getItem("friesgo_leads_v2_backup_pre_p1")) {
              localStorage.setItem("friesgo_leads_v2_backup_pre_p1", localStorage.getItem("friesgo_leads_v2"));
            }
            localStorage.removeItem("friesgo_leads_v2");
          }
          if (localStorage.getItem("friesgo_trash_v1")) {
            localStorage.removeItem("friesgo_trash_v1");
          }
        } catch (_) {}
        return api.loadState();
      }

      // Perform one-time lossless migration from localStorage -> IndexedDB
      var rawV2 = null, rawTrash = null, rawFollow = null;
      try {
        rawV2 = localStorage.getItem("friesgo_leads_v2");
        rawTrash = localStorage.getItem("friesgo_trash_v1");
        rawFollow = localStorage.getItem("friesgo_follow");
      } catch (_) {}

      var toMigrate = [];
      var seenIds = {};

      if (rawV2) {
        try {
          var parsedV2 = JSON.parse(rawV2);
          if (Array.isArray(parsedV2)) {
            parsedV2.forEach(function (item) {
              if (!item || typeof item !== "object" || !item.company) return;
              var norm = ensureTimelineAndQuoteIds(item);
              delete norm.deletedAt;
              if (seenIds[norm.id]) norm.id = FG_CORE.genStableId("ld");
              seenIds[norm.id] = 1;
              toMigrate.push(norm);
            });
          }
        } catch (_) {}
      } else if (rawFollow) {
        try {
          var fmap = JSON.parse(rawFollow);
          if (fmap && typeof fmap === "object") {
            Object.keys(fmap).forEach(function (c) {
              var f = fmap[c] || {};
              var cnName = (o.cnMap && o.cnMap[c]) || c;
              var norm = ensureTimelineAndQuoteIds({
                id: FG_CORE.genStableId("ld"),
                company: cnName + " 市场跟进（旧版迁移）",
                country: c,
                stage: f.status || "重点跟进",
                nextDate: f.nextDate || "",
                owner: f.owner || o.defaultOwner || "",
                source: "历史迁移",
                note: f.note || "",
                updated: f.updated || new Date().toISOString().slice(0, 10),
                updatedAt: Date.now()
              });
              seenIds[norm.id] = 1;
              toMigrate.push(norm);
            });
          }
        } catch (_) {}
      }

      if (rawTrash) {
        try {
          var parsedTrash = JSON.parse(rawTrash);
          if (Array.isArray(parsedTrash)) {
            parsedTrash.forEach(function (tItem) {
              if (!tItem || !tItem.lead || !tItem.lead.company) return;
              var normT = ensureTimelineAndQuoteIds(tItem.lead);
              if (seenIds[normT.id]) normT.id = FG_CORE.genStableId("ld_del");
              seenIds[normT.id] = 1;
              normT.deletedAt = tItem.deletedAt || Date.now();
              normT.deletedAtStr = tItem.deletedAtStr || new Date(normT.deletedAt).toISOString().slice(0, 16).replace("T", " ");
              normT.deletedBy = tItem.deletedBy || o.defaultOwner || "";
              normT.deleteReason = tItem.deleteReason || "旧版回收站迁移";
              toMigrate.push(normT);
            });
          }
        } catch (_) {}
      }

      // Preserve untouched raw backup before migration
      try {
        if (rawV2 && !localStorage.getItem("friesgo_leads_v2_backup_pre_p1")) {
          localStorage.setItem("friesgo_leads_v2_backup_pre_p1", rawV2);
        }
      } catch (_) {}

      var expectedCounts = countNested(toMigrate);
      var migratedAt = new Date().toISOString();

      return runTx(["meta", "leads"], "readwrite", function (tx, setRes) {
        var lStore = tx.objectStore("leads");
        for (var i = 0; i < toMigrate.length; i++) {
          lStore.put(toMigrate[i]);
        }
        var audit = {
          key: "schema",
          version: APP_SCHEMA_VERSION,
          migratedAt: migratedAt,
          expectedCounts: expectedCounts
        };
        tx.objectStore("meta").put(audit);
        setRes(audit);
      }).then(function (audit) {
        // Post-migration readback verification
        return api.loadState().then(function (state) {
          var actualCounts = countNested(state.activeLeads.concat(state.deletedLeads));
          if (
            actualCounts.active < expectedCounts.active ||
            actualCounts.deleted < expectedCounts.deleted ||
            actualCounts.timelines < expectedCounts.timelines ||
            actualCounts.quotes < expectedCounts.quotes
          ) {
            throw new Error("IndexedDB 迁移数量校验不一致，已保留原 localStorage 数据不删除");
          }
          try {
            localStorage.setItem("friesgo_idb_migrated_v1", JSON.stringify({
              migratedAt: migratedAt,
              counts: actualCounts
            }));
            localStorage.setItem("friesgo_schema_guard", JSON.stringify({
              version: APP_SCHEMA_VERSION,
              at: migratedAt
            }));
            // Stop dual-writing active leads/trash to localStorage
            localStorage.removeItem("friesgo_leads_v2");
            localStorage.removeItem("friesgo_trash_v1");
          } catch (_) {}
          state.migrationAudit = audit;
          return state;
        });
      });
    });
  };

  api.loadState = function () {
    return runTx(["leads", "snapshots", "compliance_logs", "meta"], "readonly", function (tx, setRes) {
      var lReq = tx.objectStore("leads").getAll();
      var sReq = tx.objectStore("snapshots").getAll();
      var cReq = tx.objectStore("compliance_logs").getAll();
      var mReq = tx.objectStore("meta").get("schema");
      lReq.onsuccess = function () {
        sReq.onsuccess = function () {
          cReq.onsuccess = function () {
            mReq.onsuccess = function () {
              var all = lReq.result || [];
              var active = [];
              var deleted = [];
              for (var i = 0; i < all.length; i++) {
                var item = ensureTimelineAndQuoteIds(all[i]);
                if (item.deletedAt) deleted.push(item);
                else active.push(item);
              }
              active.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
              deleted.sort(function (a, b) { return (Number(b.deletedAt) || 0) - (Number(a.deletedAt) || 0); });
              var snaps = (sReq.result || []).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
              var clogs = (cReq.result || []).sort(function (a, b) { return String(b.savedAt || "").localeCompare(String(a.savedAt || "")); });
              setRes({
                schema: mReq.result || null,
                activeLeads: active,
                deletedLeads: deleted,
                snapshots: snaps,
                complianceLogs: clogs
              });
            };
          };
        };
      };
    });
  };

  api.getAllLeads = function () {
    return api.loadState().then(function (s) { return s.activeLeads; });
  };

  api.putLead = function (lead) {
    var norm = ensureTimelineAndQuoteIds(lead);
    delete norm.deletedAt;
    delete norm.deletedAtStr;
    delete norm.deletedBy;
    delete norm.deleteReason;
    return runTx(["leads"], "readwrite", function (tx, setRes) {
      tx.objectStore("leads").put(norm);
      setRes(norm);
    }).then(function (saved) {
      broadcastChange("put_lead", { id: saved.id });
      return saved;
    });
  };

  /**
   * Sync active in-memory crmLeads array to IndexedDB authoritatively:
   * Preserves all soft-deleted leads in IndexedDB (`deletedAt != null`),
   * updates/inserts all active leads in `activeLeads`.
   */
  api.syncActiveLeads = function (activeLeads, opts) {
    var o = opts || {};
    var normalizedActive = (activeLeads || []).map(function (l) {
      var n = ensureTimelineAndQuoteIds(l);
      delete n.deletedAt;
      delete n.deletedAtStr;
      delete n.deletedBy;
      delete n.deleteReason;
      return n;
    });
    var activeIdMap = {};
    for (var i = 0; i < normalizedActive.length; i++) {
      activeIdMap[normalizedActive[i].id] = normalizedActive[i];
    }

    return runTx(["leads"], "readwrite", function (tx, setRes) {
      var store = tx.objectStore("leads");
      var allReq = store.getAll();
      allReq.onsuccess = function () {
        var existingAll = allReq.result || [];
        if (o.replaceActive) {
          // Remove active records that are not in activeIdMap (keep soft-deleted ones intact!)
          for (var j = 0; j < existingAll.length; j++) {
            var ex = existingAll[j];
            if (!ex.deletedAt && !activeIdMap[ex.id]) {
              store.delete(ex.id);
            }
          }
        }
        for (var k = 0; k < normalizedActive.length; k++) {
          store.put(normalizedActive[k]);
        }
        setRes({ count: normalizedActive.length });
      };
    }).then(function (res) {
      broadcastChange("sync_active", { count: res.count });
      return res;
    });
  };

  api.softDeleteLead = function (leadId, meta) {
    var m = meta || {};
    var now = Date.now();
    var nowStr = m.deletedAtStr || new Date(now).toISOString().slice(0, 16).replace("T", " ");
    return runTx(["leads"], "readwrite", function (tx, setRes) {
      var store = tx.objectStore("leads");
      var gReq = store.get(leadId);
      gReq.onsuccess = function () {
        var rec = gReq.result || (m.fallbackLead ? ensureTimelineAndQuoteIds(m.fallbackLead) : null);
        if (!rec) { setRes(null); return; }
        rec.deletedAt = now;
        rec.deletedAtStr = nowStr;
        rec.deletedBy = m.deletedBy || "";
        rec.deleteReason = m.deleteReason || "手动移入回收站";
        store.put(rec);
        setRes(rec);
      };
    }).then(function (res) {
      broadcastChange("soft_delete", { id: leadId });
      return res;
    });
  };

  api.restoreSoftDeletedLead = function (leadId) {
    return runTx(["leads"], "readwrite", function (tx, setRes) {
      var store = tx.objectStore("leads");
      var gReq = store.get(leadId);
      gReq.onsuccess = function () {
        var rec = gReq.result;
        if (!rec) { setRes(null); return; }
        delete rec.deletedAt;
        delete rec.deletedAtStr;
        delete rec.deletedBy;
        delete rec.deleteReason;
        rec.updatedAt = Date.now();
        store.put(rec);
        setRes(rec);
      };
    }).then(function (res) {
      broadcastChange("restore_trash", { id: leadId });
      return res;
    });
  };

  api.purgeSoftDeletedLead = function (leadId) {
    return runTx(["leads"], "readwrite", function (tx, setRes) {
      tx.objectStore("leads").delete(leadId);
      setRes({ purged: leadId });
    }).then(function (res) {
      broadcastChange("purge_one", { id: leadId });
      return res;
    });
  };

  api.emptyTrash = function () {
    return runTx(["leads"], "readwrite", function (tx, setRes) {
      var store = tx.objectStore("leads");
      var req = store.getAll();
      req.onsuccess = function () {
        var all = req.result || [];
        var removed = 0;
        for (var i = 0; i < all.length; i++) {
          if (all[i].deletedAt) {
            store.delete(all[i].id);
            removed++;
          }
        }
        setRes({ removed: removed });
      };
    }).then(function (res) {
      broadcastChange("empty_trash", res);
      return res;
    });
  };

  /**
   * Create a verified transactional snapshot BEFORE destructive operations (bulk clear / overwrite restore).
   * Never deletes the sole valid snapshot when pruning old snapshots.
   */
  api.createSnapshot = function (reason) {
    var now = Date.now();
    var snapId = "snap_" + now + "_" + Math.random().toString(36).slice(2, 6);
    var nowStr = new Date(now).toISOString().slice(0, 19).replace("T", " ");
    return runTx(["leads", "snapshots"], "readwrite", function (tx, setRes) {
      var lStore = tx.objectStore("leads");
      var sStore = tx.objectStore("snapshots");
      var lReq = lStore.getAll();
      var sReq = sStore.getAll();
      lReq.onsuccess = function () {
        sReq.onsuccess = function () {
          var allLeads = lReq.result || [];
          var counts = countNested(allLeads);
          var snap = {
            snapId: snapId,
            createdAt: now,
            createdAtStr: nowStr,
            reason: reason || "手动快照",
            activeCount: counts.active,
            deletedCount: counts.deleted,
            leads: allLeads
          };
          sStore.put(snap);

          // Prune older snapshots beyond MAX_AUTO_SNAPSHOTS while NEVER deleting the newly written snapshot
          var prevSnaps = (sReq.result || []).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
          if (prevSnaps.length >= MAX_AUTO_SNAPSHOTS) {
            var toPrune = prevSnaps.slice(MAX_AUTO_SNAPSHOTS - 1);
            for (var i = 0; i < toPrune.length; i++) {
              if (toPrune[i].snapId !== snapId) {
                sStore.delete(toPrune[i].snapId);
              }
            }
          }
          setRes(snap);
        };
      };
    }).then(function (snap) {
      broadcastChange("snapshot_created", { snapId: snap.snapId });
      return snap;
    });
  };

  /**
   * Soft-delete ALL active leads atomically AFTER creating a verified snapshot in the SAME or preceding transaction.
   * Zero truncation: all 10,000+ leads retain soft-delete metadata and full timeline/quote history.
   */
  api.clearAllActiveWithSnapshot = function (meta) {
    var m = meta || {};
    return api.createSnapshot(m.reason || "清空客户列表前自动保护快照").then(function (snap) {
      var now = Date.now();
      var nowStr = m.deletedAtStr || new Date(now).toISOString().slice(0, 16).replace("T", " ");
      return runTx(["leads"], "readwrite", function (tx, setRes) {
        var store = tx.objectStore("leads");
        var req = store.getAll();
        req.onsuccess = function () {
          var all = req.result || [];
          var moved = 0;
          for (var i = 0; i < all.length; i++) {
            var rec = all[i];
            if (!rec.deletedAt) {
              rec.deletedAt = now;
              rec.deletedAtStr = nowStr;
              rec.deletedBy = m.deletedBy || "";
              rec.deleteReason = "批量清空列表（快照 " + snap.snapId + " 可一键回滚）";
              store.put(rec);
              moved++;
            }
          }
          setRes({ snapId: snap.snapId, movedToTrash: moved });
        };
      });
    }).then(function (res) {
      broadcastChange("clear_all_active", res);
      return res;
    });
  };

  api.restoreSnapshot = function (snapId) {
    return runTx(["leads", "snapshots"], "readwrite", function (tx, setRes) {
      var sStore = tx.objectStore("snapshots");
      var lStore = tx.objectStore("leads");
      var sReq = sStore.get(snapId);
      sReq.onsuccess = function () {
        var snap = sReq.result;
        if (!snap || !Array.isArray(snap.leads)) {
          throw new Error("未找到指定快照或快照数据已损坏");
        }
        var clearReq = lStore.clear();
        clearReq.onsuccess = function () {
          for (var i = 0; i < snap.leads.length; i++) {
            lStore.put(ensureTimelineAndQuoteIds(snap.leads[i]));
          }
          setRes({
            snapId: snap.snapId,
            restoredActive: snap.activeCount,
            restoredDeleted: snap.deletedCount
          });
        };
      };
    }).then(function (res) {
      broadcastChange("snapshot_restored", res);
      return res;
    });
  };

  /**
   * Lossless Stable-ID Merge Restore (`id` primary, fallback to normalized `(company, country)` only when IDs differ for exact same company+country).
   * Preserves all timelines (`tlId`) and quote versions (`quoteId`) without truncation.
   */
  api.mergeImportLeads = function (incomingList) {
    var incoming = (incomingList || []).map(ensureTimelineAndQuoteIds);
    return runTx(["leads"], "readwrite", function (tx, setRes) {
      var store = tx.objectStore("leads");
      var req = store.getAll();
      req.onsuccess = function () {
        var existingAll = (req.result || []).map(ensureTimelineAndQuoteIds);
        var byId = new Map();
        var byCompCountry = new Map();
        existingAll.forEach(function (ex) {
          byId.set(ex.id, ex);
          if (!ex.deletedAt && ex.company) {
            var ck = String(ex.company).trim().toLowerCase() + "|" + String(ex.country || "").trim().toLowerCase();
            if (!byCompCountry.has(ck)) byCompCountry.set(ck, ex);
          }
        });

        var added = 0, mergedCount = 0;
        incoming.forEach(function (inc) {
          var target = byId.get(inc.id);
          if (!target && inc.company) {
            var ck = String(inc.company).trim().toLowerCase() + "|" + String(inc.country || "").trim().toLowerCase();
            target = byCompCountry.get(ck) || null;
          }
          if (target) {
            var merged = FG_CORE.mergeLeadRecord(target, inc);
            byId.set(merged.id, merged);
            store.put(merged);
            mergedCount++;
          } else {
            byId.set(inc.id, inc);
            if (!inc.deletedAt && inc.company) {
              var ckNew = String(inc.company).trim().toLowerCase() + "|" + String(inc.country || "").trim().toLowerCase();
              byCompCountry.set(ckNew, inc);
            }
            store.put(inc);
            added++;
          }
        });
        setRes({ added: added, merged: mergedCount });
      };
    }).then(function (res) {
      broadcastChange("merge_import", res);
      return res;
    });
  };

  api.overwriteImportWithSnapshot = function (incomingList, reason) {
    var incoming = (incomingList || []).map(ensureTimelineAndQuoteIds);
    return api.createSnapshot(reason || "覆盖恢复 JSON 前自动保护快照").then(function (snap) {
      return runTx(["leads"], "readwrite", function (tx, setRes) {
        var store = tx.objectStore("leads");
        var req = store.getAll();
        req.onsuccess = function () {
          var all = req.result || [];
          // Delete only active leads; keep soft-deleted trash intact or replace active cleanly
          for (var i = 0; i < all.length; i++) {
            if (!all[i].deletedAt) store.delete(all[i].id);
          }
          for (var j = 0; j < incoming.length; j++) {
            store.put(incoming[j]);
          }
          setRes({ snapId: snap.snapId, imported: incoming.length });
        };
      });
    }).then(function (res) {
      broadcastChange("overwrite_import", res);
      return res;
    });
  };

  /* Order-Bound 6-Step Pre-Shipment Compliance Logs (T06) */
  api.saveComplianceLog = function (record) {
    var rec = Object.assign({}, record || {});
    if (!rec.logId) rec.logId = FG_CORE.genStableId("chk");
    if (!rec.savedAt) rec.savedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
    return runTx(["compliance_logs"], "readwrite", function (tx, setRes) {
      tx.objectStore("compliance_logs").put(rec);
      setRes(rec);
    }).then(function (saved) {
      broadcastChange("compliance_saved", { logId: saved.logId });
      return saved;
    });
  };

  api.deleteComplianceLog = function (logId) {
    return runTx(["compliance_logs"], "readwrite", function (tx, setRes) {
      tx.objectStore("compliance_logs").delete(logId);
      setRes({ deleted: logId });
    }).then(function (res) {
      broadcastChange("compliance_deleted", res);
      return res;
    });
  };

  return api;
});
