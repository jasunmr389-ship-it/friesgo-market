#!/usr/bin/env python3
"""
FriesGo Global - Daily Global Industrial Opportunity Radar Fetcher
Runs via GitHub Actions (daily 08:00 Beijing time / 00:00 UTC) or locally.
Zero third-party dependencies (Python 3 standard library only).

Sources:
  1. GDACS Official RSS (Global Tropical Cyclones / Floods / Earthquakes / Droughts)
  2. World Bank Official Projects API v2 (Newly approved global infrastructure/industrial/energy/water/agri/mining loans)
  3. Global Project Financing, EIA/New Factory & Chinese EPC News RSS

Optional Environment Variables (GitHub Secrets):
  - GEMINI_API_KEY       : Free Google AI Studio key for Chinese summaries & B2B angle extraction
  - WXPUSHER_APP_TOKEN   : WxPusher app token for personal WeChat morning brief
  - WXPUSHER_TOPIC_ID    : WxPusher topic ID (all colleagues who scan QR receive brief)
  - PUSHPLUS_TOKEN       : PushPlus token (alternative personal WeChat push)
  - PUSHPLUS_TOPIC       : Optional PushPlus group topic code
  - WECOM_WEBHOOK        : WeCom (企业微信) group bot webhook URL
  - FEISHU_WEBHOOK       : Feishu (飞书) group bot webhook URL
  - DINGTALK_WEBHOOK     : DingTalk (钉钉) group bot webhook URL
"""

import datetime
import html as html_lib
import json
import os
import re
import ssl
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, "data")
JSON_OUT = os.path.join(DATA_DIR, "radar_feed.json")
JS_OUT = os.path.join(DATA_DIR, "radar_feed.js")
SITE_URL = "https://jasunmr389-ship-it.github.io/friesgo-market/#tab=radar"

USER_AGENT = "Mozilla/5.0 (compatible; FriesGoRadarBot/2.0; +https://jasunmr389-ship-it.github.io/friesgo-market/)"

## Country Chinese names & region mapping for global high-potential & emerging markets
COUNTRY_INFO = {
    "Vietnam": ("越南", "东南亚", "vi"),
    "Viet Nam": ("越南", "东南亚", "vi"),
    "Indonesia": ("印度尼西亚", "东南亚", "id"),
    "Thailand": ("泰国", "东南亚", "th"),
    "Philippines": ("菲律宾", "东南亚", "en"),
    "Malaysia": ("马来西亚", "东南亚", "en"),
    "Cambodia": ("柬埔寨", "东南亚", "en"),
    "Myanmar": ("缅甸", "东南亚", "en"),
    "Laos": ("老挝", "东南亚", "en"),
    "Lao PDR": ("老挝", "东南亚", "en"),
    "Singapore": ("新加坡", "东南亚", "en"),
    "Brunei": ("文莱", "东南亚", "en"),
    "Timor-Leste": ("东帝汶", "东南亚", "en"),
    "India": ("印度", "南亚", "en"),
    "Bangladesh": ("孟加拉国", "南亚", "en"),
    "Pakistan": ("巴基斯坦", "南亚", "en"),
    "Sri Lanka": ("斯里兰卡", "南亚", "en"),
    "Nepal": ("尼泊尔", "南亚", "en"),
    "Bhutan": ("不丹", "南亚", "en"),
    "Maldives": ("马尔代夫", "南亚", "en"),
    "Saudi Arabia": ("沙特阿拉伯", "中东", "ar"),
    "United Arab Emirates": ("阿联酋", "中东", "en"),
    "UAE": ("阿联酋", "中东", "en"),
    "Egypt": ("埃及", "中东/北非", "ar"),
    "Iraq": ("伊拉克", "中东", "ar"),
    "Oman": ("阿曼", "中东", "ar"),
    "Qatar": ("卡塔尔", "中东", "ar"),
    "Kuwait": ("科威特", "中东", "ar"),
    "Bahrain": ("巴林", "中东", "ar"),
    "Jordan": ("约旦", "中东", "ar"),
    "Lebanon": ("黎巴嫩", "中东", "ar"),
    "Israel": ("以色列", "中东", "en"),
    "Yemen": ("也门", "中东", "ar"),
    "Morocco": ("摩洛哥", "中东/北非", "fr"),
    "Algeria": ("阿尔及利亚", "中东/北非", "fr"),
    "Tunisia": ("突尼斯", "中东/北非", "fr"),
    "Turkey": ("土耳其", "欧亚", "en"),
    "Türkiye": ("土耳其", "欧亚", "en"),
    "Turkiye": ("土耳其", "欧亚", "en"),
    "Turkish": ("土耳其", "欧亚", "en"),
    "Kazakhstan": ("哈萨克斯坦", "中亚", "ru"),
    "Uzbekistan": ("乌兹别克斯坦", "中亚", "ru"),
    "Kyrgyz Republic": ("吉尔吉斯斯坦", "中亚", "ru"),
    "Kyrgyzstan": ("吉尔吉斯斯坦", "中亚", "ru"),
    "Tajikistan": ("塔吉克斯坦", "中亚", "ru"),
    "Turkmenistan": ("土库曼斯坦", "中亚", "ru"),
    "Mexico": ("墨西哥", "拉美", "es"),
    "Brazil": ("巴西", "拉美", "pt"),
    "Chile": ("智利", "拉美", "es"),
    "Peru": ("秘鲁", "拉美", "es"),
    "Colombia": ("哥伦比亚", "拉美", "es"),
    "Argentina": ("阿根廷", "拉美", "es"),
    "Ecuador": ("厄瓜多尔", "拉美", "es"),
    "Panama": ("巴拿马", "拉美", "es"),
    "Dominican Republic": ("多米尼加", "拉美", "es"),
    "Guatemala": ("危地马拉", "拉美", "es"),
    "Honduras": ("洪都拉斯", "拉美", "es"),
    "Paraguay": ("巴拉圭", "拉美", "es"),
    "Bolivia": ("玻利维亚", "拉美", "es"),
    "Venezuela": ("委内瑞拉", "拉美", "es"),
    "Uruguay": ("乌拉圭", "拉美", "es"),
    "Costa Rica": ("哥斯达黎加", "拉美", "es"),
    "El Salvador": ("萨尔瓦多", "拉美", "es"),
    "Nicaragua": ("尼加拉瓜", "拉美", "es"),
    "Guyana": ("圭亚那", "拉美", "en"),
    "Suriname": ("苏里南", "拉美", "en"),
    "Jamaica": ("牙买加", "拉美", "en"),
    "Trinidad and Tobago": ("特立尼达和多巴哥", "拉美", "en"),
    "Belize": ("伯利兹", "拉美", "en"),
    "Haiti": ("海地", "拉美", "fr"),
    "Nigeria": ("尼日利亚", "非洲", "en"),
    "South Africa": ("南非", "非洲", "en"),
    "Kenya": ("肯尼亚", "非洲", "en"),
    "Ethiopia": ("埃塞俄比亚", "非洲", "en"),
    "Tanzania": ("坦桑尼亚", "非洲", "en"),
    "Ghana": ("加纳", "非洲", "en"),
    "Angola": ("安哥拉", "非洲", "pt"),
    "Mozambique": ("莫桑比克", "非洲", "pt"),
    "Zambia": ("赞比亚", "非洲", "en"),
    "Senegal": ("塞内加尔", "非洲", "fr"),
    "Cote d'Ivoire": ("科特迪瓦", "非洲", "fr"),
    "Côte d'Ivoire": ("科特迪瓦", "非洲", "fr"),
    "Ivory Coast": ("科特迪瓦", "非洲", "fr"),
    "Democratic Republic of the Congo": ("刚果（金）", "非洲", "fr"),
    "Democratic Republic of Congo": ("刚果（金）", "非洲", "fr"),
    "Congo, Democratic Republic of": ("刚果（金）", "非洲", "fr"),
    "Congo, Dem. Rep.": ("刚果（金）", "非洲", "fr"),
    "Dem. Rep. Congo": ("刚果（金）", "非洲", "fr"),
    "DR Congo": ("刚果（金）", "非洲", "fr"),
    "DRC": ("刚果（金）", "非洲", "fr"),
    "Congo Republic": ("刚果（布）", "非洲", "fr"),
    "Republic of Congo": ("刚果（布）", "非洲", "fr"),
    "Republic of the Congo": ("刚果（布）", "非洲", "fr"),
    "Uganda": ("乌干达", "非洲", "en"),
    "Cameroon": ("喀麦隆", "非洲", "fr"),
    "Madagascar": ("马达加斯加", "非洲", "fr"),
    "Rwanda": ("卢旺达", "非洲", "en"),
    "Burundi": ("布隆迪", "非洲", "fr"),
    "Malawi": ("马拉维", "非洲", "en"),
    "Benin": ("贝宁", "非洲", "fr"),
    "Togo": ("多哥", "非洲", "fr"),
    "Mali": ("马里", "非洲", "fr"),
    "Niger": ("尼日尔", "非洲", "fr"),
    "Burkina Faso": ("布基纳法索", "非洲", "fr"),
    "Sierra Leone": ("塞拉利昂", "非洲", "en"),
    "Liberia": ("利比里亚", "非洲", "en"),
    "Mauritania": ("毛里塔尼亚", "非洲", "fr"),
    "Namibia": ("纳米比亚", "非洲", "en"),
    "Botswana": ("博茨瓦纳", "非洲", "en"),
    "Zimbabwe": ("津巴布韦", "非洲", "en"),
    "Gambia": ("冈比亚", "非洲", "en"),
    "Guinea-Bissau": ("几内亚比绍", "非洲", "pt"),
    "Guinea": ("几内亚", "非洲", "fr"),
    "Gabon": ("加蓬", "非洲", "fr"),
    "Chad": ("乍得", "非洲", "fr"),
    "South Sudan": ("南苏丹", "非洲", "en"),
    "Sudan": ("苏丹", "非洲", "ar"),
    "Somalia": ("索马里", "非洲", "en"),
    "Djibouti": ("吉布提", "非洲", "fr"),
    "Mauritius": ("毛里求斯", "非洲", "en"),
    "Lesotho": ("莱索托", "非洲", "en"),
    "Eswatini": ("斯威士兰", "非洲", "en"),
    "Cabo Verde": ("佛得角", "非洲", "pt"),
    "Poland": ("波兰", "欧洲", "en"),
    "Romania": ("罗马尼亚", "欧洲", "en"),
    "Hungary": ("匈牙利", "欧洲", "en"),
    "Serbia": ("塞尔维亚", "欧洲", "en"),
    "Montenegro": ("黑山", "欧洲", "en"),
    "Bosnia and Herzegovina": ("波黑", "欧洲", "en"),
    "North Macedonia": ("北马其顿", "欧洲", "en"),
    "Albania": ("阿尔巴尼亚", "欧洲", "en"),
    "Croatia": ("克罗地亚", "欧洲", "en"),
    "Slovenia": ("斯洛文尼亚", "欧洲", "en"),
    "Bulgaria": ("保加利亚", "欧洲", "en"),
    "Czechia": ("捷克", "欧洲", "en"),
    "Czech Republic": ("捷克", "欧洲", "en"),
    "Slovakia": ("斯洛伐克", "欧洲", "en"),
    "Moldova": ("摩尔多瓦", "欧洲", "en"),
    "Ukraine": ("乌克兰", "欧洲", "en"),
    "Germany": ("德国", "欧洲", "de"),
    "Spain": ("西班牙", "欧洲", "es"),
    "Italy": ("意大利", "欧洲", "en"),
    "France": ("法国", "欧洲", "fr"),
    "Netherlands": ("荷兰", "欧洲", "en"),
    "Belgium": ("比利时", "欧洲", "fr"),
    "Portugal": ("葡萄牙", "欧洲", "pt"),
    "Greece": ("希腊", "欧洲", "en"),
    "Ireland": ("爱尔兰", "欧洲", "en"),
    "Austria": ("奥地利", "欧洲", "de"),
    "Switzerland": ("瑞士", "欧洲", "de"),
    "Sweden": ("瑞典", "欧洲", "en"),
    "Norway": ("挪威", "欧洲", "en"),
    "Denmark": ("丹麦", "欧洲", "en"),
    "Finland": ("芬兰", "欧洲", "en"),
    "Lithuania": ("立陶宛", "欧洲", "en"),
    "Latvia": ("拉脱维亚", "欧洲", "en"),
    "Estonia": ("爱沙尼亚", "欧洲", "en"),
    "Cyprus": ("塞浦路斯", "欧洲", "en"),
    "United Kingdom": ("英国", "欧洲", "en"),
    "United States": ("美国", "北美", "en"),
    "Canada": ("加拿大", "北美", "en"),
    "Australia": ("澳大利亚", "大洋洲", "en"),
    "New Zealand": ("新西兰", "大洋洲", "en"),
    "Papua New Guinea": ("巴布亚新几内亚", "大洋洲", "en"),
    "Fiji": ("斐济", "大洋洲", "en"),
    "Solomon Islands": ("所罗门群岛", "大洋洲", "en"),
    "Vanuatu": ("瓦努阿图", "大洋洲", "en"),
    "Samoa": ("萨摩亚", "大洋洲", "en"),
    "Kiribati": ("基里巴斯", "大洋洲", "en"),
    "Japan": ("日本", "东亚", "en"),
    "South Korea": ("韩国", "东亚", "en"),
    "Mongolia": ("蒙古", "东亚", "en"),
    "Azerbaijan": ("阿塞拜疆", "中亚", "ru"),
    "Georgia": ("格鲁吉亚", "欧亚", "en"),
    "Armenia": ("亚美尼亚", "欧亚", "ru"),
}

