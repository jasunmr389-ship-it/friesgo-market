// FriesGo Global V3.0 - Exact BigInt Rational Monetary, FX & Largest-Remainder Split Engine (ENG02 / REV04 / N05)
// Zero floating-point arithmetic. Strictly rejects fractional numbers, scientific notation, NaN, Infinity,
// and unsafe integers (> Number.MAX_SAFE_INTEGER) BEFORE any Number conversion.

export const SUPPORTED_CURRENCIES = Object.freeze({
  USD: { code: "USD", decimals: 2, symbol: "$" },
  EUR: { code: "EUR", decimals: 2, symbol: "€" },
  CNY: { code: "CNY", decimals: 2, symbol: "¥" },
  GBP: { code: "GBP", decimals: 2, symbol: "£" },
  AED: { code: "AED", decimals: 2, symbol: "AED " },
  SAR: { code: "SAR", decimals: 2, symbol: "SAR " },
  JPY: { code: "JPY", decimals: 0, symbol: "¥" },
});

export const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER); // 9007199254740991n
const MAX_LINE_MAJOR = 100000000n; // 100,000,000 major units cap per single line
const POW10 = [1n, 10n, 100n, 1000n, 10000n, 100000n, 1000000n, 10000000n, 100000000n];

export function getCurrencySpec(code) {
  const clean = String(code || "").trim().toUpperCase();
  const spec = SUPPORTED_CURRENCIES[clean];
  if (!spec) {
    throw new Error(`UNSUPPORTED_CURRENCY: ${clean || "(empty)"}`);
  }
  return spec;
}

/**
 * N05: Strict exact integer parser that rejects floats, NaN, Infinity, scientific notation,
 * booleans, empty values, and integers outside JS/D1 safe integer range BEFORE any Number() cast!
 */
