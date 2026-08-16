# -*- coding: utf-8 -*-
# RFM 用户价值分析单文件仪表盘生成器（合成、勾稽一致）
import os

# ---------------- 底层数据（唯一真相源） ----------------
segments = [
    {"key":"vip","name":"重要价值","users":1120,"gmv":3584000,"r":5,"f":5,"m":5,"row":0,"col":0,"color":"#00e5ff",
     "feature":"近期活跃、高频高客单的核心买家，品牌忠诚度高",
     "action":"会员专属权益、新品优先购、邀请制社群、积分翻倍",
     "goal":"维持 95%+ 留存，客单价再提升 8–10%"},
    {"key":"keep","name":"重要保持","users":860,"gmv":2408000,"r":2,"f":5,"m":5,"row":1,"col":0,"color":"#22d3ee",
     "feature":"历史高价值但近期未购，高净值用户存在流失风险",
     "action":"召回礼包、一对一客服触达、限时回归优惠",
     "goal":"唤醒 30%+，推动 30 日内复购"},
    {"key":"dev","name":"重要发展","users":1540,"gmv":1694000,"r":5,"f":2,"m":4,"row":0,"col":1,"color":"#34d399",
     "feature":"近期新成交、客单高但频次低，增长潜力大",
     "action":"关联推荐、订阅/周期购引导、满赠提频",
     "goal":"频次 +1，6 个月内升级为重要价值"},
    {"key":"winback","name":"重要挽留","users":690,"gmv":1035000,"r":2,"f":3,"m":4,"row":1,"col":1,"color":"#fbbf24",
     "feature":"高客单但长期未活跃，沉睡的高价值用户",
     "action":"高额召回券、专属顾问、生日/节日关怀",
     "goal":"挽回 25%，重建购买习惯"},
    {"key":"gval","name":"一般价值","users":1980,"gmv":950400,"r":5,"f":4,"m":2,"row":0,"col":2,"color":"#818cf8",
     "feature":"近期活跃、频次高但客单低，价格敏感型",
     "action":"组合装/凑单、会员升级、高毛利推荐",
     "goal":"客单价 +15%"},
    {"key":"gkeep","name":"一般保持","users":1450,"gmv":609000,"r":2,"f":4,"m":2,"row":1,"col":2,"color":"#a78bfa",
     "feature":"稳定复购但客单低且近期沉寂",
     "action":"低价高频品类提醒、签到任务、轻量召回",
     "goal":"提升活跃度，防止跌入流失池"},
    {"key":"gdev","name":"一般发展","users":2310,"gmv":415800,"r":4,"f":2,"m":1,"row":0,"col":3,"color":"#f472b6",
     "feature":"偶尔购买、客单低的边缘新客",
     "action":"新人券、爆品引流、内容种草",
     "goal":"培养首复购，向一般价值迁移"},
    {"key":"churn","name":"流失预警","users":2500,"gmv":225000,"r":1,"f":1,"m":1,"row":1,"col":3,"color":"#f87171",
     "feature":"长期未购、几乎无互动的沉默用户",
     "action":"低成本批量触达、问卷挽回、必要时清洗",
     "goal":"低成本唤醒或确认流失，释放运营资源"},
]

# 周期级汇总指标（全部由 segments 推导，保证勾稽一致）
total_users = sum(s["users"] for s in segments)
total_gmv   = sum(s["gmv"] for s in segments)
for s in segments:
    s["user_share"] = s["users"]/total_users*100
    s["gmv_share"]  = s["gmv"]/total_gmv*100
    s["arpu"]       = s["gmv"]/s["users"]

# 周期级派生指标
total_orders   = 40051
aov            = total_gmv/total_orders
repurchasers   = 7522
repurchase_rate= repurchasers/total_users*100

# 近 6 个月趋势（月度，月度可跨月重叠；月度 GMV 之和=周期总 GMV）
months     = ["2026-02","2026-03","2026-04","2026-05","2026-06","2026-07"]
gmv_trend  = [1480000,1620000,1690000,1860000,1920000,2351200]
users_trend= [3120,3340,3510,3780,3920,4560]
rep_trend  = [54.2,56.8,58.1,59.3,60.0,60.4]
assert sum(gmv_trend)==total_gmv, (sum(gmv_trend),total_gmv)