# Canonical country names matching index.html DATA.country
CANONICAL_COUNTRY = {
    "Viet Nam": "Vietnam",
    "UAE": "United Arab Emirates",
    "Turkey": "Turkey (Türkiye)",
    "Türkiye": "Turkey (Türkiye)",
    "Turkiye": "Turkey (Türkiye)",
    "Turkish": "Turkey (Türkiye)",
    "Lao PDR": "Laos",
    "Kyrgyzstan": "Kyrgyz Republic",
    "Czech Republic": "Czechia",
    "Democratic Republic of Congo": "Democratic Republic of the Congo",
    "Congo, Democratic Republic of": "Democratic Republic of the Congo",
    "Congo, Dem. Rep.": "Democratic Republic of the Congo",
    "Dem. Rep. Congo": "Democratic Republic of the Congo",
    "DR Congo": "Democratic Republic of the Congo",
    "DRC": "Democratic Republic of the Congo",
    "Republic of Congo": "Congo Republic",
    "Republic of the Congo": "Congo Republic",
    "Congo, Republic of": "Congo Republic",
    "Gambia, The": "Gambia",
    "The Gambia": "Gambia",
    "Côte d'Ivoire": "Cote d'Ivoire",
    "Ivory Coast": "Cote d'Ivoire",
    "Egypt, Arab Republic of": "Egypt",
    "Arab Republic of Egypt": "Egypt",
    "Republic of Indonesia": "Indonesia",
    "Federal Republic of Nigeria": "Nigeria",
    "Kingdom of Saudi Arabia": "Saudi Arabia",
    "United Mexican States": "Mexico",
    "Federative Republic of Brazil": "Brazil",
    "Republic of the Philippines": "Philippines",
    "Republic of Peru": "Peru",
    "Republic of Colombia": "Colombia",
    "Republic of Kenya": "Kenya",
    "United Republic of Tanzania": "Tanzania",
    "Republic of Zambia": "Zambia",
    "Republic of India": "India",
    "People's Republic of Bangladesh": "Bangladesh",
    "Islamic Republic of Pakistan": "Pakistan",
    "Republic of Korea": "South Korea",
    "Slovak Republic": "Slovakia",
    "Dubai": "United Arab Emirates",
    "Abu Dhabi": "United Arab Emirates",
    "Sharjah": "United Arab Emirates",
    "Emirati": "United Arab Emirates",
    "Riyadh": "Saudi Arabia",
    "Jeddah": "Saudi Arabia",
    "Dammam": "Saudi Arabia",
    "Saudi": "Saudi Arabia",
    "Monterrey": "Mexico",
    "Mexican": "Mexico",
    "Ho Chi Minh": "Vietnam",
    "Hanoi": "Vietnam",
    "Vietnamese": "Vietnam",
    "Jakarta": "Indonesia",
    "Indonesian": "Indonesia",
    "Brazilian": "Brazil",
    "Egyptian": "Egypt",
    "Cairo": "Egypt",
    "Nigerian": "Nigeria",
    "Lagos": "Nigeria",
    "Moroccan": "Morocco",
    "Casablanca": "Morocco",
    "South African": "South Africa",
    "Johannesburg": "South Africa",
    "Indian": "India",
    "Uzbek": "Uzbekistan",
    "Tashkent": "Uzbekistan",
    "Kazakh": "Kazakhstan",
    "Almaty": "Kazakhstan",
}

COUNTRY_INFO.update({
    "Cameroon": ("喀麦隆", "非洲", "fr"),
    "Tuvalu": ("图瓦卢", "大洋洲", "en"),
    "West Bank and Gaza": ("巴勒斯坦地区", "中东", "ar"),
    "Congo Republic": ("刚果（布）", "非洲", "fr"),
    "Democratic Republic of the Congo": ("刚果（金）", "非洲", "fr"),
})
for _alias, _canon in list(CANONICAL_COUNTRY.items()):
    if _canon in COUNTRY_INFO and _alias not in COUNTRY_INFO:
        COUNTRY_INFO[_alias] = COUNTRY_INFO[_canon]

# Precompile word-boundary patterns sorted longest-first to avoid substring collisions (e.g. Romania vs Oman, Nigeria vs Niger)
_COUNTRY_PATTERNS = [
    (key, re.compile(r"(?<![A-Za-z])" + re.escape(key) + r"(?![A-Za-z])", re.I), info)
    for key, info in sorted(COUNTRY_INFO.items(), key=lambda kv: -len(kv[0]))
]

