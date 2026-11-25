#!/usr/bin/env python3
"""检查每日商机数据是否按时更新：data/radar_feed.json 的 updatedIso 超过 36 小时即返回非零退出码。"""
import datetime, json, sys

path = sys.argv[1] if len(sys.argv) > 1 else "data/radar_feed.json"
limit_h = float(sys.argv[2]) if len(sys.argv) > 2 else 36.0
feed = json.load(open(path, encoding="utf-8"))
ts = datetime.datetime.strptime(feed["updatedIso"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
age = (datetime.datetime.now(datetime.timezone.utc) - ts).total_seconds() / 3600.0
bad = [k for k, v in (feed.get("sourcesStatus") or {}).items() if not v.get("ok")]
print(
    f"商机数据最后更新：{feed.get('updatedCn')}（距今 {age:.1f} 小时）｜"
    f"AI 中文研判：{'已启用' if feed.get('aiEnriched') else '未生效(原文)'}｜"
    f"异常来源：{bad or '无'}"
)
if age > limit_h:
    print(f"[ERROR] 商机数据已超过 {limit_h:.0f} 小时未更新，请检查 Daily Global Industrial Radar 工作流状态。")
    sys.exit(1)
