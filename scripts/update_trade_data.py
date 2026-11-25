#!/usr/bin/env python3
"""
FriesGo Global 市场数据自动拉取、清洗与熔断校验脚本
====================================================
从联合国 UN Comtrade 官方接口拉取各国年度进口数据，经防串行清洗与完整性校验后写入
data/trade_data.json 及 data/trade_data.js（供前端同步加载，失败自动回退内置数据）。

硬规则防毒与校验：
  1. 统计维度锁死：强制限定 partner2Code=0（第二伙伴全球汇总）、customsCode=C00（全海关监管方式）、
     motCode=0（全运输方式），杜绝细分行覆盖总值。
  2. 完整性校验：HS84 与 HS85 缺一则不强算工业品；扣减后若非正数或占比越界直接报错拦截。
  3. 人工覆盖溯源：trade_overrides.json 中任何补充项必须附合法官方 URL 与 YYYY-MM-DD 核查日期。
  4. 发布前 Diff 熔断：对比上一版，缺失国家 >5、同年数值跳变 >15% 或增速突变 >30pp 警告超限即拒绝覆盖（exit 2）。

用法：
  python3 scripts/update_trade_data.py                                      # 全量拉取更新
  python3 scripts/update_trade_data.py --only "Germany,Brazil,Saudi Arabia" --out /tmp/t.json
  python3 scripts/update_trade_data.py --bootstrap-from index.html          # 从已核验页面导出初始基线
"""
import argparse, datetime, json, os, re, subprocess, sys, time, urllib.parse, urllib.request

PREVIEW = "https://comtradeapi.un.org/public/v1/preview/C/A/HS"
KEYED = "https://comtradeapi.un.org/data/v1/get/C/A/HS"
IND_EXCL = ["8471", "8473", "8517", "8518", "8519", "8521", "8525", "8528", "8542"]
STEEL_RAW = ["7201", "7202", "7203", "7204", "7205"]
STEEL_SUB = {
    "s7308": ["7308"],
    "pipe": ["7304", "7305", "7306"],
    "s7216": ["7216"],
    "s7208": ["7208"],
    "s7318": ["7318"],
}
PAGE_LIMIT = 500

MAX_LOST_COUNTRIES = 5
MAX_REVISION_PCT = 15.0
MAX_GROWTH_SHIFT = 30.0
MAX_WARNINGS = 15


def log(*a):
    print(*a, flush=True)


def _http_json(url, key):
    hdrs = {"User-Agent": "FriesGo-Trade-Validator/1.0"}
    if key:
        hdrs["Ocp-Apim-Subscription-Key"] = key
    try:
        req = urllib.request.Request(url, headers=hdrs)
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        # Resilient curl fallback for networks/proxies where Python http.client hits IncompleteRead
        cmd = ["curl", "-sS", "--max-time", "90", "-H", "User-Agent: FriesGo-Trade-Validator/1.0"]
        if key:
            cmd += ["-H", f"Ocp-Apim-Subscription-Key: {key}"]
        cmd.append(url)
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(res.stdout)


def fetch(reporters, period, partner, codes, key):
    """取一批数据；锁定 partner2Code=0 / customsCode=C00 / motCode=0，若触及 500 行上限自动二分重取。"""
    q = {
        "reporterCode": ",".join(map(str, reporters)),
        "period": str(period),
        "partnerCode": str(partner),
        "partner2Code": "0",
        "customsCode": "C00",
        "motCode": "0",
        "cmdCode": ",".join(codes),
        "flowCode": "M",
    }
    url = (KEYED if key else PREVIEW) + "?" + urllib.parse.urlencode(q)
    last = None
    for attempt in range(5):
        try:
            d = _http_json(url, key)
            if d.get("error"):
                raise RuntimeError(d["error"])
            rows = d.get("data") or []
            break
        except Exception as e:
            last = e
            time.sleep(4 * (attempt + 1))
    else:
        raise RuntimeError(f"Comtrade 请求失败 period={period} partner={partner}: {last}")

    time.sleep(1.1 if not key else 0.3)
    if len(rows) >= PAGE_LIMIT and not key:
        if len(reporters) == 1:
            raise RuntimeError(f"单个国家 {reporters[0]} 返回 {len(rows)} 行，超过预览接口上限")
        mid = len(reporters) // 2
        return fetch(reporters[:mid], period, partner, codes, key) + fetch(reporters[mid:], period, partner, codes, key)
    return rows