# Industrial sector keywords -> FriesGo recommended bundle (specific verticals BEFORE generic factory/infra)
PRODUCT_RULES = [
    (
        r"mining|nickel|copper|lithium|smelter|mineral|oil|gas|refinery|petrochemical|矿山|冶炼|油气",
        "矿用渣浆泵、高压油气阀门、耐磨管件 & 矿用电缆",
        "mining slurry pumps, high-pressure valves, wear-resistant pipes & mining cables",
    ),
    (
        r"power|energy|solar|photovoltaic|wind|grid|substation|electric|transmission|battery|generator|electricity|transformer|switchgear|electrification|solaire|电力|电站|光伏|电网|储能",
        "电力电缆、配电变压器、开关柜 & 柴油发电机组",
        "power cables, distribution transformers, switchgear & backup diesel generators",
    ),
    (
        r"water|sanitation|sewage|desalination|pipeline|pipe|flood|drainage|dam|irrigation|hydropower|borehole|reservoir|pump|valve|eau|pompe|agua|bomba|供水|水务|排水|灌溉",
        "工业阀门、离心/排涝水泵、管道法兰 & 控制柜",
        "industrial waterworks valves, heavy-duty pumps, pipe fittings & control panels",
    ),
    (
        r"agricult|farm|food|grain|livestock|cold storage|fisheries|rural|drought|tractor|农业|农机|冷链|粮仓",
        "农业机械、光伏/柴油灌溉泵、钢构粮仓/冷库 & 维修工具",
        "agricultural machinery, irrigation pumps, cold-storage steel structures & tools",
    ),
    (
        r"steel|warehouse|factory|industrial park|manufacturing|roof|structural|cyclone|typhoon|hurricane|earthquake|reconstruction|shelter|acero|钢结构|厂房|工业园|建材",
        "钢结构厂房、彩钢瓦、高强紧固件 & 厂房机电",
        "prefabricated steel structures, structural fasteners & factory MEP equipment",
    ),
    (
        r"port|transport|road|rail|bridge|airport|logistics|highway|infrastructure|corridor|urban|civil works|travaux|港口|铁路|基建|物流",
        "基建钢结构、施工机电、工业泵阀、照明电缆 & 五金工具",
        "steel structures, construction hardware, industrial pumps/valves & power cables",
    ),
]


def http_get(url, timeout=25, headers=None):
    import subprocess
    hdrs = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    if headers:
        hdrs.update(headers)
    ctx = ssl.create_default_context()
    last_err = None
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                raw = resp.read()
                if raw:
                    return raw.decode("utf-8", errors="replace")
        except Exception as e:
            last_err = e
    # Fallback to system curl (rock-solid HTTP/2 & chunked handling on Ubuntu Actions & macOS)
    try:
        cmd = ["curl", "-sSL", "--retry", "2", "--max-time", str(timeout), "-A", USER_AGENT, url]
        raw = subprocess.check_output(cmd, stderr=subprocess.DEVNULL)
        if raw:
            return raw.decode("utf-8", errors="replace")
    except Exception as e2:
        last_err = e2
    raise last_err


def http_post_json(url, payload, timeout=20, headers=None):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    hdrs = {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json; charset=utf-8",
    }
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return resp.read().decode("utf-8", errors="replace")


def clean_text(s):
    if not s:
        return ""
    s = html_lib.unescape(str(s))
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def normalize_country(raw):
    if not raw:
        return "", "", "全球", "en"
    raw_clean = clean_text(raw)
    if raw_clean in CANONICAL_COUNTRY:
        c = CANONICAL_COUNTRY[raw_clean]
        if c in COUNTRY_INFO:
            cn, reg, lang = COUNTRY_INFO[c]
            return c, cn, reg, lang
    # Multi-country comma lists (e.g. GDACS regional droughts): prefer major export markets over alphabetical micro-countries
    if "," in raw_clean:
        parts = [p.strip() for p in raw_clean.split(",") if p.strip()]
        if len(parts) >= 5:
            priority_markets = (
                "Vietnam", "Indonesia", "Thailand", "Philippines", "India", "Saudi Arabia",
                "United Arab Emirates", "Egypt", "Mexico", "Brazil", "Chile", "Peru", "Colombia",
                "Argentina", "Nigeria", "South Africa", "Kenya", "Tanzania", "Ethiopia", "Morocco",
                "Algeria", "Turkey (Türkiye)", "Poland", "Romania", "Spain", "Germany", "United States",
            )
            parsed_parts = []
            for p in parts:
                c_p = CANONICAL_COUNTRY.get(p, p)
                if c_p in COUNTRY_INFO:
                    parsed_parts.append((c_p, COUNTRY_INFO[c_p]))
            for pm in priority_markets:
                for c_p, (cn, reg, lang) in parsed_parts:
                    if c_p == pm:
                        return c_p, f"{cn}等{len(parts)}国", reg, lang
            if parsed_parts:
                c_p, (cn, reg, lang) = parsed_parts[0]
                return c_p, f"{cn}等{len(parts)}国", reg, lang
    # Strict word-boundary English match (longest key first)
    for key, pat, (cn, reg, lang) in _COUNTRY_PATTERNS:
        if pat.search(raw_clean):
            canon = CANONICAL_COUNTRY.get(key, key)
            return canon, cn, reg, lang
    # Check Chinese country mentions
    for key, (cn, reg, lang) in COUNTRY_INFO.items():
        if cn and cn in raw_clean:
            canon = CANONICAL_COUNTRY.get(key, key)
            return canon, cn, reg, lang
    return raw_clean, raw_clean, "其他", "en"


def match_products(text):
    t = (text or "").lower()
    for pat, cn_rec, en_rec in PRODUCT_RULES:
        if re.search(pat, t, re.I):
            return cn_rec, en_rec
    return (
        "工业泵阀、电力电缆、钢结构与工业五金配套",
        "industrial valves, pumps, power cables & structural hardware",
    )


