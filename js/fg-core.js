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
      "cadenceStep", "cadenceLabel", "lossReason"
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

  function computeDefaultNextFollowDate(baseDateStr, offsetDays) {
    var days = (typeof offsetDays === "number" && Number.isFinite(offsetDays)) ? Math.max(1, Math.round(offsetDays)) : 3;
    var baseMs = baseDateStr && /^\d{4}-\d{2}-\d{2}$/.test(baseDateStr)
      ? Date.parse(baseDateStr + "T00:00:00Z")
      : Date.now();
    var targetMs = baseMs + days * 86400000;
    var dt = new Date(targetMs);
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
    breakup: { stepNum: 5, nextStep: "done", offsetDays: 14, sentLabel: "已发第5封(Day18礼貌唤醒)", nextLabel: "5步开发已完成(两周后复盘)" }
  };

  function nextCadenceSchedule(sentStepKey, baseDateStr) {
    var cfg = CADENCE_FLOW[sentStepKey] || CADENCE_FLOW.first;
    return {
      sentStep: sentStepKey in CADENCE_FLOW ? sentStepKey : "first",
      sentLabel: cfg.sentLabel,
      nextStep: cfg.nextStep,
      nextLabel: cfg.nextLabel,
      offsetDays: cfg.offsetDays,
      nextDate: computeDefaultNextFollowDate(baseDateStr, cfg.offsetDays)
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
    nextCadenceSchedule: nextCadenceSchedule
  };
});
