// FriesGo Global V3.0 - Exact BigInt Rational Monetary, FX & Largest-Remainder Split Engine (ENG02 / REV04)
// Zero floating-point arithmetic. Validates supported currencies, currency minor-unit decimal places (e.g. JPY=0, USD=2),
// JS Number.MAX_SAFE_INTEGER binding boundaries for Cloudflare D1, and deterministic Hamilton Largest-Remainder splits.

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
 * Parses a strict decimal string (e.g. "18.3750", "-0.0050") into scaled BigInt (value * 10^scale).
 * Rejects scientific notation, NaN, trailing garbage, or excess decimal precision.
 */
export function parseDecimalToScaledBigInt(raw, maxScale, { allowNegative = false } = {}) {
  const s = String(raw === undefined || raw === null ? "" : raw).trim();
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
  const m = BigInt(minorInt);
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
    const base = BigInt(Math.trunc(Number(commissionableMinor)));
    if (!Number.isInteger(ratePpm) || ratePpm < 0 || ratePpm > 500000) {
      throw new Error(`INVALID_RATE_PPM: ${ratePpm}`);
    }
    if (!allowNegative && base < 0n) throw new Error("NEGATIVE_BASE_NOT_ALLOWED");
    const res = divRoundHalfUp(base * BigInt(ratePpm), 1000000n);
    return assertD1SafeInt(res, "commission_minor");
  }
  if (calcMode === "fixed_per_unit") {
    const qtyScaled = parseDecimalToScaledBigInt(qtyDec, 4, { allowNegative });
    const rateScaled = parseDecimalToScaledBigInt(unitRateDec, 4, { allowNegative: false });
    // qtyScaled * rateScaled is scaled by 10^8 in major currency.
    // Convert to minor units (10^dp): multiply by 10^dp, divide by 10^8.
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
 * Example: JPY 1,000 (minor=1000, dp=0) * 0.006700 -> USD (dp=2) = 670 minor ($6.70), NOT $0.07!
 */
export function convertCurrencyMinor({ sourceMinor, sourceCurrency, targetCurrency, fxRateDec }) {
  const srcSpec = getCurrencySpec(sourceCurrency);
  const tgtSpec = getCurrencySpec(targetCurrency);
  const srcBig = BigInt(Math.trunc(Number(sourceMinor)));
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
 * Explicitly separates:
 *   - companyRetainedMinor (pre-agreed company share, if configured in rule)
 *   - partnerAllocations (each partner's exact minor share)
 *   - unallocatedPoolMinor (remainder pool if configured weights sum < 100%)
 * Guarantees: SUM(partnerAllocations) + companyRetainedMinor + unallocatedPoolMinor === totalCommissionMinor
 *
 * Each entry in `shares`: { id: string, rolePriority?: number, weightPpm: number }
 *   where total sum of partner weights + companyRetainedPpm <= 1,000,000 (100%).
 * Deterministic tie-break for identical fractional remainders:
 *   1. Higher rolePriority (e.g. primary_followup > referrer > collaborator)
 *   2. Higher weightPpm
 *   3. Lexicographical id ASC (stable, independent of input order!)
 */
export function splitCommissionLargestRemainder({
  totalCommissionMinor,
  shares = [],
  companyRetainedPpm = 0,
}) {
  const total = BigInt(Math.trunc(Number(totalCommissionMinor)));
  if (!Number.isInteger(companyRetainedPpm) || companyRetainedPpm < 0 || companyRetainedPpm > 1000000) {
    throw new Error(`INVALID_COMPANY_RETAINED_PPM: ${companyRetainedPpm}`);
  }
  let partnerWeightSum = 0;
  for (const s of shares) {
    if (!s || !s.id) throw new Error("SHARE_ID_REQUIRED");
    if (!Number.isInteger(s.weightPpm) || s.weightPpm < 0) {
      throw new Error(`INVALID_SHARE_WEIGHT_PPM: ${s.weightPpm}`);
    }
    partnerWeightSum += s.weightPpm;
  }
  const totalConfiguredPpm = partnerWeightSum + companyRetainedPpm;
  if (totalConfiguredPpm > 1000000) {
    throw new Error(`SHARE_WEIGHTS_EXCEED_100_PCT: ${totalConfiguredPpm} ppm`);
  }

  const unallocatedPpm = 1000000 - totalConfiguredPpm;
  const neg = total < 0n;
  const absTotal = neg ? -total : total;

  // Build unified Hamilton buckets across partners + optional companyRetained + optional unallocatedPool
  const buckets = shares.map((s) => ({
    kind: "partner",
    id: String(s.id),
    rolePriority: Number(s.rolePriority || 0),
    weightPpm: BigInt(s.weightPpm),
  }));
  if (companyRetainedPpm > 0) {
    buckets.push({
      kind: "company_retained",
      id: "__company_retained__",
      rolePriority: -10,
      weightPpm: BigInt(companyRetainedPpm),
    });
  }
  if (unallocatedPpm > 0) {
    buckets.push({
      kind: "unallocated_pool",
      id: "__unallocated_pool__",
      rolePriority: -20,
      weightPpm: BigInt(unallocatedPpm),
    });
  }

  // Exact floor + fractional remainder (num % 1,000,000)
  let floorSum = 0n;
  const computed = buckets.map((b) => {
    const exactNum = absTotal * b.weightPpm;
    const base = exactNum / 1000000n;
    const rem = exactNum % 1000000n;
    floorSum += base;
    return { ...b, alloc: base, rem };
  });

  let leftover = absTotal - floorSum; // guaranteed 0 <= leftover < buckets.length
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

  // Restore original input order for partners & apply sign symmetrically
  const partnerMap = new Map();
  let companyRetainedBig = 0n;
  let unallocatedPoolBig = 0n;
  for (const item of ranked) {
    const signed = neg ? -item.alloc : item.alloc;
    if (item.kind === "partner") partnerMap.set(item.id, signed);
    else if (item.kind === "company_retained") companyRetainedBig = signed;
    else unallocatedPoolBig = signed;
  }

  const allocations = shares.map((s) => ({
    id: String(s.id),
    weightPpm: s.weightPpm,
    amountMinor: assertD1SafeInt(partnerMap.get(String(s.id)) || 0n, "partner_share_minor"),
  }));
  const companyRetainedMinor = assertD1SafeInt(companyRetainedBig, "company_retained_minor");
  const unallocatedPoolMinor = assertD1SafeInt(unallocatedPoolBig, "unallocated_pool_minor");

  // Hard invariant assertion
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