def fetch_gdacs():
    """Fetch live global disaster/typhoon/flood/drought alerts from GDACS RSS."""
    items = []
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    try:
        xml_text = http_get("https://www.gdacs.org/xml/rss.xml", timeout=20)
        root = ET.fromstring(xml_text)
        ns = {
            "gdacs": "http://www.gdacs.org",
            "geo": "http://www.w3.org/2003/01/geo/wgs84_pos#",
        }
        type_cn = {
            "TC": "🌀 热带气旋 / 台风",
            "FL": "🌊 洪涝灾害",
            "EQ": "🌋 强震预警",
            "DR": "☀️ 干旱预警",
            "VO": "🌋 火山",
            "WF": "🔥 山火预警",
            "PW": "⚡ 电网限电/能源危机",
        }
        level_rank = {"Red": 0, "Orange": 1, "Green": 2}
        level_cn = {"Red": "🔴 红色高危", "Orange": "🟠 橙色预警", "Green": "🟢 常规关注"}
        skip_green_micro = {"Cook Islands", "Kiribati", "Tonga", "Niue", "Tuvalu", "Nauru"}

        for it in root.findall("./channel/item"):
            title = clean_text(it.findtext("title"))
            link = clean_text(it.findtext("link"))
            desc = clean_text(it.findtext("description"))
            pub = clean_text(it.findtext("pubDate"))
            ev_type = clean_text(it.findtext("gdacs:eventtype", "", ns)) or "TC"
            alert = clean_text(it.findtext("gdacs:alertlevel", "", ns)) or "Green"
            country_raw = clean_text(it.findtext("gdacs:country", "", ns))
            pop_raw = clean_text(it.findtext("gdacs:population", "", ns))

            # Parse earthquake magnitude if EQ
            eq_mag = 0.0
            if ev_type == "EQ":
                m_mag = re.search(r"\bM\s*(\d+(?:\.\d+)?)\b|Magnitude\s*(\d+(?:\.\d+)?)", title + " " + desc, re.I)
                if m_mag:
                    try:
                        eq_mag = float(m_mag.group(1) or m_mag.group(2))
                    except Exception:
                        eq_mag = 0.0

            # Keep TC/FL/DR, Red/Orange WF/EQ, and populated >=6.0M earthquakes; drop minor noise
            if alert == "Green":
                if ev_type == "EQ":
                    if eq_mag < 6.0:
                        continue
                elif ev_type not in ("TC", "FL", "DR"):
                    continue

            # Parse date cleanly and skip stale alerts (>180d for droughts, >35d for green alerts, >21d for EQ)
            date_str = ""
            age_days = 0
            try:
                dt = datetime.datetime.strptime(pub[:25].strip(), "%a, %d %b %Y %H:%M:%S").replace(tzinfo=datetime.timezone.utc)
                date_str = dt.strftime("%Y-%m-%d")
                age_days = (now_utc - dt).days
            except Exception:
                date_str = pub[:16]
            if ev_type == "DR" and age_days > 180:
                continue
            if ev_type == "EQ" and age_days > 21:
                continue
            if alert == "Green" and age_days > 35:
                continue

            c_en, c_cn, reg, lang = normalize_country(country_raw or title)
            # Filter out unpopulated ocean/micro-island noise
            if alert == "Green":
                if c_en in skip_green_micro or reg == "其他":
                    continue
                if re.search(r"\b0\s+people\b|\baffected\s+population\s+is\s+0\b|\boff\s+the\s+coast\b|\bsea\b", desc + " " + pop_raw, re.I):
                    continue

            if ev_type == "TC":
                rec_cn = "抗风钢结构厂房、彩钢瓦、高强紧固件、排水泵、应急柴油发电机"
                rec_en = "wind-resistant steel structures, metal roofing, structural bolts, dewatering pumps & emergency generators"
                win_lbl = "灾后 2–8 周 · 钢构/建材批发商补库 & 园区修缮"
                map_q = "steel structure roofing building materials distributor"
                angle = "台风/飓风路径区：优先对接当地大型建材批发商与钢构工程商（补库+厂房修复），警惕受灾小厂现金流风险"
            elif ev_type == "FL":
                rec_cn = "大流量排涝水泵、球墨阀门、防水电力电缆、应急发电机"
                rec_en = "high-flow dewatering pumps, industrial valves, waterproof cables & diesel generators"
                win_lbl = "灾后 2–6 周 · 市政排涝总包 & 泵阀批发商补库"
                map_q = "water pump industrial valve distributor"
                angle = "洪涝受损区：重点跟进当地大型泵阀批发商补库、市政排涝工程与工业园恢复供电急单"
            elif ev_type == "EQ":
                rec_cn = "快装预制钢结构/活动板房、抗震紧固件、供水/燃气钢管与阀门、抢修五金"
                rec_en = "prefabricated steel structures, seismic fasteners, water/gas pipes & valves, repair hardware"
                win_lbl = "灾后 2–8 周 · 政府/保险重建总包 & 建材批发商补库"
                map_q = "steel structure construction contractor building materials"
                angle = "强震重建刚需：对接当地大型建材/钢构批发商、市政水务管道承包商及政府/世行重建总包"
            elif ev_type == "DR":
                rec_cn = "深井/光伏灌溉水泵、喷灌阀门管件、储水钢罐 & 农机设备"
                rec_en = "deep-well solar/diesel irrigation pumps, agricultural valves, water storage tanks & farm equipment"
                win_lbl = "旱季持续窗口 · 农机/水务经销商与农场灌溉采购"
                map_q = "irrigation pump agricultural equipment distributor"
                angle = "干旱农区：切入当地农机/水泵大经销商、大型种植园打井提水、光伏灌溉水泵与输水管件刚需"
            elif ev_type == "WF":
                rec_cn = "电力电缆、消防水泵阀门、预制钢结构厂房与五金工具"
                rec_en = "power cables, fire pumps & valves, prefabricated steel structures & hardware"
                win_lbl = "灾后 2–8 周 · 电网抢修与农牧/厂房重建"
                map_q = "electrical cable fire pump contractor"
                angle = "山火灾后重建：切入受灾区域输电线路修复、消防管网与钢构仓储重建工程商"
            else:
                rec_cn = "快装预制钢结构、应急发电机、水泵阀门与建筑五金"
                rec_en = "prefabricated steel structures, emergency generators, water pumps & construction hardware"
                win_lbl = "灾后 2–8 周 · 重建总包与批发商补库"
                map_q = "industrial hardware steel structure distributor"
                angle = "灾后重建刚需：对接当地大型基建承包商、批发商与政府/保险理赔修缮项目"

            safe_link = (link or "https://www.gdacs.org/").replace("http://", "https://")
            today_str = now_utc.strftime("%Y-%m-%d")
            mag_tag = f" M{eq_mag:.1f}" if (ev_type == "EQ" and eq_mag > 0) else ""
            item_obj = {
                "id": f"gdacs_{len(items)}_{ev_type}",
                "cat": "weather",
                "hazardType": ev_type,
                "catLabel": type_cn.get(ev_type, "⚠️ 灾害预警"),
                "severity": alert,
                "severityLabel": level_cn.get(alert, alert),
                "windowLabel": win_lbl,
                "mapQuery": map_q,
                "_rank": (level_rank.get(alert, 9), {"TC": 0, "EQ": 1, "FL": 2, "WF": 3, "DR": 4}.get(ev_type, 5)),
                "country": c_en or "Global",
                "countryCn": c_cn or "全球多国",
                "region": reg,
                "lang": lang,
                "date": date_str,
                "startDate": date_str,
                "lastSeenDate": today_str if ev_type == "DR" else date_str,
                "ongoing": bool(ev_type == "DR" and age_days > 14),
                "title": title,
                "titleCn": f"{level_cn.get(alert, '')} {type_cn.get(ev_type, '')}{mag_tag}：{c_cn or country_raw or title}",
                "summary": desc[:220],
                "amount": "",
                "entity": "",
                "productsCn": rec_cn,
                "productsEn": rec_en,
                "angleCn": angle,
                "source": "GDACS 国际灾害预警",
                "url": safe_link,
            }
            items.append(item_obj)

        # Also pull fresh global power-grid crisis / blackout / load-shedding signals (hazardType="PW")
        try:
            pw_url = (
                "https://news.google.com/rss/search?q="
                + urllib.parse.quote(
                    '("power outage" OR "blackout" OR "load shedding" OR "power shortage" OR "grid collapse" OR "electricity rationing") '
                    '(Vietnam OR Indonesia OR Mexico OR "South Africa" OR Nigeria OR Pakistan OR Egypt OR Brazil OR Philippines OR India OR Iraq OR Chile OR Ecuador OR Kenya OR Zambia OR Bangladesh OR Argentina) when:14d'
                )
                + "&hl=en-US&gl=US&ceid=US:en"
            )
            pw_xml = http_get(pw_url, timeout=14)
            pw_root = ET.fromstring(pw_xml)
            pw_seen = set()
            pw_country_cnt = {}
            pw_neg_re = re.compile(
                r"\b(no\s+load\s*shedding|load\s*shedding[\s-]*free|without\s+load\s*shedding|"
                r"celebrat\w+|anniversary|ends?\s+blackout|no\s+blackout|zero\s+load\s*shedding|"
                r"movie|film|album|concert|game|sports|soccer|football|cricket)\b",
                re.I,
            )
            pw_cnt = 0
            for pit in pw_root.findall("./channel/item"):
                raw_t = clean_text(pit.findtext("title"))
                p_link = clean_text(pit.findtext("link"))
                p_pub = clean_text(pit.findtext("pubDate"))
                p_src = clean_text(pit.findtext("source")) or "全球能源/电网快讯"
                if not raw_t:
                    continue
                p_title = re.sub(r"\s+-\s+[^-]{2,45}$", "", raw_t).strip() or raw_t
                if _is_spam_news(p_title, p_src, p_link) or pw_neg_re.search(p_title):
                    continue
                dk = _news_dedup_key(p_title)
                if dk in pw_seen:
                    continue
                p_date, p_age = "", 0
                try:
                    pdt = datetime.datetime.strptime(p_pub[:25].strip(), "%a, %d %b %Y %H:%M:%S").replace(tzinfo=datetime.timezone.utc)
                    p_date = pdt.strftime("%Y-%m-%d")
                    p_age = max(0, (now_utc - pdt).days)
                except Exception:
                    p_date = p_pub[:16]
                if p_age > 14:
                    continue
                pc_en, pc_cn, p_reg, p_lang = normalize_country(p_title)
                if p_reg == "其他":
                    continue
                if pw_country_cnt.get(pc_en, 0) >= 2:
                    continue
                pw_country_cnt[pc_en] = pw_country_cnt.get(pc_en, 0) + 1
                pw_seen.add(dk)
                items.append({
                    "id": f"pw_{pw_cnt}",
                    "cat": "weather",
                    "hazardType": "PW",
                    "catLabel": "⚡ 电网限电/能源危机",
                    "severity": "Orange",
                    "severityLabel": "⚡ 限电/电网信号",
                    "windowLabel": "应急备电 & 工业园电缆/配电补库",
                    "mapQuery": "electrical cable diesel generator distributor",
                    "_rank": (1, 2),
                    "country": pc_en,
                    "countryCn": pc_cn,
                    "region": p_reg,
                    "lang": p_lang,
                    "date": p_date,
                    "ageDays": p_age,
                    "title": p_title,
                    "titleCn": f"【{pc_cn}】{p_title}",
                    "summary": f"来源：{p_src}",
                    "amount": "",
                    "entity": "",
                    "productsCn": "电力电缆、柴油/燃气发电机、配电稳压设备、工业风机、光伏支架钢构",
                    "productsEn": "power cables, diesel generators, switchgear & voltage stabilizers, industrial fans, solar steel mounting",
                    "angleCn": "电网限电/能源缺口：切入当地电力工程安装商、工业园区物业与备电/电缆批发商补库急单",
                    "source": p_src,
                    "url": p_link,
                })
                pw_cnt += 1
                if pw_cnt >= 4:
                    break
        except Exception as e_pw:
            print(f"[WARN] Power-crisis RSS optional fetch failed: {e_pw}")

        items.sort(key=lambda x: (x["_rank"][0], x["_rank"][1], -(int(x["date"].replace("-", "")[:8]) if re.match(r"^\d{4}-\d{2}-\d{2}$", x["date"]) else 0)))
        for x in items:
            x.pop("_rank", None)
        return items[:14], True, ""
    except Exception as e:
        print(f"[WARN] GDACS fetch failed: {e}")
        return [], False, str(e)[:180]