export function parseExactSafeIntBigInt(raw, label = "integer", { allowNegative = true } = {}) {
  let val;
  if (typeof raw === "bigint") {
    val = raw;
  } else if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isSafeInteger(raw)) {
      throw new Error(`INVALID_EXACT_INTEGER: ${label} must be a finite safe integer`);
    }
    val = BigInt(raw);
  } else if (typeof raw === "string") {
    const s = raw.trim();
    const re = allowNegative ? /^-?\d+$/ : /^\d+$/;
    if (!re.test(s)) {
      throw new Error(`INVALID_EXACT_INTEGER: ${label} must be a strict base-10 integer string`);
    }
    val = BigInt(s);
  } else {
    throw new Error(`INVALID_EXACT_INTEGER: ${label} has unsupported type`);
  }

  if (!allowNegative && val < 0n) {
    throw new Error(`NEGATIVE_NOT_ALLOWED: ${label} must be >= 0`);
  }
  const abs = val < 0n ? -val : val;
  if (abs > MAX_SAFE_BIGINT) {
    throw new Error(`D1_SAFE_INT_OVERFLOW: ${label} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return val;
}

/**
 * Parses a strict decimal string (e.g. "18.3750", "-0.0050") into scaled BigInt (value * 10^scale).
 * Rejects scientific notation, NaN, trailing garbage, or excess decimal precision.
 */
export function parseDecimalToScaledBigInt(raw, maxScale, { allowNegative = false } = {}) {
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") {
    throw new Error("INVALID_DECIMAL: unsupported type");
  }
  if (typeof raw === "number" && !Number.isFinite(raw)) {
    throw new Error("INVALID_DECIMAL: non-finite number");
  }
  const s = String(raw).trim();
  const re = allowNegative ? /^-?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/;
  if (!re.test(s)) {
    throw new Error(`INVALID_DECIMAL: ${s}`);
  }
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const parts = body.split(".");
  const intPart = parts[0];
  const fracPart = parts[1] || "";
  if (fracPart.length > maxScale) {
    throw new Error(`EXCESS_DECIMAL_PRECISION: max ${maxScale} fractional digits, got ${fracPart.length}`);
  }
  const padded = fracPart.padEnd(maxScale, "0");
  const combined = BigInt(intPart + padded);
  return neg ? -combined : combined;
}

/**
 * Exact HALF_UP rounding on integer fraction num / den (symmetric for negative numbers).
 */
export function divRoundHalfUp(num, den) {
  if (den === 0n) throw new Error("DIVISION_BY_ZERO");
  const neg = (num < 0n) !== (den < 0n);
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = a / b;
  const r = a % b;
  const rounded = r * 2n >= b ? q + 1n : q;
  return neg ? -rounded : rounded;
}

export function assertD1SafeInt(valBigInt, label = "amount_minor") {
  if (typeof valBigInt !== "bigint") {
    throw new Error(`INVALID_BIGINT: ${label}`);
  }
  const abs = valBigInt < 0n ? -valBigInt : valBigInt;
  if (abs > MAX_SAFE_BIGINT) {
    throw new Error(`D1_SAFE_INT_OVERFLOW: ${label} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(valBigInt);
}

/**
 * Parses a major-unit monetary string into D1-safe integer minor units for the given currency.
 */
export function parseMoneyToMinor(rawMajor, currencyCode, { allowNegative = false } = {}) {
  const spec = getCurrencySpec(currencyCode);
  const minor = parseDecimalToScaledBigInt(rawMajor, spec.decimals, { allowNegative });
  const maxMinor = MAX_LINE_MAJOR * POW10[spec.decimals];
  const abs = minor < 0n ? -minor : minor;
  if (abs > maxMinor) {
    throw new Error(`AMOUNT_EXCEEDS_MAX_LINE_CAP: ${rawMajor} ${spec.code}`);
  }
  return assertD1SafeInt(minor, "amount_minor");
}

export function formatMinor(minorInt, currencyCode) {
  const spec = getCurrencySpec(currencyCode);
  const m = parseExactSafeIntBigInt(minorInt, "minorInt", { allowNegative: true });
  const neg = m < 0n ? "-" : "";
  const abs = m < 0n ? -m : m;
  if (spec.decimals === 0) return `${neg}${abs.toString()}`;
  const s = abs.toString().padStart(spec.decimals + 1, "0");
  return `${neg}${s.slice(0, -spec.decimals)}.${s.slice(-spec.decimals)}`;
}

/**
 * Calculates line commission in order currency minor units:
 *  - mode = 'pct_of_commissionable': baseMinor * ratePpm / 1,000,000 (ratePpm: 1% = 10000)
 *  - mode = 'fixed_per_unit': qtyDec (scale 4) * unitRateDec (scale 4) -> target currency minor units
 */
export function calculateLineCommissionMinor({
  calcMode,
  currency,
  commissionableMinor = 0,
  ratePpm = 0,
  qtyDec = "0",
  unitRateDec = "0",
  allowNegative = false,
}) {
  const spec = getCurrencySpec(currency);
  if (calcMode === "pct_of_commissionable") {
    const base = parseExactSafeIntBigInt(commissionableMinor, "commissionableMinor", { allowNegative });
    const rateBig = parseExactSafeIntBigInt(ratePpm, "ratePpm", { allowNegative: false });
    if (rateBig > 500000n) {
      throw new Error(`INVALID_RATE_PPM: ${ratePpm}`);
    }
    const res = divRoundHalfUp(base * rateBig, 1000000n);
    return assertD1SafeInt(res, "commission_minor");
  }
  if (calcMode === "fixed_per_unit") {
    const qtyScaled = parseDecimalToScaledBigInt(qtyDec, 4, { allowNegative });
    const rateScaled = parseDecimalToScaledBigInt(unitRateDec, 4, { allowNegative: false });
    const num = qtyScaled * rateScaled * POW10[spec.decimals];
    const den = POW10[8];
    const res = divRoundHalfUp(num, den);
    return assertD1SafeInt(res, "commission_minor");
  }
  throw new Error(`UNSUPPORTED_CALC_MODE: ${calcMode}`);
}

/**
 * ENG02: Exact cross-currency FX conversion accounting for source AND target currency decimal places!
 * fxRateDec expresses: 1 major unit of sourceCurrency = fxRateDec major units of targetCurrency (up to 6 decimals).
 * Formula:
 *   target_minor = round_half_up( source_minor * fx_scaled * 10^dp_target / (10^6 * 10^dp_source) )
 */
export function convertCurrencyMinor({ sourceMinor, sourceCurrency, targetCurrency, fxRateDec }) {
  const srcSpec = getCurrencySpec(sourceCurrency);
  const tgtSpec = getCurrencySpec(targetCurrency);
  const srcBig = parseExactSafeIntBigInt(sourceMinor, "sourceMinor", { allowNegative: true });
  if (srcSpec.code === tgtSpec.code) {
    return assertD1SafeInt(srcBig, "converted_minor");
  }
  const fxScaled = parseDecimalToScaledBigInt(fxRateDec, 6, { allowNegative: false });
  if (fxScaled <= 0n) throw new Error("INVALID_FX_RATE: must be > 0");
  const num = srcBig * fxScaled * POW10[tgtSpec.decimals];
  const den = POW10[6] * POW10[srcSpec.decimals];
  const res = divRoundHalfUp(num, den);
  return assertD1SafeInt(res, "converted_minor");
}

/**
 * ENG02: Deterministic Hamilton Largest-Remainder split for multi-partner commission allocation.
 * Works symmetrically for positive commissions AND negative refund adjustments!
 */
export function splitCommissionLargestRemainder({
  totalCommissionMinor,
  shares = [],
  companyRetainedPpm = 0,
}) {
  const total = parseExactSafeIntBigInt(totalCommissionMinor, "totalCommissionMinor", { allowNegative: true });
  const retainedBig = parseExactSafeIntBigInt(companyRetainedPpm, "companyRetainedPpm", { allowNegative: false });
  if (retainedBig > 1000000n) {
    throw new Error(`INVALID_COMPANY_RETAINED_PPM: ${companyRetainedPpm}`);
  }
  let partnerWeightSum = 0n;
  const parsedShares = [];
  for (const s of shares) {
    if (!s || !s.id) throw new Error("SHARE_ID_REQUIRED");
    const w = parseExactSafeIntBigInt(s.weightPpm, "weightPpm", { allowNegative: false });
    partnerWeightSum += w;
    parsedShares.push({
      id: String(s.id),
      rolePriority: Number.isSafeInteger(Number(s.rolePriority || 0)) ? Number(s.rolePriority || 0) : 0,
      weightPpmBig: w,
      weightPpm: Number(w),
    });
  }
  const totalConfiguredPpm = partnerWeightSum + retainedBig;
  if (totalConfiguredPpm > 1000000n) {
    throw new Error(`SHARE_WEIGHTS_EXCEED_100_PCT: ${totalConfiguredPpm.toString()} ppm`);
  }

  const unallocatedPpm = 1000000n - totalConfiguredPpm;
  const neg = total < 0n;
  const absTotal = neg ? -total : total;

  const buckets = parsedShares.map((s) => ({
    kind: "partner",
    id: s.id,
    rolePriority: s.rolePriority,
    weightPpm: s.weightPpmBig,
  }));
  if (retainedBig > 0n) {
    buckets.push({
      kind: "company_retained",
      id: "__company_retained__",
      rolePriority: -10,
      weightPpm: retainedBig,
    });
  }
  if (unallocatedPpm > 0n) {
    buckets.push({
      kind: "unallocated_pool",
      id: "__unallocated_pool__",
      rolePriority: -20,
      weightPpm: unallocatedPpm,
    });
  }

  let floorSum = 0n;
  const computed = buckets.map((b) => {
    const exactNum = absTotal * b.weightPpm;
    const base = exactNum / 1000000n;
    const rem = exactNum % 1000000n;
    floorSum += base;
    return { ...b, alloc: base, rem };
  });

  let leftover = absTotal - floorSum;
  const ranked = computed.slice().sort((a, b) => {
    if (b.rem !== a.rem) return b.rem > a.rem ? 1 : -1;
    if (b.rolePriority !== a.rolePriority) return b.rolePriority - a.rolePriority;
    if (b.weightPpm !== a.weightPpm) return b.weightPpm > a.weightPpm ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (let i = 0; i < ranked.length && leftover > 0n; i++) {
    ranked[i].alloc += 1n;
    leftover -= 1n;
  }

  const partnerMap = new Map();
  let companyRetainedBig = 0n;
  let unallocatedPoolBig = 0n;
  for (const item of ranked) {
    const signed = neg ? -item.alloc : item.alloc;
    if (item.kind === "partner") partnerMap.set(item.id, signed);
    else if (item.kind === "company_retained") companyRetainedBig = signed;
    else unallocatedPoolBig = signed;
  }

  const allocations = parsedShares.map((s) => ({
    id: s.id,
    weightPpm: s.weightPpm,
    amountMinor: assertD1SafeInt(partnerMap.get(s.id) || 0n, "partner_share_minor"),
  }));
  const companyRetainedMinor = assertD1SafeInt(companyRetainedBig, "company_retained_minor");
  const unallocatedPoolMinor = assertD1SafeInt(unallocatedPoolBig, "unallocated_pool_minor");

  const checkSum =
    allocations.reduce((acc, a) => acc + BigInt(a.amountMinor), 0n) +
    BigInt(companyRetainedMinor) +
    BigInt(unallocatedPoolMinor);
  if (checkSum !== total) {
    throw new Error(`SPLIT_INVARIANT_VIOLATION: expected ${total}, got ${checkSum}`);
  }

  return {
    totalCommissionMinor: assertD1SafeInt(total, "total_commission_minor"),
    allocations,
    companyRetainedMinor,
    unallocatedPoolMinor,
  };
}
