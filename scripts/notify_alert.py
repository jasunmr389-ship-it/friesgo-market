#!/usr/bin/env python3
"""
数据任务异常告警推送（O-01）
=============================
当每日商机更新、月度 Comtrade 拉取校验或政策复核到期检查失败时，自动把告警推送到已配置的
微信测试号模板消息（WX_APP_ID + WX_APP_SECRET + WX_TEMPLATE_ID）、企业微信（WECOM_WEBHOOK）、
飞书（FEISHU_WEBHOOK）、钉钉（DINGTALK_WEBHOOK）、PushPlus 或 WxPusher。

用法：
  python3 scripts/notify_alert.py "标题" "告警详情内容"
"""
import datetime, json, os, re, sys, urllib.parse, urllib.request


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "FriesGo-Alert/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode("utf-8", errors="ignore")


def _post(url, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": "FriesGo-Alert/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode("utf-8", errors="ignore")


def _strip_emoji(s):
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9\s\-\.\$\(\)（）：:、/|，,]", "", str(s or "")).strip()


def main():
    title = sys.argv[1] if len(sys.argv) > 1 else "⚠️ FriesGo 数据巡检告警"
    detail = sys.argv[2] if len(sys.argv) > 2 else "请检查仓库 GitHub Actions 运行日志。"
    repo = os.environ.get("GITHUB_REPOSITORY", "jasunmr389-ship-it/friesgo-market")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    run_url = f"https://github.com/{repo}/actions/runs/{run_id}" if run_id else f"https://github.com/{repo}/actions"
    now_cn = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=8)).strftime("%Y-%m-%d %H:%M 北京时间")
    body = f"{title}\n时间：{now_cn}\n说明：{detail}\n查看日志：{run_url}"

    sent = 0
    # 0. Native Tencent WeChat Official Test Account (reuses existing WX_APP_ID / SECRET / TEMPLATE_ID)
    wx_appid = os.environ.get("WX_APP_ID", "").strip()
    wx_secret = os.environ.get("WX_APP_SECRET", "").strip()
    wx_tpl = os.environ.get("WX_TEMPLATE_ID", "").strip()
    if wx_appid and wx_secret and wx_tpl:
        try:
            tok_url = (
                "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential"
                + "&appid=" + urllib.parse.quote(wx_appid)
                + "&secret=" + urllib.parse.quote(wx_secret)
            )
            access_token = json.loads(_get(tok_url)).get("access_token", "")
            if access_token:
                raw_openids = os.environ.get("WX_OPENIDS", "").strip()
                if raw_openids:
                    openids = [o.strip() for o in raw_openids.split(",") if o.strip()]
                else:
                    usr_data = json.loads(_get(f"https://api.weixin.qq.com/cgi-bin/user/get?access_token={urllib.parse.quote(access_token)}"))
                    openids = (usr_data.get("data") or {}).get("openid") or []
                send_url = f"https://api.weixin.qq.com/cgi-bin/message/template/send?access_token={urllib.parse.quote(access_token)}"
                for oid in openids:
                    payload = {
                        "touser": oid,
                        "template_id": wx_tpl,
                        "url": run_url,
                        "data": {
                            "date": {"value": now_cn},
                            "stats": {"value": _strip_emoji(title)[:32]},
                            "weather": {"value": _strip_emoji(detail)[:40]},
                            "leads": {"value": "点击详情直达 GitHub Actions 查看告警日志"},
                        },
                    }
                    if json.loads(_post(send_url, payload)).get("errcode") == 0:
                        sent += 1
        except Exception as e:
            print(f"[WARN] WeChat Test Account alert failed: {e}")

    wecom = os.environ.get("WECOM_WEBHOOK", "").strip()
    if wecom:
        try:
            _post(wecom, {"msgtype": "text", "text": {"content": body}})
            sent += 1
        except Exception as e:
            print(f"[WARN] WeCom alert failed: {e}")

    feishu = os.environ.get("FEISHU_WEBHOOK", "").strip()
    if feishu:
        try:
            _post(feishu, {"msg_type": "text", "content": {"text": body}})
            sent += 1
        except Exception as e:
            print(f"[WARN] Feishu alert failed: {e}")

    ding = os.environ.get("DINGTALK_WEBHOOK", "").strip()
    if ding:
        try:
            _post(ding, {"msgtype": "text", "text": {"content": body}})
            sent += 1
        except Exception as e:
            print(f"[WARN] DingTalk alert failed: {e}")

    pp = os.environ.get("PUSHPLUS_TOKEN", "").strip()
    if pp:
        try:
            payload = {"token": pp, "title": title, "content": body.replace("\n", "<br>"), "template": "html"}
            topic = os.environ.get("PUSHPLUS_TOPIC", "").strip()
            if topic:
                payload["topic"] = topic
            _post("https://www.pushplus.plus/send", payload)
            sent += 1
        except Exception as e:
            print(f"[WARN] PushPlus alert failed: {e}")

    wxp = os.environ.get("WXPUSHER_APP_TOKEN", "").strip()
    wxp_topic = os.environ.get("WXPUSHER_TOPIC_ID", "").strip()
    if wxp and wxp_topic:
        try:
            _post(
                "https://wxpusher.zjiecode.com/api/send/message",
                {"appToken": wxp, "content": body, "summary": title[:90], "contentType": 1, "topicIds": [int(wxp_topic)]},
            )
            sent += 1
        except Exception as e:
            print(f"[WARN] WxPusher alert failed: {e}")

    print(f"[ALERT] 已向 {sent} 个接收端发送告警通知。")


if __name__ == "__main__":
    main()