def _parse_wb_date(s):
    s = clean_text(s)
    if not s:
        return ""
    if re.match(r"^\d{4}-\d{2}-\d{2}", s):
        return s[:10]
    for fmt in ("%d-%b-%Y", "%b %d, %Y", "%d %B %Y", "%B %d, %Y", "%d %b %Y", "%Y/%m/%d"):
        try:
            return datetime.datetime.strptime(s[:24].strip(), fmt).strftime("%Y-%m-%d")
        except Exception:
            pass
    return s[:10]


def _extract_wb_orig_date(notice_html):
    """Extract original issue date from World Bank notice_text body to flag re-posted old notices (R-08)."""
    if not notice_html:
        return ""
    plain = re.sub(r"<[^>]+>", " ", str(notice_html)[:1800])
    plain = re.sub(r"\s+", " ", plain).strip()
    patterns = [
        r"\b(?:Date|Dated|Fecha)\s*[:\-]\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+20\d{2})",
        r"\b(?:Date|Dated|Fecha)\s*[:\-]\s*([A-Za-z]{3,9}\s+\d{1,2},\s*20\d{2})",
        r"\b(?:Date|Dated|Fecha)\s*[:\-]\s*(20\d{2}-\d{2}-\d{2})",
        r"\b(?:Date|Dated|Fecha)\s*[:\-]\s*(\d{1,2}[/-]\d{1,2}[/-]20\d{2})",
    ]
    for pat in patterns:
        m = re.search(pat, plain, re.I)
        if not m:
            continue
        raw_d = m.group(1).strip()
        for fmt in ("%d %B %Y", "%d %b %Y", "%B %d, %Y", "%b %d, %Y", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y"):
            try:
                return datetime.datetime.strptime(raw_d, fmt).strftime("%Y-%m-%d")
            except Exception:
                pass
    return ""


def _today_cn():
    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=8)).strftime("%Y-%m-%d")


def fetch_worldbank():
    """Fetch LIVE World Bank equipment/infrastructure procurement notices (IFB/GPN/Contract Awards) from v2/procnotices API."""
    items = []
    seen = set()
    agency_counts = {}
    last_err = ""

    include_kw = re.compile(
        r"pump|valve|pipe|pipeline|water\s*supply|wastewater|sewage|drainage|irrigat|borehole|reservoir|"
        r"solar|photovoltaic|power|substation|transformer|switchgear|cable|grid|transmission|generator|electrific|"
        r"steel|bridge|port|warehouse|factory|machinery|tractor|agricult|cold\s*storage|hydropower|"
        r"industrial|mining|plant|equipment|civil\s*works|distribution\s*network|water\s*treatment|"
        r"fourniture|solaire|pompe|eau|réseau|équipement|électri|acero|agua|bomba|energía",
        re.I,
    )
    exclude_kw = re.compile(
        r"consultan|advisory|audit|training|workshop|software|computer|laptop|printer|server|it\s+equipment|"
        r"furniture|stationery|sedan|suv|passenger\s+vehicle|ambulance|medical|hospital|pharmaceut|vaccine|"
        r"clinical|laboratory\s+reagent|school\s+book|literacy|higher\s+education|nutrition|film|animation|"
        r"muck|silt|debris|janitor|cleaning|catering|security\s+guard|legal\s+service|accounting|printing|"
        r"public\s+relations|communication|supports?\s+de\s+communication|recruitment|study\s+tour|curriculum|"
        r"periodic(?:al)?\s+(?:renewal|maintenance)|pothole|resurfacing|pav[ée]",
        re.I,
    )

    notice_badges = {
        "Invitation for Bids": ("公开招标", "High"),
        "Invitation for Prequalification": ("资格预审", "High"),
        "General Procurement Notice": ("采购总公告", "High"),
        "Contract Award": ("已授标·找总包", "Normal"),
    }

    urls = [
        "https://search.worldbank.org/api/v2/procnotices?format=json&rows=160&notice_type=Invitation%20for%20Bids&srt=noticedate&order=desc",
        "https://search.worldbank.org/api/v2/procnotices?format=json&rows=160&srt=noticedate&order=desc",
    ]
    for url in urls:
        try:
            raw = http_get(url, timeout=25)
            data = json.loads(raw)
            notices = data.get("procnotices") or []
            if isinstance(notices, dict):
                notices = list(notices.values())
            for n in notices:
                if not isinstance(n, dict):
                    continue
                nid = clean_text(n.get("id"))
                if not nid or nid in seen:
                    continue
                ntype = clean_text(n.get("notice_type"))
                if ntype not in notice_badges:
                    continue
                desc = clean_text(n.get("bid_description"))
                pname = clean_text(n.get("project_name"))
                combined = f"{desc} {pname}".strip()
                if not combined:
                    continue
                # Match industrial keywords primarily in bid_description (or pname if desc is short)
                match_text = desc if len(desc) >= 24 else combined
                if exclude_kw.search(combined):
                    continue
                if not include_kw.search(match_text):
                    continue

                c_raw = clean_text(n.get("project_ctry_name") or n.get("contact_ctry_name") or "")
                c_en, c_cn, reg, lang = normalize_country(c_raw or pname)
                if not c_en or c_en.lower() in ("world", "africa", "western and central africa", "eastern and southern africa"):
                    c_en = c_raw or "Global"
                    c_cn = c_cn or c_en

                org = clean_text(n.get("contact_organization") or "")
                # Cap max 2 notices per (country, agency) so one road dept doesn't flood the board
                ag_key = (c_en.lower(), (org or pname[:30]).lower())
                if agency_counts.get(ag_key, 0) >= 2:
                    continue
                agency_counts[ag_key] = agency_counts.get(ag_key, 0) + 1
                seen.add(nid)

                date_str = _parse_wb_date(n.get("noticedate") or n.get("submission_date"))
                deadline = _parse_wb_date(n.get("submission_deadline_date"))
                # 整改：已过截标日的招标不再进入商机列表
                if deadline and deadline < _today_cn():
                    continue
                orig_date = _extract_wb_orig_date(n.get("notice_text") or "")
                reposted = False
                if orig_date and date_str and re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
                    try:
                        d_pub = datetime.date.fromisoformat(date_str)
                        d_orig = datetime.date.fromisoformat(orig_date)
                        if (d_pub - d_orig).days >= 365:
                            reposted = True
                    except Exception:
                        pass

                proc_group = clean_text(n.get("procurement_group") or "")
                email = clean_text(n.get("contact_email") or "")
                phone = clean_text(n.get("contact_phone_no") or "")
                pid = clean_text(n.get("project_id") or "")

                if len(org) > 85:
                    org = org[:82] + "..."

                title_show = desc if len(desc) >= 18 else (pname or desc)
                if len(title_show) > 135:
                    title_show = title_show[:132] + "..."

                prod_cn, prod_en = match_products(combined)
                badge_lbl, sev = notice_badges[ntype]
                sev_lbl = badge_lbl

                if proc_group == "CW":
                    angle = f"土建工程总包招标，工厂一般不能直接投标：跟踪投标或中标的承包商，争取分包供货（{prod_cn}）"
                elif ntype == "Contract Award":
                    angle = f"已授标公告：核查中标总包商，联系其采购部门争取二级设备/材料供货（{prod_cn}）"
                elif ntype == "General Procurement Notice":
                    angle = f"项目采购计划总公告，正式招标尚未开始：先联系业主或当地代理，提前进入供应商短名单（{prod_cn}）"
                elif ntype == "Invitation for Prequalification":
                    angle = f"资格预审阶段：先下载预审文件核对业绩与保函门槛，评估直投或联合当地承包商参与（{prod_cn}）"
                elif proc_group == "GO":
                    angle = f"货物直采招标，可直接投标：先下载标书核对资格要求、交货期与投标保函（{prod_cn}）"
                else:
                    angle = f"先下载招标文件核对资格门槛，再决定直接投标还是经当地代理/承包商配套供货（{prod_cn}）"

                sum_parts = [f"类型：{ntype}"]
                if pname and pname != title_show:
                    sum_parts.append(f"所属项目：{pname[:70]}")
                if email:
                    sum_parts.append(f"官方邮箱：{email}")
                if deadline:
                    sum_parts.append(f"截标日期：{deadline}")
                if orig_date and reposted:
                    sum_parts.append(f"正文原日期：{orig_date}（重新挂网）")
                if proc_group:
                    sum_parts.append("采购类别：" + {"CW": "土建工程（需经总包供货）", "GO": "货物直采", "CS": "咨询服务", "NC": "非咨询服务"}.get(proc_group, proc_group))

                notice_url = f"https://projects.worldbank.org/en/projects-operations/procurement-detail/{nid}"
                if not nid.startswith("OP") and pid:
                    notice_url = f"https://projects.worldbank.org/en/projects-operations/project-detail/{pid}"

                items.append({
                    "id": f"wb_{nid}",
                    "cat": "loan",
                    "catLabel": badge_lbl,
                    "noticeType": ntype,
                    "severity": sev,
                    "severityLabel": sev_lbl,
                    "country": c_en,
                    "countryCn": c_cn,
                    "region": reg,
                    "lang": lang,
                    "date": date_str,
                    "deadline": deadline,
                    "reposted": reposted,
                    "origNoticeDate": orig_date if reposted else "",
                    "procGroup": proc_group,
                    "title": title_show,
                    "titleCn": f"【{c_cn}】{title_show}",
                    "summary": " ｜ ".join(sum_parts),
                    "amount": "",
                    "entity": org,
                    "contactEmail": email,
                    "contactPhone": phone,
                    "productsCn": prod_cn,
                    "productsEn": prod_en,
                    "angleCn": angle,
                    "source": "世界银行实时招标 API",
                    "url": notice_url,
                })
                if len(items) >= 22:
                    break
        except Exception as e:
            print(f"[WARN] World Bank procnotices fetch failed: {e}")
            last_err = str(e)[:180]
        if len(items) >= 22:
            break

    return items, (len(items) > 0 or not last_err), last_err



