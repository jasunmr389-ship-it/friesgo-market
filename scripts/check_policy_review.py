#!/usr/bin/env python3
"""
政策与准入条目出处及复核期检查脚本
====================================
1. 校验每条政策表述必须具备合法官方 URL（http/https 且无空格）与核查日期 checked。
2. 检查是否超过 reviewBy 复核期限（默认 high=30天, normal=60天, low=90天）。
3. 支持 --sync-js 自动同步生成前端所需的 data/policy_sources.js。

用法：
  python3 scripts/check_policy_review.py [data/policy_sources.json] [--warn-only] [--sync-js]
"""
import datetime, json, os, re, sys

LIMIT = {"high": 30, "normal": 60, "low": 90}


def sync_js(json_path):
    doc = json.load(open(json_path, encoding="utf-8"))
    js_path = os.path.splitext(json_path)[0] + ".js"
    tmp = js_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("window.POLICY_SOURCES_INLINE = " + json.dumps(doc, ensure_ascii=False) + ";\n")
    os.replace(tmp, js_path)
    print(f"已同步生成前端脚本：{js_path}（共 {len(doc.get('items', []))} 条）")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = args[0] if args else "data/policy_sources.json"
    if "--sync-js" in sys.argv:
        sync_js(path)

    doc = json.load(open(path, encoding="utf-8"))
    items = doc.get("items", [])
    today = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=8)).date()
    bad = []
    missing_src = []
    soon = []
    for it in items:
        pid = it.get("id", "?")
        url = str(it.get("url") or "").strip()
        chk = str(it.get("checked") or "").strip()
        if not re.match(r"^https?://\S+$", url) or not re.match(r"^\d{4}-\d{2}-\d{2}$", chk):
            msg = f"[缺官方出处或日期格式无效] {pid}: {it.get('claim', '')[:45]}"
            bad.append(msg)
            missing_src.append(msg)
            continue
        checked = datetime.date.fromisoformat(chk)
        rev_raw = str(it.get("reviewBy") or "").strip()
        review = (
            datetime.date.fromisoformat(rev_raw)
            if rev_raw
            else checked + datetime.timedelta(days=LIMIT.get(it.get("severity", "normal"), 60))
        )
        days_left = (review - today).days
        if days_left < 0:
            bad.append(
                f"[已过复核期 {-days_left} 天 · {it.get('severity', 'normal')}] "
                f"{pid}（{it.get('country', '')}）: {it.get('claim', '')[:48]} → {url}"
            )
        elif days_left <= 7:
            soon.append(
                f"[临期预警：距复核截止仅剩 {days_left} 天 · {it.get('severity', 'normal')}] "
                f"{pid}（{it.get('country', '')}）: {it.get('claim', '')[:48]} (reviewBy={review.isoformat()})"
            )

    print(f"共核查 {len(items)} 条政策/海关数据表述，待处理 {len(bad)} 条，7天内临期 {len(soon)} 条")
    for s in soon:
        print("::warning::" + s)
    for b in bad:
        print("  " + b)

    # 缺官方出处属于零容忍错误，即使 --warn-only 也必须拦截
    if missing_src:
        sys.exit(1)
    if bad and "--warn-only" not in sys.argv:
        sys.exit(1)


if __name__ == "__main__":
    main()
