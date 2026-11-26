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
    var seqNum = Math.max(1, parseInt(o.seq || 1, 10) || 1);
    var verNum = Math.max(1, parseInt(o.version || 1, 10) || 1);
    return "FG-" + datePart + "-" + code + "-" + String(seqNum).padStart(3, "0") + "-V" + verNum;
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

    return {
      ok: true,
      taxMode: taxMode,
      commBasis: commBasis,
      decimals: decFob,
      cifDecimals: decCif,
      isAutoDecimals: isAutoDec,
      precisionNote: precisionNote,

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
      // Multi-container calculation (only reached when NO single unit exceeds route container payload or OOG)
      var byVol40Hq = Math.ceil(effCbmWithNoStackHq / cap40HqVol);
      var byVol40Gp = Math.ceil(effCbmWithNoStackGp / cap40GpVol);
      var byArea40 = Math.ceil(noStackAreaM2 / floorArea40);
      var byWt40 = Math.ceil(totTon / maxWt40);
      var byWt20 = Math.ceil(totTon / maxWt20);
      var byArea20 = Math.ceil(noStackAreaM2 / floorArea20);
      var byVol20 = Math.ceil(effCbmWithNoStackGp / cap20Vol);
      var n20 = Math.max(byWt20, byArea20, byVol20);
      var n40Hq = Math.max(byVol40Hq, byWt40, byArea40);
      var n40Gp = Math.max(byVol40Gp, byWt40, byArea40);

      // Discrete indivisible weight check: e.g. two 15t machines in a 26t limit route CANNOT fit in 2 * 26t? They CAN (1 per box = 2 boxes), whereas three 15t machines (45t) ceil(45/26)=2 boxes CANNOT hold 3 * 15t -> needs 3 boxes!
      var heavyCountOverHalf20 = 0, heavyCountOverHalf40 = 0;
      for (var hIdx = 0; hIdx < list.length; hIdx++) {
        var uTon = list[hIdx].kg / 1000;
        if (uTon > maxWt20 / 2) heavyCountOverHalf20 += list[hIdx].qty;
        if (uTon > maxWt40 / 2) heavyCountOverHalf40 += list[hIdx].qty;
      }
      if (heavyCountOverHalf20 > n20) n20 = heavyCountOverHalf20;
      if (heavyCountOverHalf40 > n40Hq) n40Hq = heavyCountOverHalf40;
      if (heavyCountOverHalf40 > n40Gp) n40Gp = heavyCountOverHalf40;

      if (forbid40GpByHeight) {
        rec = n40Hq + " × 40'HQ 高柜（含超高/不可叠放/限重校核）";
        recEn = n40Hq + " x 40'HQ (height, floor & weight checked)";
      } else if (forbid20Gp) {
        if (n40Gp <= n40Hq && effCbmWithNoStackGp <= n40Gp * cap40GpVol) {
          rec = n40Gp + " × 40'GP 平柜（或同数 40'HQ）";
          recEn = n40Gp + " x 40'GP (or 40'HQ)";
        } else {
          rec = n40Hq + " × 40'HQ 高柜（含超长/限重校核）";
          recEn = n40Hq + " x 40'HQ (length & weight checked)";
        }
      } else if (byWt20 > byVol40Hq && n20 === byWt20 && maxWt20 >= 19) {
        rec = n20 + " × 20'GP 小柜（重货按航线限重分柜）";
        recEn = n20 + " x 20'GP (heavy cargo route weight checked)";
      } else {
        rec = n40Hq + " × 40'HQ 高柜（按实装容积/底面积/限重）";
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

  function mergeLeadRecord(existingRaw, incomingRaw) {
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
      "website", "stage", "source", "nextDate", "note", "product", "estUsd"
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
        if (!item || (!item.txt && !item.tlId)) return;
        var prev = tlMap.get(item.tlId);
        if (!prev) {
          tlMap.set(item.tlId, Object.assign({}, item));
        } else {
          var prevMs = parseTsMs(prev.editedAt || prev.ts);
          var curMs = parseTsMs(item.editedAt || item.ts);
          if (curMs >= prevMs) tlMap.set(item.tlId, Object.assign({}, prev, item));
        }
      });
    });
    out.timeline = Array.from(tlMap.values()).sort(function (x, y) {
      return String(y.ts || "").localeCompare(String(x.ts || ""));
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

    // Soft-delete resolution: keep active if updated after deletion; otherwise preserve soft-delete metadata
    var delA = a.deletedAt ? parseTsMs(a.deletedAt) : 0;
    var delB = b.deletedAt ? parseTsMs(b.deletedAt) : 0;
    if (delA || delB) {
      var latestDel = Math.max(delA, delB);
      var latestActiveUpdate = Math.max(!a.deletedAt ? aMs : 0, !b.deletedAt ? bMs : 0);
      if (latestActiveUpdate > latestDel) {
        delete out.deletedAt;
        delete out.deletedBy;
        delete out.deleteReason;
      } else {
        var delSrc = delB >= delA ? b : a;
        out.deletedAt = delSrc.deletedAt;
        out.deletedBy = delSrc.deletedBy || "";
        out.deleteReason = delSrc.deleteReason || "";
      }
    }

    out.createdAt = (parseTsMs(a.createdAt) && parseTsMs(b.createdAt))
      ? (parseTsMs(a.createdAt) <= parseTsMs(b.createdAt) ? a.createdAt : b.createdAt)
      : (a.createdAt || b.createdAt);
    out.updatedAt = bMs >= aMs ? b.updatedAt : a.updatedAt;
    return out;
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
    mergeLeadRecord: mergeLeadRecord
  };
});