NEWS_MAX_AGE_DAYS = 21
NEWS_SPAM_PAT = re.compile(
    r"(openpr|einnews|prlog|researchandmarkets|mordorintelligence|fortunebusinessinsights|"
    r"grandviewresearch|marketresearchfuture|verifiedmarketresearch|sphericalinsights|imarcgroup|"
    r"technavio|coherentmarketinsights|transparencymarketresearch|globenewswire.*market\s+size|"
    r"volza|importgenius|panjiva|52wmb|tendata|exportgenius|seair|trademo|"
    r"\bmarket\s+size\b|\bcagr\b|\bforecast\s+20[23]\d\b|\bindustry\s+report\b)",
    re.I,
)


def _is_spam_news(title, src, link):
    blob = f"{title} {src} {link}"
    return bool(NEWS_SPAM_PAT.search(blob))


def _news_dedup_key(title):
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", title.lower()).strip()
    toks = [w for w in s.split() if w not in ("the", "a", "an", "in", "of", "to", "for", "and", "on", "with", "at", "by")]
    return " ".join(toks[:9]) or title.lower()


def _verify_ai_entity(cand, item):
    """Code-level hallucination guard: AI entity must appear verbatim in original title or summary."""
    c = clean_text(cand or "").strip(" ,.;:()[]【】\"'")
    if len(c) < 2 or len(c) > 80:
        return ""
    if c.lower() in (
        "ifc", "adb", "afdb", "idb", "ebrd", "world bank", "imf", "un", "eu",
        "china", "india", "vietnam", "mexico", "brazil", "indonesia", "saudi arabia",
        "thailand", "chile", "egypt", "nigeria", "south africa", "uae", "turkey",
        "unknown", "n/a", "none", "null", "业主", "采购方", "未提及",
    ):
        return ""
    hay = f"{item.get('title', '')} {item.get('summary', '')}".lower()
    if c.lower() in hay:
        return c
    # Also allow stripping trailing corporate suffix if core >=4-char name appears verbatim
    core = re.sub(r"\b(ltd|limited|inc|corp|corporation|co|plc|llc|group|sa|gmbh|bhd|pte|jsc)\.?$", "", c, flags=re.I).strip(" ,.-")
    if len(core) >= 4 and core.lower() in hay:
        return c
    return ""


def fetch_news_rss():
    """Fetch fresh project financing, factory expansion & Chinese EPC wins via Google News RSS."""
    queries = [
        (
            "国际开发项目立项",
            "https://news.google.com/rss/search?q="
            + urllib.parse.quote(
                '("IFC" OR "ADB" OR "AfDB" OR "IDB" OR "EBRD") ("loan" OR "financing") ("factory" OR "power" OR "water" OR "steel" OR "industrial" OR "mining") when:14d'
            )
            + "&hl=en-US&gl=US&ceid=US:en",
        ),
        (
            "新建厂房/扩产",
            "https://news.google.com/rss/search?q="
            + urllib.parse.quote(
                '("breaks ground" OR "new factory" OR "industrial park" OR "plant expansion") (Vietnam OR Indonesia OR Mexico OR "Saudi Arabia" OR Brazil OR Thailand OR India OR Chile OR Egypt OR Nigeria OR "South Africa") when:14d'
            )
            + "&hl=en-US&gl=US&ceid=US:en",
        ),
        (
            "中资总包项目",
            "https://news.google.com/rss/search?q="
            + urllib.parse.quote(
                '("中标" OR "签约" OR "开工") ("钢结构" OR "电站" OR "工业园" OR "矿山" OR "水务" OR "厂房") ("越南" OR "印尼" OR "沙特" OR "阿联酋" OR "墨西哥" OR "巴西" OR "尼日利亚" OR "智利" OR "埃及" OR "泰国") when:21d'
            )
            + "&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
        ),
    ]

    items = []
    seen = set()
    ok_queries = 0
    last_err = ""
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    for label, url in queries:
        try:
            xml_text = http_get(url, timeout=16)
            root = ET.fromstring(xml_text)
            ok_queries += 1
            count = 0
            for it in root.findall("./channel/item"):
                raw_title = clean_text(it.findtext("title"))
                link = clean_text(it.findtext("link"))
                pub = clean_text(it.findtext("pubDate"))
                src = clean_text(it.findtext("source")) or "财经/工程快讯"
                if not raw_title:
                    continue
                # Strip trailing " - SourceName" added by Google News RSS
                title = re.sub(r"\s+-\s+[^-]{2,45}$", "", raw_title).strip() or raw_title
                if _is_spam_news(title, src, link):
                    continue
                dedup_k = _news_dedup_key(title)
                if title.lower() in seen or dedup_k in seen:
                    continue

                date_str = ""
                age_days = 0
                try:
                    dt = datetime.datetime.strptime(pub[:25].strip(), "%a, %d %b %Y %H:%M:%S").replace(tzinfo=datetime.timezone.utc)
                    date_str = dt.strftime("%Y-%m-%d")
                    age_days = max(0, (now_utc - dt).days)
                except Exception:
                    date_str = pub[:16]
                # Enforce strict freshness (R-07): drop stale RSS items older than 21 days
                if age_days > NEWS_MAX_AGE_DAYS:
                    continue

                seen.add(title.lower())
                seen.add(dedup_k)
                c_en, c_cn, reg, lang = normalize_country(title)
                if reg == "其他":
                    c_en, c_cn, reg, lang = "Global", "全球新兴市场", "全球", "en"

                prod_cn, prod_en = match_products(title)
                m_amt = re.search(r"(\$\s?\d+(?:\.\d+)?\s?(?:billion|million|bn|m|B|M)|\d+(?:\.\d+)?\s?(?:亿美元|亿元))", title, re.I)
                amt = m_amt.group(1) if m_amt else ""

                # Heuristic buyer/EPC entity extraction (concise subject before action verb)
                ent = ""
                m_en = re.match(r"^([A-Z][A-Za-z0-9&.\-']+(?:\s+[A-Z][A-Za-z0-9&.\-']+){0,3})\s+(?:secures|signs|wins|breaks|opens|expands|launches|invests|to\s+build|plans|announces|receives|gets)", title)
                if m_en:
                    cand = m_en.group(1).strip()
                    if cand.lower() not in ("ifc", "adb", "afdb", "idb", "ebrd", "world bank", "china", "india", "vietnam", "mexico", "brazil", "indonesia", "saudi arabia"):
                        ent = cand
                else:
                    m_zh = re.match(r"^([\u4e00-\u9fffA-Za-z0-9]{2,14}?)(?:中标|签约|承建|开工|落地|投资)", title)
                    if m_zh:
                        ent = m_zh.group(1).strip()

                cue_label = f"线索 · {label}"
                items.append({
                    "id": f"news_{len(items)}",
                    "cat": "news",
                    "catLabel": cue_label,
                    "severity": "High" if amt else "Normal",
                    "severityLabel": f"💰 {amt}" if amt else cue_label,
                    "country": c_en,
                    "countryCn": c_cn,
                    "region": reg,
                    "lang": lang,
                    "date": date_str,
                    "ageDays": age_days,
                    "title": title,
                    "titleCn": title,
                    "summary": f"来源：{src}",
                    "amount": amt,
                    "entity": ent,
                    "productsCn": prod_cn,
                    "productsEn": prod_en,
                    "angleCn": f"新闻线索（联系前请核实原文）：可在「客户背调」核查业主或总包官网，重点切入 {prod_cn}",
                    "source": src,
                    "url": link,
                })
                count += 1
                if count >= 8:
                    break
        except Exception as e:
            print(f"[WARN] News RSS ({label}) failed: {e}")
            last_err = str(e)[:180]
    return items, (ok_queries > 0), last_err


