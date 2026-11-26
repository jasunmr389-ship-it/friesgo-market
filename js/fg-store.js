/**
 * FriesGo Global - IndexedDB Authoritative Local Persistence, Concurrency Merge & Snapshot Engine
 * Single Source of Truth for:
 *   1. `leads`: Active & Soft-Deleted CRM leads (transactional read-merge-write, monotonic `_rev`, soft-delete resurrection guard)
 *   2. `snapshots`: Transactional pre-destructive snapshots covering BOTH `leads` AND `compliance_logs` with 1-click rollback
 *   3. `compliance_logs`: Order-bound 6-step pre-shipment export compliance records
 *   4. `meta`: Schema version guard, 2-phase verified migration audit, persistent `deviceTag`, and atomic daily quote sequences
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
  var _liveDbRef = null;
  var _tabId = FG_CORE.genStableId("tab");
  var _bus = null;
  var _changeListeners = [];
  var _readOnlyHigherSchema = false;
  var _deviceTag = "";
  var _quoteSeqCache = Object.create(null);

  function genDeviceTag4() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var out = "";
    for (var i = 0; i < 4; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  function ensureLocalDeviceTag() {
    if (_deviceTag) return _deviceTag;
    try {
      var saved = localStorage.getItem("friesgo_device_tag");
      if (saved && /^[A-Z0-9]{4}$/.test(saved)) {
        _deviceTag = saved;
        return _deviceTag;
      }
    } catch (_) {}
    _deviceTag = genDeviceTag4();
    try { localStorage.setItem("friesgo_device_tag", _deviceTag); } catch (_) {}
    return _deviceTag;
  }

  var api = {
    DB_NAME: DB_NAME,
    APP_SCHEMA_VERSION: APP_SCHEMA_VERSION,
    tabId: _tabId,
    _simulateFailure: false,
    isReadOnlyHigherSchema: function () { return _readOnlyHigherSchema; },
    getDeviceTag: function () { return ensureLocalDeviceTag(); },
    _resetForTest: function () {
      if (_liveDbRef) {
        try { _liveDbRef.close(); } catch (_) {}
        _liveDbRef = null;
      }
      _dbPromise = null;
      _readOnlyHigherSchema = false;
      _deviceTag = "";
      _quoteSeqCache = Object.create(null);
    }
  };

  function initBus() {
    if (_bus || typeof BroadcastChannel === "undefined") return;
    try {
      _bus = new BroadcastChannel(BUS_NAME);
      _bus.onmessage = function (ev) {
        var msg = ev && ev.data;
        if (!msg || msg.tabId === _tabId) return;
        if (msg.type === "qseq_bumped" && msg.dateKey && msg.seq) {
          if ((_quoteSeqCache[msg.dateKey] || 0) < msg.seq) {
            _quoteSeqCache[msg.dateKey] = msg.seq;
          }
          return;
        }
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
        _liveDbRef = db;
        db.onversionchange = function () {
          db.close();
          _liveDbRef = null;
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
    if (!norm._rev || typeof norm._rev !== "number") norm._rev = 1;
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

  function recordsIdenticalFast(ex, inc) {
    if (!ex || !inc) return false;
    if (!!ex.deletedAt !== !!inc.deletedAt) return false;
    if (Number(ex.updatedAt || 0) !== Number(inc.updatedAt || 0)) return false;
    if ((ex.timeline ? ex.timeline.length : 0) !== (inc.timeline ? inc.timeline.length : 0)) return false;
    if ((ex.quotes ? ex.quotes.length : 0) !== (inc.quotes ? inc.quotes.length : 0)) return false;
    if (String(ex.company || "") !== String(inc.company || "")) return false;
    if (String(ex.stage || "") !== String(inc.stage || "")) return false;
    if (String(ex.nextDate || "") !== String(inc.nextDate || "")) return false;
    if (String(ex.phone || "") !== String(inc.phone || "")) return false;
    if (String(ex.email || "") !== String(inc.email || "")) return false;
    if (String(ex.note || "") !== String(inc.note || "")) return false;
    var ddA = ex.ddRecord ? (ex.ddRecord.decision + "|" + ex.ddRecord.checkedAt) : "";
    var ddB = inc.ddRecord ? (inc.ddRecord.decision + "|" + inc.ddRecord.checkedAt) : "";
    return ddA === ddB;
  }

  /**
   * Initialize IndexedDB & run strict two-phase verified migration from legacy localStorage (P0-3).
   * - Never silently swallows corrupted JSON! Aborts migration, preserves untouched raw localStorage keys, and surfaces error.
   * - Commits `migratedAt` ONLY in Phase 3 AFTER Phase 2 readback integrity verification passes!
   */
  api.init = function (opts) {
    var o = opts || {};
    initBus();
    ensureLocalDeviceTag();

    try {
      var guardRaw = localStorage.getItem("friesgo_schema_guard");
      if (guardRaw) {
        var guard = JSON.parse(guardRaw);
        var gVer = (typeof guard === "number") ? guard : Number(guard && guard.version);
        if (gVer > APP_SCHEMA_VERSION) {
          _readOnlyHigherSchema = true;
        }
      }
    } catch (_) {}

    return runTx(["meta", "leads"], "readonly", function (tx, setRes) {
      var mStore = tx.objectStore("meta");
      var metaReq = mStore.get("schema");
      var devReq = mStore.get("device_tag");
      var allReq = tx.objectStore("leads").getAll();
      metaReq.onsuccess = function () {
        devReq.onsuccess = function () {
          allReq.onsuccess = function () {
            setRes({
              schema: metaReq.result || null,
              devRec: devReq.result || null,
              leads: allReq.result || []
            });
          };
        };
      };
    }).then(function (initial) {
      if (initial.devRec && initial.devRec.tag && /^[A-Z0-9]{4}$/.test(initial.devRec.tag)) {
        _deviceTag = initial.devRec.tag;
        try { localStorage.setItem("friesgo_device_tag", _deviceTag); } catch (_) {}
      }
      if (initial.schema && Number(initial.schema.version) > APP_SCHEMA_VERSION) {
        _readOnlyHigherSchema = true;
        return api.loadState();
      }
      if (initial.schema && initial.schema.migrationStatus === "verified" && initial.schema.migratedAt) {
        // Already verified & committed; clean up lingering live keys ONLY if valid JSON or backup exists
        try {
          var remV2 = localStorage.getItem("friesgo_leads_v2");
          if (remV2) {
            JSON.parse(remV2); // Verify parseable before touching
            if (!localStorage.getItem("friesgo_leads_v2_backup_pre_p1")) {
              localStorage.setItem("friesgo_leads_v2_backup_pre_p1", remV2);
            }
            localStorage.removeItem("friesgo_leads_v2");
          }
          var remTr = localStorage.getItem("friesgo_trash_v1");
          if (remTr) {
            JSON.parse(remTr);
            localStorage.removeItem("friesgo_trash_v1");
          }
        } catch (_) {}
        return api.loadState();
      }

      // Read legacy localStorage keys
      var rawV2 = null, rawTrash = null, rawFollow = null;
      try {
        rawV2 = localStorage.getItem("friesgo_leads_v2");
        rawTrash = localStorage.getItem("friesgo_trash_v1");
        rawFollow = localStorage.getItem("friesgo_follow");
      } catch (_) {}

      var toMigrate = [];
      var seenIds = {};

      // Strict JSON validation (P0-3): NEVER silently swallow corrupt legacy JSON!
      if (rawV2 != null && String(rawV2).trim() !== "") {
        var parsedV2;
        try {
          parsedV2 = JSON.parse(rawV2);
        } catch (parseErr) {
          throw new Error("旧版客户缓存 (friesgo_leads_v2) JSON 格式已损坏，已安全中止自动迁移并原样保留旧数据不删除：" + parseErr.message);
        }
        if (!Array.isArray(parsedV2)) {
          throw new Error("旧版客户缓存 (friesgo_leads_v2) 结构异常（非数组），已安全中止自动迁移并保留原始数据");
        }
        parsedV2.forEach(function (item) {
          if (!item || typeof item !== "object" || !item.company) return;
          var norm = ensureTimelineAndQuoteIds(item);
          delete norm.deletedAt;
          if (seenIds[norm.id]) {
            var prevObj = seenIds[norm.id];
            if (prevObj && typeof prevObj === "object" &&
                String(prevObj.company || "").toLowerCase() === String(norm.company || "").toLowerCase() &&
                String(prevObj.country || "").toLowerCase() === String(norm.country || "").toLowerCase()) {
              var mergedDup = FG_CORE.mergeLeadRecord(prevObj, norm);
              Object.assign(prevObj, mergedDup);
              return;
            }
            norm.id = FG_CORE.genStableId("ld");
          }
          seenIds[norm.id] = norm;
          toMigrate.push(norm);
        });
      } else if (rawFollow != null && String(rawFollow).trim() !== "") {
        var fmap;
        try {
          fmap = JSON.parse(rawFollow);
        } catch (fErr) {
          throw new Error("旧版国家跟进缓存 (friesgo_follow) JSON 格式已损坏，已中止迁移并保留原始数据：" + fErr.message);
        }
        if (!fmap || typeof fmap !== "object" || Array.isArray(fmap)) {
          throw new Error("旧版国家跟进缓存 (friesgo_follow) 结构异常，已中止迁移并保留原始数据");
        }
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

      if (rawTrash != null && String(rawTrash).trim() !== "") {
        var parsedTrash;
        try {
          parsedTrash = JSON.parse(rawTrash);
        } catch (tErr) {
          throw new Error("旧版回收站缓存 (friesgo_trash_v1) JSON 格式已损坏，已中止迁移并保留原始数据：" + tErr.message);
        }
        if (!Array.isArray(parsedTrash)) {
          throw new Error("旧版回收站缓存 (friesgo_trash_v1) 结构异常（非数组），已中止迁移并保留原始数据");
        }
        parsedTrash.forEach(function (tItem) {
          var rawLead = (tItem && tItem.lead) ? tItem.lead : tItem;
          if (!rawLead || !rawLead.company) return;
          var normT = ensureTimelineAndQuoteIds(rawLead);
          if (seenIds[normT.id]) normT.id = FG_CORE.genStableId("ld_del");
          seenIds[normT.id] = 1;
          normT.deletedAt = (tItem && tItem.deletedAt) || rawLead.deletedAt || Date.now();
          normT.deletedAtStr = (tItem && tItem.deletedAtStr) || rawLead.deletedAtStr || new Date(normT.deletedAt).toISOString().slice(0, 16).replace("T", " ");
          normT.deletedBy = (tItem && tItem.deletedBy) || rawLead.deletedBy || o.defaultOwner || "";
          normT.deleteReason = (tItem && tItem.deleteReason) || rawLead.deleteReason || "旧版回收站迁移";
          toMigrate.push(normT);
        });
      }

      // Preserve untouched raw backup BEFORE writing anything
      try {
        if (rawV2 && !localStorage.getItem("friesgo_leads_v2_backup_pre_p1")) {
          localStorage.setItem("friesgo_leads_v2_backup_pre_p1", rawV2);
        }
      } catch (_) {}

      var expectedCounts = countNested(toMigrate);
      var startedAt = new Date().toISOString();

      // PHASE 1: Write migrated records + mark `migrationStatus: "in_progress"` (migratedAt NOT set yet!)
      return runTx(["meta", "leads"], "readwrite", function (tx, setRes) {
        var lStore = tx.objectStore("leads");
        var mStore = tx.objectStore("meta");
        var existingById = {};
        (initial.leads || []).forEach(function (ex) { existingById[ex.id] = ex; });
        for (var i = 0; i < toMigrate.length; i++) {
          var item = toMigrate[i];
          if (existingById[item.id]) {
            lStore.put(FG_CORE.mergeLeadRecord(existingById[item.id], item));
          } else {
            lStore.put(item);
          }
        }
        mStore.put({ key: "device_tag", tag: ensureLocalDeviceTag() });
        mStore.put({
          key: "schema",
          version: APP_SCHEMA_VERSION,
          migrationStatus: "in_progress",
          startedAt: startedAt,
          migratedAt: null,
          expectedCounts: expectedCounts
        });
        setRes(true);
      }).then(function () {
        // PHASE 2: Independent readback & strict integrity verification
        return api.loadState();
      }).then(function (state) {
        var allRead = state.activeLeads.concat(state.deletedLeads);
        var actualCounts = countNested(allRead);
        var idSet = {};
        allRead.forEach(function (r) { idSet[r.id] = 1; });
        var missingAnyId = toMigrate.some(function (m) { return !idSet[m.id]; });

        if (
          missingAnyId ||
          actualCounts.active < expectedCounts.active ||
          actualCounts.deleted < expectedCounts.deleted ||
          actualCounts.timelines < expectedCounts.timelines ||
          actualCounts.quotes < expectedCounts.quotes
        ) {
          throw new Error("IndexedDB 迁移回读完整性校验未通过，已中止完成标记并保留原 localStorage 数据不删除");
        }

        // PHASE 3: Commit `migrationStatus: "verified"` & `migratedAt` ONLY AFTER verification succeeded!
        var migratedAt = new Date().toISOString();
        var verifiedAudit = {
          key: "schema",
          version: APP_SCHEMA_VERSION,
          migrationStatus: "verified",
          startedAt: startedAt,
          migratedAt: migratedAt,
          expectedCounts: expectedCounts,
          verifiedCounts: actualCounts
        };
        return runTx(["meta"], "readwrite", function (tx, setRes) {
          tx.objectStore("meta").put(verifiedAudit);
          setRes(verifiedAudit);
        }).then(function (audit) {
          // PHASE 4: Remove legacy live keys ONLY AFTER Phase 3 transaction committed
          try {
            localStorage.setItem("friesgo_idb_migrated_v1", JSON.stringify({
              migratedAt: migratedAt,
              counts: actualCounts
            }));
            localStorage.setItem("friesgo_schema_guard", JSON.stringify({
              version: APP_SCHEMA_VERSION,
              at: migratedAt
            }));
            localStorage.removeItem("friesgo_leads_v2");
            localStorage.removeItem("friesgo_trash_v1");
          } catch (_) {}
          state.schema = audit;
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
      var mReq = tx.objectStore("meta").getAll();
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

              var metaArr = mReq.result || [];
              var schemaObj = null;
              metaArr.forEach(function (m) {
                if (!m || !m.key) return;
                if (m.key === "schema") schemaObj = m;
                else if (m.key === "device_tag" && m.tag && /^[A-Z0-9]{4}$/.test(m.tag)) _deviceTag = m.tag;
                else if (m.key.indexOf("qseq_") === 0 && typeof m.seq === "number") {
                  if ((_quoteSeqCache[m.key] || 0) < m.seq) _quoteSeqCache[m.key] = m.seq;
                }
              });

              setRes({
                schema: schemaObj,
                deviceTag: ensureLocalDeviceTag(),
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

  /**
   * Peek next quote sequence synchronously from cache + localStorage fallback,
   * and atomically reserve/increment in IndexedDB `meta` on formal save/copy (P1-6).
   */
  api.peekNextQuoteSeq = function (dateStr) {
    var dKey = "qseq_" + String(dateStr || "").replace(/-/g, "").slice(0, 8);
    var mem = _quoteSeqCache[dKey] || 0;
    var loc = 0;
    try { loc = parseInt(localStorage.getItem("friesgo_" + dKey) || "0", 10) || 0; } catch (_) {}
    return Math.max(mem, loc) + 1;
  };

  api.reserveNextQuoteSeq = function (dateStr) {
    var dKey = "qseq_" + String(dateStr || "").replace(/-/g, "").slice(0, 8);
    return runTx(["meta"], "readwrite", function (tx, setRes) {
      var mStore = tx.objectStore("meta");
      var req = mStore.get(dKey);
      req.onsuccess = function () {
        var curDb = (req.result && typeof req.result.seq === "number") ? req.result.seq : 0;
        var curLoc = 0;
        try { curLoc = parseInt(localStorage.getItem("friesgo_" + dKey) || "0", 10) || 0; } catch (_) {}
        var next = Math.max(curDb, curLoc, _quoteSeqCache[dKey] || 0) + 1;
        _quoteSeqCache[dKey] = next;
        mStore.put({ key: dKey, seq: next, updatedAt: Date.now() });
        try { localStorage.setItem("friesgo_" + dKey, String(next)); } catch (_) {}
        setRes(next);
      };
    }).then(function (seq) {
      initBus();
      if (_bus) {
        try { _bus.postMessage({ type: "qseq_bumped", tabId: _tabId, dateKey: dKey, seq: seq }); } catch (_) {}
      }
      return seq;
    });
  };

  /**
   * Incremental single-lead transactional read-merge-write with soft-delete resurrection protection (P0-1).
   */
  api.putLeadMerged = function (lead, opts) {
    var o = opts || {};
    var norm = ensureTimelineAndQuoteIds(lead);
    if (!o.keepDeletedAt) {
      delete norm.deletedAt;
      delete norm.deletedAtStr;
      delete norm.deletedBy;
      delete norm.deleteReason;
    }
    return runTx(["leads"], "readwrite", function (tx, setRes) {
      var store = tx.objectStore("leads");
      var gReq = store.get(norm.id);
      gReq.onsuccess = function () {
        var ex = gReq.result;
        var toWrite;
        if (ex) {
          toWrite = FG_CORE.mergeLeadRecord(ex, norm, { respectExistingSoftDelete: !o.allowResurrect });
        } else {
          norm._rev = Number(norm._rev || 0) + 1;
          toWrite = norm;
        }
        store.put(toWrite);
        setRes(toWrite);
      };
    }).then(function (saved) {
      broadcastChange("put_lead", { id: saved.id });
      return saved;
    });
  };

  api.putLead = function (lead, opts) {
    return api.putLeadMerged(lead, opts);
  };

  /**
   * Transactional multi-tab-safe active leads sync (P0-1):
   * - Normal mode: merges each changed lead with existing DB record via `FG_CORE.mergeLeadRecord(..., { respectExistingSoftDelete: true })`
   *   so concurrent tab timelines/quotes/edits are NEVER lost and soft-deleted leads are NEVER resurrected by stale tabs!
   * - Authoritative overwrite (`opts.replaceActive && opts.authoritativeOverwrite`): replaces all active leads while keeping trash intact.
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
        var existingById = Object.create(null);
        for (var eIdx = 0; eIdx < existingAll.length; eIdx++) {
          existingById[existingAll[eIdx].id] = existingAll[eIdx];
        }

        if (o.replaceActive) {
          for (var j = 0; j < existingAll.length; j++) {
            var exRec = existingAll[j];
            if (!exRec.deletedAt && !activeIdMap[exRec.id]) {
              store.delete(exRec.id);
            }
          }
        }

        var written = 0;
        for (var k = 0; k < normalizedActive.length; k++) {
          var inc = normalizedActive[k];
          var ex = existingById[inc.id];
          if (!ex) {
            inc._rev = Number(inc._rev || 0) + 1;
            store.put(inc);
            written++;
          } else if (o.authoritativeOverwrite && !ex.deletedAt) {
            inc._rev = Math.max(Number(ex._rev || 0), Number(inc._rev || 0)) + 1;
            store.put(inc);
            written++;
          } else if (!recordsIdenticalFast(ex, inc)) {
            var merged = FG_CORE.mergeLeadRecord(ex, inc, { respectExistingSoftDelete: !o.allowResurrect });
            store.put(merged);
            written++;
          }
        }
        setRes({ count: normalizedActive.length, written: written });
      };
    }).then(function (res) {
      broadcastChange("sync_active", { count: res.count, written: res.written });
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
        var rec = gReq.result
          ? (m.fallbackLead ? FG_CORE.mergeLeadRecord(gReq.result, m.fallbackLead) : ensureTimelineAndQuoteIds(gReq.result))
          : (m.fallbackLead ? ensureTimelineAndQuoteIds(m.fallbackLead) : null);
        if (!rec) { setRes(null); return; }
        rec.deletedAt = now;
        rec.deletedAtStr = nowStr;
        rec.deletedBy = m.deletedBy || "";
        rec.deleteReason = m.deleteReason || "手动移入回收站";
        rec._rev = Number(rec._rev || 0) + 1;
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
        rec._rev = Number(rec._rev || 0) + 1;
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
   * Create a verified transactional snapshot BEFORE destructive operations (P0-2).
   * Captures active leads, soft-deleted trash leads, AND `compliance_logs`!
   */
  api.createSnapshot = function (reason) {
    var now = Date.now();
    var snapId = "snap_" + now + "_" + Math.random().toString(36).slice(2, 6);
    var nowStr = new Date(now).toISOString().slice(0, 19).replace("T", " ");
    return runTx(["leads", "snapshots", "compliance_logs"], "readwrite", function (tx, setRes) {
      var lStore = tx.objectStore("leads");
      var sStore = tx.objectStore("snapshots");
      var cStore = tx.objectStore("compliance_logs");
      var lReq = lStore.getAll();
      var sReq = sStore.getAll();
      var cReq = cStore.getAll();
      lReq.onsuccess = function () {
        sReq.onsuccess = function () {
          cReq.onsuccess = function () {
            var allLeads = lReq.result || [];
            var allCompLogs = cReq.result || [];
            var counts = countNested(allLeads);
            var snap = {
              snapId: snapId,
              createdAt: now,
              createdAtStr: nowStr,
              reason: reason || "手动快照",
              activeCount: counts.active,
              deletedCount: counts.deleted,
              complianceCount: allCompLogs.length,
              leads: allLeads,
              complianceLogs: allCompLogs
            };
            sStore.put(snap);

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
      };
    }).then(function (snap) {
      broadcastChange("snapshot_created", { snapId: snap.snapId });
      return snap;
    });
  };

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
              rec._rev = Number(rec._rev || 0) + 1;
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
    return runTx(["leads", "snapshots", "compliance_logs"], "readwrite", function (tx, setRes) {
      var sStore = tx.objectStore("snapshots");
      var lStore = tx.objectStore("leads");
      var cStore = tx.objectStore("compliance_logs");
      var sReq = sStore.get(snapId);
      sReq.onsuccess = function () {
        var snap = sReq.result;
        if (!snap || !Array.isArray(snap.leads)) {
          throw new Error("未找到指定快照或快照数据已损坏");
        }
        var clearL = lStore.clear();
        clearL.onsuccess = function () {
          for (var i = 0; i < snap.leads.length; i++) {
            lStore.put(ensureTimelineAndQuoteIds(snap.leads[i]));
          }
          if (Array.isArray(snap.complianceLogs)) {
            var clearC = cStore.clear();
            clearC.onsuccess = function () {
              for (var j = 0; j < snap.complianceLogs.length; j++) {
                cStore.put(snap.complianceLogs[j]);
              }
              setRes({
                snapId: snap.snapId,
                restoredActive: snap.activeCount,
                restoredDeleted: snap.deletedCount,
                restoredCompliance: snap.complianceLogs.length
              });
            };
          } else {
            setRes({
              snapId: snap.snapId,
              restoredActive: snap.activeCount,
              restoredDeleted: snap.deletedCount,
              restoredCompliance: 0
            });
          }
        };
      };
    }).then(function (res) {
      broadcastChange("snapshot_restored", res);
      return res;
    });
  };

  /**
   * Lossless Stable-ID Merge Restore (`id` primary, fallback to `(company, country)`).
   */
  api.mergeImportLeads = function (incomingList) {
    return api.restoreBackupBundle({ crmLeads: incomingList || [] }, { mode: "merge" });
  };

  api.overwriteImportWithSnapshot = function (incomingList, reason) {
    return api.restoreBackupBundle({ crmLeads: incomingList || [] }, { mode: "overwrite", reason: reason });
  };

  /**
   * Full Business Backup Bundle Restore (P0-2):
   * Restores active `crmLeads`, soft-deleted `crmTrash` (`deletedLeads`), AND `complianceLogs`!
   * Supports `mode: "merge"` (lossless union) and `mode: "overwrite"` (creates pre-destructive snapshot first).
   */
  api.restoreBackupBundle = function (bundle, opts) {
    var b = bundle || {};
    var o = opts || {};
    var mode = o.mode === "overwrite" ? "overwrite" : "merge";

    var activeIn = (b.crmLeads || []).map(function (item) {
      var n = ensureTimelineAndQuoteIds(item);
      if (!item.deletedAt) {
        delete n.deletedAt;
        delete n.deletedAtStr;
        delete n.deletedBy;
        delete n.deleteReason;
      }
      return n;
    });

    var rawTrashIn = Array.isArray(b.crmTrash) ? b.crmTrash : (Array.isArray(b.deletedLeads) ? b.deletedLeads : []);
    var trashIn = rawTrashIn.map(function (tItem) {
      var rawL = (tItem && tItem.lead) ? tItem.lead : tItem;
      if (!rawL || !rawL.company) return null;
      var n = ensureTimelineAndQuoteIds(rawL);
      n.deletedAt = (tItem && tItem.deletedAt) || rawL.deletedAt || Date.now();
      n.deletedAtStr = (tItem && tItem.deletedAtStr) || rawL.deletedAtStr || new Date(n.deletedAt).toISOString().slice(0, 16).replace("T", " ");
      n.deletedBy = (tItem && tItem.deletedBy) || rawL.deletedBy || "";
      n.deleteReason = (tItem && tItem.deleteReason) || rawL.deleteReason || "备份恢复回收站记录";
      return n;
    }).filter(Boolean);

    var compIn = (b.complianceLogs || []).filter(function (c) { return c && typeof c === "object"; }).map(function (c) {
      var rec = Object.assign({}, c);
      if (!rec.logId) rec.logId = FG_CORE.genStableId("chk");
      if (!rec.savedAt) rec.savedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
      return rec;
    });

    if (mode === "overwrite") {
      var preStep = o.skipSnapshot
        ? Promise.resolve({ snapId: null })
        : api.createSnapshot(o.reason || "覆盖恢复完整 JSON 备份前自动保护快照");
      return preStep.then(function (snap) {
        return runTx(["leads", "compliance_logs"], "readwrite", function (tx, setRes) {
          var lStore = tx.objectStore("leads");
          var cStore = tx.objectStore("compliance_logs");
          var clL = lStore.clear();
          clL.onsuccess = function () {
            var seen = {};
            for (var i = 0; i < activeIn.length; i++) {
              seen[activeIn[i].id] = 1;
              lStore.put(activeIn[i]);
            }
            var trashRestored = 0;
            for (var j = 0; j < trashIn.length; j++) {
              var tr = trashIn[j];
              if (!seen[tr.id]) {
                seen[tr.id] = 1;
                lStore.put(tr);
                trashRestored++;
              }
            }
            if (Array.isArray(b.complianceLogs)) {
              var clC = cStore.clear();
              clC.onsuccess = function () {
                for (var k = 0; k < compIn.length; k++) {
                  cStore.put(compIn[k]);
                }
                setRes({
                  snapId: snap.snapId,
                  imported: activeIn.length,
                  trashRestored: trashRestored,
                  complianceRestored: compIn.length
                });
              };
            } else {
              setRes({
                snapId: snap.snapId,
                imported: activeIn.length,
                trashRestored: trashRestored,
                complianceRestored: 0
              });
            }
          };
        });
      }).then(function (res) {
        broadcastChange("overwrite_import", res);
        return res;
      });
    }

    // Merge mode: union active + trash leads + compliance_logs
    var allIncomingLeads = activeIn.concat(trashIn);
    return runTx(["leads", "compliance_logs"], "readwrite", function (tx, setRes) {
      var lStore = tx.objectStore("leads");
      var cStore = tx.objectStore("compliance_logs");
      var lReq = lStore.getAll();
      var cReq = cStore.getAll();
      lReq.onsuccess = function () {
        cReq.onsuccess = function () {
          var existingAll = (lReq.result || []).map(ensureTimelineAndQuoteIds);
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
          allIncomingLeads.forEach(function (inc) {
            var target = byId.get(inc.id);
            if (!target && !inc.deletedAt && inc.company) {
              var ck = String(inc.company).trim().toLowerCase() + "|" + String(inc.country || "").trim().toLowerCase();
              target = byCompCountry.get(ck) || null;
            }
            if (target) {
              var merged = FG_CORE.mergeLeadRecord(target, inc);
              byId.set(merged.id, merged);
              lStore.put(merged);
              mergedCount++;
            } else {
              byId.set(inc.id, inc);
              if (!inc.deletedAt && inc.company) {
                var ckNew = String(inc.company).trim().toLowerCase() + "|" + String(inc.country || "").trim().toLowerCase();
                byCompCountry.set(ckNew, inc);
              }
              lStore.put(inc);
              added++;
            }
          });

          var existingCompIds = {};
          (cReq.result || []).forEach(function (c) { existingCompIds[c.logId] = c; });
          var compAdded = 0, compUpdated = 0;
          compIn.forEach(function (c) {
            if (existingCompIds[c.logId]) {
              cStore.put(Object.assign({}, existingCompIds[c.logId], c));
              compUpdated++;
            } else {
              cStore.put(c);
              compAdded++;
            }
          });

          setRes({
            added: added,
            merged: mergedCount,
            complianceAdded: compAdded,
            complianceUpdated: compUpdated
          });
        };
      };
    }).then(function (res) {
      broadcastChange("merge_import", res);
      return res;
    });
  };

  api.wipeAllForTest = function () {
    return runTx(["leads", "snapshots", "compliance_logs"], "readwrite", function (tx, setRes) {
      tx.objectStore("leads").clear();
      tx.objectStore("snapshots").clear();
      tx.objectStore("compliance_logs").clear();
      setRes(true);
    });
  };

  /* Order-Bound 6-Step Pre-Shipment Compliance Logs (T06 / P1-9) */
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