def pull(ids, years, partner, codes, key):
    per_call = max(1, (PAGE_LIMIT - 20) // len(codes))
    out = []
    for y in years:
        for i in range(0, len(ids), per_call):
            got = fetch(ids[i : i + per_call], y, partner, codes, key)
            log(f"  {y} partner={partner} reporters {i}-{i + per_call - 1}: {len(got)} 行")
            out += got
    return out


def index(rows):
    """严格过滤聚合维度行，防止细分运输方式或特殊监管方式覆盖全国总计。"""
    idx = {}
    for r in rows:
        if r.get("primaryValue") is None:
            continue
        if str(r.get("partner2Code") or 0) not in ("0", "None"):
            continue
        if str(r.get("customsCode") or "C00") not in ("C00", "TOTAL", "None"):
            continue
        if str(r.get("motCode") or 0) not in ("0", "None"):
            continue
        k = (int(r["reporterCode"]), int(r["period"]), str(r["cmdCode"]), int(r["partnerCode"]))
        idx[k] = float(r["primaryValue"]) / 1e6
    return idx


def compute(codes_map, V, years):
    out = {}

    def ind_m(rid, y):
        a, b = V.get((rid, y, "84", 0)), V.get((rid, y, "85", 0))
        if a is None or b is None:
            return None
        val = a + b - sum(V.get((rid, y, k, 0), 0.0) for k in IND_EXCL)
        return val if val > 0 else None

    def steel_m(rid, y, p=0):
        a, b = V.get((rid, y, "72", p)), V.get((rid, y, "73", p))
        if (a is None or b is None) if p == 0 else (a is None and b is None):
            return None
        val = (a or 0.0) + (b or 0.0) - sum(V.get((rid, y, k, p), 0.0) for k in STEEL_RAW)
        return val if val >= 0 else None

    pct = lambda a, b: round((a / b - 1.0) * 100.0, 1) if (a and b and b > 0) else None

    for name, rid in codes_map.items():
        e = {}
        y = next((yy for yy in sorted(years, reverse=True) if ind_m(rid, yy) is not None), None)
        if y:
            v_m = ind_m(rid, y)
            a84 = V.get((rid, y, "84", 0), 0.0)
            a85 = V.get((rid, y, "85", 0), 0.0)
            full_m = a84 + a85
            excl_m = sum(V.get((rid, y, k, 0), 0.0) for k in IND_EXCL)
            prev2 = ind_m(rid, y - 2)
            e["ind"] = {
                "y": y,
                "v": round(v_m / 1000.0, 3),
                "full": round(full_m / 1000.0, 3),
                "excl": round(excl_m / 1000.0, 3),
                "share": round(v_m / full_m * 100.0, 1) if full_m > 0 else None,
                "imp84": round(a84, 1),
                "imp85": round(a85, 1),
                "growth": pct(v_m, prev2),
                "yoy": pct(v_m, ind_m(rid, y - 1)),
                "g84": pct(a84, V.get((rid, y - 2, "84", 0))),
                "gWin": f"{str(y - 2)[-2:]}→{str(y)[-2:]}" if prev2 else None,
            }
        ys = next((yy for yy in sorted(years, reverse=True) if steel_m(rid, yy) is not None), None)
        if ys:
            t = steel_m(rid, ys)
            s_full = (V.get((rid, ys, "72", 0), 0.0) + V.get((rid, ys, "73", 0), 0.0))
            s_raw = sum(V.get((rid, ys, k, 0), 0.0) for k in STEEL_RAW)
            s = {
                "y": ys,
                "t": round(t, 1),
                "full": round(s_full, 1),
                "raw": round(s_raw, 1),
                "g": pct(t, steel_m(rid, ys - 2)),
            }
            for k, cs in STEEL_SUB.items():
                s[k] = round(sum(V.get((rid, ys, c, 0), 0.0) for c in cs), 1)
            if rid != 156:
                cn = steel_m(rid, ys, 156)
                if cn is not None and t > 0:
                    s["cn"] = round(cn, 1)
                    s["cs"] = round(cn / t * 100.0, 1)
            e["steel"] = s
        if e:
            out[name] = e
    return out


def validate(new, old):
    """返回 (errors, warnings)。errors 非空则拒绝发布。"""
    errors, warns = [], []
    if not new:
        errors.append("拉取结果为空（0 个国家）")
        return errors, warns

    for n, e in new.items():
        s = e.get("steel") or {}
        if s.get("cs") is not None and not (0.0 <= s["cs"] <= 100.0):
            errors.append(f"{n}: 钢材中国占比 {s['cs']}% 超出 0–100%")
        if s.get("t") is not None and s["t"] < 0:
            errors.append(f"{n}: 钢材进口额为负数 ({s['t']})")
        ind = e.get("ind") or {}
        if ind.get("v") is not None and ind["v"] <= 0:
            errors.append(f"{n}: 工业品进口额非正数 ({ind['v']})")
        if ind.get("share") is not None and not (0.0 < ind["share"] <= 100.0):
            errors.append(f"{n}: 工业品占机电比重异常 ({ind['share']}%)")

    if not old:
        return errors, warns

    lost = [n for n in old if n not in new]
    if len(lost) > MAX_LOST_COUNTRIES:
        errors.append(f"缺失 {len(lost)} 个上一版已有的国家（上限 {MAX_LOST_COUNTRIES}）：{', '.join(lost[:12])}")
    elif lost:
        warns.append(f"缺失国家：{', '.join(lost)}")

    for n, e in new.items():
        o = old.get(n)
        if not o:
            continue
        for blk, vk, gk in (("ind", "v", "growth"), ("steel", "t", "g")):
            a, b = e.get(blk), o.get(blk)
            if not a or not b:
                continue
            if a["y"] < b["y"]:
                warns.append(f"{n} {blk}: 年份倒退 {b['y']}→{a['y']}")
            elif a["y"] == b["y"]:
                if b.get(vk) and abs(a[vk] / b[vk] - 1.0) * 100.0 > MAX_REVISION_PCT:
                    warns.append(f"{n} {blk}: 同年数值变化 {b[vk]}→{a[vk]}（超过 {MAX_REVISION_PCT}%）")
                if a.get(gk) is not None and b.get(gk) is not None and abs(a[gk] - b[gk]) > MAX_GROWTH_SHIFT:
                    warns.append(f"{n} {blk}: 增速突变 {b[gk]}%→{a[gk]}%")
    return errors, warns


def apply_overrides(data, overrides_path, codes_map, only_mode):
    if not os.path.exists(overrides_path):
        return
    ov_doc = json.load(open(overrides_path, encoding="utf-8"))
    for n, ov in ov_doc.items():
        if n.startswith("_") or (only_mode and n not in codes_map):
            continue
        src = str(ov.get("src") or "").strip()
        chk = str(ov.get("checked") or "").strip()
        if not re.match(r"^https?://\S+$", src) or not re.match(r"^\d{4}-\d{2}-\d{2}$", chk):
            sys.exit(f"[ERROR] 人工覆盖项 {n} 必须包含合法无空格官方链接 src 与 YYYY-MM-DD 核查日期 checked")
        datetime.date.fromisoformat(chk)
        e = data.setdefault(n, {})
        for blk in ("ind", "steel"):
            if blk in ov and isinstance(ov[blk], dict):
                e[blk] = dict(ov[blk], override={"src": src, "checked": chk})


def write_outputs(doc, out_path, js_path):
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    os.replace(tmp, out_path)

    js = js_path or os.path.splitext(out_path)[0] + ".js"
    with open(js + ".tmp", "w", encoding="utf-8") as f:
        f.write("window.TRADE_DATA_INLINE = " + json.dumps(doc, ensure_ascii=False) + ";\n")
    os.replace(js + ".tmp", js)
    return js


def bootstrap_from_html(html_path, out_path, js_path):
    """从当前已核验的 index.html 导出初始 data/trade_data.json 与 .js 基线。"""
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    d_arr = json.loads(re.search(r"var DATA = (\[.*?\]);", html).group(1))
    ind_map = json.loads(re.search(r"var IND = (\{[\s\S]*?\n\});", html).group(1))
    steel_map = json.loads(re.search(r"var STEEL = (\{.*?\});", html).group(1))

    countries = {}
    for row in d_arr:
        c = row["country"]
        if c in ("Taiwan (Other Asia nes)",):
            # 台湾在 Comtrade 无单独申报，保持内置回退或通过 trade_overrides.json 维护
            continue
        im = ind_map.get(c) or {}
        yr = row.get("yr") or im.get("yr") or (2025 if "2025" in str(row.get("flag", "")) else 2024)
        e = {}
        if im.get("ind") is not None:
            e["ind"] = {
                "y": int(yr),
                "v": im["ind"],
                "full": im.get("full"),
                "excl": im.get("excl"),
                "share": im.get("share"),
                "imp84": row.get("imp84"),
                "imp85": row.get("imp85"),
                "growth": row.get("growth"),
                "yoy": row.get("g25"),
                "g84": row.get("g84"),
                "gWin": row.get("gWin"),
            }
            if row.get("gb"):
                e["ind"]["gb"] = row["gb"]
        if c in steel_map:
            e["steel"] = steel_map[c]
        if e:
            countries[c] = e

    yrs = [e["ind"]["y"] for e in countries.values() if e.get("ind")]
    syrs = [e["steel"]["y"] for e in countries.values() if e.get("steel")]
    now = datetime.datetime.now(datetime.timezone.utc)
    doc = {
        "meta": {
            "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "checkedDate": "2026-11-25",
            "source": "UN Comtrade (comtradeapi.un.org)",
            "api": "verified-baseline",
            "scopeInd": "HS84+85 剔除 " + " ".join(IND_EXCL),
            "scopeSteel": "HS72+73 剔除 " + "–".join([STEEL_RAW[0], STEEL_RAW[-1]]),
            "latestYearCounts": {str(y): yrs.count(y) for y in sorted(set(yrs))},
            "steelYearCounts": {str(y): syrs.count(y) for y in sorted(set(syrs))},
            "countries": len(countries),
            "warnings": [],
        },
        "countries": countries,
    }
    js = write_outputs(doc, out_path, js_path)
    log(f"基线导出完成：{len(countries)} 国写入 {out_path} / {js}；工业品年份分布 {doc['meta']['latestYearCounts']}；钢材年份分布 {doc['meta']['steelYearCounts']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--codes", default="data/comtrade_reporters.json")
    ap.add_argument("--out", default="data/trade_data.json")
    ap.add_argument("--js", default=None)
    ap.add_argument("--overrides", default="data/trade_overrides.json")
    ap.add_argument("--only", default="", help="逗号分隔的国家名，用于小样测试")
    ap.add_argument("--latest-year", type=int, default=datetime.date.today().year - 1)
    ap.add_argument("--force", action="store_true", help="忽略警告上限强制发布（错误仍会拦截）")
    ap.add_argument("--bootstrap-from", default="", help="从已核验的 index.html 导出初始基线文件")
    a = ap.parse_args()

    if a.bootstrap_from:
        bootstrap_from_html(a.bootstrap_from, a.out, a.js)
        return

    key = os.environ.get("COMTRADE_KEY", "").strip()
    codes_map = json.load(open(a.codes, encoding="utf-8"))
    # 排除台湾(490, Comtrade 无单独申报)；保留中国(156)用于世界口径进口，自中国进口自动跳过
    codes_map = {k: v for k, v in codes_map.items() if v != 490}
    if a.only:
        want = [s.strip() for s in a.only.split(",") if s.strip()]
        codes_map = {k: v for k, v in codes_map.items() if k in want}
    ids = sorted(set(codes_map.values()))
    ids_non_cn = [rid for rid in ids if rid != 156]
    years = list(range(a.latest_year - 3, a.latest_year + 1))
    log(f"国家 {len(ids)} 个，年份 {years}，接口：{'正式(密钥)' if key else '公开预览'}")

    rows = []
    log("[1/3] 拉取工业品 HS84/85 及消费电子剔除项")
    rows += pull(ids, years, 0, ["84", "85"] + IND_EXCL, key)
    log("[2/3] 拉取钢材 HS72/73（全球进口）")
    rows += pull(ids, years, 0, ["72", "73"] + STEEL_RAW + sum(STEEL_SUB.values(), []), key)
    if ids_non_cn:
        log("[3/3] 拉取钢材 HS72/73（自中国进口）")
        rows += pull(ids_non_cn, years[-2:], 156, ["72", "73"] + STEEL_RAW, key)

    data = compute(codes_map, index(rows), years)
    apply_overrides(data, a.overrides, codes_map, bool(a.only))

    old = {}
    if os.path.exists(a.out):
        try:
            old = json.load(open(a.out, encoding="utf-8")).get("countries", {})
            if a.only:
                old = {k: v for k, v in old.items() if k in codes_map}
        except Exception as e:
            log(f"[WARN] 读取上一版失败，跳过比对：{e}")

    errors, warns = validate(data, old)
    for w in warns:
        log("[WARN]", w)
    if len(warns) > MAX_WARNINGS and not a.force:
        errors.append(f"警告 {len(warns)} 条，超过上限 {MAX_WARNINGS}，需人工核对后加 --force 发布")
    if errors:
        for e in errors:
            log("[ERROR]", e)
        log("熔断拦截：校验未通过，保留上一版数据文件不变。")
        sys.exit(2)

    now = datetime.datetime.now(datetime.timezone.utc)
    yrs = [e["ind"]["y"] for e in data.values() if e.get("ind")]
    syrs = [e["steel"]["y"] for e in data.values() if e.get("steel")]
    doc = {
        "meta": {
            "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "checkedDate": now.strftime("%Y-%m-%d"),
            "source": "UN Comtrade (comtradeapi.un.org)",
            "api": "data/v1 (keyed)" if key else "public/v1/preview",
            "scopeInd": "HS84+85 剔除 " + " ".join(IND_EXCL),
            "scopeSteel": "HS72+73 剔除 " + "–".join([STEEL_RAW[0], STEEL_RAW[-1]]),
            "latestYearCounts": {str(y): yrs.count(y) for y in sorted(set(yrs))},
            "steelYearCounts": {str(y): syrs.count(y) for y in sorted(set(syrs))},
            "countries": len(data),
            "warnings": warns,
        },
        "countries": data,
    }
    js = write_outputs(doc, a.out, a.js)
    log(f"完成：{len(data)} 国写入 {a.out} / {js}；年份分布 {doc['meta']['latestYearCounts']}；警告 {len(warns)} 条")


if __name__ == "__main__":
    main()