def enrich_with_gemini(items, prev_items=None):
    """Translate English titles & extract concise Chinese B2B angles via Gemini API, reusing cached translations from prev_items."""
    if not items:
        return False

    # 1. Reuse already-verified AI translations from previous feed for unchanged items (prevents 503 regression & cuts API quota by ~85%)
    reused_cnt = 0
    if prev_items:
        prev_by_key = {}
        for p in prev_items:
            if isinstance(p, dict) and p.get("aiFields"):
                if p.get("id") and str(p["id"]).startswith("wb_"):
                    prev_by_key[("id", p["id"])] = p
                if p.get("url") and p.get("title"):
                    prev_by_key[("ut", p["url"], p["title"])] = p
        for it in items:
            matched = None
            if it.get("id") and str(it["id"]).startswith("wb_"):
                matched = prev_by_key.get(("id", it["id"]))
            if not matched and it.get("url") and it.get("title"):
                matched = prev_by_key.get(("ut", it["url"], it["title"]))
            if matched:
                copied_fields = []
                if "titleCn" in (matched.get("aiFields") or []) and matched.get("titleCn"):
                    it["titleCn"] = clean_text(matched["titleCn"]).replace("！", "")
                    copied_fields.append("titleCn")
                if it.get("cat") != "loan" and "angleCn" in (matched.get("aiFields") or []) and matched.get("angleCn"):
                    it["angleCn"] = clean_text(matched["angleCn"]).replace("！", "，").replace("实盘", "").strip("， ")
                    copied_fields.append("angleCn")
                if not it.get("entity") and "entity" in (matched.get("aiFields") or []) and matched.get("entity"):
                    v_ent = _verify_ai_entity(matched["entity"], it)
                    if v_ent:
                        it["entity"] = v_ent
                        copied_fields.append("entity")
                if copied_fields:
                    it["aiFields"] = copied_fields
                    reused_cnt += 1

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return reused_cnt > 0

    # 2. Only send items that STILL need translation to Gemini
    targets = []
    for cat_prio in ("loan", "weather", "news"):
        for idx, it in enumerate(items):
            if it["cat"] != cat_prio or it.get("aiFields"):
                continue
            if cat_prio == "weather" and it.get("hazardType") != "PW":
                continue
            zh_chars = len(re.findall(r"[\u4e00-\u9fff]", it["title"]))
            if zh_chars < 6 and len(targets) < 48:
                targets.append({
                    "i": idx,
                    "cat": it["cat"],
                    "country": it["countryCn"],
                    "title": it["title"],
                    "entity": it["entity"],
                    "amount": it["amount"],
                })
    if not targets:
        if reused_cnt > 0:
            print(f"[INFO] Reused {reused_cnt} cached Gemini translations; 0 new items needed API call.")
        return True

    import time
    endpoints = [
        ("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent", {"x-goog-api-key": api_key}),
        ("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent", {"x-goog-api-key": api_key}),
        ("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent", {"x-goog-api-key": api_key}),
        ("https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent", {"x-goog-api-key": api_key}),
    ]

    enriched_total = 0
    working_ep = None
    for start in range(0, len(targets), 16):
        if start > 0:
            time.sleep(4)
        batch = targets[start : start + 16]
        prompt = (
            "你是中国全品类工业品外贸总监（主营钢结构、阀门、水泵、电缆、机械、农机、五金）。\n"
            "请把下面每条海外商机翻译成精炼易懂的中文标题（带国别，28字以内），给一句克制务实的外贸切入建议（30字以内，禁用感叹号和“实盘/必拿”等夸大用语）。\n"
            "重要硬规则：entity 字段只能一字不差摘录原 title 中真实出现的具体业主或采购公司名称；如果原 title 没有明确公司名，必须返回空字符串 \"\"，严禁猜测、补全或编造公司名。\n"
            "严格返回纯 JSON 数组，每个对象只含字段：i（原整数索引）、titleCn（中文标题）、angleCn（外贸切入建议）、entity（原文出现的业主/采购方名或空串）。不要输出任何多余文字。\n"
            + json.dumps(batch, ensure_ascii=False)
        )
        body = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"},
        }
        try_list = ([working_ep] + [e for e in endpoints if e != working_ep]) if working_ep else endpoints
        resp_txt = None
        for ep_url, ep_hdrs in try_list:
            try:
                resp_txt = http_post_json(ep_url, body, timeout=55, headers=ep_hdrs)
                working_ep = (ep_url, ep_hdrs)
                break
            except Exception as e_ep:
                print(f"[WARN] Gemini endpoint failed ({ep_url.split('?')[0]}): {e_ep}")
                time.sleep(3)
        if not resp_txt:
            continue
        try:
            resp_json = json.loads(resp_txt)
            text = resp_json["candidates"][0]["content"]["parts"][0]["text"]
            text = re.sub(r"^```json\s*|\s*```$", "", text.strip())
            arr = json.loads(text)
            if isinstance(arr, list):
                for obj in arr:
                    i = obj.get("i")
                    if isinstance(i, int) and 0 <= i < len(items):
                        ai_fields = []
                        if obj.get("titleCn"):
                            items[i]["titleCn"] = clean_text(obj["titleCn"]).replace("！", "")
                            ai_fields.append("titleCn")
                        if obj.get("angleCn") and items[i].get("cat") != "loan":
                            items[i]["angleCn"] = clean_text(obj["angleCn"]).replace("！", "，").replace("实盘", "").strip("， ")
                            ai_fields.append("angleCn")
                        if obj.get("entity") and not items[i].get("entity"):
                            verified_ent = _verify_ai_entity(obj.get("entity"), items[i])
                            if verified_ent:
                                items[i]["entity"] = verified_ent
                                ai_fields.append("entity")
                            else:
                                print(f"[CLEAN] Dropped unverified AI entity: {obj.get('entity')!r}")
                        if ai_fields:
                            items[i]["aiFields"] = ai_fields
                        enriched_total += 1
        except Exception as e_parse:
            print(f"[WARN] Gemini batch parse failed: {e_parse}")

    if enriched_total > 0 or reused_cnt > 0:
        print(f"[INFO] Gemini enriched {enriched_total} new items + reused {reused_cnt} cached items.")
        return True
    return False


def build_brief_markdown(feed):
    """Build crisp Chinese morning brief for WeChat / WxPusher / WeCom / Feishu / DingTalk."""
    stats = feed["stats"]
    lines = [
        f"🌍 FriesGo 全球工业商机早报（{feed['updatedCn']}）",
        f"今日抓取 {stats['total']} 条：🌀 台风/灾害 {stats['weather']} ｜ 🏦 世行放款项目 {stats['loan']} ｜ 📰 融资/扩产/EPC {stats['news']}",
        "",
    ]
    weathers = [x for x in feed["items"] if x["cat"] == "weather"][:3]
    loans = [x for x in feed["items"] if x["cat"] == "loan"][:4]
    news = [x for x in feed["items"] if x["cat"] == "news"][:4]

    if weathers:
        lines.append("【🌀 台风/灾害预警（钢构/排水泵/备电抢修机会）】")
        for x in weathers:
            lines.append(f"• {x['titleCn']} → 推：{x['productsCn']}")
        lines.append("")
    if loans:
        lines.append("【🏦 世界银行最新基建/工业获批项目】")
        for x in loans:
            amt = f"（{x['amount']}）" if x["amount"] else ""
            lines.append(f"• {x['titleCn']}{amt} → 推：{x['productsCn']}")
        lines.append("")
    if news:
        lines.append("【📰 全球放款 / 建厂扩产 / 中资EPC动态】")
        for x in news:
            lines.append(f"• [{x['countryCn']}] {x['titleCn']}")
        lines.append("")
    lines.append(f"👉 点击进入作战地图查看全文、一键背调与生成开发信：\n{SITE_URL}")
    return "\n".join(lines)


