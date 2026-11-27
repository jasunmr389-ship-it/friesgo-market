/**
 * FriesGo Global - Core Pure Logic, Security Guards & Fixed-Point Engines (Phase 1)
 * Zero-Build UMD module: works identically in Browser (`window.FG_CORE`) and Node.js (`require('./js/fg-core.js')`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FG_CORE = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ==================== 1. Security, Sanitization & Module Error Boundary ==================== */

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  var DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  var TLD_RE = /^(?:[a-z]{2,24}|xn--[a-z0-9]{2,59})$/;

  function extractCleanDomain(raw) {
    if (raw == null) return "";
    var s = String(raw).trim().toLowerCase();
    if (!s) return "";
    // Reject any string containing XSS / HTML / whitespace / control chars even before stripping path
    if (/[<>"'`\s\\{}]/.test(s) || /[\x00-\x1f\x7f]/.test(s)) return "";
    s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
    var slashIdx = s.indexOf("/");
    if (slashIdx !== -1) s = s.slice(0, slashIdx);
    var qIdx = s.indexOf("?");
    if (qIdx !== -1) s = s.slice(0, qIdx);
    var hIdx = s.indexOf("#");
    if (hIdx !== -1) s = s.slice(0, hIdx);
    var atIdx = s.lastIndexOf("@");
    if (atIdx !== -1) s = s.slice(atIdx + 1);
    var colonIdx = s.indexOf(":");
    if (colonIdx !== -1) s = s.slice(0, colonIdx);
    s = s.replace(/\.+$/, "");
    return isValidDomain(s) ? s : "";
  }

  function isValidDomain(d) {
    if (typeof d !== "string") return false;
    var s = d.trim().toLowerCase();
    if (!s || s.length > 253) return false;
    if (/[^a-z0-9.-]/.test(s)) return false;
    var parts = s.split(".");
    if (parts.length < 2) return false;
    for (var i = 0; i < parts.length; i++) {
      if (!DOMAIN_LABEL_RE.test(parts[i])) return false;
    }
    var tld = parts[parts.length - 1];
    if (!TLD_RE.test(tld)) return false;
    return true;
  }

  function safeHttpUrl(raw) {
    if (raw == null) return "";
    var s = String(raw).trim();
    if (!s) return "";
    if (/[\x00-\x1f\x7f<>"'`\s]/.test(s)) {
      // Encode spaces only if valid http(s) URL, reject angle/quote chars outright
      if (/[\x00-\x1f\x7f<>"'`]/.test(s)) return "";
      s = s.replace(/\s+/g, "%20");
    }
    if (!/^https?:\/\//i.test(s)) return "";
    try {
      var u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      if (!u.hostname) return "";
      return u.href;
    } catch (_) {
      return "";
    }
  }

  function safeInit(moduleName, fn) {
    try {
      return fn();
    } catch (err) {
      if (typeof console !== "undefined" && console.error) {
        console.error("[FG_INIT_ERROR:" + moduleName + "]", err);
      }
      if (typeof window !== "undefined") {
        window._fgInitErrors = window._fgInitErrors || [];
        window._fgInitErrors.push({
          module: moduleName,
          message: String((err && err.message) || err),
          at: new Date().toISOString()
        });
      }
      return null;
    }
  }

  function genStableId(prefix) {
    var p = prefix || "fg";
    var rand = "";
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return p + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    }
    for (var i = 0; i < 12; i++) {
      rand += Math.floor(Math.random() * 36).toString(36);
    }
    return p + "_" + Date.now().toString(36) + "_" + rand;
  }

  /* ==================== 2. Fixed-Point Decimal Arithmetic (Scale 10^8 BigInt) ==================== */

  var SCALE_DIGITS = 8;
  var SCALE = 100000000n; // 10^8
  var HALF_SCALE = 50000000n;

  function toScaled(val) {
    if (typeof val === "bigint") return val;
    if (val == null || val === "") return 0n;
    var s = typeof val === "number" ? (Number.isFinite(val) ? val.toFixed(10) : "0") : String(val).trim().replace(/,/g, "");
    if (!s || s === "-" || s === "+") return 0n;
    // Handle scientific notation if passed
    if (/[eE]/.test(s)) {
      var num = Number(s);
      if (!Number.isFinite(num)) return 0n;
      s = num.toFixed(10);
    }
    var neg = false;
    if (s[0] === "-") { neg = true; s = s.slice(1); }
    else if (s[0] === "+") { s = s.slice(1); }
    var m = s.match(/^(\d*)(?:\.(\d*))?$/);
    if (!m) return 0n;
    var intPart = m[1] || "0";
    var fracRaw = m[2] || "";
    var fracPadded = (fracRaw + "000000000").slice(0, SCALE_DIGITS + 1);
    var mainFrac = fracPadded.slice(0, SCALE_DIGITS);
    var ninthDigit = parseInt(fracPadded[SCALE_DIGITS] || "0", 10);
    var res = BigInt(intPart) * SCALE + BigInt(mainFrac);
    if (ninthDigit >= 5) res += 1n;
    return neg ? -res : res;
  }

  function fromScaled(b, decimals) {
    var dec = decimals == null ? 8 : decimals;
    var r = roundToDecimalsScaled(b, dec);
    var neg = r < 0n;
    var abs = neg ? -r : r;
    var intPart = abs / SCALE;
    var fracPart = String(abs % SCALE).padStart(SCALE_DIGITS, "0");
    var numStr = (neg ? "-" : "") + intPart.toString() + (dec > 0 ? "." + fracPart.slice(0, dec) : "");
    return Number(numStr);
  }

  function formatScaled(b, decimals) {
    var dec = Math.max(0, Math.min(8, decimals == null ? 2 : decimals));
    var r = roundToDecimalsScaled(b, dec);
    var neg = r < 0n;
    var abs = neg ? -r : r;
    var intPart = abs / SCALE;
    var fracPart = String(abs % SCALE).padStart(SCALE_DIGITS, "0");
    return (neg ? "-" : "") + intPart.toString() + (dec > 0 ? "." + fracPart.slice(0, dec) : "");
  }

  function mulScaled(a, b) {
    var prod = a * b;
    if (prod >= 0n) return (prod + HALF_SCALE) / SCALE;
    return -((-prod + HALF_SCALE) / SCALE);
  }

  function divScaled(a, b, mode) {
    if (b === 0n) throw new Error("Division by zero in fixed-point engine");
    var neg = (a < 0n) !== (b < 0n);
    var aa = a < 0n ? -a : a;
    var bb = b < 0n ? -b : b;
    var num = aa * SCALE;
    var q;
    if (mode === "ceil" && !neg) {
      q = (num + bb - 1n) / bb;
    } else if (mode === "floor" && !neg) {
      q = num / bb;
    } else {
      q = (num + bb / 2n) / bb;
    }
    return neg ? -q : q;
  }

  function roundToDecimalsScaled(b, decimals) {
    var dec = Math.max(0, Math.min(8, decimals));
    if (dec === 8) return b;
    var step = 10n ** BigInt(8 - dec);
    var half = step / 2n;
    if (b >= 0n) return ((b + half) / step) * step;
    return -(((-b + half) / step) * step);
  }

  function ceilToDecimalsScaled(b, decimals) {
    var dec = Math.max(0, Math.min(8, decimals));
    if (dec === 8) return b;
    var step = 10n ** BigInt(8 - dec);
    if (b >= 0n) return ((b + step - 1n) / step) * step;
    return -((-b / step) * step);
  }

  function pickAutoDecimals(unitUsdScaled) {
    var u = unitUsdScaled < 0n ? -unitUsdScaled : unitUsdScaled;
    if (u === 0n) return 2;
    if (u < 1000000n) return 6;    // < $0.01 -> 6 decimals
    if (u < 10000000n) return 5;   // < $0.10 -> 5 decimals (e.g., $0.02605)
    if (u < 100000000n) return 4;  // < $1.00 -> 4 decimals
    return 2;                      // >= $1.00 -> 2 decimals
  }

  var DEC = {
    SCALE: SCALE,
    toScaled: toScaled,
    fromScaled: fromScaled,
    formatScaled: formatScaled,
    mulScaled: mulScaled,
    divScaled: divScaled,
    roundToDecimalsScaled: roundToDecimalsScaled,
    ceilToDecimalsScaled: ceilToDecimalsScaled,
    pickAutoDecimals: pickAutoDecimals
  };

  /* ==================== 3. Export Quotation Precision & Tax Engine (T02 + T03) ==================== */

  function sanitizeClientCode(name) {
    var raw = String(name || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (raw.length >= 3) return raw.slice(0, 6);
    if (!name || !String(name).trim()) return "GEN";
    // Hash Chinese or non-ASCII client name deterministically to 4 uppercase alphanumeric chars
    var s = String(name).trim();
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return "C" + ((h >>> 0) % 46656).toString(36).toUpperCase().padStart(3, "0");
  }

  function formatQuoteRef(opts) {
    var o = opts || {};
    var datePart = String(o.dateStr || "").replace(/-/g, "").slice(0, 8);
    if (!/^\d{8}$/.test(datePart)) {
      var d = new Date();
      datePart = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    }
    var code = sanitizeClientCode(o.clientName || o.country || "GEN");
    var devRaw = String(o.deviceTag || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    var devPart = devRaw ? ("-" + devRaw.slice(0, 4).padEnd(4, "X")) : "";
    var seqNum = Math.max(1, parseInt(o.seq || 1, 10) || 1);
    var verNum = Math.max(1, parseInt(o.version || 1, 10) || 1);
    return "FG-" + datePart + "-" + code + devPart + "-" + String(seqNum).padStart(3, "0") + "-V" + verNum;
  }

  /**
   * Pure Fixed-Point Export Quote Calculation
   * Supports:
   * - taxMode:
   *   "small_exempt" (default): Small-scale taxpayer VAT-exempt without refund -> 0% rebate deducted on base price; shows hypothetical general-taxpayer post-rebate profit & margin side-by-side.
   *   "vat_unconfirmed": VAT-inclusive purchase, rebate eligibility unconfirmed -> conservative 0% rebate deducted on base price; shows hypothetical post-rebate profit & margin.
   *   "vat_rebate": Confirmed General Taxpayer VAT Special Invoice export rebate -> deducts (fac / (1 + vat)) * reb; also shows conservative 0-rebate fallback profit & margin.
   *   "ex_tax": Ex-tax factory price -> 0% rebate, optional exTaxExtraPct invoicing/compliance surcharge.
   * - commBasis:
   *   "cif_keep_amt" (default Mode A): CIF absorbs incremental commission on freight & insurance so RMB profit amount is preserved.
   *   "cif_keep_pct" (optional Mode B): CIF preserves target net profit margin % across total CIF contract value.
   *   "fob": Commission calculated strictly on FOB value only.
   * - decimals: "auto" | 2 | 3 | 4 | 5 | 6 (ceiling-rounded to protect target profit floor).
   */
  function computeQuote(input) {
    var p = input || {};
    var errs = [];
    var bad = {};

    var priceMode = p.priceMode === "unit" ? "unit" : "total";
    var taxMode = p.taxMode || "small_exempt";
    if (["small_exempt", "vat_unconfirmed", "vat_rebate", "ex_tax"].indexOf(taxMode) === -1) {
      taxMode = "small_exempt";
    }
    var commBasis = p.commBasis || "cif_keep_amt";
    if (["cif_keep_amt", "cif_keep_pct", "fob"].indexOf(commBasis) === -1) {
      commBasis = "cif_keep_amt";
    }

    var rawFacNum = Number(p.rawFac);
    var qtyNum = Number(p.qty);
    var fxNum = Number(p.fx);
    var vatPctNum = p.vatPct == null || p.vatPct === "" ? 13 : Number(p.vatPct);
    var rebPctNum = p.rebPct == null || p.rebPct === "" ? 0 : Number(p.rebPct);
    var exTaxExtraPctNum = p.exTaxExtraPct == null || p.exTaxExtraPct === "" ? 0 : Number(p.exTaxExtraPct);
    var marginPctNum = Number(p.marginPct);
    var commPctNum = p.commPct == null || p.commPct === "" ? 0 : Number(p.commPct);
    var locRmbNum = p.locRmb == null || p.locRmb === "" ? 0 : Number(p.locRmb);
    var frtUsdNum = p.freightUsd == null || p.freightUsd === "" ? 0 : Number(p.freightUsd);
    var insPctNum = p.insPct == null || p.insPct === "" ? 0 : Number(p.insPct);
    var bankUsdNum = p.bankUsd == null || p.bankUsd === "" ? 0 : Number(p.bankUsd);
    var dutyPctNum = p.dutyPct == null || p.dutyPct === "" ? 0 : Number(p.dutyPct);
    var leadNum = p.lead == null || p.lead === "" ? 25 : Number(p.lead);
    var validDaysNum = p.validDays == null || p.validDays === "" ? 15 : Number(p.validDays);
    var cutCustNum = p.cutCust == null || p.cutCust === "" ? 5 : Number(p.cutCust);

    if (!Number.isFinite(rawFacNum) || rawFacNum <= 0) { bad.qcFactoryRmb = true; errs.push("工厂采购价须大于 0"); }
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) { bad.qcQty = true; errs.push("报价数量须大于 0"); }
    if (!Number.isFinite(fxNum) || fxNum < 3 || fxNum > 20) { bad.qcFx = true; errs.push("结算汇率须在 3.00–20.00 合理区间"); }
    if (!Number.isFinite(vatPctNum) || vatPctNum < 0 || vatPctNum > 25) { bad.qcVatPct = true; errs.push("采购发票税率须在 0%–25% 之间"); }
    if (!Number.isFinite(rebPctNum) || rebPctNum < 0 || rebPctNum > 17) { bad.qcRebate = true; errs.push("出口退税率须在 0%–17% 之间"); }
    if (taxMode !== "ex_tax" && Number.isFinite(rebPctNum) && Number.isFinite(vatPctNum) && rebPctNum > vatPctNum + 1e-9) {
      bad.qcRebate = true; bad.qcVatPct = true;
      errs.push("出口退税率（" + rebPctNum + "%）不能高于采购发票增值税率（" + vatPctNum + "%）");
    }
    if (!Number.isFinite(exTaxExtraPctNum) || exTaxExtraPctNum < 0 || exTaxExtraPctNum > 30) {
      bad.qcExTaxExtraPct = true; errs.push("不含税附加税费率须在 0%–30% 之间");
    }
    if (!Number.isFinite(marginPctNum) || marginPctNum < 0 || marginPctNum >= 95) { bad.qcMargin = true; errs.push("目标净利率须在 0%–94.9% 之间"); }
    if (!Number.isFinite(commPctNum) || commPctNum < 0 || commPctNum >= 80) { bad.qcCommPct = true; errs.push("佣金/保费率须在 0%–79.9% 之间"); }
    if (Number.isFinite(marginPctNum) && Number.isFinite(commPctNum) && (marginPctNum + commPctNum >= 95)) {
      bad.qcMargin = true; bad.qcCommPct = true; errs.push("目标净利率 + 佣金率合计须小于 95%");
    }
    if (!Number.isFinite(locRmbNum) || locRmbNum < 0) { bad.qcLocalRmb = true; errs.push("港杂拖车费不能为负数"); }
    if (!Number.isFinite(frtUsdNum) || frtUsdNum < 0) { bad.qcFreightUsd = true; errs.push("海运费不能为负数"); }
    if (!Number.isFinite(insPctNum) || insPctNum < 0 || insPctNum >= 20) { bad.qcInsPct = true; errs.push("海运保险费率须在 0%–19.9% 之间"); }
    if (commBasis === "cif_keep_amt" && Number.isFinite(commPctNum) && Number.isFinite(insPctNum) && (commPctNum + 1.1 * insPctNum >= 95)) {
      bad.qcCommPct = true; bad.qcInsPct = true; errs.push("CIF 计佣模式下（佣金率 + 1.1×保费率）合计须小于 95%");
    }
    if (commBasis === "cif_keep_pct" && Number.isFinite(marginPctNum) && Number.isFinite(commPctNum) && Number.isFinite(insPctNum) && (marginPctNum + commPctNum + 1.1 * insPctNum >= 95)) {
      bad.qcMargin = true; bad.qcCommPct = true; bad.qcInsPct = true; errs.push("CIF 保利润率模式下（目标净利率 + 佣金率 + 1.1×保费率）合计须小于 95%");
    }
    if (!Number.isFinite(bankUsdNum) || bankUsdNum < 0) { bad.qcBankUsd = true; errs.push("银行手续费不能为负数"); }
    if (!Number.isFinite(dutyPctNum) || dutyPctNum < 0 || dutyPctNum > 300) { bad.qcDutyPct = true; errs.push("目的国关税率须在 0%–300% 之间"); }
    if (!Number.isFinite(leadNum) || leadNum < 1 || leadNum > 730) { bad.qcLeadDays = true; errs.push("交货期须在 1–730 天之间"); }
    if (!Number.isFinite(validDaysNum) || validDaysNum < 1 || validDaysNum > 365) { bad.qcValidDays = true; errs.push("报价有效期须在 1–365 天之间"); }
    if (!Number.isFinite(cutCustNum) || cutCustNum <= 0 || cutCustNum >= 90) { bad.qcCutCustom = true; errs.push("自定义降价模拟幅度须在 0.1%–89.9% 之间"); }

    if (errs.length > 0) {
      return { ok: false, errs: errs, bad: bad };
    }

    // Convert all financial quantities to 10^8 BigInt fixed-point
    var rawFacS = toScaled(p.rawFac);
    var qtyS = toScaled(p.qty);
    var fxS = toScaled(p.fx);
    var vatRateS = divScaled(toScaled(vatPctNum), toScaled(100), "round");
    var rebRateS = divScaled(toScaled(rebPctNum), toScaled(100), "round");
    var exExtraRateS = divScaled(toScaled(exTaxExtraPctNum), toScaled(100), "round");
    var mgnS = divScaled(toScaled(marginPctNum), toScaled(100), "round");
    var commS = divScaled(toScaled(commPctNum), toScaled(100), "round");
    var locRmbS = toScaled(locRmbNum);
    var frtUsdS = toScaled(frtUsdNum);
    var insRateS = divScaled(toScaled(insPctNum), toScaled(100), "round");
    var bankUsdS = toScaled(bankUsdNum);
    var dutyRateS = divScaled(toScaled(dutyPctNum), toScaled(100), "round");

    var facBaseRmbS = priceMode === "unit" ? mulScaled(rawFacS, qtyS) : rawFacS;
    var payableProcRmbS = taxMode === "ex_tax"
      ? mulScaled(facBaseRmbS, SCALE + exExtraRateS)
      : facBaseRmbS;

    // Potential export rebate if General Taxpayer VAT special invoice applies
    var potentialRebateRmbS = 0n;
    if (taxMode !== "ex_tax" && rebRateS > 0n) {
      var exVatBaseS = divScaled(facBaseRmbS, SCALE + vatRateS, "round");
      potentialRebateRmbS = mulScaled(exVatBaseS, rebRateS);
    }

    // Conservative rule: ONLY deduct rebate in base pricing when taxMode === "vat_rebate" (explicitly confirmed!)
    var pricingRebateRmbS = taxMode === "vat_rebate" ? potentialRebateRmbS : 0n;
    var pricingProcRmbS = payableProcRmbS - pricingRebateRmbS;
    var fixedCostRmbS = locRmbS + mulScaled(bankUsdS, fxS);

    var pricingTotalCostRmbS = pricingProcRmbS + fixedCostRmbS;       // Cost basis used to set selling price
    var conservativeCostRmbS = payableProcRmbS + fixedCostRmbS;       // Strict 0-rebate cost basis
    var postRebateCostRmbS = (payableProcRmbS - potentialRebateRmbS) + fixedCostRmbS; // Cost basis if rebate is realized

    // 1) FOB Pricing
    var fobDenomS = SCALE - mgnS - commS;
    var costUsdS = divScaled(pricingTotalCostRmbS, fxS, "ceil");
    var fobUsdRawS = divScaled(costUsdS, fobDenomS, "ceil");
    var unitFobRawS = divScaled(fobUsdRawS, qtyS, "ceil");

    var reqDec = p.decimals;
    var isAutoDec = (reqDec == null || reqDec === "" || reqDec === "auto");
    var decFob = isAutoDec ? pickAutoDecimals(unitFobRawS) : Math.max(2, Math.min(6, parseInt(reqDec, 10) || 2));

    // Ceiling-round unit price so external Unit Price * Qty NEVER drops below target profit floor
    var unitFobS = ceilToDecimalsScaled(unitFobRawS, decFob);
    var fobUsdS = roundToDecimalsScaled(mulScaled(unitFobS, qtyS), 2);
    var fobCommUsdS = roundToDecimalsScaled(mulScaled(fobUsdS, commS), 2);
    var fobCommRmbS = mulScaled(fobCommUsdS, fxS);
    var fobRevRmbS = mulScaled(fobUsdS, fxS);

    // Check if forced low decimal count inflated price noticeably (>3% over raw)
    var precisionNote = "";
    if (!isAutoDec && unitFobRawS > 0n) {
      var diffRatio = fromScaled(divScaled(unitFobS - unitFobRawS, unitFobRawS, "round"), 4);
      if (diffRatio > 0.03) {
        precisionNote = "当前单价较小，固定 " + decFob + " 位小数向上保利进位使单价上浮 " + (diffRatio * 100).toFixed(1) + "%；建议改选「Auto 智能精度」或 4–5 位小数使报价更具竞争力。";
      }
    }

    // FOB Profits & Margins (Actual pricing basis, Conservative 0-rebate basis, Hypothetical post-rebate basis)
    var fobProfitPricingRmbS = fobRevRmbS - pricingTotalCostRmbS - fobCommRmbS;
    var fobProfitConsRmbS = fobRevRmbS - conservativeCostRmbS - fobCommRmbS;
    var fobProfitRebRmbS = fobRevRmbS - postRebateCostRmbS - fobCommRmbS;

    var fobMarginPricingPct = fobRevRmbS > 0n ? fromScaled(divScaled(fobProfitPricingRmbS * 100n, fobRevRmbS, "round"), 2) : 0;
    var fobMarginConsPct = fobRevRmbS > 0n ? fromScaled(divScaled(fobProfitConsRmbS * 100n, fobRevRmbS, "round"), 2) : 0;
    var fobMarginRebPct = fobRevRmbS > 0n ? fromScaled(divScaled(fobProfitRebRmbS * 100n, fobRevRmbS, "round"), 2) : 0;

    // 2) CIF Pricing (supports Mode A: cif_keep_amt, Mode B: cif_keep_pct, and FOB-only commission: fob)
    var insFactorS = mulScaled(toScaled("1.1"), insRateS); // 1.1 * insRate
    var cifUsdRawS;
    if (commBasis === "cif_keep_amt") {
      // CIF * (1 - 1.1*i - c) = FOB * (1 - c) + F
      var netFobAfterCommS = fobUsdS - fobCommUsdS;
      var cifDenomAmtS = SCALE - insFactorS - commS;
      cifUsdRawS = divScaled(netFobAfterCommS + frtUsdS, cifDenomAmtS, "ceil");
    } else if (commBasis === "cif_keep_pct") {
      // CIF * (1 - m - c - 1.1*i) = U_cost + F
      var cifDenomPctS = SCALE - mgnS - commS - insFactorS;
      cifUsdRawS = divScaled(costUsdS + frtUsdS, cifDenomPctS, "ceil");
    } else {
      // commBasis === "fob": commission fixed to FOB value; CIF * (1 - 1.1*i) = FOB + F
      var cifDenomFobS = SCALE - insFactorS;
      cifUsdRawS = divScaled(fobUsdS + frtUsdS, cifDenomFobS, "ceil");
    }

    var unitCifRawS = divScaled(cifUsdRawS, qtyS, "ceil");
    var decCif = isAutoDec ? Math.max(decFob, pickAutoDecimals(unitCifRawS)) : decFob;
    var unitCifS = ceilToDecimalsScaled(unitCifRawS, decCif);
    var cifUsdS = roundToDecimalsScaled(mulScaled(unitCifS, qtyS), 2);
    var insUsdS = roundToDecimalsScaled(mulScaled(cifUsdS, insFactorS), 2);
    var cifCommUsdS = commBasis === "fob" ? fobCommUsdS : roundToDecimalsScaled(mulScaled(cifUsdS, commS), 2);
    var cifCommRmbS = mulScaled(cifCommUsdS, fxS);

    var cifRevRmbS = mulScaled(cifUsdS, fxS);
    var cifNetGoodsUsdS = cifUsdS - frtUsdS - insUsdS - cifCommUsdS;
    var cifNetGoodsRmbS = mulScaled(cifNetGoodsUsdS, fxS);

    var cifProfitPricingRmbS = cifNetGoodsRmbS - pricingTotalCostRmbS;
    var cifProfitConsRmbS = cifNetGoodsRmbS - conservativeCostRmbS;
    var cifProfitRebRmbS = cifNetGoodsRmbS - postRebateCostRmbS;

    var cifMarginPricingPct = cifRevRmbS > 0n ? fromScaled(divScaled(cifProfitPricingRmbS * 100n, cifRevRmbS, "round"), 2) : 0;
    var cifMarginConsPct = cifRevRmbS > 0n ? fromScaled(divScaled(cifProfitConsRmbS * 100n, cifRevRmbS, "round"), 2) : 0;
    var cifMarginRebPct = cifRevRmbS > 0n ? fromScaled(divScaled(cifProfitRebRmbS * 100n, cifRevRmbS, "round"), 2) : 0;

    var landedUsdS = roundToDecimalsScaled(mulScaled(cifUsdS, SCALE + dutyRateS), 2);
    var unitVarCostRmbS = divScaled(pricingProcRmbS, qtyS, "round");
    var breakEvenDenomS = SCALE - commS;
    var breakEvenUnitUsdS = divScaled(divScaled(pricingTotalCostRmbS, fxS, "ceil"), mulScaled(breakEvenDenomS, qtyS), "ceil");
    var fxDropLossRmb = Math.round(fromScaled(mulScaled(fobUsdS, mulScaled(fxS, toScaled("0.03"))), 2));

    // Post-rounding actual profit floor check (evaluated strictly AFTER external unit/total/commission/insurance rounding)
    var minFloorRaw = Number(p.minMarginFloorPct);
    var minFloorPctNum = (Number.isFinite(minFloorRaw) && minFloorRaw > 0) ? Math.min(80, minFloorRaw) : 0;
    var isLossAfterRounding = (fobProfitPricingRmbS < 0n || cifProfitPricingRmbS < 0n);
    var isBelowFobFloor = minFloorPctNum > 0 && (fobMarginPricingPct + 1e-6 < minFloorPctNum);
    var isBelowCifPctFloor = minFloorPctNum > 0 && commBasis === "cif_keep_pct" && frtUsdS > 0n && (cifMarginPricingPct + 1e-6 < minFloorPctNum);
    var belowProfitFloor = isLossAfterRounding || isBelowFobFloor || isBelowCifPctFloor;
    var conservativeNegativeWarn = (fobProfitConsRmbS < 0n || cifProfitConsRmbS < 0n);
    var profitFloorMsg = "";
    if (isLossAfterRounding) {
      profitFloorMsg = "⛔ 舍入后实得净利为负（FOB ¥" + fromScaled(fobProfitPricingRmbS, 2).toFixed(2) + " / CIF ¥" + fromScaled(cifProfitPricingRmbS, 2).toFixed(2) + "），严禁按此价格对外正式报价！";
    } else if (belowProfitFloor) {
      profitFloorMsg = "⚠️ 最终对外舍入后实际净利率（FOB " + fobMarginPricingPct.toFixed(2) + "%" + (frtUsdS > 0n ? (" / CIF " + cifMarginPricingPct.toFixed(2) + "%") : "") + "）低于设定的公司最低利润红线（" + minFloorPctNum.toFixed(1) + "%），已拦截正式报价输出，请上调目标利润率或经管理层特批调整底线！";
    } else if (conservativeNegativeWarn) {
      profitFloorMsg = "⚠️ 退税依赖风险：当前报价建立在出口退税抵扣基础上，若退税受阻（按保守不退税口径），本单将亏损 ¥" + Math.abs(fromScaled(fobProfitConsRmbS, 2)).toFixed(2) + "，请务必确认进项专票与退税率无误！";
    }

    return {
      ok: true,
      quoteId: p.quoteId || genStableId("qt"),
      taxMode: taxMode,
      commBasis: commBasis,
      decimals: decFob,
      cifDecimals: decCif,
      isAutoDecimals: isAutoDec,
      precisionNote: precisionNote,
      minMarginFloorPct: minFloorPctNum,
      belowProfitFloor: belowProfitFloor,
      conservativeNegativeWarn: conservativeNegativeWarn,
      profitFloorMsg: profitFloorMsg,

      facBaseRmb: fromScaled(facBaseRmbS, 2),
      payableProcRmb: fromScaled(payableProcRmbS, 2),
      potentialRebateRmb: fromScaled(potentialRebateRmbS, 2),
      pricingRebateRmb: fromScaled(pricingRebateRmbS, 2),
      fixedCostRmb: fromScaled(fixedCostRmbS, 2),
      pricingTotalCostRmb: fromScaled(pricingTotalCostRmbS, 2),
      conservativeCostRmb: fromScaled(conservativeCostRmbS, 2),
      postRebateCostRmb: fromScaled(postRebateCostRmbS, 2),

      unitFobUsd: fromScaled(unitFobS, decFob),
      unitFobStr: "$" + formatScaled(unitFobS, decFob),
      fobUsd: fromScaled(fobUsdS, 2),
      fobStr: "$" + Number(formatScaled(fobUsdS, 2)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      fobCommUsd: fromScaled(fobCommUsdS, 2),
      fobCommRmb: fromScaled(fobCommRmbS, 2),

      fobProfitRmb: fromScaled(fobProfitPricingRmbS, 2),
      fobMarginPct: fobMarginPricingPct,
      fobProfitConservativeRmb: fromScaled(fobProfitConsRmbS, 2),
      fobMarginConservativePct: fobMarginConsPct,
      fobProfitWithRebateRmb: fromScaled(fobProfitRebRmbS, 2),
      fobMarginWithRebatePct: fobMarginRebPct,

      unitCifUsd: fromScaled(unitCifS, decCif),
      unitCifStr: "$" + formatScaled(unitCifS, decCif),
      cifUsd: fromScaled(cifUsdS, 2),
      cifStr: "$" + Number(formatScaled(cifUsdS, 2)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      insUsd: fromScaled(insUsdS, 2),
      freightUsd: fromScaled(frtUsdS, 2),
      cifCommUsd: fromScaled(cifCommUsdS, 2),
      cifCommRmb: fromScaled(cifCommRmbS, 2),

      cifProfitRmb: fromScaled(cifProfitPricingRmbS, 2),
      cifMarginPct: cifMarginPricingPct,
      cifProfitConservativeRmb: fromScaled(cifProfitConsRmbS, 2),
      cifMarginConservativePct: cifMarginConsPct,
      cifProfitWithRebateRmb: fromScaled(cifProfitRebRmbS, 2),
      cifMarginWithRebatePct: cifMarginRebPct,

      landedUsd: fromScaled(landedUsdS, 2),
      landedStr: "$" + Number(formatScaled(landedUsdS, 2)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      unitVarCostRmb: fromScaled(unitVarCostRmbS, 6),
      breakEvenUnitUsd: fromScaled(breakEvenUnitUsdS, decFob),
      breakEvenUnitStr: "$" + formatScaled(breakEvenUnitUsdS, decFob),
      fxDropLossRmb: fxDropLossRmb,

      vatPct: vatPctNum,
      rebPct: rebPctNum,
      exTaxExtraPct: exTaxExtraPctNum,
      marginPct: marginPctNum,
      commPct: commPctNum,
      insPct: insPctNum,
      dutyPct: dutyPctNum,
      fx: fxNum,
      qty: qtyNum,
      lead: leadNum,
      validDays: validDaysNum,
      cutCust: cutCustNum
    };
  }

  /* ==================== 4. Container Load Optimizer Engine (T04) ==================== */

  function validateContainerRow(r, idx) {
    var bad = {};
    var errs = [];
    if (!Number.isFinite(r.l) || r.l <= 0 || r.l > 5000) { bad.l = true; errs.push("长须 >0"); }
    if (!Number.isFinite(r.w) || r.w <= 0 || r.w > 2000) { bad.w = true; errs.push("宽须 >0"); }
    if (!Number.isFinite(r.h) || r.h <= 0 || r.h > 2000) { bad.h = true; errs.push("高须 >0"); }
    if (!Number.isFinite(r.kg) || r.kg <= 0 || r.kg > 500000) { bad.kg = true; errs.push("单箱毛重须 >0"); }
    if (!Number.isFinite(r.qty) || r.qty < 1 || Math.floor(r.qty) !== r.qty || r.qty > 1000000) {
      bad.qty = true; errs.push("件数须为 ≥1 正整数");
    }
    return {
      ok: errs.length === 0,
      badFields: bad,
      msg: errs.length ? ("第 " + (idx + 1) + " 行「" + (r.name || "未命名") + "」" + errs.join("、")) : ""
    };
  }

  function computeContainerLoad(rows, opts) {
    var o = opts || {};
    var routeMode = o.routeMode === "useu" ? "useu" : "std";
    var packMode = o.packMode === "carton" ? "carton" : "crate";
    var cap20Vol = packMode === "crate" ? 24.5 : 28.0;
    var cap40GpVol = packMode === "crate" ? 52.0 : 58.0;
    var cap40HqVol = packMode === "crate" ? 60.0 : 67.0;
    var maxWt20 = routeMode === "useu" ? 19.0 : 26.0;
    var maxWt40 = routeMode === "useu" ? 22.0 : 26.0;
    var floorArea20 = 13.0; // Practical floor area (m^2) inside 20'GP (5.89 * 2.34 = 13.78)
    var floorArea40 = 27.0; // Practical floor area (m^2) inside 40'GP/HQ (12.02 * 2.34 = 28.12)

    var list = Array.isArray(rows) ? rows : [];
    var valErrs = [];
    var rowValidations = [];
    for (var i = 0; i < list.length; i++) {
      var vr = validateContainerRow(list[i], i);
      rowValidations.push(vr);
      if (!vr.ok) valErrs.push(vr.msg);
    }
    if (valErrs.length > 0) {
      return {
        ok: false,
        valErrs: valErrs,
        rowValidations: rowValidations,
        oogMsgs: [],
        pointLoadMsgs: []
      };
    }

    var totCbm = 0, totKg = 0, totQty = 0, noStackAreaM2 = 0, effCbmWithNoStackGp = 0, effCbmWithNoStackHq = 0;
    var oogMsgs = [];
    var pointLoadMsgs = [];
    var isSpecialOog = false;
    var isSingleOverweight = false;
    var forbid20Gp = false;
    var forbid40GpByHeight = false;
    var maxSingleTon = 0;

    var maxRouteTonAnyDry = Math.max(maxWt20, maxWt40);

    for (var j = 0; j < list.length; j++) {
      var r = list[j];
      var nm = r.name || "货物";
      var unitCbm = (r.l * r.w * r.h) / 1000000;
      var unitAreaM2 = (r.l * r.w) / 10000;
      var unitTon = r.kg / 1000;
      if (unitTon > maxSingleTon) maxSingleTon = unitTon;

      totCbm += unitCbm * r.qty;
      totKg += r.kg * r.qty;
      totQty += r.qty;

      if (r.noStack) {
        noStackAreaM2 += unitAreaM2 * r.qty;
        // Non-stackable crate claims full vertical column above its footprint
        effCbmWithNoStackGp += Math.max(unitCbm, unitAreaM2 * 2.20) * r.qty;
        effCbmWithNoStackHq += Math.max(unitCbm, unitAreaM2 * 2.50) * r.qty;
      } else {
        effCbmWithNoStackGp += unitCbm * r.qty;
        effCbmWithNoStackHq += unitCbm * r.qty;
      }

      // 1. Single-unit indivisible overweight check (BUG-05)
      if (unitTon > maxRouteTonAnyDry) {
        isSingleOverweight = true;
        oogMsgs.push("「" + nm + "」单件毛重 " + unitTon.toFixed(2) + "t 超出当前航线单柜最大载重（" + maxRouteTonAnyDry + "t），不可拆分为多个普通干柜，须改订加固框架柜(FR)或散杂货船(Breakbulk)！");
      } else if (unitTon > maxWt20) {
        forbid20Gp = true;
        oogMsgs.push("「" + nm + "」单件毛重 " + unitTon.toFixed(2) + "t 超出 20'GP 航线限重（" + maxWt20 + "t），不可装 20'GP！");
      }

      // 2. Orientation & dimension checks (BUG-07 + noRotate)
      var fitLen, fitWid;
      if (r.noRotate) {
        fitLen = r.l;
        fitWid = r.w;
      } else {
        fitLen = Math.max(r.l, r.w);
        fitWid = Math.min(r.l, r.w);
      }

      if (fitWid > 234 || r.h > 258 || fitLen > 1202) {
        isSpecialOog = true;
        var reasonOog = r.noRotate && r.w > 234 && Math.min(r.l, r.w) <= 234
          ? "已勾选「不可旋转」且宽度(" + r.w + "cm)超出柜门净宽(234cm)"
          : "超出标准干柜门宽(234cm)/40HQ门高(258cm)/内长(1202cm)";
        oogMsgs.push("「" + nm + "」(" + r.l + "×" + r.w + "×" + r.h + "cm) " + reasonOog + "，必须使用开顶柜(OT)或框架柜(FR)！");
      } else {
        if (r.h > 228) {
          forbid20Gp = true;
          forbid40GpByHeight = true;
          oogMsgs.push("「" + nm + "」单件高度 " + r.h + "cm 超出平柜门高(228cm)，不可装 20'GP / 40'GP，须选 40'HQ 高柜（门高258cm）！");
        } else if (fitLen > 589) {
          forbid20Gp = true;
          oogMsgs.push("「" + nm + "」单件长度 " + fitLen + "cm 超出 20'GP 内长(589cm)，不可装 20'GP，可装 40'GP 平柜或 40'HQ 高柜！");
        }
      }

      // 3. Concentrated floor load warning
      var lenM = Math.max(0.3, fitLen / 100);
      var lineLoadTonPerM = unitTon / lenM;
      var areaLoadTonPerM2 = unitAreaM2 > 0 ? (unitTon / unitAreaM2) : 0;
      if (unitTon >= 4.0 && (lineLoadTonPerM > 4.5 || areaLoadTonPerM2 > 2.5)) {
        pointLoadMsgs.push("「" + nm + "」单件 " + unitTon.toFixed(2) + "t 底部线载荷约 " + lineLoadTonPerM.toFixed(1) + " t/m（面载荷 " + areaLoadTonPerM2.toFixed(1) + " t/m²），装柜务必加铺枕木/槽钢分散底梁载荷并向船司确认柜底限重！");
      }
    }

    var totTon = totKg / 1000;
    var dens = totCbm > 0 ? (totKg / totCbm) : 0;
    var rec = "—", recEn = "To be confirmed";

    if (list.length === 0 || totCbm <= 0) {
      rec = "请添加货物";
      recEn = "To be confirmed";
    } else if (isSingleOverweight) {
      rec = "⛔ 单件超重特种运输（FR 框架柜 / 散杂船 Breakbulk）";
      recEn = "Overweight Single Unit — Heavy-Duty Flat-Rack (FR) / Breakbulk Vessel Required";
    } else if (isSpecialOog) {
      rec = "⚠️ 超尺特种柜（OT 开顶柜 / FR 框架柜）";
      recEn = "OOG Open-Top (OT) / Flat-Rack (FR) Container";
    } else if (!forbid20Gp && effCbmWithNoStackGp <= 13 && totTon <= 13 && noStackAreaM2 <= 6.5) {
      rec = "LCL 拼箱（或凑单拼 20'GP）";
      recEn = "LCL consolidation (or combine to 1 x 20'GP)";
    } else if (!forbid20Gp && effCbmWithNoStackGp <= cap20Vol && totTon <= maxWt20 && noStackAreaM2 <= floorArea20) {
      rec = "1 × 20'GP 小柜";
      recEn = "1 x 20'GP";
    } else if (!forbid40GpByHeight && effCbmWithNoStackGp <= cap40GpVol && totTon <= maxWt40 && noStackAreaM2 <= floorArea40) {
      rec = forbid20Gp && totCbm <= cap20Vol
        ? "1 × 40'GP 平柜（超20尺内长5.89m，平柜高度够用）"
        : "1 × 40'GP 平柜";
      recEn = "1 x 40'GP";
    } else if (effCbmWithNoStackHq <= cap40HqVol && totTon <= maxWt40 && noStackAreaM2 <= floorArea40) {
      rec = "1 × 40'HQ 高柜";
      recEn = "1 x 40'HQ";
    } else {
      // Multi-container calculation with First-Fit Decreasing (FFD) discrete unit packing (P1-5)
      function packDiscreteFFD(cVol, cWt, cArea, colH) {
        var preBins = 0;
        var items = [];
        for (var idx = 0; idx < list.length; idx++) {
          var row = list[idx];
          var uCbm = (row.l * row.w * row.h) / 1000000;
          var uArea = row.noStack ? ((row.l * row.w) / 10000) : 0;
          var eVol = row.noStack ? Math.max(uCbm, uArea * colH) : uCbm;
          var uTon = row.kg / 1000;
          if (uTon > cWt + 1e-9 || eVol > cVol + 1e-9 || uArea > cArea + 1e-9) {
            return Infinity;
          }
          var remQty = row.qty;
          if (remQty > 400) {
            var maxPerBin = Math.min(
              uTon > 0 ? Math.floor((cWt + 1e-9) / uTon) : 1e9,
              eVol > 0 ? Math.floor((cVol + 1e-9) / eVol) : 1e9,
              uArea > 0 ? Math.floor((cArea + 1e-9) / uArea) : 1e9
            );
            if (maxPerBin < 1) return Infinity;
            var batchBins = Math.max(0, Math.floor((remQty - 200) / maxPerBin));
            preBins += batchBins;
            remQty -= batchBins * maxPerBin;
          }
          var domRatio = Math.max(
            cWt > 0 ? (uTon / cWt) : 0,
            cVol > 0 ? (eVol / cVol) : 0,
            uArea > 0 && cArea > 0 ? (uArea / cArea) : 0
          );
          for (var q = 0; q < remQty; q++) {
            items.push({ wt: uTon, vol: eVol, area: uArea, score: domRatio });
          }
        }
        items.sort(function (a, b) {
          if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
          return b.wt - a.wt;
        });
        var bins = [];
        for (var m = 0; m < items.length; m++) {
          var it = items[m];
          var placed = false;
          for (var b = 0; b < bins.length; b++) {
            var bin = bins[b];
            if (
              bin.wt + it.wt <= cWt + 1e-9 &&
              bin.vol + it.vol <= cVol + 1e-9 &&
              bin.area + it.area <= cArea + 1e-9
            ) {
              bin.wt += it.wt;
              bin.vol += it.vol;
              bin.area += it.area;
              placed = true;
              break;
            }
          }
          if (!placed) {
            bins.push({ wt: it.wt, vol: it.vol, area: it.area });
          }
        }
        return preBins + bins.length;
      }

      var byVol40Hq = Math.ceil(effCbmWithNoStackHq / cap40HqVol);
      var byVol40Gp = Math.ceil(effCbmWithNoStackGp / cap40GpVol);
      var byArea40 = Math.ceil(noStackAreaM2 / floorArea40);
      var byWt40 = Math.ceil(totTon / maxWt40);
      var byWt20 = Math.ceil(totTon / maxWt20);
      var byArea20 = Math.ceil(noStackAreaM2 / floorArea20);
      var byVol20 = Math.ceil(effCbmWithNoStackGp / cap20Vol);

      var ffd20 = forbid20Gp ? Infinity : packDiscreteFFD(cap20Vol, maxWt20, floorArea20, 2.20);
      var ffd40Gp = forbid40GpByHeight ? Infinity : packDiscreteFFD(cap40GpVol, maxWt40, floorArea40, 2.20);
      var ffd40Hq = packDiscreteFFD(cap40HqVol, maxWt40, floorArea40, 2.50);

      var n20 = Math.max(byWt20, byArea20, byVol20, Number.isFinite(ffd20) ? ffd20 : 0);
      var n40Hq = Math.max(byVol40Hq, byWt40, byArea40, Number.isFinite(ffd40Hq) ? ffd40Hq : 0);
      var n40Gp = Math.max(byVol40Gp, byWt40, byArea40, Number.isFinite(ffd40Gp) ? ffd40Gp : 0);
      var discreteBump = (Number.isFinite(ffd40Hq) && ffd40Hq > Math.max(byVol40Hq, byWt40, byArea40)) ||
                         (Number.isFinite(ffd20) && ffd20 > Math.max(byWt20, byArea20, byVol20));

      if (forbid40GpByHeight) {
        rec = n40Hq + " × 40'HQ 高柜（含超高/不可叠放/离散限重校核）";
        recEn = n40Hq + " x 40'HQ (height, floor & discrete unit weight checked)";
      } else if (forbid20Gp) {
        if (Number.isFinite(ffd40Gp) && n40Gp <= n40Hq && effCbmWithNoStackGp <= n40Gp * cap40GpVol) {
          rec = n40Gp + " × 40'GP 平柜（或同数 40'HQ）";
          recEn = n40Gp + " x 40'GP (or 40'HQ)";
        } else {
          rec = n40Hq + " × 40'HQ 高柜（含超长/离散限重校核）";
          recEn = n40Hq + " x 40'HQ (length & discrete unit weight checked)";
        }
      } else if (Number.isFinite(ffd20) && n20 <= n40Hq && (byWt20 > byVol40Hq || discreteBump) && maxWt20 >= 19) {
        rec = n20 + " × 20'GP 小柜（重货按不可拆单元离散配重分柜）";
        recEn = n20 + " x 20'GP (heavy cargo discrete unit FFD weight checked)";
      } else {
        rec = n40Hq + " × 40'HQ 高柜（按实装容积/底面积/离散限重）";
        recEn = n40Hq + " x 40'HQ";
      }
    }

    var tp = totCbm <= 0 ? "— 待录入货物" : "🟢 黄金配重（体积重量均衡）";
    var warn = totCbm <= 0
      ? "请点击「➕ 增加一个拼柜品名」录入独立包装箱规"
      : "实装容积、不可叠放底面积与航线限重均已校核（仅供参考，最终装柜须经货代/船司打尺试装确认）";

    if (isSingleOverweight) {
      tp = "⛔ 单件超重硬拦截（禁止拆普通干柜）";
      warn = "存在单件超航线单柜限重的不可拆分重件，严禁按总重拆成多个普通柜，请向特种船东/货代核框架柜或散杂船运价！";
    } else if (isSpecialOog) {
      tp = "🔴 超尺特种柜预警（OOG）";
      warn = "普通干柜门框或内长无法装入，发货前务必向货代核实开顶柜(OT)/框架柜(FR)特种附加费！";
    } else if (noStackAreaM2 > floorArea20) {
      tp = "🟣 不可叠放占底预警（底面积受限）";
      warn = "不可叠放货物累计占柜底面积 " + noStackAreaM2.toFixed(1) + " m²（20'GP可用≈13m² · 40'柜≈27m²），已按底面积上限放大柜型！";
    } else if (dens > (routeMode === "useu" ? 780 : 950)) {
      tp = "🟠 重货预警（先达航线限重）";
      warn = "平均密度 " + Math.round(dens) + " kg/CBM（" + (routeMode === "useu" ? "欧美限重：20'GP≤19t · 40'≤22t" : "常规限重：≤26t/柜") + "），切勿硬塞超重；最终配载以货代/船司确认为准。";
    } else if (dens > 0 && dens < 300) {
      tp = "🔵 泡货提示（先满实装体积）";
      warn = "平均密度 " + Math.round(dens) + " kg/CBM，优先选 40'HQ 高柜摊薄海运费；最终配载以货代/船司装箱打尺为准。";
    }

    if (pointLoadMsgs.length > 0 && !isSingleOverweight && !isSpecialOog) {
      warn = pointLoadMsgs[0];
    }

    return {
      ok: true,
      valErrs: [],
      rowValidations: rowValidations,
      totCbm: totCbm,
      totTon: totTon,
      totQty: totQty,
      dens: dens,
      noStackAreaM2: noStackAreaM2,
      isSingleOverweight: isSingleOverweight,
      isSpecialOog: isSpecialOog,
      forbid20Gp: forbid20Gp,
      forbid40GpByHeight: forbid40GpByHeight,
      oogMsgs: oogMsgs,
      pointLoadMsgs: pointLoadMsgs,
      rec: rec,
      recEn: recEn,
      tp: tp,
      warn: warn,
      summaryEn: (totCbm > 0 && !isSingleOverweight)
        ? (totQty + " indivisible packages, approx. " + totCbm.toFixed(2) + " CBM / " + totTon.toFixed(2) + " MT (Est. fit: " + recEn + ", subject to forwarder/carrier stowage plan)")
        : ""
    };
  }

  /* ==================== 5. Phone Cleaning (T08) & CSV Dedupe Key (T08) ==================== */

  function analyzePhoneCore(raw, countryHint, dialMap) {
    if (!raw || !String(raw).trim()) {
      return { ok: false, reason: "empty", digits: "", e164: "", ext: "", waUrl: "" };
    }
    var s = String(raw).trim();
    var ext = "";

    // Extract extension cleanly before digit stripping so extension numbers never corrupt E.164 / WhatsApp links
    var extMatch = s.match(/^(.+?\d)\s*(?:ext\.?|extension|分机|转|[xX#])\s*[:：.]?\s*(\d{1,6})\s*$/i);
    if (extMatch) {
      s = extMatch[1].trim();
      ext = extMatch[2];
    }

    var map = dialMap || {};
    var cc = (countryHint && map[countryHint]) ? String(map[countryHint]) : "";
    var hasPlus = /^\+/.test(s) || /^00\d/.test(s);
    var d = s.replace(/\D/g, "");
    if (/^00/.test(s.trim())) d = d.replace(/^00/, "");

    if (!d) {
      return { ok: false, reason: "invalid_chars", digits: "", e164: "", ext: ext, waUrl: "" };
    }

    if (!hasPlus && cc) {
      if (d.indexOf(cc) === 0 && d.length >= cc.length + 8) {
        // Already includes country code
      } else if (d[0] === "0") {
        // Italy (+39) geographic landlines (0 + 1..9, e.g. 02 Milan, 06 Rome) retain the leading 0 internationally!
        if (cc === "39" && /^0[1-9]/.test(d)) {
          d = "39" + d;
        } else {
          d = cc + d.replace(/^0+/, "");
        }
      } else if (d.length <= 11) {
        d = cc + d;
      }
    }

    var ok = d.length >= 8 && d.length <= 15 && !/^0/.test(d);
    var reason = ok ? "ok" : (d.length < 8 ? "too_short" : (d.length > 15 ? "too_long" : "missing_cc"));
    var e164 = d ? ("+" + d) : "";
    return {
      ok: ok,
      reason: reason,
      digits: d,
      e164: e164,
      ext: ext,
      display: ext ? (e164 + " ext." + ext) : e164,
      waUrl: ok ? ("https://wa.me/" + d) : ""
    };
  }

  var PUBLIC_EMAIL_DOMAINS = {
    "gmail.com": 1, "yahoo.com": 1, "hotmail.com": 1, "outlook.com": 1, "icloud.com": 1,
    "aol.com": 1, "live.com": 1, "msn.com": 1, "163.com": 1, "126.com": 1, "qq.com": 1,
    "foxmail.com": 1, "proton.me": 1, "protonmail.com": 1, "yandex.ru": 1, "mail.ru": 1
  };

  function buildLeadDedupeKey(row, dialMap) {
    var r = row || {};
    var cNorm = String(r.country || "").trim().toLowerCase() || "_unspec_";
    var em = String(r.email || "").trim().toLowerCase();
    var dom = extractCleanDomain(r.website || "");
    if (!dom && em && em.indexOf("@") !== -1) {
      var emDom = extractCleanDomain(em.split("@")[1]);
      if (emDom && !PUBLIC_EMAIL_DOMAINS[emDom]) dom = emDom;
    }
    var phRes = analyzePhoneCore(r.phone || "", r.country || "", dialMap);
    var ph = phRes.digits && phRes.digits.length >= 8 ? phRes.digits : "";
    var comp = String(r.company || "")
      .trim()
      .toLowerCase()
      .replace(/[.,/#!$%^&*;:{}=\-_`~()'"\s]+/g, " ")
      .trim();

    // Country is ALWAYS included on domain/company/shared-inbox keys so multinational branches (e.g. Vietnam vs Mexico) never collide
    if (em && dom) return "em:" + em + "|c:" + cNorm;
    if (ph) return "ph:" + ph + "|c:" + cNorm;
    if (em) return "em:" + em + "|c:" + cNorm;
    if (dom && comp) return "dom:" + dom + "|co:" + comp + "|c:" + cNorm;
    if (dom) return "dom:" + dom + "|c:" + cNorm;
    if (comp) return "co:" + comp + "|c:" + cNorm;
    return "";
  }

  /* ==================== 6. Lossless Stable-ID CRM Lead Merger (T05) ==================== */

  function parseTsMs(v) {
    if (!v) return 0;
    if (typeof v === "number") return v;
    var s = String(v).trim().replace(" ", "T");
    var t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  }

  function normalizeLeadForStore(rawLead) {
    var x = Object.assign({}, rawLead || {});
    if (!x.id) x.id = genStableId("ld");
    if (!x.createdAt) x.createdAt = x.updatedAt || new Date().toISOString();
    if (!x.updatedAt) x.updatedAt = x.createdAt;
    if (!Array.isArray(x.timeline)) x.timeline = [];
    x.timeline = x.timeline.map(function (t, idx) {
      var item = Object.assign({}, t || {});
      if (!item.tlId) {
        // Deterministic fallback ID for legacy timeline entries without tlId
        var base = String(item.ts || "") + "|" + String(item.txt || "") + "|" + idx;
        var h = 5381;
        for (var k = 0; k < base.length; k++) h = ((h << 5) + h) ^ base.charCodeAt(k);
        item.tlId = "tl_leg_" + (h >>> 0).toString(36);
      }
      return item;
    });
    if (!Array.isArray(x.quotes)) x.quotes = [];
    x.quotes = x.quotes.map(function (q, idx) {
      var qi = Object.assign({}, q || {});
      if (!qi.quoteId) {
        var qBase = String(qi.refNo || "") + "|" + String(qi.savedAt || "") + "|" + String(qi.fobStr || "") + "|" + idx;
        var h = 5381;
        for (var k = 0; k < qBase.length; k++) h = ((h << 5) + h) ^ qBase.charCodeAt(k);
        qi.quoteId = "qt_leg_" + (h >>> 0).toString(36);
      }
      return qi;
    });
    if (!Array.isArray(x.contacts)) x.contacts = [];
    x.contacts = x.contacts.map(function (c, idx) {
      var ci = Object.assign({}, c || {});
      if (!ci.ctId) {
        var cBase = String(ci.email || "") + "|" + String(ci.name || "") + "|" + String(ci.role || "") + "|" + idx;
        var h = 5381;
        for (var k = 0; k < cBase.length; k++) h = ((h << 5) + h) ^ cBase.charCodeAt(k);
        ci.ctId = "ct_leg_" + (h >>> 0).toString(36);
      }
      return ci;
    });
    return x;
  }

  function mergeLeadRecord(existingRaw, incomingRaw, opts) {
    var o = opts || {};
    var a = normalizeLeadForStore(existingRaw);
    var b = normalizeLeadForStore(incomingRaw);
    var aMs = parseTsMs(a.updatedAt);
    var bMs = parseTsMs(b.updatedAt);
    var primary = bMs >= aMs ? b : a;
    var secondary = bMs >= aMs ? a : b;

    var out = Object.assign({}, secondary, primary);
    out.id = a.id; // Keep canonical existing ID stable

    // Never overwrite non-empty scalar fields with empty strings
    var scalarFields = [
      "company", "country", "contact", "role", "email", "phone",
      "website", "stage", "source", "nextDate", "note", "product", "estUsd", "owner", "leadType",
      "cadenceStep", "cadenceLabel", "lossReason", "inquiryTier"
    ];
    for (var i = 0; i < scalarFields.length; i++) {
      var f = scalarFields[i];
      var pv = primary[f];
      var sv = secondary[f];
      if ((pv == null || String(pv).trim() === "") && sv != null && String(sv).trim() !== "") {
        out[f] = sv;
      }
    }

    // Merge timelines by stable `tlId` (newer `editedAt` or `ts` wins for same `tlId`, union across distinct `tlId`s)
    var tlMap = new Map();
    [a.timeline, b.timeline].forEach(function (arr) {
      (arr || []).forEach(function (item) {
        if (!item || (!item.txt && !item.result && !item.tlId)) return;
        var prev = tlMap.get(item.tlId);
        if (!prev) {
          tlMap.set(item.tlId, Object.assign({}, item));
        } else {
          var prevMs = parseTsMs(prev.editedAt || prev.ts || prev.at);
          var curMs = parseTsMs(item.editedAt || item.ts || item.at);
          if (curMs >= prevMs) tlMap.set(item.tlId, Object.assign({}, prev, item));
        }
      });
    });
    out.timeline = Array.from(tlMap.values()).sort(function (x, y) {
      return String(y.ts || y.at || "").localeCompare(String(x.ts || x.at || ""));
    });

    // Merge quotes by stable `quoteId`
    var qtMap = new Map();
    [a.quotes, b.quotes].forEach(function (arr) {
      (arr || []).forEach(function (q) {
        if (!q) return;
        var prev = qtMap.get(q.quoteId);
        if (!prev) {
          qtMap.set(q.quoteId, Object.assign({}, q));
        } else {
          var prevMs = parseTsMs(prev.savedAt);
          var curMs = parseTsMs(q.savedAt);
          if (curMs >= prevMs) qtMap.set(q.quoteId, Object.assign({}, prev, q));
        }
      });
    });
    out.quotes = Array.from(qtMap.values()).sort(function (x, y) {
      return String(y.savedAt || "").localeCompare(String(x.savedAt || ""));
    });

    // Merge multi-person contacts by stable `ctId` or email
    var ctMap = new Map();
    [a.contacts, b.contacts].forEach(function (arr) {
      (arr || []).forEach(function (c) {
        if (!c || (!c.name && !c.email && !c.phone)) return;
        var key = c.email ? ("em:" + String(c.email).trim().toLowerCase()) : c.ctId;
        var prev = ctMap.get(key);
        if (!prev) {
          ctMap.set(key, Object.assign({}, c));
        } else {
          ctMap.set(key, Object.assign({}, prev, c));
        }
      });
    });
    out.contacts = Array.from(ctMap.values());

    // Merge Due Diligence record keeping newer checkedAt
    if (a.ddRecord && b.ddRecord) {
      out.ddRecord = parseTsMs(b.ddRecord.checkedAt) >= parseTsMs(a.ddRecord.checkedAt)
        ? Object.assign({}, a.ddRecord, b.ddRecord)
        : Object.assign({}, b.ddRecord, a.ddRecord);
    } else {
      out.ddRecord = b.ddRecord || a.ddRecord || null;
    }

    // Soft-delete resolution:
    // If `respectExistingSoftDelete` is set (background/concurrent tab save), NEVER resurrect an already soft-deleted DB record!
    var delA = a.deletedAt ? parseTsMs(a.deletedAt) : 0;
    var delB = b.deletedAt ? parseTsMs(b.deletedAt) : 0;
    if (o.respectExistingSoftDelete && delA) {
      out.deletedAt = a.deletedAt;
      out.deletedAtStr = a.deletedAtStr || "";
      out.deletedBy = a.deletedBy || "";
      out.deleteReason = a.deleteReason || "";
    } else if (delA || delB) {
      var latestDel = Math.max(delA, delB);
      var latestActiveUpdate = Math.max(!a.deletedAt ? aMs : 0, !b.deletedAt ? bMs : 0);
      if (latestActiveUpdate > latestDel) {
        delete out.deletedAt;
        delete out.deletedAtStr;
        delete out.deletedBy;
        delete out.deleteReason;
      } else {
        var delSrc = delB >= delA ? b : a;
        out.deletedAt = delSrc.deletedAt;
        out.deletedAtStr = delSrc.deletedAtStr || "";
        out.deletedBy = delSrc.deletedBy || "";
        out.deleteReason = delSrc.deleteReason || "";
      }
    }

    out._rev = Math.max(Number(a._rev || 0), Number(b._rev || 0)) + 1;
    out.createdAt = (parseTsMs(a.createdAt) && parseTsMs(b.createdAt))
      ? (parseTsMs(a.createdAt) <= parseTsMs(b.createdAt) ? a.createdAt : b.createdAt)
      : (a.createdAt || b.createdAt);
    out.updatedAt = bMs >= aMs ? b.updatedAt : a.updatedAt;
    return out;
  }

  /* ==================== 7. Phase 2A Outreach, GLEIF & Cadence Pure Helpers ==================== */

  function normalizeEmailToken(raw) {
    if (raw == null) return "";
    var s = String(raw).trim();
    if (!s) return "";
    s = s
      .replace(/[đĐðÐ]/g, "d")
      .replace(/[øØ]/g, "o")
      .replace(/ß/g, "ss")
      .replace(/[æÆ]/g, "ae")
      .replace(/[œŒ]/g, "oe")
      .replace(/[łŁ]/g, "l")
      .replace(/[þÞ]/g, "th")
      .replace(/ı/g, "i");
    if (typeof s.normalize === "function") {
      s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function expandUmlautToken(raw) {
    var s = String(raw || "")
      .replace(/[äÄ]/g, "ae")
      .replace(/[öÖ]/g, "oe")
      .replace(/[üÜ]/g, "ue");
    return normalizeEmailToken(s);
  }

  function guessCorporateEmails(firstRaw, lastRaw, domRaw) {
    var d = extractCleanDomain(domRaw);
    if (!d) return [];
    var fParts = String(firstRaw || "").trim().split(/[\s\-]+/).map(normalizeEmailToken).filter(Boolean);
    var lParts = String(lastRaw || "").trim().split(/[\s\-]+/).map(normalizeEmailToken).filter(Boolean);
    var f = fParts[0] || "";
    var l = lParts[0] || "";
    var fDe = (String(firstRaw || "").trim().split(/[\s\-]+/).map(expandUmlautToken).filter(Boolean))[0] || "";
    var lDe = (String(lastRaw || "").trim().split(/[\s\-]+/).map(expandUmlautToken).filter(Boolean))[0] || "";
    var list = [];
    if (f && l) {
      if ((fDe && fDe !== f) || (lDe && lDe !== l)) {
        list.push((fDe || f) + "." + (lDe || l) + "@" + d);
      }
      list.push(
        f + "." + l + "@" + d,
        f[0] + l + "@" + d,
        f + "@" + d,
        f[0] + "." + l + "@" + d,
        f + l + "@" + d,
        l + "@" + d
      );
      if (lParts.length > 1) {
        var lLast = lParts[lParts.length - 1];
        if (lLast && lLast !== l) list.push(f + "." + lLast + "@" + d);
      }
    } else if (f) {
      if (fDe && fDe !== f) list.push(fDe + "@" + d);
      list.push(f + "@" + d);
    } else if (l) {
      if (lDe && lDe !== l) list.push(lDe + "@" + d);
      list.push(l + "@" + d);
    }
    list.push("procurement@" + d, "purchasing@" + d);
    var seen = Object.create(null);
    return list.filter(function (em) {
      if (seen[em]) return false;
      seen[em] = 1;
      return true;
    });
  }

  var PROD_I18N_PHRASES = [
    ["industrial valves & water pumps", { es: "válvulas industriales y bombas de agua", pt: "válvulas industriais e bombas d'água", fr: "vannes industrielles et pompes à eau", de: "Industriearmaturen und Wasserpumpen", ru: "промышленной арматуры и водяных насосов", ar: "الصمامات الصناعية ومضخات المياه", vi: "van công nghiệp và máy bơm nước", id: "katup industri dan pompa air", th: "วาล์วอุตสาหกรรมและปั๊มน้ำ" }],
    ["industrial valves, pumps & steel structures", { es: "válvulas industriales, bombas y estructuras de acero", pt: "válvulas industriais, bombas e estruturas metálicas", fr: "vannes industrielles, pompes et structures métalliques", de: "Industriearmaturen, Pumpen und Stahlkonstruktionen", ru: "промышленной арматуры, насосов и металлоконструкций", ar: "الصمامات الصناعية والمضخات والهياكل الفولاذية", vi: "van công nghiệp, máy bơm và kết cấu thép", id: "katup industri, pompa, dan struktur baja", th: "วาล์วอุตสาหกรรม ปั๊มน้ำ และโครงสร้างเหล็ก" }],
    ["api 6d forged ball valves", { es: "válvulas de bola forjadas API 6D", pt: "válvulas esfera forjadas API 6D", fr: "vannes à boisseau sphérique forgées API 6D", de: "geschmiedete Kugelhähne nach API 6D", ru: "кованые шаровые краны API 6D", ar: "صمامات كروية مطروقة بمعيار API 6D", vi: "van bi thép rèn API 6D", id: "katup bola tempa API 6D", th: "บอลวาล์วเหล็กฟอร์จ API 6D" }],
    ["industrial valves", { es: "válvulas industriales", pt: "válvulas industriais", fr: "vannes industrielles", de: "Industriearmaturen", ru: "промышленной арматуры", ar: "الصمامات الصناعية", vi: "van công nghiệp", id: "katup industri", th: "วาล์วอุตสาหกรรม" }],
    ["water pumps", { es: "bombas de agua industriales", pt: "bombas d'água industriais", fr: "pompes à eau industrielles", de: "Wasserpumpen", ru: "водяных насосов", ar: "مضخات المياه الصناعية", vi: "máy bơm nước công nghiệp", id: "pompa air industri", th: "ปั๊มน้ำอุตสาหกรรม" }],
    ["steel structures", { es: "estructuras de acero prefabricadas", pt: "estruturas metálicas de aço", fr: "structures métalliques en acier", de: "Stahlkonstruktionen", ru: "металлоконструкций", ar: "الهياكل الفولاذية المسبقة الصنع", vi: "kết cấu thép nhà xưởng", id: "struktur baja konstruksi", th: "โครงสร้างเหล็กรูปพรรณ" }],
    ["power cables", { es: "cables eléctricos de potencia", pt: "cabos elétricos de potência", fr: "câbles électriques de puissance", de: "Energiekabel und Leitungen", ru: "силовых кабелей", ar: "كابلات الطاقة الكهربائية", vi: "cáp điện công nghiệp", id: "kabel listrik daya", th: "สายไฟกำลังอุตสาหกรรม" }],
    ["fasteners", { es: "tornillería y fijaciones industriales", pt: "fixadores e parafusos industriais", fr: "boulonnerie et fixations industrielles", de: "Verbindungselemente und Schrauben", ru: "промышленного крепежа и метизов", ar: "المثبتات والبراغي الصناعية", vi: "bu lông ốc vít công nghiệp", id: "baut dan pengikat industri", th: "สลักเกลียวและน็อตอุตสาหกรรม" }],
    ["agricultural machinery", { es: "maquinaria y equipos agrícolas", pt: "máquinas e implementos agrícolas", fr: "machines et équipements agricoles", de: "Landmaschinen", ru: "сельскохозяйственной техники", ar: "الآلات والمعدات الزراعية", vi: "máy móc nông nghiệp", id: "mesin pertanian", th: "เครื่องจักรกลการเกษตร" }],
    ["industrial equipment", { es: "equipos y suministros industriales", pt: "equipamentos industriais", fr: "équipements industriels", de: "Industrieausrüstung", ru: "промышленного оборудования", ar: "المعدات والتوريدات الصناعية", vi: "thiết bị công nghiệp", id: "peralatan industri", th: "อุปกรณ์และเครื่องจักรอุตสาหกรรม" }]
  ];

  function localizeProductForLang(rawProd, lang) {
    var base = String(rawProd || "").trim() || "industrial equipment";
    if (!lang || lang === "en") return base;
    var norm = base.toLowerCase().replace(/\s+/g, " ").replace(/\band\b/g, "&");
    for (var i = 0; i < PROD_I18N_PHRASES.length; i++) {
      var key = PROD_I18N_PHRASES[i][0];
      var map = PROD_I18N_PHRASES[i][1];
      if (norm === key && map[lang]) return map[lang];
    }
    if (/^[\x20-\x7E]+$/.test(base)) {
      for (var j = 0; j < PROD_I18N_PHRASES.length; j++) {
        var k2 = PROD_I18N_PHRASES[j][0];
        var m2 = PROD_I18N_PHRASES[j][1];
        if (k2.length >= 11 && norm.indexOf(k2) >= 0 && m2[lang]) {
          return m2[lang];
        }
      }
    }
    return base;
  }

  var COUNTRY_TO_ISO2 = {
    "Vietnam": "VN", "Indonesia": "ID", "Thailand": "TH", "Malaysia": "MY", "Philippines": "PH",
    "Singapore": "SG", "Cambodia": "KH", "Myanmar": "MM", "Laos": "LA", "India": "IN",
    "Pakistan": "PK", "Bangladesh": "BD", "Sri Lanka": "LK", "Saudi Arabia": "SA",
    "United Arab Emirates": "AE", "UAE": "AE", "Qatar": "QA", "Kuwait": "KW", "Oman": "OM",
    "Bahrain": "BH", "Iraq": "IQ", "Jordan": "JO", "Egypt": "EG", "Morocco": "MA",
    "Algeria": "DZ", "Tunisia": "TN", "Turkey": "TR", "Turkey (Türkiye)": "TR",
    "Kazakhstan": "KZ", "Uzbekistan": "UZ", "Kyrgyz Republic": "KG", "Kyrgyzstan": "KG",
    "Mexico": "MX", "Brazil": "BR", "Chile": "CL", "Peru": "PE", "Colombia": "CO",
    "Argentina": "AR", "Ecuador": "EC", "Panama": "PA", "Dominican Republic": "DO",
    "Nigeria": "NG", "South Africa": "ZA", "Kenya": "KE", "Ethiopia": "ET", "Tanzania": "TZ",
    "Ghana": "GH", "Angola": "AO", "Mozambique": "MZ", "Zambia": "ZM", "Senegal": "SN",
    "Cote d'Ivoire": "CI", "Democratic Republic of the Congo": "CD", "Uganda": "UG",
    "Germany": "DE", "Italy": "IT", "Spain": "ES", "France": "FR", "United Kingdom": "GB",
    "Netherlands": "NL", "Belgium": "BE", "Poland": "PL", "Romania": "RO", "Hungary": "HU",
    "Czechia": "CZ", "Serbia": "RS", "Switzerland": "CH", "Austria": "AT", "Sweden": "SE",
    "Norway": "NO", "Denmark": "DK", "Finland": "FI", "Portugal": "PT", "Greece": "GR",
    "United States": "US", "Canada": "CA", "Australia": "AU", "New Zealand": "NZ",
    "Japan": "JP", "South Korea": "KR"
  };

  function resolveCountryIso2(country) {
    var c = String(country || "").trim();
    if (/^[A-Z]{2}$/.test(c)) return c;
    return COUNTRY_TO_ISO2[c] || "";
  }

  function scoreGleifRecords(records, companyQuery, countryOrIso2) {
    if (!Array.isArray(records) || !records.length) return [];
    var targetIso = resolveCountryIso2(countryOrIso2);
    var stopWords = { ag: 1, sa: 1, ltd: 1, limited: 1, llc: 1, inc: 1, corp: 1, corporation: 1, gmbh: 1, co: 1, plc: 1, jsc: 1, pt: 1, cv: 1, bhd: 1, pte: 1, srl: 1, spa: 1, bv: 1, nv: 1, the: 1, and: 1, of: 1 };
    var qNorm = normalizeEmailToken(companyQuery);
    var qTokens = String(companyQuery || "")
      .toLowerCase()
      .replace(/[^a-z0-9\u00C0-\u024F\u4e00-\u9fff]+/g, " ")
      .split(/\s+/)
      .filter(function (w) { return w.length >= 2 && !stopWords[w]; });

    var scored = [];
    for (var i = 0; i < records.length; i++) {
      var it = records[i];
      var attr = (it && it.attributes) || {};
      var ent = attr.entity || {};
      var reg = attr.registration || {};
      var nm = (ent.legalName && ent.legalName.name) ? String(ent.legalName.name).trim() : "";
      if (!nm) continue;
      var addrCtry = (ent.legalAddress && ent.legalAddress.country) ? String(ent.legalAddress.country).toUpperCase() : "";
      var jur = addrCtry || (ent.jurisdiction ? String(ent.jurisdiction).slice(0, 2).toUpperCase() : "");
      var entSt = String(ent.status || "").toUpperCase();
      var regSt = String(reg.status || "").toUpperCase();
      var isActive = entSt === "ACTIVE" && regSt !== "RETIRED" && regSt !== "ANNULLED" && regSt !== "CANCELLED";

      var nmLower = nm.toLowerCase();
      var nmNorm = normalizeEmailToken(nm);
      var exactMatch = (nmNorm && qNorm && nmNorm === qNorm);
      var prefixMatch = !exactMatch && qNorm.length >= 4 && nmNorm.indexOf(qNorm) === 0;
      var tokenHits = 0;
      for (var t = 0; t < qTokens.length; t++) {
        if (nmLower.indexOf(qTokens[t]) >= 0) tokenHits++;
      }
      if (!exactMatch && !prefixMatch && qTokens.length > 0 && tokenHits === 0) {
        continue;
      }
      var sameCountry = !!(targetIso && jur === targetIso);
      if (targetIso && !sameCountry && !isActive) {
        continue;
      }
      var isFundNoise = /(pensionskasse|pensionsfonds|auszahlungsfonds|pension\s+fund|stiftung|\bverein\b|belegschaft|trustee|sub-fund|\betf\b)/i.test(nm) && !/(pension|stiftung|fund|verein)/i.test(String(companyQuery || ""));
      if (isFundNoise && !exactMatch) {
        continue;
      }

      var score = 0;
      if (sameCountry) score += 50;
      if (isActive) score += 30;
      if (exactMatch) score += 40;
      else if (prefixMatch) score += 25;
      score += tokenHits * 10;

      scored.push({
        id: it.id || "",
        name: nm,
        countryIso2: jur,
        entityStatus: entSt || "UNKNOWN",
        regStatus: regSt || "",
        isActive: isActive,
        sameCountry: sameCountry,
        score: score
      });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    if (targetIso && scored.some(function (x) { return x.sameCountry; })) {
      scored = scored.filter(function (x) { return x.sameCountry; });
    }
    return scored.slice(0, 3);
  }

  function computeDefaultNextFollowDate(baseDateStr, offsetDays, countryEn) {
    var days = (typeof offsetDays === "number" && Number.isFinite(offsetDays)) ? Math.max(1, Math.round(offsetDays)) : 3;
    var baseMs = baseDateStr && /^\d{4}-\d{2}-\d{2}$/.test(baseDateStr)
      ? Date.parse(baseDateStr + "T00:00:00Z")
      : Date.now();
    var targetMs = baseMs + days * 86400000;
    var dt = new Date(targetMs);
    if (countryEn && String(countryEn).trim()) {
      for (var guard = 0; guard < 16; guard++) {
        var isoCheck = dt.toISOString().slice(0, 10);
        if (!isCountryNonWorkingDate(countryEn, isoCheck, dt.getUTCDay())) break;
        targetMs += 86400000;
        dt = new Date(targetMs);
      }
      return dt.toISOString().slice(0, 10);
    }
    if (dt.getUTCDay() === 0) {
      dt = new Date(targetMs + 86400000);
    }
    return dt.toISOString().slice(0, 10);
  }

  var CADENCE_FLOW = {
    first: { stepNum: 1, nextStep: "followup", offsetDays: 3, sentLabel: "已发第1封(Day1破冰)", nextLabel: "待发第2封(Day4技术/单证)" },
    wa: { stepNum: 1, nextStep: "followup", offsetDays: 3, sentLabel: "已发WhatsApp首轮破冰", nextLabel: "待发第2封(Day4技术/单证)" },
    followup: { stepNum: 2, nextStep: "case", offsetDays: 4, sentLabel: "已发第2封(Day4技术跟进)", nextLabel: "待发第3封(Day8同行案例)" },
    case: { stepNum: 3, nextStep: "logistics", offsetDays: 4, sentLabel: "已发第3封(Day8同行案例)", nextLabel: "待发第4封(Day12拼柜方案)" },
    logistics: { stepNum: 4, nextStep: "breakup", offsetDays: 6, sentLabel: "已发第4封(Day12拼柜方案)", nextLabel: "待发第5封(Day18礼貌唤醒)" },
    breakup: { stepNum: 5, nextStep: "done", offsetDays: 14, sentLabel: "已发第5封(Day18礼貌唤醒)", nextLabel: "5步开发已完成(两周后复盘)" },
    linkedin_conn: { stepNum: 1, nextStep: "linkedin_dm", offsetDays: 3, sentLabel: "已发LinkedIn加好友申请", nextLabel: "待发LinkedIn通过后首条私信" },
    linkedin_dm: { stepNum: 2, nextStep: "followup", offsetDays: 4, sentLabel: "已发LinkedIn破冰私信", nextLabel: "待发邮件技术规格与单证跟进" }
  };

  function nextCadenceSchedule(sentStepKey, baseDateStr, countryEn) {
    var cfg = CADENCE_FLOW[sentStepKey] || CADENCE_FLOW.first;
    return {
      sentStep: sentStepKey in CADENCE_FLOW ? sentStepKey : "first",
      sentLabel: cfg.sentLabel,
      nextStep: cfg.nextStep,
      nextLabel: cfg.nextLabel,
      offsetDays: cfg.offsetDays,
      nextDate: computeDefaultNextFollowDate(baseDateStr, cfg.offsetDays, countryEn)
    };
  }

  /* ==================== 8. Phase 2B Multi-Category Profiles, Signals, LinkedIn, ICP & Funnel ==================== */

  var PRODUCT_PROFILES = {
    all: {
      key: "all",
      labelCn: "全品类工业打包（默认）",
      lfPreset: "industrial valve",
      lfCustom: "",
      mapKw: "industrial valve pump hardware distributor",
      csvWaProd: "industrial valves, pumps & steel structures",
      emailProd: "industrial valves & water pumps",
      quoteProd: "Industrial Valves & Water Pumps"
    },
    valve_pump: {
      key: "valve_pump",
      labelCn: "阀门 · 水泵 · 管道法兰",
      lfPreset: "industrial valve",
      lfCustom: "industrial valve OR centrifugal water pump OR pipe flange",
      mapKw: "industrial valve water pump piping distributor",
      csvWaProd: "industrial valves, water pumps & pipe flanges",
      emailProd: "industrial valves & water pumps",
      quoteProd: "Industrial Gate/Ball Valves & Centrifugal Pumps"
    },
    steel_fastener: {
      key: "steel_fastener",
      labelCn: "钢结构 · 紧固件 · 五金",
      lfPreset: "steel structure OR prefabricated steel warehouse",
      lfCustom: "prefabricated steel structure OR high strength fastener",
      mapKw: "steel structure metal fabrication fastener distributor",
      csvWaProd: "steel structures & fasteners",
      emailProd: "steel structures",
      quoteProd: "Prefabricated Steel Structure & High-Strength Fasteners"
    },
    cable_power: {
      key: "cable_power",
      labelCn: "电力电缆 · 变压器 · 配电",
      lfPreset: "power cable OR electrical cable",
      lfCustom: "power cable OR distribution transformer OR switchgear",
      mapKw: "electrical power cable transformer switchgear distributor",
      csvWaProd: "power cables, transformers & switchgear",
      emailProd: "power cables",
      quoteProd: "MV/LV Power Cables & Distribution Switchgear"
    },
    machinery: {
      key: "machinery",
      labelCn: "空压机 · 电机 · 通用机械",
      lfPreset: "air compressor",
      lfCustom: "screw air compressor OR industrial electric motor",
      mapKw: "air compressor industrial machinery motor distributor",
      csvWaProd: "air compressors, industrial motors & machinery parts",
      emailProd: "industrial equipment",
      quoteProd: "Rotary Screw Air Compressors & Industrial Motors"
    },
    mining: {
      key: "mining",
      labelCn: "矿山选矿 · 渣浆泵 · 耐磨件",
      lfPreset: "water pump OR centrifugal pump",
      lfCustom: "mining slurry pump OR wear resistant valve",
      mapKw: "mining equipment slurry pump industrial supplier",
      csvWaProd: "mining slurry pumps, high-pressure valves & wear parts",
      emailProd: "industrial valves & water pumps",
      quoteProd: "Heavy-Duty Slurry Pumps & High-Pressure Mining Valves"
    },
    agri: {
      key: "agri",
      labelCn: "农业机械 · 光伏/柴油灌溉",
      lfPreset: "agricultural machinery OR tractor",
      lfCustom: "agricultural machinery OR solar irrigation water pump",
      mapKw: "agricultural machinery irrigation pump dealer",
      csvWaProd: "agricultural machinery & irrigation water pumps",
      emailProd: "agricultural machinery",
      quoteProd: "Solar/Diesel Irrigation Pumps & Agricultural Machinery"
    }
  };

  function getProductProfile(key) {
    return PRODUCT_PROFILES[key] || PRODUCT_PROFILES.all;
  }

  function buildSignalIcebreaker(signalKey, vars, lang) {
    if (!signalKey || signalKey === "general") return "";
    var v = vars || {};
    var comp = v.comp || "your company";
    var country = v.country || "your market";
    var prod = v.prod || "industrial equipment";
    var note = v.signalNote ? (" (" + String(v.signalNote).trim() + ")") : "";
    var lg = lang || "en";
    var map = {
      award: {
        en: "Noticed " + comp + "'s recent engineering/project contract activity" + note + "—reaching out in case your procurement team is comparing secondary suppliers for " + prod + ".",
        es: "Vimos la reciente adjudicación/actividad de proyectos de " + comp + note + " y le escribo por si su equipo de compras está evaluando proveedores de " + prod + ".",
        pt: "Acompanhamos os recentes projetos/contratos da " + comp + note + " e entro em contato caso sua equipe de compras esteja cotando fornecedores de " + prod + ".",
        fr: "Suite aux récents projets/marchés remportés par " + comp + note + ", je vous contacte au cas où votre service achats consulterait des fournisseurs pour " + prod + ".",
        ar: "لاحظنا نشاط مشاريع وعقود شركة " + comp + " الأخيرة" + note + "، ونتواصل معكم في حال كان فريق المشتريات يقارن موردي " + prod + ".",
        vi: "Được biết " + comp + " đang triển khai gói thầu/dự án mới" + note + ", em xin phép liên hệ phòng vật tư nếu bên mình đang so sánh nhà cung cấp " + prod + ".",
        id: "Kami melihat aktivitas proyek/kontrak terbaru " + comp + note + ", sehingga menghubungi tim pengadaan Anda terkait opsi pemasok " + prod + "."
      },
      expansion: {
        en: "Saw " + comp + " expanding facility/project capacity in " + country + note + "—sharing a quick supply option for " + prod + " before your vendor list is finalized.",
        es: "Vimos que " + comp + " está ampliando operaciones/proyectos en " + country + note + " y quería compartirle una opción directa de fábrica para " + prod + ".",
        pt: "Vimos que a " + comp + " está expandindo projetos/operações em " + country + note + " e gostaria de apresentar nossa linha de fornecimento para " + prod + ".",
        fr: "Ayant vu le développement des activités de " + comp + " (" + country + ")" + note + ", je vous propose une option d'approvisionnement direct pour " + prod + ".",
        ar: "اطلعنا على توسع أعمال ومشاريع " + comp + " في " + country + note + "، ونود تقديم خيار توريد مباشر لمنتجات " + prod + ".",
        vi: "Thấy " + comp + " đang mở rộng nhà xưởng/dự án tại " + country + note + ", em xin gửi phương án cung ứng trực tiếp mặt hàng " + prod + ".",
        id: "Melihat ekspansi fasilitas/proyek " + comp + " di " + country + note + ", kami ingin berbagi opsi pasokan pabrik langsung untuk " + prod + "."
      },
      import: {
        en: "Noticed " + comp + " regularly imports industrial equipment in this category" + note + "—happy to provide a benchmark FOB/CIF quote on " + prod + " to compare against your current vendors.",
        es: "Notamos que " + comp + " importa regularmente este rubro industrial" + note + " y podemos ofrecerle una cotización comparativa FOB/CIF en " + prod + ".",
        pt: "Notamos que a " + comp + " já importa regularmente esta linha industrial" + note + " e podemos enviar uma cotação comparativa FOB/CIF para " + prod + ".",
        fr: "Voyant que " + comp + " importe régulièrement cette gamme industrielle" + note + ", nous pouvons vous soumettre un devis comparatif FOB/CIF sur " + prod + ".",
        ar: "لاحظنا أن شركة " + comp + " تستورد هذه الفئة الصناعية بانتظام" + note + "، ويسعدنا تقديم عرض سعر مرجعي FOB/CIF لمنتجات " + prod + " للمقارنة.",
        vi: "Được biết " + comp + " thường xuyên nhập khẩu nhóm hàng này" + note + ", bên em sẵn sàng gửi báo giá đối chiếu FOB/CIF cho " + prod + ".",
        id: "Kami melihat " + comp + " rutin mengimpor kategori produk industri ini" + note + ", dan siap memberikan penawaran pembanding FOB/CIF untuk " + prod + "."
      },
      expo: {
        en: "Ahead of the upcoming industrial trade show" + note + ", reaching out to connect with " + comp + " regarding factory-direct sourcing & container consolidation for " + prod + ".",
        es: "Previo a la próxima feria industrial" + note + ", contacto a " + comp + " para compartir opciones de suministro directo y consolidación de " + prod + ".",
        pt: "Antes da próxima feira industrial" + note + ", entro em contato com a " + comp + " sobre fornecimento direto e consolidação de carga para " + prod + ".",
        fr: "À l'approche du prochain salon industriel" + note + ", je contacte " + comp + " concernant la fourniture directe de " + prod + ".",
        ar: "قبيل المعرض الصناعي القادم" + note + "، نتواصل مع " + comp + " لمشاركة خيارات التوريد المباشر لمنتجات " + prod + ".",
        vi: "Trước thềm triển lãm công nghiệp sắp tới" + note + ", em xin kết nối trước với " + comp + " về nguồn hàng xuất xưởng " + prod + ".",
        id: "Menjelang pameran industri mendatang" + note + ", kami menghubungi " + comp + " terkait opsi pasokan langsung pabrik untuk " + prod + "."
      }
    };
    var bucket = map[signalKey];
    if (!bucket) return "";
    return bucket[lg] || bucket.en || "";
  }

  function buildLinkedInOutreach(mode, vars, lang) {
    var v = vars || {};
    var lg = lang || "en";
    var contact = v.contact && v.contact !== "Procurement Team" ? v.contact : "";
    var comp = v.comp || "your company";
    var prod = v.prod || "industrial equipment";
    var country = v.country || "your market";
    var sender = (v.sender || "FriesGo Global").split(/[·,|]/)[0].trim();

    if (mode === "linkedin_conn") {
      var hiEn = contact ? ("Hi " + contact + ", ") : "Hi, ";
      var templatesConn = {
        en: hiEn + "saw your procurement/engineering work at " + comp + " in " + country + ". We supply export-ready " + prod + " from China with third-party QC & mixed-container options. Open to connecting here? — " + sender,
        es: (contact ? ("Hola " + contact + ", ") : "Hola, ") + "vi su perfil en " + comp + " (" + country + "). Suministramos " + prod + " desde China con inspección SGS y opción de consolidado. ¿Conectamos por aquí? — " + sender,
        pt: (contact ? ("Olá " + contact + ", ") : "Olá, ") + "vi sua atuação na " + comp + " (" + country + "). Fornecemos " + prod + " da China com inspeção pré-embarque. Podemos nos conectar? — " + sender,
        fr: (contact ? ("Bonjour " + contact + ", ") : "Bonjour, ") + "vu votre rôle chez " + comp + ". Nous fournissons " + prod + " depuis la Chine avec contrôle qualité SGS. Au plaisir d'échanger — " + sender,
        ar: "مرحباً" + (contact ? (" " + contact) : "") + "، اطلعت على عملكم في " + comp + ". نورد " + prod + " من الصين مع فحص جودة قبل الشحن. يسعدني التواصل معكم — " + sender,
        vi: (contact ? ("Chào " + contact + ", ") : "Xin chào, ") + "thấy Anh/Chị phụ trách tại " + comp + ". Bên mình cung ứng " + prod + " xuất xưởng kèm C/O ưu đãi. Rất vui được kết nối — " + sender,
        id: (contact ? ("Halo " + contact + ", ") : "Halo, ") + "melihat peran Anda di " + comp + ". Kami memasok " + prod + " dari Tiongkok dengan dukungan C/O & QC. Senang bisa terhubung — " + sender
      };
      var txt = templatesConn[lg] || templatesConn.en;
      var maxLen = 280;
      if (txt.length > maxLen) {
        txt = txt.slice(0, maxLen - 1).replace(/\s+\S*$/, "") + "…";
      }
      return { text: txt, charCount: txt.length, maxChars: maxLen, withinLimit: txt.length <= maxLen };
    }

    // Post-connection 1st lightweight DM (no spam links)
    var hiDm = contact ? ("Thanks for connecting, " + contact + "!") : "Thanks for connecting!";
    var templatesDm = {
      en: hiDm + "\n\nNo pitch deck spam—just a quick question: does " + comp + " review external factory quotes for " + prod + " this quarter, or do you work through a fixed annual vendor list?\n\nHappy to send a 1-page spec & FOB/CIF benchmark only if useful.\n\nBest,\n" + sender,
      es: "¡Gracias por aceptar la invitación" + (contact ? (", " + contact) : "") + "!\n\nConsulta breve sin spam: ¿en " + comp + " evalúan cotizaciones comparativas para " + prod + " este trimestre, o manejan lista cerrada anual?\n\nSolo si le sirve, le comparto resumen técnico de 1 página y precios FOB/CIF.\n\nSaludos,\n" + sender,
      pt: "Obrigado por aceitar o convite" + (contact ? (", " + contact) : "") + "!\n\nPergunta rápida sem spam: a " + comp + " avalia cotações comparativas de fábrica para " + prod + " neste trimestre?\n\nSe fizer sentido, envio apenas um resumo técnico de 1 página com referência FOB/CIF.\n\nAbraço,\n" + sender,
      fr: "Merci d'avoir accepté l'invitation" + (contact ? (", " + contact) : "") + " !\n\nQuestion rapide : est-ce que " + comp + " consulte de nouveaux fournisseurs pour " + prod + " ce trimestre ?\n\nJe peux vous partager une fiche 1 page avec prix indicatifs FOB/CIF si pertinent.\n\nCordialement,\n" + sender,
      ar: "شكراً لقبول الدعوة" + (contact ? (" أ. " + contact) : "") + "!\n\nسؤال سريع دون إطالة: هل تقارن شركة " + comp + " عروض أسعار خارجية لمنتجات " + prod + " خلال هذا الربع؟ يسعدني إرسال ملخص فني من صفحة واحدة مع أسعار FOB/CIF إذا كان مناسباً.\n\nتحياتي،\n" + sender,
      vi: "Cảm ơn " + (contact || "Anh/Chị") + " đã kết nối!\n\nEm hỏi nhanh 1 ý thôi ạ: quý này " + comp + " có đang tham khảo thêm báo giá " + prod + " để đối chiếu nhà cung cấp hiện tại không ạ? Nếu cần em gửi bảng thông số gọn 1 trang kèm giá FOB/CIF.\n\nTrân trọng,\n" + sender,
      id: "Terima kasih sudah terhubung" + (contact ? (", " + contact) : "") + "!\n\nPertanyaan singkat saja: apakah kuartal ini " + comp + " terbuka membandingkan penawaran pabrik untuk " + prod + "? Jika relevan, saya kirimkan ringkasan spek 1 halaman & estimasi FOB/CIF.\n\nSalam,\n" + sender
    };
    var dmTxt = templatesDm[lg] || templatesDm.en;
    return { text: dmTxt, charCount: dmTxt.length, maxChars: 1200, withinLimit: true };
  }

  var ICP_ROLE_CLAUSES = {
    procurement: {
      labelCn: "采购负责人（Procurement / Purchasing / Compras / Achats）",
      query: '("Procurement Manager" OR "Purchasing Manager" OR "Head of Procurement" OR "Supply Chain Manager" OR "Jefe de Compras" OR "Gerente de Compras" OR "Directeur des Achats" OR "Einkaufsleiter" OR "Trưởng phòng thu mua")'
    },
    epc_eng: {
      labelCn: "项目总包 / 工程总监（EPC / Project / Engineering）",
      query: '("Project Manager" OR "EPC Manager" OR "Engineering Manager" OR "MEP Manager" OR "Director de Proyectos" OR "Gerente de Engenharia" OR "Chef de Projet")'
    },
    plant_maint: {
      labelCn: "工厂厂长 / 设备维护经理（Plant / Maintenance / Operations）",
      query: '("Plant Manager" OR "Maintenance Manager" OR "Operations Manager" OR "Chief Engineer" OR "Gerente de Planta" OR "Jefe de Mantenimiento")'
    },
    exec_dist: {
      labelCn: "进口商老板 / 总经理（Owner / Managing Director / Import）",
      query: '("Managing Director" OR "Import Manager" OR "General Manager" OR "Commercial Director" OR "Director General" OR "Diretor Comercial")'
    }
  };

  function buildBuyerRoleDorks(countryClean, prodKeyword, roleKey) {
    var c = String(countryClean || "Vietnam").replace(/\s*\([^)]*\)/g, "").trim();
    var p = String(prodKeyword || "industrial valve").split(/\s+OR\s+/i)[0].replace(/["()]/g, "").trim() || "industrial";
    var roleCfg = ICP_ROLE_CLAUSES[roleKey] || ICP_ROLE_CLAUSES.procurement;
    var qLiPeople = 'site:linkedin.com/in/ ' + roleCfg.query + ' "' + p + '" "' + c + '"';
    var qDecisionWeb = '"' + p + '" (' + roleCfg.query + ') "' + c + '" -jobs -salary';
    return {
      roleLabelCn: roleCfg.labelCn,
      linkedinPeopleUrl: "https://www.google.com/search?q=" + encodeURIComponent(qLiPeople),
      webDecisionUrl: "https://www.google.com/search?q=" + encodeURIComponent(qDecisionWeb),
      rawQuery: qLiPeople
    };
  }

  var CLARIFY_ITEMS = {
    spec: {
      cn: "关键规格参数（口径尺寸/压力等级/材质/标准或图纸）",
      en: "1. Technical Specification / Drawing: exact size/rating, material grade, and applicable standard (e.g. API / DIN / ANSI / JIS or CAD drawing)?",
      es: "1. Especificación técnica / plano: ¿medida exacta, presión/capacidad, material y norma aplicable (API / DIN / ANSI)?"
    },
    qty: {
      cn: "采购数量与分批交货计划（试单 vs 整柜量）",
      en: "2. Order Quantity: target quantity per SKU (trial batch vs. full container load) so we can calculate accurate unit & packing costs?",
      es: "2. Cantidad requerida: ¿volumen estimado por ítem (pedido de prueba vs. contenedor completo) para optimizar el costo unitario?"
    },
    incoterm: {
      cn: "报价条款与目的港（FOB 或 CIF 具体港口名）",
      en: "3. Trade Term & Destination Port: do you prefer FOB China port or CIF [Destination Port Name]?",
      es: "3. Incoterm y puerto destino: ¿prefieren cotización FOB puerto de China o CIF [Nombre del puerto de destino]?"
    },
    cert: {
      cn: "目的国强制认证与电气制式（电压赫兹 / SABER / CE / SONCAP 等）",
      en: "4. Local Compliance & Power Supply: any mandatory destination certificates (e.g. CE / SABER / SONCAP / Form E) or specific voltage/Hz requirements?",
      es: "4. Certificaciones y energía: ¿requieren algún certificado específico en destino (NOM / INMETRO / CE / C.O.) o voltaje/frecuencia especial?"
    },
    enduse: {
      cn: "实际工况介质与项目期望到货时间",
      en: "5. Working Media & Target Delivery: working medium/environment and your required delivery schedule?",
      es: "5. Aplicación y plazo de entrega: ¿fluido/condición de trabajo y fecha objetivo de recepción?"
    }
  };

  function buildInquiryClarification(opts) {
    var o = opts || {};
    var missing = Array.isArray(o.missingItems) ? o.missingItems.filter(function (k) { return !!CLARIFY_ITEMS[k]; }) : [];
    var comp = String(o.company || "your company").trim();
    var contact = String(o.contact || "Procurement Team").trim();
    var prod = String(o.prod || "industrial equipment").trim();
    var lang = o.lang === "es" ? "es" : "en";

    var tier = "A";
    var tierLabel = "🟢 A级实盘（要素齐全 → 立即进报价器出正式/参考报价单）";
    if (missing.length >= 3) {
      tier = "C";
      tierLabel = "🟡 C级宽泛询盘（缺 " + missing.length + " 项核心要素 → 先发参考区间 + 下方澄清清单筛真伪）";
    } else if (missing.length >= 1) {
      tier = "B";
      tierLabel = "🔵 B级待澄清询盘（缺 " + missing.length + " 项规格/条款 → 15分钟内回复下方专业确认函）";
    }

    var questions = (missing.length ? missing : ["spec", "qty", "incoterm"]).map(function (k) {
      return CLARIFY_ITEMS[k][lang] || CLARIFY_ITEMS[k].en;
    }).join("\n");

    var text = lang === "es"
      ? ("Estimado/a " + contact + ",\n\nGracias por la consulta de " + comp + " sobre " + prod + ".\n\nPara enviarle una cotización exacta y evitar errores de especificación, ¿podría confirmarnos brevemente los siguientes puntos?\n\n" + questions + "\n\nApenas nos confirme estos datos (o nos comparta su hoja de cálculo/plano), le prepararemos la oferta formal FOB/CIF en el día.\n\nSaludos cordiales,")
      : ("Dear " + contact + ",\n\nThank you for " + comp + "'s inquiry regarding " + prod + ".\n\nTo prepare an accurate, engineering-verified FOB/CIF quotation rather than a rough guess, could you briefly confirm:\n\n" + questions + "\n\nOnce confirmed (or if you have a BOQ sheet / drawing to share), our team will turn around a detailed quotation promptly.\n\nBest regards,");

    return {
      tier: tier,
      tierLabel: tierLabel,
      missingCount: missing.length,
      text: text
    };
  }

  function computeWeeklyFunnel(leads, nowDateStr) {
    var list = Array.isArray(leads) ? leads : [];
    var todayIso = (nowDateStr && /^\d{4}-\d{2}-\d{2}$/.test(nowDateStr))
      ? nowDateStr
      : new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    var todayMs = Date.parse(todayIso + "T23:59:59Z");
    var sevenDaysAgoMs = todayMs - 7 * 86400000;

    var totalActive = 0;
    var touched7d = 0;
    var ddApproved = 0;
    var quotedCount = 0;
    var highIntentOrWon = 0;
    var lostCount = 0;
    var lossMap = Object.create(null);

    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      if (!l || l.deletedAt) continue;
      totalActive++;
      var st = String(l.stage || "");
      if (/流失|归档|Lost/i.test(st)) {
        lostCount++;
        var rsn = String(l.lossReason || "未注明原因").trim();
        lossMap[rsn] = (lossMap[rsn] || 0) + 1;
      }
      if (/样品|谈判|成交|赢单|复购|高意向|合同|Won/i.test(st)) {
        highIntentOrWon++;
      }
      if (l.ddRecord && l.ddRecord.decision === "approved") {
        ddApproved++;
      }
      if (Array.isArray(l.quotes) && l.quotes.length > 0) {
        quotedCount++;
      }
      var hasRecentTouch = false;
      var uMs = parseTsMs(l.updatedAt || l.updated);
      if (uMs >= sevenDaysAgoMs && Array.isArray(l.timeline) && l.timeline.length > 0) {
        for (var t = 0; t < l.timeline.length; t++) {
          var tl = l.timeline[t];
          var tlMs = parseTsMs((tl && (tl.ts || tl.at)) || "");
          if (!tlMs || tlMs >= sevenDaysAgoMs) {
            hasRecentTouch = true;
            break;
          }
        }
      }
      if (hasRecentTouch) touched7d++;
    }

    var topLossReasons = Object.keys(lossMap)
      .map(function (k) { return { reason: k, count: lossMap[k] }; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 4);

    return {
      totalActive: totalActive,
      touched7d: touched7d,
      ddApproved: ddApproved,
      quotedCount: quotedCount,
      highIntentOrWon: highIntentOrWon,
      lostCount: lostCount,
      topLossReasons: topLossReasons
    };
  }

  /* ==================== 9. V2.0 Trade Timing, 10 High-Impact Holidays/Ramadan, Industrial Specs, Spam Check & Smart Paste ==================== */

  var COUNTRY_TRADE_PROFILES = {
    "Vietnam": { tz: "Asia/Ho_Chi_Minh", hubCn: "胡志明/河内", workWeek: "mon_fri", lunch: [11.5, 13.5], groups: ["tet_cny"], voltage: "380V · 50Hz", is60Hz: false, pipeStd: "JIS / ANSI / DIN", cert: "CR认证 · Form E/RCEP" },
    "Indonesia": { tz: "Asia/Jakarta", hubCn: "雅加达(西印尼)", workWeek: "mon_fri_jummah", lunch: [12, 13], groups: ["islamic"], voltage: "380V · 50Hz", is60Hz: false, pipeStd: "JIS / ANSI", cert: "SNI 强制认证 · Form E" },
    "Thailand": { tz: "Asia/Bangkok", hubCn: "曼谷/罗勇", workWeek: "mon_fri", lunch: [12, 13], groups: ["songkran"], voltage: "380V · 50Hz", is60Hz: false, pipeStd: "JIS / ANSI", cert: "TISI 强制认证 · Form E" },
    "Malaysia": { tz: "Asia/Kuala_Lumpur", hubCn: "吉隆坡/巴生", workWeek: "mon_fri_jummah", lunch: [12.5, 14], groups: ["islamic", "tet_cny"], voltage: "415V · 50Hz", is60Hz: false, pipeStd: "BS / ANSI / JIS", cert: "SIRIM · Form E" },
    "Philippines": { tz: "Asia/Manila", hubCn: "马尼拉", workWeek: "mon_fri", lunch: [12, 13], groups: ["xmas_ny", "semana_santa"], voltage: "220V/440V · 60Hz", is60Hz: true, pipeStd: "ANSI / ASME 美标", cert: "BPS (ICC) · Form E" },
    "Singapore": { tz: "Asia/Singapore", hubCn: "裕廊工业区", workWeek: "mon_fri", lunch: [12, 13], groups: ["tet_cny"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "BS / EN / ANSI", cert: "CPS / SS 标准" },
    "Cambodia": { tz: "Asia/Phnom_Penh", hubCn: "金边/西港", workWeek: "mon_fri", lunch: [12, 13.5], groups: ["songkran"], voltage: "380V · 50Hz", is60Hz: false, pipeStd: "DIN / JIS / 国标", cert: "ISC · Form E" },
    "India": { tz: "Asia/Kolkata", hubCn: "孟买/浦那(UTC+5:30)", workWeek: "mon_fri", lunch: [13, 14], groups: ["diwali"], voltage: "415V · 50Hz", is60Hz: false, pipeStd: "BS / ANSI / IS", cert: "BIS 强制认证(涉钢/机电)" },
    "Pakistan": { tz: "Asia/Karachi", hubCn: "卡拉奇/拉合尔", workWeek: "mon_fri_jummah", lunch: [13, 14], groups: ["islamic"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "BS / ANSI", cert: "PSQCA · 中巴FTA" },
    "Bangladesh": { tz: "Asia/Dhaka", hubCn: "达卡/吉大港", workWeek: "sun_thu", lunch: [13, 14], groups: ["islamic"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "BS / ANSI", cert: "BSTI · 信用证L/C审单严" },
    "Saudi Arabia": { tz: "Asia/Riyadh", hubCn: "利雅得/达曼", workWeek: "sun_thu", lunch: [12, 13.5], groups: ["islamic"], voltage: "380V/400V · 60Hz", is60Hz: true, pipeStd: "ANSI / ASME / API 美标", cert: "SABER (SALEEM) 强制清关" },
    "United Arab Emirates": { tz: "Asia/Dubai", hubCn: "迪拜/杰贝阿里", workWeek: "mon_fri_jummah", lunch: [12.5, 14], groups: ["islamic"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "BS / EN / ANSI", cert: "ECAS / MOIAT" },
    "Qatar": { tz: "Asia/Qatar", hubCn: "多哈", workWeek: "sun_thu", lunch: [12, 13.5], groups: ["islamic"], voltage: "415V · 50Hz", is60Hz: false, pipeStd: "BS / ANSI / API", cert: "QS 标准 · 原产地证使馆认证" },
    "Kuwait": { tz: "Asia/Kuwait", hubCn: "科威特城", workWeek: "sun_thu", lunch: [12, 13.5], groups: ["islamic"], voltage: "415V · 50Hz", is60Hz: false, pipeStd: "ANSI / API / BS", cert: "KUCAS (TER/TIR)" },
    "Oman": { tz: "Asia/Muscat", hubCn: "马斯喀特/苏哈尔", workWeek: "sun_thu", lunch: [12.5, 14], groups: ["islamic"], voltage: "415V · 50Hz", is60Hz: false, pipeStd: "BS / ANSI", cert: "DGSM / G-Mark" },
    "Iraq": { tz: "Asia/Baghdad", hubCn: "巴格达/巴士拉", workWeek: "sun_thu", lunch: [12.5, 14], groups: ["islamic"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "ANSI / API / DIN", cert: "COC 装船前检验(BV/SGS)" },
    "Egypt": { tz: "Africa/Cairo", hubCn: "开罗/十月城", workWeek: "sun_thu", lunch: [13, 14], groups: ["islamic"], voltage: "380V · 50Hz", is60Hz: false, pipeStd: "DIN / EN / ANSI", cert: "ACID 预登记 + GOEIC/COC" },
    "Algeria": { tz: "Africa/Algiers", hubCn: "阿尔及尔", workWeek: "sun_thu", lunch: [12, 13.5], groups: ["islamic"], voltage: "380V/400V · 50Hz", is60Hz: false, pipeStd: "EN / DIN 法标欧标", cert: "COC 符合性证书 + 银行交单" },
    "Morocco": { tz: "Africa/Casablanca", hubCn: "卡萨布兰卡/丹吉尔", workWeek: "mon_fri_jummah", lunch: [12.5, 14], groups: ["islamic"], voltage: "380V/400V · 50Hz", is60Hz: false, pipeStd: "EN / NF 欧标法标", cert: "CMim 强制标志 + VOC" },
    "Israel": { tz: "Asia/Jerusalem", hubCn: "海法/特拉维夫", workWeek: "sun_thu", lunch: [12.5, 13.5], groups: [], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "EN / ANSI", cert: "SII 标准认证" },
    "Turkey (Türkiye)": { tz: "Europe/Istanbul", hubCn: "伊斯坦布尔", workWeek: "mon_fri_jummah", lunch: [12, 13.5], groups: ["islamic"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "DIN / EN 欧标", cert: "CE + TAREKS 进口核查" },
    "Mexico": { tz: "America/Monterrey", hubCn: "蒙特雷/墨西哥城", workWeek: "mon_fri", lunch: [13.5, 15], groups: ["xmas_ny", "semana_santa"], voltage: "220V/440V · 60Hz", is60Hz: true, pipeStd: "ANSI / ASME 美标", cert: "NOM 强制认证 + 西语铭牌" },
    "Brazil": { tz: "America/Sao_Paulo", hubCn: "圣保罗", workWeek: "mon_fri", lunch: [12, 13.5], groups: ["xmas_ny", "br_carnival"], voltage: "220V/380V/440V · 60Hz", is60Hz: true, pipeStd: "ANSI / ASME / ABNT", cert: "INMETRO + CNPJ 税号必填提单" },
    "Chile": { tz: "America/Santiago", hubCn: "圣地亚哥/安托法加斯塔", workWeek: "mon_fri", lunch: [13, 14.5], groups: ["xmas_ny", "semana_santa"], voltage: "380V · 50Hz", is60Hz: false, pipeStd: "ANSI / ASME 美标", cert: "SEC 认证 · 中智FTA(Form F)" },
    "Peru": { tz: "America/Lima", hubCn: "利马/卡亚俄", workWeek: "mon_fri", lunch: [13, 14.5], groups: ["xmas_ny", "semana_santa"], voltage: "220V/380V/440V · 60Hz", is60Hz: true, pipeStd: "ANSI / ASME 美标", cert: "中秘FTA原产地证降税" },
    "Colombia": { tz: "America/Bogota", hubCn: "波哥大/麦德林", workWeek: "mon_fri", lunch: [12.5, 14], groups: ["xmas_ny", "semana_santa"], voltage: "220V/440V · 60Hz", is60Hz: true, pipeStd: "ANSI / ASME 美标", cert: "RETIE (电气电缆强制)" },
    "Argentina": { tz: "America/Argentina/Buenos_Aires", hubCn: "布宜诺斯艾利斯", workWeek: "mon_fri", lunch: [13, 14.5], groups: ["xmas_ny", "semana_santa"], voltage: "380V · 50Hz", is60Hz: false, pipeStd: "ANSI / IRAM", cert: "IRAM 认证 · 严控外汇付款期" },
    "United States": { tz: "America/Chicago", hubCn: "休斯顿(美中工业带)", workWeek: "mon_fri", lunch: [12, 13], groups: ["xmas_ny"], voltage: "460V/480V · 60Hz", is60Hz: true, pipeStd: "ANSI / ASME / API / NPT", cert: "UL / ASME · 注意301/232关税" },
    "Canada": { tz: "America/Toronto", hubCn: "多伦多/卡尔加里", workWeek: "mon_fri", lunch: [12, 13], groups: ["xmas_ny"], voltage: "575V/600V(注意高压!) · 60Hz", is60Hz: true, pipeStd: "ANSI / ASME / CSA", cert: "CSA / cUL + CRN(压力容器/阀门)" },
    "Germany": { tz: "Europe/Berlin", hubCn: "汉堡/鲁尔区", workWeek: "mon_fri", lunch: [12, 13], groups: ["xmas_ny", "eu_aug"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "DIN / EN 欧标", cert: "CE (PED承压/MD机械) + CBAM(涉钢)" },
    "France": { tz: "Europe/Paris", hubCn: "里昂/巴黎", workWeek: "mon_fri", lunch: [12, 14], groups: ["xmas_ny", "eu_aug"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "EN / NF 欧标", cert: "CE + CBAM(涉钢碳数据)" },
    "Italy": { tz: "Europe/Rome", hubCn: "米兰/布雷西亚", workWeek: "mon_fri", lunch: [12.5, 14.5], groups: ["xmas_ny", "eu_aug"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "UNI / EN 欧标", cert: "CE + CBAM(涉钢)" },
    "Spain": { tz: "Europe/Madrid", hubCn: "巴塞罗那/毕尔巴鄂", workWeek: "mon_fri", lunch: [13.5, 15.5], groups: ["xmas_ny", "eu_aug", "semana_santa"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "EN / DIN 欧标", cert: "CE + CBAM(涉钢)" },
    "Poland": { tz: "Europe/Warsaw", hubCn: "华沙/卡托维兹", workWeek: "mon_fri", lunch: [12.5, 13.5], groups: ["xmas_ny"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "EN / DIN 欧标", cert: "CE + CBAM(涉钢)" },
    "United Kingdom": { tz: "Europe/London", hubCn: "伯明翰/曼彻斯特", workWeek: "mon_fri", lunch: [12.5, 13.5], groups: ["xmas_ny"], voltage: "400V/415V · 50Hz", is60Hz: false, pipeStd: "BS / EN / ANSI", cert: "UKCA / CE" },
    "Russia": { tz: "Europe/Moscow", hubCn: "莫斯科(UTC+3)", workWeek: "mon_fri", lunch: [13, 14], groups: ["ru_ny_may"], voltage: "380V/400V · 50Hz", is60Hz: false, pipeStd: "GOST 俄标 / DIN", cert: "EAC 海关联盟认证 · 核查收汇通道与两用物项" },
    "Kazakhstan": { tz: "Asia/Almaty", hubCn: "阿拉木图/阿斯塔纳", workWeek: "mon_fri", lunch: [13, 14], groups: ["ru_ny_may"], voltage: "380V/400V · 50Hz", is60Hz: false, pipeStd: "GOST / DIN", cert: "EAC 海关联盟认证" },
    "Uzbekistan": { tz: "Asia/Tashkent", hubCn: "塔什干", workWeek: "mon_fri", lunch: [13, 14], groups: ["ru_ny_may", "islamic"], voltage: "380V · 50Hz", is60Hz: false, pipeStd: "GOST", cert: "GOST-UZ 符合性认证" },
    "South Africa": { tz: "Africa/Johannesburg", hubCn: "约翰内斯堡", workWeek: "mon_fri", lunch: [12.5, 13.5], groups: ["xmas_ny", "sa_builders"], voltage: "400V/525V(矿山常见525V!) · 50Hz", is60Hz: false, pipeStd: "BS / SANS / EN", cert: "SABS / NRCS LOA" },
    "Nigeria": { tz: "Africa/Lagos", hubCn: "拉各斯", workWeek: "mon_fri", lunch: [13, 14], groups: ["xmas_ny", "islamic"], voltage: "400V/415V · 50Hz", is60Hz: false, pipeStd: "BS / ANSI", cert: "SONCAP (PC+SC) + Form M" },
    "Kenya": { tz: "Africa/Nairobi", hubCn: "内罗毕/蒙巴萨", workWeek: "mon_fri", lunch: [13, 14], groups: ["xmas_ny"], voltage: "415V · 50Hz", is60Hz: false, pipeStd: "BS / EN", cert: "PVoC (COC 装船前验货)" },
    "Australia": { tz: "Australia/Perth", hubCn: "珀斯(矿区同北京时) / 悉尼+2~3h", workWeek: "mon_fri", lunch: [12, 13], groups: ["xmas_ny"], voltage: "400V/415V · 50Hz", is60Hz: false, pipeStd: "AS (澳标Table D/E) / ANSI", cert: "RCM / WaterMark · 中澳FTA(ChAFTA)" },
    "South Korea": { tz: "Asia/Seoul", hubCn: "釜山/仁川", workWeek: "mon_fri", lunch: [12, 13], groups: ["tet_cny"], voltage: "380V/440V · 60Hz", is60Hz: true, pipeStd: "KS / JIS / ANSI", cert: "KC 认证 · 中韩FTA" },
    "Japan": { tz: "Asia/Tokyo", hubCn: "大阪/东京", workWeek: "mon_fri", lunch: [12, 13], groups: [], voltage: "200V · 东日本50Hz / 西日本60Hz!", is60Hz: true, pipeStd: "JIS 日标 (10K/20K)", cert: "JIS / PSE · RCEP原产地证" }
  };

  function getCountryTradeProfile(countryEn) {
    var raw = String(countryEn || "Vietnam").trim();
    if (COUNTRY_TRADE_PROFILES[raw]) return COUNTRY_TRADE_PROFILES[raw];
    var clean = raw.replace(/\s*\([^)]*\)/g, "").trim();
    if (COUNTRY_TRADE_PROFILES[clean]) return COUNTRY_TRADE_PROFILES[clean];
    // Regional intelligent fallbacks across remaining 146 countries
    if (/Bahrain|Jordan|Yemen|Libya|Syria|Sudan/i.test(clean)) {
      return { tz: "Asia/Riyadh", hubCn: clean, workWeek: "sun_thu", lunch: [12.5, 14], groups: ["islamic"], voltage: "380V/400V · 50Hz", is60Hz: false, pipeStd: "BS / EN / ANSI", cert: "COC 装船前检验 + 原产地证" };
    }
    if (/Tunisia|Senegal|Mauritania|Mali|Niger|Brunei/i.test(clean)) {
      return { tz: "Africa/Casablanca", hubCn: clean, workWeek: "mon_fri_jummah", lunch: [12.5, 14], groups: ["islamic"], voltage: "380V/400V · 50Hz", is60Hz: false, pipeStd: "EN / DIN", cert: "COC / BV 检验" };
    }
    if (/Panama|Costa Rica|Guatemala|Honduras|El Salvador|Nicaragua|Dominican|Ecuador|Venezuela/i.test(clean)) {
      return { tz: "America/Panama", hubCn: clean, workWeek: "mon_fri", lunch: [12.5, 14], groups: ["xmas_ny", "semana_santa"], voltage: "220V/440V · 60Hz", is60Hz: true, pipeStd: "ANSI / ASME 美标", cert: "核实当地西语铭牌与电压60Hz" };
    }
    if (/Uruguay|Paraguay|Bolivia/i.test(clean)) {
      return { tz: "America/Sao_Paulo", hubCn: clean, workWeek: "mon_fri", lunch: [12.5, 14], groups: ["xmas_ny", "semana_santa"], voltage: "380V · 50Hz", is60Hz: false, pipeStd: "ANSI / DIN", cert: "原产地证与电压核实" };
    }
    if (/Netherlands|Belgium|Austria|Switzerland|Sweden|Norway|Denmark|Finland|Czech|Hungary|Romania|Portugal|Greece|Ireland|Serbia|Bulgaria|Croatia|Slovakia|Slovenia|Lithuania|Latvia|Estonia/i.test(clean)) {
      return { tz: "Europe/Berlin", hubCn: clean, workWeek: "mon_fri", lunch: [12, 13], groups: ["xmas_ny", "eu_aug"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "EN / DIN 欧标", cert: "CE + CBAM(涉钢/铝报告)" };
    }
    if (/Belarus|Azerbaijan|Armenia|Georgia|Kyrgyz|Tajikistan|Turkmenistan|Ukraine|Moldova/i.test(clean)) {
      return { tz: "Europe/Moscow", hubCn: clean, workWeek: "mon_fri", lunch: [13, 14], groups: ["ru_ny_may"], voltage: "380V/400V · 50Hz", is60Hz: false, pipeStd: "GOST / EN", cert: "EAC / GOST 符合性认证" };
    }
    if (/Tanzania|Uganda|Ghana|Angola|Ethiopia|Mozambique|Zambia|Zimbabwe|Congo|Cameroon|Cote|Ivory/i.test(clean)) {
      return { tz: "Africa/Nairobi", hubCn: clean, workWeek: "mon_fri", lunch: [12.5, 13.5], groups: ["xmas_ny"], voltage: "380V/400V · 50Hz", is60Hz: false, pipeStd: "BS / EN", cert: "PVoC / COC 装船前检验" };
    }
    if (/New Zealand/i.test(clean)) {
      return { tz: "Pacific/Auckland", hubCn: "奥克兰", workWeek: "mon_fri", lunch: [12, 13], groups: ["xmas_ny"], voltage: "400V · 50Hz", is60Hz: false, pipeStd: "AS/NZS / ANSI", cert: "RCM · 中新FTA" };
    }
    return { tz: "Asia/Ho_Chi_Minh", hubCn: clean || "目标市场", workWeek: "mon_fri", lunch: [12, 13], groups: [], voltage: "请核实工业电压(50/60Hz)", is60Hz: false, pipeStd: "请确认法兰/螺纹标准(ANSI/DIN/JIS)", cert: "核实目的港清关单证" };
  }

  /* 10 High-Impact Foreign Trade Windows (2026–2030 exact floating & fixed ranges; trivial 1-day holidays intentionally omitted) */
  var TRADE_WINDOWS = [
    // 1. Ramadan (shortened work hours 10:00-15:00; pre-45~60d stocking golden window)
    { group: "islamic", mode: "ramadan", nameCn: "伊斯兰斋月 (Ramadan)", regionCn: "中东/印尼/马来/北非/巴基斯坦", ranges: [["2026-02-18","2026-03-19"],["2027-02-08","2027-03-09"],["2028-01-28","2028-02-26"],["2029-01-16","2029-02-14"],["2030-01-06","2030-02-04"],["2030-12-26","2031-01-24"]], tipCn: "白天工时缩短(约10:00–15:00)，决策与清关放缓；开斋晚间可轻度沟通，斋月前45–60天务必催单锁舱位" },
    // 2. Eid al-Fitr (strict 5-day shutdown)
    { group: "islamic", mode: "shutdown", nameCn: "开斋节大假 (Eid al-Fitr)", regionCn: "中东/印尼/马来/北非/巴基斯坦", ranges: [["2026-03-19","2026-03-24"],["2027-03-09","2027-03-14"],["2028-02-26","2028-03-02"],["2029-02-14","2029-02-19"],["2030-02-04","2030-02-09"]], tipCn: "全行业停工休假，严禁硬推销，适合仅发一句 Eid Mubarak 节日祝福" },
    // 3. Eid al-Adha (strict 5-day shutdown)
    { group: "islamic", mode: "shutdown", nameCn: "宰牲节大假 (Eid al-Adha)", regionCn: "中东/北非/印尼/巴基斯坦", ranges: [["2026-05-26","2026-05-31"],["2027-05-16","2027-05-21"],["2028-05-04","2028-05-09"],["2029-04-23","2029-04-28"],["2030-04-13","2030-04-18"]], tipCn: "政府与企业连休停摆，暂停电话/WhatsApp催单，仅发节日问候" },
    // 4. Christmas & New Year Western/LatAm Shutdown
    { group: "xmas_ny", mode: "shutdown", nameCn: "圣诞至元旦跨年停工期", regionCn: "欧美/拉美/澳新/非洲", ranges: [["2025-12-24","2026-01-03"],["2026-12-24","2027-01-03"],["2027-12-24","2028-01-03"],["2028-12-24","2029-01-03"],["2029-12-24","2030-01-03"],["2030-12-24","2031-01-03"]], tipCn: "欧美拉美采购集中休假(Out of Office)，11月底–12月中旬是年前锁单最后窗口" },
    // 5. South Africa Builders' Holiday
    { group: "sa_builders", mode: "shutdown", nameCn: "南非矿业与建筑夏休月", regionCn: "南非", ranges: [["2025-12-15","2026-01-12"],["2026-12-15","2027-01-12"],["2027-12-15","2028-01-12"],["2028-12-15","2029-01-12"],["2029-12-15","2030-01-12"],["2030-12-15","2031-01-12"]], tipCn: "南非工程与矿山机电采购整月休假，务必在11月–12月初锁死备件订单" },
    // 6. European August Factory Vacation
    { group: "eu_aug", mode: "slowdown", nameCn: "欧洲 8 月工业夏休期", regionCn: "法/意/西/德等欧盟国家", ranges: [["2026-08-05","2026-08-24"],["2027-08-05","2027-08-24"],["2028-08-05","2028-08-24"],["2029-08-05","2029-08-24"],["2030-08-05","2030-08-24"]], tipCn: "南欧与西欧大量工厂轮休，回复极慢；6–7月提前锁单，9月首周集中唤醒" },
    // 7. Semana Santa (LatAm & Spain Holy Week)
    { group: "semana_santa", mode: "shutdown", nameCn: "圣周长假 (Semana Santa)", regionCn: "墨西哥/智利/秘鲁/哥伦比亚/西班牙", ranges: [["2026-04-02","2026-04-05"],["2027-03-25","2027-03-28"],["2028-04-13","2028-04-16"],["2029-03-29","2029-04-01"],["2030-04-18","2030-04-21"]], tipCn: "拉美最重要传统假期之一，周四至周日全停，提前一周确认付款与提单" },
    // 8. Brazil Carnival
    { group: "br_carnival", mode: "shutdown", nameCn: "巴西狂欢节停工周", regionCn: "巴西", ranges: [["2026-02-14","2026-02-18"],["2027-02-06","2027-02-10"],["2028-02-26","2028-03-01"],["2029-02-10","2029-02-14"],["2030-03-02","2030-03-06"]], tipCn: "巴西全国停摆近一周，清关与银行付汇顺延" },
    // 9. Vietnam Tết & Lunar New Year + China Factory Cutoff
    { group: "tet_cny", mode: "shutdown", nameCn: "越南春节 (Tết) / 农历新年", regionCn: "越南/马新华人采购/韩国", ranges: [["2026-02-15","2026-02-23"],["2027-02-04","2027-02-12"],["2028-01-24","2028-02-01"],["2029-02-11","2029-02-19"],["2030-02-01","2030-02-09"]], tipCn: "越南工厂与清关连休7–9天，叠加中国国内工厂停工，须提前40天锁排产" },
    // 10a. Thailand Songkran
    { group: "songkran", mode: "shutdown", nameCn: "泰国泼水节新年 (Songkran)", regionCn: "泰国/柬埔寨", ranges: [["2026-04-13","2026-04-16"],["2027-04-13","2027-04-16"],["2028-04-13","2028-04-16"],["2029-04-13","2029-04-16"],["2030-04-13","2030-04-16"]], tipCn: "泰国全年最大长假，提前确认到港免箱期(Free Demurrage)" },
    // 10b. India Diwali
    { group: "diwali", mode: "shutdown", nameCn: "印度排灯节大假 (Diwali)", regionCn: "印度", ranges: [["2026-11-07","2026-11-11"],["2027-10-28","2027-11-01"],["2028-10-16","2028-10-20"],["2029-11-04","2029-11-08"],["2030-10-25","2030-10-29"]], tipCn: "印度工业界最大节日，工厂停工发奖金，节前备货集中" },
    // 10c. Russia & CIS New Year / May Holidays
    { group: "ru_ny_may", mode: "shutdown", nameCn: "俄语区新年/五月连休", regionCn: "俄罗斯/哈萨克/乌兹别克等", ranges: [["2026-01-01","2026-01-08"],["2026-05-01","2026-05-09"],["2027-01-01","2027-01-08"],["2027-05-01","2027-05-09"],["2028-01-01","2028-01-08"],["2028-05-01","2028-05-09"],["2029-01-01","2029-01-08"],["2029-05-01","2029-05-09"],["2030-01-01","2030-01-08"],["2030-05-01","2030-05-09"]], tipCn: "俄语区1月首周与5月首周官方连休，银行结算暂停" },
    // Supply-side global alert: China Spring Festival Factory & Shipping Cutoff
    { group: "cn_factory", mode: "supply_cutoff", nameCn: "中国春节工厂截单与海运爆舱期", regionCn: "全球买家催单通用", ranges: [["2026-02-15","2026-02-24"],["2027-02-04","2027-02-14"],["2028-01-24","2028-02-03"],["2029-02-11","2029-02-20"],["2030-02-01","2030-02-10"]], tipCn: "提前35–50天通知所有在谈客户锁定年前最后排产与海运舱位（2027春节与斋月几乎重合，务必提前！）" }
  ];

  function findCountryHolidayMatch(prof, isoDate) {
    var groups = (prof && prof.groups) || [];
    var activeShutdown = null;
    var activeSpecial = null;
    var nearestUpcoming = null;
    var baseMs = Date.parse(isoDate + "T00:00:00Z");
    for (var i = 0; i < TRADE_WINDOWS.length; i++) {
      var w = TRADE_WINDOWS[i];
      if (groups.indexOf(w.group) < 0) continue;
      for (var r = 0; r < w.ranges.length; r++) {
        var st = w.ranges[r][0], ed = w.ranges[r][1];
        if (isoDate >= st && isoDate <= ed) {
          if (w.mode === "shutdown") activeShutdown = { nameCn: w.nameCn, mode: w.mode, start: st, end: ed, tipCn: w.tipCn };
          else if (!activeSpecial) activeSpecial = { nameCn: w.nameCn, mode: w.mode, start: st, end: ed, tipCn: w.tipCn };
        } else if (st > isoDate) {
          var diffDays = Math.round((Date.parse(st + "T00:00:00Z") - baseMs) / 86400000);
          if (diffDays > 0 && diffDays <= 65 && (!nearestUpcoming || diffDays < nearestUpcoming.daysAway)) {
            nearestUpcoming = { nameCn: w.nameCn, mode: w.mode, start: st, end: ed, daysAway: diffDays, tipCn: w.tipCn };
          }
        }
      }
    }
    return { active: activeShutdown || activeSpecial, nearestUpcoming: nearestUpcoming };
  }

  function isCountryNonWorkingDate(countryEn, isoDate, utcWeekday) {
    var prof = getCountryTradeProfile(countryEn);
    var wd = typeof utcWeekday === "number" ? utcWeekday : new Date(Date.parse(isoDate + "T00:00:00Z")).getUTCDay();
    var isWknd = prof.workWeek === "sun_thu" ? (wd === 5 || wd === 6) : (wd === 0 || wd === 6);
    if (isWknd) return true;
    var hm = findCountryHolidayMatch(prof, isoDate);
    return !!(hm.active && hm.active.mode === "shutdown");
  }

  var WD_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var WD_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function extractZonedParts(dateObj, tz) {
    var yr = "2026", mo = "01", dy = "01", hh = 9, mm = 0, wd = 1;
    try {
      var parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit"
      }).formatToParts(dateObj);
      parts.forEach(function (p) {
        if (p.type === "year") yr = p.value;
        else if (p.type === "month") mo = p.value;
        else if (p.type === "day") dy = p.value;
        else if (p.type === "hour") hh = parseInt(p.value, 10) % 24;
        else if (p.type === "minute") mm = parseInt(p.value, 10) || 0;
        else if (p.type === "weekday" && WD_MAP[p.value] !== undefined) wd = WD_MAP[p.value];
      });
    } catch (_) {}
    return {
      isoDate: yr + "-" + mo + "-" + dy,
      hh: hh,
      mm: mm,
      timeStr: (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm,
      wd: wd,
      wdCn: WD_CN[wd]
    };
  }

  function computeNextLocalWorkSlotBeijing(prof, nowMs) {
    // Scan forward in 30-min steps (up to 12 days) to find buyer's next 09:30 working morning, then format in Beijing time
    var stepMs = 1800000;
    var startMs = Math.ceil(nowMs / stepMs) * stepMs;
    for (var k = 1; k <= 576; k++) {
      var candMs = startMs + k * stepMs;
      var zp = extractZonedParts(new Date(candMs), prof.tz);
      if (isCountryNonWorkingDateFromProf(prof, zp.isoDate, zp.wd)) continue;
      var targetH = 9;
      var hm = findCountryHolidayMatch(prof, zp.isoDate);
      if (hm.active && hm.active.mode === "ramadan") targetH = 10;
      if (zp.hh === targetH && zp.mm >= 15 && zp.mm <= 45) {
        var bj = extractZonedParts(new Date(candMs), "Asia/Shanghai");
        var bjNow = extractZonedParts(new Date(nowMs), "Asia/Shanghai");
        var dayPrefix = bj.isoDate === bjNow.isoDate ? "今日 " : ("北京时间 " + bj.isoDate.slice(5) + "(" + bj.wdCn + ") ");
        return dayPrefix.indexOf("北京时间") === 0 ? (dayPrefix + bj.timeStr) : ("北京时间 " + dayPrefix + bj.timeStr);
      }
    }
    return "建议按对方工作日上午 09:30 定时发送";
  }

  function isCountryNonWorkingDateFromProf(prof, isoDate, wd) {
    var isWknd = prof.workWeek === "sun_thu" ? (wd === 5 || wd === 6) : (wd === 0 || wd === 6);
    if (isWknd) return true;
    var hm = findCountryHolidayMatch(prof, isoDate);
    return !!(hm.active && hm.active.mode === "shutdown");
  }

  function evaluateCountryContactTiming(countryEn, nowInput) {
    var nowMs = nowInput instanceof Date ? nowInput.getTime() : (typeof nowInput === "number" ? nowInput : Date.now());
    var prof = getCountryTradeProfile(countryEn);
    var zp = extractZonedParts(new Date(nowMs), prof.tz);
    var hm = findCountryHolidayMatch(prof, zp.isoDate);
    var decHour = zp.hh + zp.mm / 60;
    var isWknd = prof.workWeek === "sun_thu" ? (zp.wd === 5 || zp.wd === 6) : (zp.wd === 0 || zp.wd === 6);

    var level = "green";
    var dot = "🟢";
    var statusLabel = "";
    var actionAdvice = "";

    if (hm.active && hm.active.mode === "shutdown") {
      level = "red";
      dot = "🔴";
      statusLabel = "当地大假停工 · " + hm.active.nameCn;
      actionAdvice = hm.active.tipCn + "｜恢复后首轮建议定时：" + computeNextLocalWorkSlotBeijing(prof, nowMs);
    } else if (isWknd) {
      level = "red";
      dot = "🔴";
      statusLabel = "当地周末公休（" + zp.wdCn + " " + zp.timeStr + (prof.workWeek === "sun_thu" ? " · 周日–周四上班" : "") + "）";
      actionAdvice = "切勿周末发陌生 WhatsApp 防拉黑｜邮件建议定时：" + computeNextLocalWorkSlotBeijing(prof, nowMs);
    } else if (decHour < 8 || decHour >= 20) {
      level = "red";
      dot = "🔴";
      statusLabel = "当地深夜/清晨休息（" + zp.wdCn + " " + zp.timeStr + "）";
      actionAdvice = "严禁直发 WhatsApp/电话吵醒客户｜邮件建议定时：" + computeNextLocalWorkSlotBeijing(prof, nowMs);
    } else if (hm.active && hm.active.mode === "ramadan") {
      if (decHour >= 10 && decHour < 15) {
        level = "yellow";
        dot = "🟡";
        statusLabel = "斋月短班在岗（" + zp.timeStr + " · 斋月 10:00–15:00 办公）";
        actionAdvice = "沟通宜简明扼要，避免催促；也可在日落开斋后晚间轻度问候";
      } else {
        level = "yellow";
        dot = "🟡";
        statusLabel = "斋月非集中办公时段（" + zp.timeStr + "）";
        actionAdvice = "建议邮件定时至次日斋月上午：" + computeNextLocalWorkSlotBeijing(prof, nowMs);
      }
    } else if (prof.workWeek === "mon_fri_jummah" && zp.wd === 5 && decHour >= 11.75 && decHour < 14.5) {
      level = "yellow";
      dot = "🟡";
      statusLabel = "当地周五主麻祈祷时段（" + zp.timeStr + "）";
      actionAdvice = "阿联酋/印尼/马来/土耳其在此时段普遍离岗祈祷，建议延后2小时或排下周初定时邮件";
    } else if (prof.lunch && decHour >= prof.lunch[0] && decHour < prof.lunch[1]) {
      level = "yellow";
      dot = "🟡";
      statusLabel = "当地午休时段（" + zp.timeStr + "）";
      actionAdvice = "可正常发邮件，但暂缓陌生电话直拨，1小时后联系接通率更高";
    } else if (decHour >= 8 && decHour < 9) {
      level = "yellow";
      dot = "🟡";
      statusLabel = "当地刚上班整理邮件（" + zp.timeStr + "）";
      actionAdvice = "发开发信极佳（正好排在收件箱顶部），电话/WhatsApp建议等 09:15 后";
    } else if (decHour >= 17.5 && decHour < 20) {
      level = "yellow";
      dot = "🟡";
      statusLabel = "当地已下班（" + zp.timeStr + "）";
      actionAdvice = "欧美/德日客户忌下班打扰；建议将开发信定时至：" + computeNextLocalWorkSlotBeijing(prof, nowMs);
    } else {
      level = "green";
      dot = "🟢";
      statusLabel = "黄金办公时段（" + prof.hubCn + " " + zp.wdCn + " " + zp.timeStr + "）";
      actionAdvice = (hm.active && hm.active.mode === "slowdown")
        ? ("注意当前处于「" + hm.active.nameCn + "」，部分采购轮休，回复可能偏慢")
        : "买家正在上班，适合立即发开发信、WhatsApp 破冰或电话跟进";
    }

    return {
      country: countryEn,
      level: level,
      dot: dot,
      isWorkingNow: level === "green",
      isRamadan: !!(hm.active && hm.active.mode === "ramadan"),
      localTimeStr: zp.timeStr,
      localDateStr: zp.isoDate,
      weekdayCn: zp.wdCn,
      hubCn: prof.hubCn,
      statusLabel: statusLabel,
      actionAdvice: actionAdvice,
      activeHoliday: hm.active,
      upcomingHoliday: hm.nearestUpcoming,
      spec: {
        voltage: prof.voltage,
        is60Hz: !!prof.is60Hz,
        pipeStd: prof.pipeStd,
        cert: prof.cert
      }
    };
  }

  function getUpcomingGlobalTradeAlerts(nowDateStr, horizonDays) {
    var iso = (nowDateStr && /^\d{4}-\d{2}-\d{2}$/.test(nowDateStr))
      ? nowDateStr
      : new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    var maxDays = typeof horizonDays === "number" ? horizonDays : 65;
    var baseMs = Date.parse(iso + "T00:00:00Z");
    var activeOrSoon = [];
    var preStocking = [];

    for (var i = 0; i < TRADE_WINDOWS.length; i++) {
      var w = TRADE_WINDOWS[i];
      for (var r = 0; r < w.ranges.length; r++) {
        var st = w.ranges[r][0], ed = w.ranges[r][1];
        if (iso >= st && iso <= ed && w.mode !== "supply_cutoff") {
          activeOrSoon.push({
            group: w.group,
            nameCn: w.nameCn,
            regionCn: w.regionCn,
            dateRange: st.slice(5) + "~" + ed.slice(5),
            daysAway: 0,
            mode: w.mode,
            tipCn: w.tipCn
          });
          break;
        } else if (st > iso) {
          var dAway = Math.round((Date.parse(st + "T00:00:00Z") - baseMs) / 86400000);
          if (dAway > 0 && dAway <= 20 && w.mode !== "supply_cutoff") {
            activeOrSoon.push({
              group: w.group,
              nameCn: w.nameCn,
              regionCn: w.regionCn,
              dateRange: st.slice(5) + "~" + ed.slice(5),
              daysAway: dAway,
              mode: w.mode,
              tipCn: w.tipCn
            });
          } else if (dAway > 10 && dAway <= maxDays) {
            preStocking.push({
              group: w.group,
              nameCn: w.nameCn,
              regionCn: w.regionCn,
              dateRange: st + " 起",
              daysAway: dAway,
              mode: w.mode,
              tipCn: w.tipCn
            });
          }
          break;
        }
      }
    }
    preStocking.sort(function (a, b) { return a.daysAway - b.daysAway; });
    return {
      activeOrSoon: activeOrSoon.slice(0, 3),
      preStocking: preStocking.slice(0, 4)
    };
  }

  var SPAM_TRIGGERS = [
    { re: /\b100%\s*free\b/i, label: "100% free" },
    { re: /\blowest\s+price\b/i, label: "lowest price（低质群发高频词）" },
    { re: /\bcheapest\b/i, label: "cheapest（易触发垃圾箱且拉低定位）" },
    { re: /\bbest\s+price\s+guaranteed\b/i, label: "best price guaranteed" },
    { re: /\bact\s+now\b/i, label: "act now" },
    { re: /\bclick\s+here\b/i, label: "click here" },
    { re: /\burgent\b/i, label: "urgent（陌生首封慎用）" },
    { re: /\bdear\s+sir\s*\/?\s*madam\b/i, label: "Dear Sir/Madam（典型群发模板抬头）" },
    { re: /\brisk[\s-]*free\b/i, label: "risk-free" },
    { re: /\bno\s+obligation\b/i, label: "no obligation" }
  ];

  var SAFE_IND_ACRONYMS = {
    FOB:1, CIF:1, CFR:1, EXW:1, DDP:1, DAP:1, FCA:1, API:1, ANSI:1, ASME:1, ASTM:1,
    DIN:1, JIS:1, ISO:1, SGS:1, TUV:1, NOM:1, SABER:1, SONCAP:1, INMETRO:1, RCEP:1,
    SABS:1, SIRIM:1, TISI:1, GOST:1, EAC:1, CBAM:1, BOQ:1, CAD:1, MTC:1, USD:1,
    EUR:1, CNY:1, RMB:1, MOQ:1, LCL:1, FCL:1, TEU:1, EPC:1, MEP:1, OEM:1, ODM:1,
    AQL:1, IEC:1, NEMA:1, UL:1, CSA:1, CE:1, JSC:1, LLC:1, GMBH:1, B2B:1, RFQ:1
  };

  function auditColdEmailDeliverability(subject, body, opts) {
    var o = opts || {};
    var sub = String(subject || "").trim();
    var bd = String(body || "").trim();
    var full = (o.noSubject ? "" : (sub + "\n")) + bd;
    var issues = [];

    for (var i = 0; i < SPAM_TRIGGERS.length; i++) {
      if (SPAM_TRIGGERS[i].re.test(full)) {
        issues.push("含垃圾箱高敏词「" + SPAM_TRIGGERS[i].label + "」");
      }
    }
    var links = full.match(/https?:\/\/[^\s)]+|www\.[^\s)]+/gi) || [];
    if (links.length >= 2) {
      issues.push("含 " + links.length + " 条网址（冷启动首封建议 0–1 条链接防拦截）");
    }
    var exclamations = (full.match(/![!！]*|！[！!]*/g) || []).length;
    if (exclamations >= 3) {
      issues.push("感叹号过多（" + exclamations + " 处，易触发反垃圾评分）");
    }
    var capsWords = (sub.match(/\b[A-Z]{4,}\b/g) || []).filter(function (w) { return !SAFE_IND_ACRONYMS[w]; });
    if (capsWords.length >= 2) {
      issues.push("主题含多个全大写单词（" + capsWords.slice(0, 2).join(", ") + "）");
    }
    var words = bd.split(/\s+/).filter(Boolean).length;
    if (!o.noSubject && words > 175) {
      issues.push("正文偏长（" + words + " 词，工业开发信黄金长度为 70–145 词）");
    }

    var level = issues.length === 0 ? "green" : (issues.length >= 2 || links.length >= 3 ? "red" : "yellow");
    var score = Math.max(0, 100 - issues.length * 22);
    var badgeText = level === "green"
      ? ("🛡️ 进收件箱体检通过（" + words + " 词 · " + links.length + " 外链 · 0 敏感词）")
      : ("⚠️ 发信体检提醒（" + words + " 词）：" + issues.join("；"));
    return {
      level: level,
      score: score,
      words: words,
      wordCount: words,
      linkCount: links.length,
      issues: issues,
      badgeText: badgeText
    };
  }

  var TLD_COUNTRY_HINT = {
    vn: "Vietnam", id: "Indonesia", th: "Thailand", my: "Malaysia", ph: "Philippines", sg: "Singapore",
    sa: "Saudi Arabia", ae: "United Arab Emirates", qa: "Qatar", kw: "Kuwait", om: "Oman", eg: "Egypt",
    ma: "Morocco", dz: "Algeria", tr: "Turkey (Türkiye)", mx: "Mexico", br: "Brazil", cl: "Chile",
    pe: "Peru", co: "Colombia", ar: "Argentina", de: "Germany", fr: "France", it: "Italy", es: "Spain",
    pl: "Poland", uk: "United Kingdom", ru: "Russia", kz: "Kazakhstan", uz: "Uzbekistan",
    za: "South Africa", ng: "Nigeria", ke: "Kenya", au: "Australia", in: "India", pk: "Pakistan",
    bd: "Bangladesh", kr: "South Korea", jp: "Japan", ca: "Canada"
  };

  var DIAL_COUNTRY_HINT = [
    ["+966", "Saudi Arabia"], ["+971", "United Arab Emirates"], ["+84", "Vietnam"], ["+62", "Indonesia"],
    ["+66", "Thailand"], ["+60", "Malaysia"], ["+63", "Philippines"], ["+65", "Singapore"],
    ["+91", "India"], ["+92", "Pakistan"], ["+880", "Bangladesh"], ["+20", "Egypt"], ["+212", "Morocco"],
    ["+213", "Algeria"], ["+90", "Turkey (Türkiye)"], ["+52", "Mexico"], ["+55", "Brazil"], ["+56", "Chile"],
    ["+51", "Peru"], ["+57", "Colombia"], ["+54", "Argentina"], ["+49", "Germany"], ["+33", "France"],
    ["+39", "Italy"], ["+34", "Spain"], ["+48", "Poland"], ["+44", "United Kingdom"], ["+7", "Russia"],
    ["+27", "South Africa"], ["+234", "Nigeria"], ["+254", "Kenya"], ["+61", "Australia"],
    ["+82", "South Korea"], ["+81", "Japan"], ["+1", "United States"]
  ];

  function parseSmartBusinessCard(rawText) {
    var txt = String(rawText || "").trim();
    if (!txt) return { ok: false, company: "", contact: "", email: "", phone: "", website: "", country: "" };

    var emMatch = txt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    var email = emMatch ? emMatch[0].toLowerCase() : "";

    var urlMatch = txt.match(/(?:https?:\/\/|www\.)[A-Z0-9.-]+\.[A-Z]{2,}(?:\/[^\s|,;]*)?/i);
    var rawUrl = urlMatch ? urlMatch[0].replace(/[.,;)]+$/, "") : "";
    if (!rawUrl && email) {
      var emDom = email.split("@")[1] || "";
      if (emDom && !PUBLIC_EMAIL_DOMAINS[emDom]) rawUrl = emDom;
    }
    var website = rawUrl ? extractCleanDomain(rawUrl) : "";

    var phMatch = txt.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,5}(?:\s*(?:ext\.?|x)\s*\d{1,5})?/i);
    var phone = "";
    if (phMatch && phMatch[0].replace(/\D/g, "").length >= 7) {
      phone = phMatch[0].trim();
    }

    // Guess country from explicit country name, dial prefix, or ccTLD
    var country = "";
    var lower = txt.toLowerCase();
    var knownNames = Object.keys(COUNTRY_TRADE_PROFILES);
    for (var n = 0; n < knownNames.length; n++) {
      var nm = knownNames[n].replace(/\s*\([^)]*\)/g, "").toLowerCase();
      if (nm.length >= 4 && lower.indexOf(nm) >= 0) { country = knownNames[n]; break; }
    }
    if (!country && /UAE|Dubai|Abu Dhabi/i.test(txt)) country = "United Arab Emirates";
    if (!country && /KSA|Riyadh|Dammam|Jeddah/i.test(txt)) country = "Saudi Arabia";
    if (!country && /Monterrey|Guadalajara|CDMX/i.test(txt)) country = "Mexico";
    if (!country && /Ho Chi Minh|Hanoi/i.test(txt)) country = "Vietnam";
    if (!country && phone.indexOf("+") === 0) {
      for (var d = 0; d < DIAL_COUNTRY_HINT.length; d++) {
        if (phone.indexOf(DIAL_COUNTRY_HINT[d][0]) === 0) { country = DIAL_COUNTRY_HINT[d][1]; break; }
      }
    }
    if (!country) {
      var domHost = website || extractCleanDomain(email);
      if (domHost) {
        var lastSeg = domHost.split(".").pop();
        if (TLD_COUNTRY_HINT[lastSeg]) country = TLD_COUNTRY_HINT[lastSeg];
      }
    }

    var signoffRe = /^(?:best\s+regards|kind\s+regards|warm\s+regards|regards|sincerely|yours\s+truly|thanks(?:\s*(?:&|and)\s*regards)?|atentamente|saludos(?:\s+cordiales)?|cordialmente|cordialement|mit\s+freundlichen\s+grüßen|trân\s+trọng|hormat\s+kami)[,!.\s]*$/i;

    // Split tokens across lines / pipes / semicolons to identify Company vs Contact Name + Role
    var segments = txt
      .split(/[\r\n|｜;；]+/)
      .map(function (s) {
        return s
          .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
          .replace(/(?:https?:\/\/|www\.)[^\s]+/gi, "")
          .replace(/^(?:company|organization|firm|client|name|contact|tel|phone|mobile|whatsapp|email|web|website|address)\s*[:：\/\s]*/i, "")
          .trim();
      })
      .filter(function (s) {
        return s.length >= 2 && !/^\+?[\d\s().\/-]+$/.test(s) && !signoffRe.test(s);
      });

    var company = "";
    var roleSeg = "";
    var personSeg = "";
    var compSuffixRe = /\b(Ltd\.?|Limited|LLC|Inc\.?|Corp\.?|Corporation|Co\.?\s*,?\s*Ltd|Co\.|S\.?A\.?\s*de\s*C\.?V\.?|S\.?A\.?C?\.?|S\.?R\.?L\.?|Ltda\.?|GmbH|AG|BV|NV|JSC|PLC|Pvt|Sdn\s*Bhd|PT\.?\s+\w|CV\.?\s+\w|Industrial|Engineering|Trading|Supply|Supplies|Equipment|Machinery|Valves?|Pumps?|Steel|Piping|Group|Enterprises?|Constructora|Comercializadora|Importadora|Distribuidora)\b/i;
    var roleWordRe = /\b(Manager|Director|Engineer|Buyer|Procurement|Purchasing|Sourcing|Head|VP|President|Owner|CEO|Founder|Coordinator|Specialist|Jefe|Gerente|Diretor|Ingeniero|采购|经理|总监|工程师)\b/i;

    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s];
      if (!company && compSuffixRe.test(seg)) {
        company = seg;
      } else if (!roleSeg && roleWordRe.test(seg)) {
        roleSeg = seg;
      }
    }
    for (var s2 = 0; s2 < segments.length; s2++) {
      var seg2 = segments[s2];
      if (seg2 === company || seg2 === roleSeg) continue;
      if (knownNames.some(function (k) { return k.toLowerCase() === seg2.toLowerCase(); })) continue;
      if (!personSeg && seg2.split(/\s+/).length <= 5 && !/\d/.test(seg2)) {
        personSeg = seg2;
      } else if (!company) {
        company = seg2;
      }
    }
    var contact = "";
    if (personSeg && roleSeg) contact = personSeg + " (" + roleSeg + ")";
    else contact = personSeg || roleSeg || "";

    if (!company && website) {
      var stem = website.split(".")[0] || "";
      if (stem) company = stem.charAt(0).toUpperCase() + stem.slice(1);
    }

    return {
      ok: Boolean(company || contact || email || phone || website),
      company: company,
      contact: contact,
      email: email,
      phone: phone,
      website: website,
      country: country
    };
  }

  return {
    escHtml: escHtml,
    extractCleanDomain: extractCleanDomain,
    isValidDomain: isValidDomain,
    safeHttpUrl: safeHttpUrl,
    safeInit: safeInit,
    genStableId: genStableId,
    DEC: DEC,
    sanitizeClientCode: sanitizeClientCode,
    formatQuoteRef: formatQuoteRef,
    computeQuote: computeQuote,
    validateContainerRow: validateContainerRow,
    computeContainerLoad: computeContainerLoad,
    analyzePhoneCore: analyzePhoneCore,
    buildLeadDedupeKey: buildLeadDedupeKey,
    normalizeLeadForStore: normalizeLeadForStore,
    mergeLeadRecord: mergeLeadRecord,
    normalizeEmailToken: normalizeEmailToken,
    guessCorporateEmails: guessCorporateEmails,
    localizeProductForLang: localizeProductForLang,
    resolveCountryIso2: resolveCountryIso2,
    scoreGleifRecords: scoreGleifRecords,
    computeDefaultNextFollowDate: computeDefaultNextFollowDate,
    nextCadenceSchedule: nextCadenceSchedule,
    PRODUCT_PROFILES: PRODUCT_PROFILES,
    getProductProfile: getProductProfile,
    buildSignalIcebreaker: buildSignalIcebreaker,
    buildLinkedInOutreach: buildLinkedInOutreach,
    buildBuyerRoleDorks: buildBuyerRoleDorks,
    buildInquiryClarification: buildInquiryClarification,
    computeWeeklyFunnel: computeWeeklyFunnel,
    getCountryTradeProfile: getCountryTradeProfile,
    isCountryNonWorkingDate: isCountryNonWorkingDate,
    evaluateCountryContactTiming: evaluateCountryContactTiming,
    getUpcomingGlobalTradeAlerts: getUpcomingGlobalTradeAlerts,
    auditColdEmailDeliverability: auditColdEmailDeliverability,
    parseSmartBusinessCard: parseSmartBusinessCard
  };
});