# KPI 环比（合成，演示用）
kpi = [
    ("活跃用户数", f"{total_users:,}", f"环比 +8.3%", "#00e5ff"),
    ("GMV", f"¥{total_gmv/10000:,.1f}万", f"环比 +12.5%", "#34d399"),
    ("客单价", f"¥{aov:,.0f}", f"环比 +3.1%", "#fbbf24"),
    ("复购率", f"{repurchase_rate:.1f}%", f"环比 +1.2pp", "#f472b6"),
]

# ---------------- 工具 ----------------
def hex2rgb(h): return tuple(int(h[i:i+2],16) for i in (1,3,5))
def rgb2hex(c): return "#%02x%02x%02x"%tuple(max(0,min(255,int(v))) for v in c)
def lerp(a,b,t): return tuple(a[i]+(b[i]-a[i])*t for i in range(3))
def fnum(n): return f"{n:,}"

# ---------------- 1) RFM 分层矩阵热力格（SVG） ----------------
def build_matrix():
    W,H=940,340
    left=120; top=84; cellW=185; cellH=104; gapX=10; gapY=14
    cols=["F高 · M高","F低 · M高","F高 · M低","F低 · M低"]
    rows=["R 高 · 近期活跃","R 低 · 近期沉寂"]
    maxshare=max(s["gmv_share"] for s in segments)
    dark=(11,30,38); bright=(0,229,255)
    p=[f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="RFM分层矩阵热力格">']
    # 列头
    for c,label in enumerate(cols):
        x=left+c*(cellW+gapX)
        p.append(f'<text x="{x+cellW/2:.0f}" y="46" fill="#9fb3c8" font-size="13" font-weight="600" text-anchor="middle">{label}</text>')
    # 行头
    for r,label in enumerate(rows):
        y=top+r*(cellH+gapY)
        p.append(f'<text x="60" y="{y+cellH/2:.0f}" fill="#9fb3c8" font-size="13" font-weight="600" text-anchor="middle" dominant-baseline="middle">{label}</text>')
    # 单元格
    for s in segments:
        x=left+s["col"]*(cellW+gapX)
        y=top+s["row"]*(cellH+gapY)
        t=(s["gmv_share"]/maxshare)**0.7
        fill=rgb2hex(lerp(dark,bright,t))
        txt="#06222a" if t>0.55 else "#e6f6ff"
        p.append(f'<rect x="{x:.0f}" y="{y:.0f}" width="{cellW}" height="{cellH}" rx="12" fill="{fill}" fill-opacity="0.95" stroke="{s["color"]}" stroke-opacity="0.5"/>')
        p.append(f'<text x="{x+cellW/2:.0f}" y="{y+34:.0f}" fill="{txt}" font-size="16" font-weight="700" text-anchor="middle">{s["name"]}</text>')
        p.append(f'<text x="{x+cellW/2:.0f}" y="{y+60:.0f}" fill="{txt}" font-size="13" text-anchor="middle">GMV 占比 {s["gmv_share"]:.1f}%</text>')
        p.append(f'<text x="{x+cellW/2:.0f}" y="{y+82:.0f}" fill="{txt}" font-size="12.5" text-anchor="middle" opacity="0.85">人数 {fnum(s["users"])}（{s["user_share"]:.1f}%）</text>')
    p.append('</svg>')
    return "".join(p)

# ---------------- 2) 人数占比 vs GMV占比 对比条形图（SVG） ----------------
def build_bars():
    W,H=960,410
    mL=52; mT=54; mB=66; mR=18
    plotW=W-mL-mR; plotH=H-mT-mB
    ymax=35.0
    order=["vip","keep","dev","winback","gval","gkeep","gdev","churn"]
    segs={s["key"]:s for s in segments}
    seq=[segs[k] for k in order]
    gw=plotW/len(seq)
    barW=30
    baseY=mT+plotH
    p=[f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="分层人数占比与GMV贡献占比对比">']
    # y 轴网格
    for v in range(0,36,5):
        y=baseY-(v/ymax)*plotH
        p.append(f'<line x1="{mL}" y1="{y:.1f}" x2="{mL+plotW}" y2="{y:.1f}" stroke="#1c2a3a" stroke-width="1"/>')
        p.append(f'<text x="{mL-8}" y="{y+4:.1f}" fill="#7f97ad" font-size="11" text-anchor="end">{v}%</text>')
    # 图例
    p.append(f'<rect x="{mL}" y="20" width="14" height="14" rx="3" fill="#2dd4bf"/>')
    p.append(f'<text x="{mL+20}" y="31" fill="#cbd9e6" font-size="12">人数占比</text>')
    p.append(f'<rect x="{mL+110}" y="20" width="14" height="14" rx="3" fill="#f59e0b"/>')
    p.append(f'<text x="{mL+130}" y="31" fill="#cbd9e6" font-size="12">GMV 贡献占比</text>')
    # 柱
    for i,s in enumerate(seq):
        gx=mL+i*gw+gw/2
        x1=gx-barW-2; x2=gx+2
        h1=(s["user_share"]/ymax)*plotH
        h2=(s["gmv_share"]/ymax)*plotH
        p.append(f'<rect x="{x1:.1f}" y="{baseY-h1:.1f}" width="{barW}" height="{h1:.1f}" rx="3" fill="#2dd4bf"/>')
        p.append(f'<rect x="{x2:.1f}" y="{baseY-h2:.1f}" width="{barW}" height="{h2:.1f}" rx="3" fill="#f59e0b"/>')
        p.append(f'<text x="{x1+barW/2:.1f}" y="{baseY-h1-5:.1f}" fill="#9fe9dd" font-size="10.5" text-anchor="middle">{s["user_share"]:.1f}</text>')
        p.append(f'<text x="{x2+barW/2:.1f}" y="{baseY-h2-5:.1f}" fill="#f8c873" font-size="10.5" text-anchor="middle">{s["gmv_share"]:.1f}</text>')
        p.append(f'<text x="{gx:.1f}" y="{baseY+18:.1f}" fill="#cbd9e6" font-size="11.5" text-anchor="middle">{s["name"]}</text>')
    p.append('</svg>')
    return "".join(p)

# ---------------- 3) 近 6 个月趋势折线（SVG，双/三轴） ----------------
def build_trend():
    W,H=960,360
    x0=64; y0=34; x1=900; y1=286
    plotW=x1-x0; plotH=y1-y0
    n=len(months)
    gmv_max=2.6e6; users_max=5000; rep_min=50; rep_max=65
    xs=[x0+(i+0.5)*(plotW/n) for i in range(n)]
    def yg(v): return y1-(v/gmv_max)*plotH
    def yu(v): return y1-(v/users_max)*plotH
    def yr(p): return y1-((p-rep_min)/(rep_max-rep_min))*plotH
    p=[f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="近6个月趋势折线">']
    # 网格 + 左轴(GMV 万) + 右轴(用户 千)
    for k in range(6):
        v=k/5
        y=y1-v*plotH
        p.append(f'<line x1="{x0}" y1="{y:.1f}" x2="{x1}" y2="{y:.1f}" stroke="#1c2a3a" stroke-width="1"/>')
        p.append(f'<text x="{x0-8:.0f}" y="{y+4:.1f}" fill="#5fb0c9" font-size="11" text-anchor="end">{int(v*gmv_max/10000)}万</text>')
        p.append(f'<text x="{x1+8:.0f}" y="{y+4:.1f}" fill="#34d399" font-size="11" text-anchor="start">{int(v*users_max/1000)}k</text>')
    # x 标签
    for i,mo in enumerate(months):
        p.append(f'<text x="{xs[i]:.1f}" y="{y1+20:.0f}" fill="#cbd9e6" font-size="11.5" text-anchor="middle">{mo}</text>')
    # GMV 面积
    area=f'M{xs[0]:.1f},{yg(gmv_trend[0]):.1f} '+" ".join(f'L{xs[i]:.1f},{yg(gmv_trend[i]):.1f}' for i in range(n))+f' L{xs[-1]:.1f},{y1} L{xs[0]:.1f},{y1} Z'
    p.append(f'<path d="{area}" fill="#00e5ff" fill-opacity="0.12"/>')
    # GMV 线
    gmv_line=" ".join(f'L{xs[i]:.1f},{yg(gmv_trend[i]):.1f}' for i in range(n))
    p.append(f'<path d="M{xs[0]:.1f},{yg(gmv_trend[0]):.1f} {gmv_line}" fill="none" stroke="#00e5ff" stroke-width="2.5"/>')
    # 用户线
    us_line=" ".join(f'L{xs[i]:.1f},{yu(users_trend[i]):.1f}' for i in range(n))
    p.append(f'<path d="M{xs[0]:.1f},{yu(users_trend[0]):.1f} {us_line}" fill="none" stroke="#34d399" stroke-width="2.5"/>')
    # 复购率线（虚线）
    rp_line=" ".join(f'L{xs[i]:.1f},{yr(rep_trend[i]):.1f}' for i in range(n))
    p.append(f'<path d="M{xs[0]:.1f},{yr(rep_trend[0]):.1f} {rp_line}" fill="none" stroke="#fbbf24" stroke-width="2" stroke-dasharray="6 4"/>')
    # 数据点
    for i in range(n):
        p.append(f'<circle cx="{xs[i]:.1f}" cy="{yg(gmv_trend[i]):.1f}" r="3.2" fill="#00e5ff"/>')
        p.append(f'<circle cx="{xs[i]:.1f}" cy="{yu(users_trend[i]):.1f}" r="3.2" fill="#34d399"/>')
        p.append(f'<circle cx="{xs[i]:.1f}" cy="{yr(rep_trend[i]):.1f}" r="3" fill="#fbbf24"/>')
    # 图例
    p.append(f'<rect x="{x0}" y="10" width="14" height="14" rx="3" fill="#00e5ff"/><text x="{x0+20}" y="21" fill="#cbd9e6" font-size="12">GMV（左轴）</text>')
    p.append(f'<rect x="{x0+130}" y="10" width="14" height="14" rx="3" fill="#34d399"/><text x="{x0+150}" y="21" fill="#cbd9e6" font-size="12">活跃用户（右轴）</text>')
    p.append(f'<rect x="{x0+290}" y="10" width="14" height="14" rx="3" fill="#fbbf24"/><text x="{x0+310}" y="21" fill="#cbd9e6" font-size="12">复购率（50–65%）</text>')
    p.append('</svg>')
    return "".join(p)

# ---------------- 4) 策略卡 ----------------
def build_strategy_cards():
    order=["vip","keep","dev","winback","gval","gkeep","gdev","churn"]
    segs={s["key"]:s for s in segments}
    out=[]
    for k in order:
        s=segs[k]
        out.append(f'''
        <div class="strat-card" style="border-left:4px solid {s['color']}">
          <div class="strat-head">
            <span class="dot" style="background:{s['color']}"></span>
            <h3>{s['name']}</h3>
            <span class="rfm-chips">
              <span class="chip">R{s['r']}</span><span class="chip">F{s['f']}</span><span class="chip">M{s['m']}</span>
            </span>
          </div>
          <div class="strat-meta">
            <span>人数 {fnum(s['users'])}（{s['user_share']:.1f}%）</span>
            <span>GMV {s['gmv_share']:.1f}%</span>
            <span>人均 ¥{s['arpu']:,.0f}</span>
          </div>
          <dl>
            <dt>人群特征</dt><dd>{s['feature']}</dd>
            <dt>运营动作</dt><dd>{s['action']}</dd>
            <dt>预期目标</dt><dd>{s['goal']}</dd>
          </dl>
        </div>''')
    return "\n".join(out)

# ---------------- 5) RFM 三维说明 ----------------
rfm_info=[
    ("R","Recency 最近购买","距分析周期末的天数。越近（分越高）说明用户越活跃、越容易被再次触达。打分 1–5 按全量用户分位切分。"),
    ("F","Frequency 购买频次","周期内完成的有效订单数。频次越高，用户习惯越强、对平台依赖度越高。"),
    ("M","Monetary 累计金额","周期内累计支付金额（实付、不含退款）。直接反映用户带来的商业价值。"),
]
rfm_cards="".join(f'''
  <div class="rfm-card">
    <div class="rfm-badge">{r}</div>
    <h3>{title}</h3>
    <p>{desc}</p>
  </div>''' for r,title,desc in rfm_info)

# ---------------- KPI 卡 ----------------
kpi_cards="".join(f'''
  <div class="kpi-card">
    <div class="kpi-label">{label}</div>
    <div class="kpi-value" style="color:{color}">{value}</div>
    <div class="kpi-delta">▲ {delta}</div>
  </div>''' for label,value,delta,color in kpi)

# ---------------- 二八小结 ----------------
top4=["vip","keep","dev","winback"]
segs={s["key"]:s for s in segments}
top4_users=sum(segs[k]["users"] for k in top4)
top4_gmv=sum(segs[k]["gmv"] for k in top4)
top4_user_share=top4_users/total_users*100
top4_gmv_share=top4_gmv/total_gmv*100

CSS = """
:root{
  --bg:#070b14; --panel:#0e1626; --panel2:#111d31; --line:#1c2a3a;
  --txt:#e6f0fb; --sub:#9fb3c8; --muted:#7f97ad;
  --cyan:#00e5ff; --teal:#34d399; --amber:#fbbf24; --pink:#f472b6; --red:#f87171;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(1200px 600px at 80% -10%, #11233b 0%, var(--bg) 55%) ,var(--bg);
  color:var(--txt);font-family:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,-apple-system,sans-serif;
  line-height:1.6;padding:0 0 60px;}
.wrap{max-width:1180px;margin:0 auto;padding:0 22px;}
/* hero */
.hero{position:relative;overflow:hidden;border-radius:0 0 24px 24px;
  background:linear-gradient(135deg,#0b1b30 0%,#0e1626 60%);border:1px solid var(--line);
  border-top:none;padding:42px 40px 34px;margin-bottom:26px;}
.hero::after{content:"";position:absolute;right:-80px;top:-80px;width:320px;height:320px;
  background:radial-gradient(circle,rgba(0,229,255,.18),transparent 70%);}
.badge-synth{display:inline-block;font-size:12px;color:#ffd27a;background:rgba(251,191,36,.12);
  border:1px solid rgba(251,191,36,.4);padding:3px 10px;border-radius:999px;margin-bottom:14px;letter-spacing:.5px}
.hero h1{font-size:30px;font-weight:800;letter-spacing:.5px}
.hero h1 .accent{color:var(--cyan)}
.hero .sub{color:var(--sub);margin-top:8px;font-size:15px}
.hero-meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.hero-meta span{background:rgba(255,255,255,.04);border:1px solid var(--line);
  padding:6px 12px;border-radius:10px;font-size:13px;color:var(--sub)}
.hero-meta b{color:var(--txt);font-weight:600}
/* section */
section{margin:34px 0}
.sec-title{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:700;margin-bottom:16px}
.sec-title .bar{width:4px;height:18px;background:linear-gradient(var(--cyan),var(--teal));border-radius:2px}
.sec-note{color:var(--muted);font-size:13px;margin:-8px 0 14px}
/* kpi */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.kpi-card{background:linear-gradient(160deg,var(--panel2),var(--panel));border:1px solid var(--line);
  border-radius:16px;padding:20px 20px 18px;position:relative;overflow:hidden}
.kpi-card::before{content:"";position:absolute;left:0;top:0;width:100%;height:3px;
  background:linear-gradient(90deg,var(--cyan),transparent)}
.kpi-label{color:var(--sub);font-size:13px}
.kpi-value{font-size:30px;font-weight:800;margin-top:6px;letter-spacing:.5px}
.kpi-delta{margin-top:6px;font-size:12.5px;color:var(--teal)}
/* rfm cards */
.rfm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.rfm-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px}
.rfm-badge{width:42px;height:42px;border-radius:12px;background:rgba(0,229,255,.12);
  border:1px solid rgba(0,229,255,.4);color:var(--cyan);font-weight:800;font-size:20px;
  display:flex;align-items:center;justify-content:center;margin-bottom:12px}
.rfm-card h3{font-size:15px;margin-bottom:8px}
.rfm-card p{color:var(--sub);font-size:13.5px}
/* panels */
.panel{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:22px 22px 10px}
/* strat */
.strat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.strat-card{background:linear-gradient(160deg,var(--panel2),var(--panel));border:1px solid var(--line);
  border-radius:14px;padding:16px 16px 14px}
.strat-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.strat-head h3{font-size:15.5px}
.dot{width:9px;height:9px;border-radius:50%}
.rfm-chips{margin-left:auto;display:flex;gap:4px}
.chip{font-size:11px;background:rgba(255,255,255,.06);border:1px solid var(--line);
  color:var(--sub);padding:1px 6px;border-radius:6px}
.strat-meta{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 8px;font-size:11.5px;color:var(--muted)}
.strat-card dl{font-size:13px}
.strat-card dt{color:var(--cyan);font-weight:600;margin-top:8px;font-size:12px}
.strat-card dd{color:var(--sub);margin-top:2px}
/* footnote */
.foot{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px;font-size:13px;color:var(--sub)}
.foot h3{color:var(--txt);font-size:15px;margin:14px 0 6px}
.foot h3:first-child{margin-top:0}
.foot ul{margin:6px 0 6px 18px}
.foot li{margin:4px 0}
.foot b{color:var(--txt)}
.foot .warn{color:#ffd27a}
@media(max-width:920px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.rfm-grid{grid-template-columns:1fr}.strat-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.kpi-grid{grid-template-columns:1fr}.strat-grid{grid-template-columns:1fr}.hero{padding:30px 20px}.hero h1{font-size:24px}}
"""

period_start="2026-02-01"; period_end="2026-07-31"
shop="云栖优选旗舰店"
html = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>用户价值分析报告 · RFM 分层驾驶舱</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">

  <header class="hero">
    <span class="badge-synth">合成演示数据 · 内部勾稽一致</span>
    <h1><span class="accent">{shop}</span> · 用户价值分析报告</h1>
    <div class="sub">基于 RFM 模型将活跃用户切分为 8 个价值层级，指导分层运营决策</div>
    <div class="hero-meta">
      <span>📅 分析周期 <b>{period_start} ~ {period_end}</b></span>
      <span>🛒 店铺 <b>{shop}</b></span>
      <span>👥 活跃用户 <b>{fnum(total_users)}</b></span>
      <span>💰 周期 GMV <b>¥{fnum(total_gmv)}</b></span>
      <span>🧮 分层数 <b>8 层</b></span>
    </div>
  </header>

  <section>
    <div class="sec-title"><span class="bar"></span>核心指标</div>
    <div class="sec-note">指标口径见文末脚注；环比为对比上一周期（合成演示）。</div>
    <div class="kpi-grid">{kpi_cards}</div>
  </section>

  <section>
    <div class="sec-title"><span class="bar"></span>RFM 三维模型说明</div>
    <div class="rfm-grid">{rfm_cards}</div>
  </section>

  <section>
    <div class="sec-title"><span class="bar"></span>RFM 分层矩阵热力格</div>
    <div class="sec-note">颜色越亮代表该层 GMV 贡献越高；单元格内标注 GMV 占比与人数（含人数占比）。行=最近购买 R（高/低），列=频次 F × 金额 M 组合。</div>
    <div class="panel">{build_matrix()}</div>
  </section>

  <section>
    <div class="sec-title"><span class="bar"></span>各层：人数占比 vs GMV 贡献占比</div>
    <div class="sec-note">典型「二八结构」：少数高价值层贡献绝大多数 GMV。下方条形对比直观呈现「人少钱多」与「人多钱少」的错位。</div>
    <div class="panel">{build_bars()}</div>
    <div class="sec-note" style="margin-top:10px">
      ⭐ <b style="color:var(--amber)">二八小结</b>：重要价值 / 重要保持 / 重要发展 / 重要挽留 4 层合计仅占用户
      <b>{top4_user_share:.1f}%</b>，却贡献 <b>{top4_gmv_share:.1f}%</b> 的 GMV。
    </div>
  </section>

  <section>
    <div class="sec-title"><span class="bar"></span>分层运营策略卡</div>
    <div class="sec-note">每卡含人群特征、典型 RFM 分数、运营动作与预期目标，可直接作为运营排期依据。</div>
    <div class="strat-grid">{build_strategy_cards()}</div>
  </section>

  <section>
    <div class="sec-title"><span class="bar"></span>近 6 个月趋势</div>
    <div class="sec-note">GMV（面积/青线，左轴）、活跃用户数（绿线，右轴）、复购率（橙虚线，50–65% 区间）。月度可跨月重叠，与周期去重活跃用户数口径不同。</div>
    <div class="panel">{build_trend()}</div>
  </section>

  <section>
    <div class="sec-title"><span class="bar"></span>方法口径与数据说明</div>
    <div class="foot">
      <h3>1. 数据来源</h3>
      <p class="warn">⚠️ 本报告为<strong>演示用途</strong>，采用<strong>内部勾稽一致的合成数据</strong>，并非真实交易记录。所有展示指标均由同一组底层数字推导：分层人数之和 = 活跃用户数（{fnum(total_users)}），分层 GMV 之和 = 周期总 GMV（¥{fnum(total_gmv)}），月度 GMV 之和 = 周期总 GMV。接入真实订单数据后替换对应字段即可复算，模板与样式无需改动。</p>
      <h3>2. 指标口径</h3>
      <ul>
        <li><b>活跃用户数</b>：分析周期内至少完成 1 笔成功支付订单的去重用户（{fnum(total_users)} 人）。</li>
        <li><b>GMV</b>：已支付订单实付金额合计（含运费、不含退款）= ¥{fnum(total_gmv)}。</li>
        <li><b>客单价</b>：GMV ÷ 成交订单数（{fnum(total_orders)} 单）= ¥{aov:,.0f}。</li>
        <li><b>复购率</b>：周期内订单数 ≥ 2 的用户数（{fnum(repurchasers)}）÷ 活跃用户数 = {repurchase_rate:.1f}%。</li>
      </ul>
      <h3>3. RFM 打分与分层逻辑</h3>
      <ul>
        <li>R/F/M 各维度按全量用户分位（quintile）映射为 1–5 分；R 为距周期末天数（越近分越高）。</li>
        <li>以 R（高/低）× F（高/低）× M（高/低）组合切分 8 层：</li>
      </ul>
      <p style="margin:6px 0 4px 18px;color:var(--muted)">
        R高F高M高→重要价值 ｜ R低F高M高→重要保持 ｜ R高F低M高→重要发展 ｜ R低F低M高→重要挽留<br>
        R高F高M低→一般价值 ｜ R低F高M低→一般保持 ｜ R高F低M低→一般发展 ｜ R低F低M低→流失预警
      </p>
      <h3>4. 趋势口径</h3>
      <ul>
        <li>近 6 个月为 2026-02 至 2026-07 的月度口径，月度活跃用户可跨月重叠，故月度之和大于周期去重活跃用户数，属正常现象。</li>
        <li>复购率趋势为各月内订单数 ≥ 2 的用户占比。</li>
      </ul>
      <h3>5. 使用与局限</h3>
      <ul>
        <li>本报告用于方法演示与决策框架呈现，分位阈值、召回/唤醒目标等运营数值为示例，落地前请结合本店历史基准校准。</li>
        <li>纯 SVG/CSS 渲染，无外部依赖、无外链，可离线打开与二次分发。</li>
      </ul>
    </div>
  </section>

</div>
</body>
</html>"""

out_path=os.path.join(os.path.dirname(os.path.abspath(__file__)),"rfm-user-value-dashboard.html")
with open(out_path,"w",encoding="utf-8") as f:
    f.write(html)

# 自检输出
print("活跃用户数:",fnum(total_users))
print("总GMV:",fnum(total_gmv))
print("分层人数之和:",fnum(sum(s['users'] for s in segments)))
print("分层GMV之和:",fnum(sum(s['gmv'] for s in segments)))
print("客单价:",round(aov,1))
print("复购率:%.1f%%"%(repurchase_rate))
print("Top4用户占比:%.1f%%  Top4 GMV占比:%.1f%%"%(top4_user_share,top4_gmv_share))
print("输出:",out_path, "大小:", os.path.getsize(out_path),"bytes")