def push_notifications(feed):
    """Send daily morning brief to whichever optional channel secrets are configured."""
    title = f"🌍 全球工业商机早报 ({feed['updatedDate']})"
    md = build_brief_markdown(feed)

    # 0. Native Tencent WeChat Official Test Account (Zero App download! Auto-sends to all followers!)
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
            tok_data = json.loads(http_get(tok_url, timeout=15))
            access_token = tok_data.get("access_token", "")
            if not access_token:
                raise RuntimeError(f"Failed to get WeChat access_token: {tok_data}")

            # Use explicit WX_OPENIDS if provided, otherwise auto-fetch ALL followers who scanned QR!
            raw_openids = os.environ.get("WX_OPENIDS", "").strip()
            if raw_openids:
                openids = [o.strip() for o in raw_openids.split(",") if o.strip()]
            else:
                usr_url = f"https://api.weixin.qq.com/cgi-bin/user/get?access_token={urllib.parse.quote(access_token)}"
                usr_data = json.loads(http_get(usr_url, timeout=15))
                openids = (usr_data.get("data") or {}).get("openid") or []

            if not openids:
                print("[WARN] WeChat Test Account has 0 followers yet — scan QR first!")
            else:
                def strip_emoji(s):
                    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9\s\-\.\$\(\)（）：:、/|，,]", "", str(s or "")).strip()

                stats = feed["stats"]
                weathers = [x for x in feed["items"] if x["cat"] == "weather"]
                loans = [x for x in feed["items"] if x["cat"] == "loan"]
                w_countries = []
                for x in weathers[:4]:
                    cn = x.get("countryCn") or x.get("country") or ""
                    if cn and cn not in w_countries:
                        w_countries.append(cn)
                if w_countries:
                    w_txt = f"{'/'.join(w_countries[:3])}等{len(weathers)}条预警（点详情查钢构/泵阀商机）"
                else:
                    w_txt = "今日全球主要市场无红橙级别灾害预警"

                lead_items = []
                zh_loans = [x for x in loans if len(re.findall(r"[\u4e00-\u9fff]", x.get("titleCn") or "")) >= 5]
                pick_pool = (zh_loans + [x for x in loans if x not in zh_loans])[:2]
                for x in pick_pool:
                    raw_t = re.sub(r"^【([^】]+)】\s*", r"\1：", str(x.get("titleCn") or ""))
                    t_clean = re.sub(r"\s+", " ", strip_emoji(raw_t)).strip()
                    amt = x.get("amount") or ""
                    if amt and amt not in t_clean:
                        t_clean = f"{t_clean}({amt})"
                    if t_clean:
                        lead_items.append(t_clean[:22])
                l_txt = "；".join(lead_items) if lead_items else "点下方「详情」查看全部全球招标与新建项目商机"

                send_url = f"https://api.weixin.qq.com/cgi-bin/message/template/send?access_token={urllib.parse.quote(access_token)}"
                sent_ok = 0
                for oid in openids:
                    payload = {
                        "touser": oid,
                        "template_id": wx_tpl,
                        "url": SITE_URL,
                        "data": {
                            "date": {"value": feed["updatedCn"]},
                            "stats": {"value": f"共{stats['total']}条（灾害{stats['weather']}｜世行招标{stats['loan']}｜扩产总包{stats['news']}）"},
                            "weather": {"value": w_txt},
                            "leads": {"value": l_txt},
                        },
                    }
                    res_j = json.loads(http_post_json(send_url, payload, timeout=15))
                    if res_j.get("errcode") == 0:
                        sent_ok += 1
                    else:
                        print(f"[WARN] WeChat send to {oid[:8]}... failed: {res_j}")
                print(f"[INFO] Pushed native WeChat morning brief to {sent_ok}/{len(openids)} colleague(s).")
        except Exception as e:
            print(f"[WARN] WeChat Official Test Account push failed: {e}")

    # 1. WxPusher (Optional legacy channel)
    wx_token = os.environ.get("WXPUSHER_APP_TOKEN", "").strip()
    wx_topic = os.environ.get("WXPUSHER_TOPIC_ID", "").strip()
    if wx_token and wx_topic:
        try:
            topic_ids = [int(t.strip()) for t in wx_topic.split(",") if t.strip().isdigit()]
            html_body = "<br>".join(html_lib.escape(line) for line in md.splitlines())
            html_body += f'<br><br><a href="{SITE_URL}">🚀 立即打开全球工业品出海作战地图</a>'
            http_post_json(
                "https://wxpusher.zjiecode.com/api/send/message",
                {
                    "appToken": wx_token,
                    "content": html_body,
                    "summary": title,
                    "contentType": 2,
                    "topicIds": topic_ids,
                    "url": SITE_URL,
                },
            )
            print("[INFO] Pushed morning brief via WxPusher.")
        except Exception as e:
            print(f"[WARN] WxPusher push failed: {e}")

    # 2. PushPlus (Alternative Personal WeChat push)
    pp_token = os.environ.get("PUSHPLUS_TOKEN", "").strip()
    if pp_token:
        try:
            payload = {"token": pp_token, "title": title, "content": md, "template": "markdown"}
            pp_topic = os.environ.get("PUSHPLUS_TOPIC", "").strip()
            if pp_topic:
                payload["topic"] = pp_topic
            http_post_json("https://www.pushplus.plus/send", payload)
            print("[INFO] Pushed morning brief via PushPlus.")
        except Exception as e:
            print(f"[WARN] PushPlus push failed: {e}")

    # 3. WeCom (企业微信群机器人)
    wecom = os.environ.get("WECOM_WEBHOOK", "").strip()
    if wecom:
        try:
            http_post_json(wecom, {"msgtype": "text", "text": {"content": md}})
            print("[INFO] Pushed morning brief via WeCom.")
        except Exception as e:
            print(f"[WARN] WeCom push failed: {e}")

    # 4. Feishu (飞书群机器人)
    feishu = os.environ.get("FEISHU_WEBHOOK", "").strip()
    if feishu:
        try:
            http_post_json(feishu, {"msg_type": "text", "content": {"text": md}})
            print("[INFO] Pushed morning brief via Feishu.")
        except Exception as e:
            print(f"[WARN] Feishu push failed: {e}")

    # 5. DingTalk (钉钉群机器人)
    ding = os.environ.get("DINGTALK_WEBHOOK", "").strip()
    if ding:
        try:
            http_post_json(ding, {"msgtype": "text", "text": {"content": md}})
            print("[INFO] Pushed morning brief via DingTalk.")
        except Exception as e:
            print(f"[WARN] DingTalk push failed: {e}")


def _load_previous_feed():
    try:
        if os.path.exists(JSON_OUT):
            with open(JSON_OUT, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and isinstance(data.get("items"), list):
                    return data
    except Exception as e:
        print(f"[WARN] Could not load previous feed: {e}")
    return {}


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    now_cn = now_utc + datetime.timedelta(hours=8)
    now_cn_str = now_cn.strftime("%Y-%m-%d %H:%M 北京时间")
    prev_feed = _load_previous_feed()
    prev_items = prev_feed.get("items") or []
    prev_status = prev_feed.get("sourcesStatus") or {}

    print("[INFO] Fetching GDACS global weather/disaster alerts...")
    weather_items, gdacs_ok, gdacs_err = fetch_gdacs()
    print(f"       -> {len(weather_items)} weather/disaster items (ok={gdacs_ok})")

    print("[INFO] Fetching World Bank newly approved industrial/infra projects...")
    wb_items, wb_ok, wb_err = fetch_worldbank()
    print(f"       -> {len(wb_items)} World Bank project items (ok={wb_ok})")

    print("[INFO] Fetching global financing / new factory / EPC news RSS...")
    news_items, news_ok, news_err = fetch_news_rss()
    print(f"       -> {len(news_items)} news items (ok={news_ok})")

    def _resolve_source(key, cat, fresh_items, ok, err):
        if ok and fresh_items:
            return fresh_items, {
                "ok": True,
                "count": len(fresh_items),
                "lastOk": now_cn_str,
                "staleFallback": False,
                "error": "",
            }
        min_news_date = (now_cn - datetime.timedelta(days=NEWS_MAX_AGE_DAYS)).strftime("%Y-%m-%d")
        prior_cat = [
            x for x in prev_items
            if isinstance(x, dict)
            and x.get("cat") == cat
            and not (x.get("deadline") and x["deadline"] < _today_cn())
            and not (cat == "news" and re.match(r"^\d{4}-\d{2}-\d{2}$", str(x.get("date") or "")) and x["date"] < min_news_date)
        ]
        if (not ok) and prior_cat:
            print(f"[WARN] Preserving {len(prior_cat)} prior '{cat}' items due to {key} fetch error: {err}")
            return prior_cat, {
                "ok": False,
                "count": len(prior_cat),
                "lastOk": (prev_status.get(key) or {}).get("lastOk") or prev_feed.get("updatedCn") or "",
                "staleFallback": True,
                "error": err or "fetch failed",
            }
        return fresh_items, {
            "ok": bool(ok),
            "count": len(fresh_items),
            "lastOk": now_cn_str if ok else ((prev_status.get(key) or {}).get("lastOk") or ""),
            "staleFallback": False,
            "error": err,
        }

    weather_items, st_gdacs = _resolve_source("gdacs", "weather", weather_items, gdacs_ok, gdacs_err)
    wb_items, st_wb = _resolve_source("worldbank", "loan", wb_items, wb_ok, wb_err)
    news_items, st_news = _resolve_source("gnews", "news", news_items, news_ok, news_err)

    all_items = weather_items + wb_items + news_items
    if not (gdacs_ok or wb_ok or news_ok):
        # 整改：三个来源全部失败时不覆盖旧数据，并让 Actions 任务失败（GitHub 会发邮件提醒）
        print("[ERROR] All sources failed; keeping previous feed untouched.")
        raise SystemExit(1)
    ai_used = enrich_with_gemini(all_items, prev_items)

    feed = {
        "updatedIso": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "updatedCn": now_cn_str,
        "updatedDate": now_cn.strftime("%Y-%m-%d"),
        "aiEnriched": ai_used,
        "sourcesStatus": {
            "gdacs": st_gdacs,
            "worldbank": st_wb,
            "gnews": st_news,
        },
        "stats": {
            "total": len(all_items),
            "weather": len(weather_items),
            "loan": len(wb_items),
            "news": len(news_items),
        },
        "items": all_items,
    }

    tmp_json = JSON_OUT + ".tmp"
    with open(tmp_json, "w", encoding="utf-8") as f:
        json.dump(feed, f, ensure_ascii=False, indent=2)
    os.replace(tmp_json, JSON_OUT)

    tmp_js = JS_OUT + ".tmp"
    with open(tmp_js, "w", encoding="utf-8") as f:
        f.write("window.RADAR_FEED_INLINE = ")
        json.dump(feed, f, ensure_ascii=False)
        f.write(";\n")
    os.replace(tmp_js, JS_OUT)

    print(f"[SUCCESS] Wrote {len(all_items)} items to {JSON_OUT} and {JS_OUT}")
    if os.environ.get("SKIP_PUSH", "").strip().lower() in ("1", "true", "yes"):
        print("[INFO] SKIP_PUSH=true: skipping WeChat/webhook morning brief push.")
    else:
        push_notifications(feed)


if __name__ == "__main__":
    main()
