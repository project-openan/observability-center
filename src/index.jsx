/**
 * Observation Center (观测中心) — OpenAN Portal plugin entry.
 *
 * Two routes (manifest v1.7.0), both grouped under the Portal parent menu
 * 可观测中心 (group label "Observation Center"):
 *
 *   /observation              → 观测中心：协作任务轨迹列表 → 详情（拓扑 + 三维度指标）
 *   /observation/third-party  → 三方可观测：Langfuse / Grafana / Prometheus
 *                               三张大卡片；菜单点击为门户内正常跳转，
 *                               **点击卡片在新标签页打开对应组件页面**
 *                               （Langfuse=自部署站点；Grafana / Prometheus
 *                               待接入，先前往官网，部署后挂控制台）。
 */
import { useEffect, useCallback, useState } from 'react';
import './index.css';
import { GRAFANA_ICON_PATH, PROMETHEUS_ICON_PATH } from './brand-icons.js';
import { METRIC_GROUPS, METRIC_TOTAL } from './metric-catalog.js';

const DEFAULT_LANGFUSE_URL = 'http://47.236.98.226:9012';

/* --------------------------------------------------------------------------
 * i18n — register this plugin's menu labels into the Portal i18n instance at
 * bundle-load time. The Portal's bundle-loader registers manifest labelKeys
 * AFTER the plugin script executes and skips labels already registered
 * (i18n.exists), so registering here wins and keeps proper zh translations
 * without patching the Portal main bundle. English literals display as-is in
 * the English UI.
 * ------------------------------------------------------------------------ */
const MENU_LABELS = {
    en: {
        'Observation Center': 'Observation Center',
        'Third-party Observability': 'Third-party Observability',
    },
    zh: {
        'Observation Center': '可观测中心',
        'Third-party Observability': '三方可观测',
    },
};

function registerMenuLabels() {
    if (typeof window === 'undefined') return;
    let i18n = null;
    try {
        const ctx = window.__OPENAN_PORTAL_CONTEXT__;
        if (ctx && ctx.i18n) i18n = ctx.i18n;
    } catch { /* ignore */ }
    if (!i18n) {
        try {
            const ri = window.ReactI18next;
            if (ri && typeof ri.getI18n === 'function') i18n = ri.getI18n();
        } catch { /* ignore */ }
    }
    if (!i18n || typeof i18n.addResource !== 'function') return;
    for (const [lng, labels] of Object.entries(MENU_LABELS)) {
        for (const [key, value] of Object.entries(labels)) {
            try { i18n.addResource(lng, 'translation', key, value, { deep: true }); } catch { /* ignore */ }
        }
    }
}
registerMenuLabels();

function resolveLangfuseUrl() {
    if (typeof window === 'undefined') return DEFAULT_LANGFUSE_URL;
    const override = window.__OPENAN_OBSERVATION_LANGFUSE_URL__;
    if (typeof override === 'string' && override.trim()) {
        return override.trim().replace(/\/+$/, '');
    }
    return DEFAULT_LANGFUSE_URL;
}

function IconRefresh() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
        </svg>
    );
}

function IconExternal() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </svg>
    );
}

/* ==========================================================================
 * Route 1 — /observation 观测中心
 *
 * 页面结构（v1.4.0）：默认展示「协作任务轨迹列表」，点开任务进入详情：
 *   · 左侧：协作拓扑图（协调端 → 参与智能体，按 span 聚合消息流/轮询/流式回传）
 *   · 右侧：三个维度的观测指标
 *       A2A-T 消息  — gen_ai.client.operation.duration / streaming.duration /
 *                     gen_ai.agent.a2at.message 日志
 *       协作工作流  — gen_ai.agent.a2at.task.count / task.duration + Jaeger 轨迹瀑布
 *       Agent      — 按智能体聚合的 Span/消息/耗时/错误与负载占比
 *
 * 数据层：默认读取随插件打包的模拟数据集（consumer-smoke 方式构建、SDK 存储
 * 形态，见 scripts/gen-mock-tasks.mjs）。observability-sdk-java 存储栈
 * （deploy/local-storage：Prometheus+Thanos / OpenSearch / Jaeger）部署并通过
 * nginx 暴露查询 API 后，注入 window.__OPENAN_OBS_DATA_URL__ 即可切换真实端点，
 * 组件按 Jaeger/Prometheus API 形状消费。
 * ======================================================================== */

const DEFAULT_DATA_URL = '/plugins/observation-center/mock-collab-tasks.json';

const TASK_TYPE_LABELS = {
    'fault-diagnosis': '故障诊断',
    'network-inspection': '网络巡检',
    'service-provisioning': '业务开通',
    'emergency-drill': '应急演练',
    'capacity-analysis': '容量分析',
};

const AGENT_LABELS = {
    'coordinator-agent': '协调智能体',
    'fault-diagnosis-agent': '故障诊断',
    'topology-agent': '拓扑分析',
    'workbench-agent': '工单执行',
    'capacity-agent': '容量分析',
    'inspection-agent': '巡检执行',
};

const SPAN_KIND_LABELS = { CLIENT: 'C', SERVER: 'S', INTERNAL: 'I' };

function resolveDataUrl() {
    if (typeof window === 'undefined') return DEFAULT_DATA_URL;
    const override = window.__OPENAN_OBS_DATA_URL__;
    return typeof override === 'string' && override.trim() ? override.trim() : DEFAULT_DATA_URL;
}

function useCollabTasks() {
    const [state, setState] = useState({ loading: true, error: null, dataset: null });
    const reload = useCallback(() => {
        setState((s) => ({ loading: true, error: null, dataset: s.dataset }));
        fetch(resolveDataUrl(), { cache: 'no-store' })
            .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then((dataset) => setState({ loading: false, error: null, dataset }))
            .catch((e) => setState({ loading: false, error: e.message || String(e), dataset: null }));
    }, []);
    useEffect(() => { reload(); }, [reload]);
    return { ...state, reload };
}

const pad2 = (n) => String(n).padStart(2, '0');

function fmtTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff)) return '';
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
}

function fmtMs(ms) {
    if (ms == null) return '—';
    if (ms >= 10_000) return `${(ms / 1000).toFixed(2)} s`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.round(ms)} ms`;
}

function fmtValue(unit, value) {
    if (value == null) return '—';
    if (unit === 'ms') return fmtMs(value);
    if (unit === 's') return `${Number(value).toFixed(3)} s`;
    if (unit === 'token') return `${value} token`;
    if (unit === '{round}') return `${value} 轮`;
    return String(value);
}

/** 图表坐标轴数字（紧凑格式）。 */
function fmtChartNum(v, unit) {
    if (v == null) return '';
    if (unit === 'ms') return fmtMs(v);
    if (unit === 's') return `${Number(v).toFixed(2)}s`;
    if (unit === 'token') return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
    if (v >= 10000) return `${(v / 1000).toFixed(1)}k`;
    return String(Math.round(v));
}

/**
 * 折线图：按采集周期的时序采样（纯 SVG，无图表库依赖）。
 * series: [{ name, color, points: [{ t, v }] }]；band: 本任务时间带高亮。
 */
function LineChart({ title, unit, intervalSec, series, band, height = 170 }) {
    const all = (series || []).flatMap((s) => s.points || []);
    if (!all.length) return null;
    const t0 = Math.min(...all.map((p) => p.t));
    const t1 = Math.max(...all.map((p) => p.t));
    const vMax = Math.max(...all.map((p) => p.v), 1) * 1.15;
    const w = 720;
    const h = height;
    const padL = 54;
    const padR = 14;
    const padT = 16;
    const padB = 24;
    const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (w - padL - padR);
    const Y = (v) => padT + (1 - v / vMax) * (h - padT - padB);
    const bandRect = band
        ? { x1: X(Math.max(band.from, t0)), x2: X(Math.min(band.to, t1)) }
        : null;
    return (
        <div className="obs-chart">
            <div className="obs-chart-title">
                <span>折线图 · {title}</span>
                <span className="obs-panel-note">采集周期 {intervalSec}s · {all.length} 个采样点 · 单位 {unit || '—'}</span>
            </div>
            <svg viewBox={`0 0 ${w} ${h}`} className="obs-chart-svg" role="img" aria-label={title}>
                {bandRect && bandRect.x2 > bandRect.x1 && (
                    <rect x={bandRect.x1} y={padT} width={Math.max(bandRect.x2 - bandRect.x1, 2)} height={h - padT - padB} fill="rgba(99, 102, 241, 0.13)" />
                )}
                {[0.25, 0.5, 0.75, 1].map((f, i) => {
                    const v = vMax * f;
                    return (
                        <g key={i}>
                            <line x1={padL} y1={Y(v)} x2={w - padR} y2={Y(v)} stroke="rgba(127, 127, 127, 0.2)" strokeWidth="1" />
                            <text x={padL - 6} y={Y(v) + 3} textAnchor="end" className="obs-chart-ylabel">{fmtChartNum(v, unit)}</text>
                        </g>
                    );
                })}
                <line x1={padL} y1={Y(0)} x2={w - padR} y2={Y(0)} stroke="rgba(127, 127, 127, 0.45)" strokeWidth="1" />
                {series.map((s) => (
                    <g key={s.name}>
                        <path
                            d={s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')}
                            fill="none"
                            stroke={s.color}
                            strokeWidth="2"
                            strokeLinejoin="round"
                        />
                        {s.points.map((p, i) => (
                            <circle key={i} cx={X(p.t)} cy={Y(p.v)} r="2" fill={s.color} />
                        ))}
                    </g>
                ))}
                <text x={padL} y={h - 6} className="obs-chart-xlabel">{new Date(t0).toLocaleTimeString('zh-CN', { hour12: false })}</text>
                <text x={w - padR} y={h - 6} textAnchor="end" className="obs-chart-xlabel">{new Date(t1).toLocaleTimeString('zh-CN', { hour12: false })}</text>
            </svg>
            {series.length > 1 && (
                <div className="obs-chart-legend">
                    {series.map((s) => (
                        <span key={s.name}><i className="obs-chart-swatch" style={{ background: s.color }} />{s.name}</span>
                    ))}
                </div>
            )}
        </div>
    );
}

/** 直方图：le 累计桶分布（纯 SVG 柱状）。 */
function HistogramChart({ title, unit, buckets, sampleCount }) {
    if (!buckets || !buckets.length) return null;
    const max = Math.max(...buckets.map((b) => b.count), 1);
    const w = 720;
    const h = 170;
    const padL = 40;
    const padR = 14;
    const padT = 20;
    const padB = 26;
    const n = buckets.length;
    const slot = (w - padL - padR) / n;
    const barW = Math.min(slot * 0.62, 64);
    const prevLe = buckets.length >= 2 ? buckets[n - 2].le : null;
    return (
        <div className="obs-chart">
            <div className="obs-chart-title">
                <span>直方图 · {title}</span>
                <span className="obs-panel-note">le 累计桶分布 · 样本 {sampleCount ?? '—'} 个</span>
            </div>
            <svg viewBox={`0 0 ${w} ${h}`} className="obs-chart-svg" role="img" aria-label={title}>
                {buckets.map((b, i) => {
                    const bh = (b.count / max) * (h - padT - padB);
                    const x = padL + slot * i + (slot - barW) / 2;
                    const y = h - padB - bh;
                    return (
                        <g key={i}>
                            {bh > 0 && (
                                <rect x={x} y={y} width={barW} height={bh} rx="3" fill="#2563eb" opacity="0.85" />
                            )}
                            <text x={x + barW / 2} y={y - 5} textAnchor="middle" className="obs-chart-barlabel">{b.count}</text>
                            <text x={x + barW / 2} y={h - 8} textAnchor="middle" className="obs-chart-xlabel">
                                {b.inf ? `>${prevLe != null ? fmtChartNum(prevLe, unit) : '∞'}` : `≤${fmtChartNum(b.le, unit)}`}
                            </text>
                        </g>
                    );
                })}
                <line x1={padL} y1={h - padB} x2={w - padR} y2={h - padB} stroke="rgba(127, 127, 127, 0.45)" strokeWidth="1" />
            </svg>
        </div>
    );
}

/** 字典属性芯片用短键名（保留完整名在 title 提示）。 */
function shortAttrKey(k) {
    return k
        .replace(/^gen_ai\.agent\.a2at\./, '')
        .replace(/^gen_ai\.agent\.a2a\./, 'a2a.');
}

function IconSearch() {
    return (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
        </svg>
    );
}

function IconChevronLeft() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
        </svg>
    );
}

function IconChevronRight() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
        </svg>
    );
}

function StatusPill({ status }) {
    const ok = status !== 'error';
    return (
        <span className={`obs-pill ${ok ? 'obs-pill-ok' : 'obs-pill-err'}`}>
            {ok ? '成功' : '失败'}
        </span>
    );
}

function KindBadge({ kind }) {
    // 类名统一小写以命中 CSS（.obs-kind-client 等）；未知 kind 回退首字母
    return <span className={`obs-kind obs-kind-${(kind || 'INTERNAL').toLowerCase()}`}>{SPAN_KIND_LABELS[kind] || (kind || '?').charAt(0)}</span>;
}

function SummaryChips({ tasks }) {
    const total = tasks.length;
    const ok = tasks.filter((t) => t.status !== 'error').length;
    const avg = total ? Math.round(tasks.reduce((a, t) => a + t.durationMs, 0) / total) : 0;
    const agents = new Set(tasks.flatMap((t) => t.agents || []));
    return (
        <div className="obs-chips">
            <div className="obs-chip"><span className="obs-chip-value">{total}</span><span className="obs-chip-label">协作任务</span></div>
            <div className="obs-chip"><span className="obs-chip-value">{total ? Math.round((ok / total) * 100) : 0}%</span><span className="obs-chip-label">成功率</span></div>
            <div className="obs-chip"><span className="obs-chip-value">{fmtMs(avg)}</span><span className="obs-chip-label">平均任务耗时</span></div>
            <div className="obs-chip"><span className="obs-chip-value">{agents.size}</span><span className="obs-chip-label">参与智能体</span></div>
        </div>
    );
}

/** 属性键值芯片（详情页指标的真实维度值）。 */
function AttrChip({ k, v }) {
    return (
        <span className="obs-attr-chip" title={`${k} = ${v}`}>
            <span className="obs-attr-chip-k">{k}</span>
            <span className="obs-attr-chip-eq">=</span>
            <span className="obs-attr-chip-v">{String(v)}</span>
        </span>
    );
}

/** 信号卡片：一个观测信号的当前采样值 + 专属折线图/直方图（定义见「数据信号字典」页签）。 */
function SignalValueCard({ metric, task, charts, band }) {
    const sampled = (task.signals || [])
        .filter((s) => s.metric === metric.name)
        .flatMap((s) => s.samples || []);
    const line = charts?.lines?.[metric.name];
    const hist = charts?.histograms?.[metric.name];
    return (
        <div className="obs-sigcard">
            <div className="obs-sigcard-head">
                <span className="obs-dict-name">{metric.name}</span>
                <span className="obs-panel-note">
                    {metric.type === 'histogram' ? '直方图' : '计数器'} · 单位 {metric.unit || '—'} · 定义见「数据信号字典」
                </span>
            </div>
            <div className="obs-sigcard-value">
                <span className="obs-attr-row-label">当前值（本任务采样）：</span>
                {sampled.length ? sampled.map((s, i) => (
                    <span key={i} className="obs-sig">
                        <span className="obs-sig-val">{fmtValue(metric.unit, s.value)}</span>
                        <span className="obs-sig-attrs">
                            {Object.entries(s.attributes || {}).map(([k, v]) => (
                                <AttrChip key={k} k={shortAttrKey(k)} v={v} />
                            ))}
                        </span>
                    </span>
                )) : (
                    <span className="obs-sig-none">—（本任务未触发该信号）</span>
                )}
            </div>
            {line && (
                <LineChart
                    title={line.label}
                    unit={line.unit}
                    intervalSec={charts?.intervalSec}
                    series={line.series}
                    band={band}
                />
            )}
            {hist && (
                <HistogramChart
                    title={hist.label}
                    unit={hist.unit}
                    buckets={hist.buckets}
                    sampleCount={hist?.buckets?.reduce((a, b) => a + b.count, 0)}
                />
            )}
        </div>
    );
}

/** Metric 页签内的信号值列表（按维度）。 */
function SignalValueList({ dim, task, charts, band }) {
    const metrics = METRIC_GROUPS.flatMap((g) => g.metrics).filter((m) => m.dim === dim);
    return (
        <>
            {metrics.map((m) => (
                <SignalValueCard key={m.name} metric={m} task={task} charts={charts} band={band} />
            ))}
        </>
    );
}

/** 数据信号字典顶层页签：全部 15 个信号的定义与属性明细（按维度分组）。 */
function DictContent() {
    const groups = METRIC_GROUPS;
    const total = groups.reduce((a, g) => a + g.metrics.length, 0);
    return (
        <>
            <div className="obs-attr-row obs-attr-row-note">
                <span className="obs-attr-row-label">
                    数据信号字典：全部 {total} 个观测信号的定义与属性明细（来源 observability-sdk-java
                    信号目录 a2at.yaml / agent.yaml / workflow.yaml）；采样值与图表见「Metric」页签。
                </span>
            </div>
            {DIM_TABS.map((t) => {
                const dimMetrics = groups.flatMap((g) => g.metrics).filter((m) => m.dim === t.key);
                return (
                    <DimensionBlock key={t.key} label={t.label} note={DIM_NOTES[t.key]}>
                        <div className="obs-panel">
                            <div className="obs-panel-title">
                                <span>数据信号字典 · {t.label}维度（{dimMetrics.length} 个信号）</span>
                                <span className="obs-panel-note">属性明细：属性名 / OTel 全名 / 类型 / 是否必填 / 取值</span>
                            </div>
                            {groups.map((g) => {
                                const gm = g.metrics.filter((m) => m.dim === t.key);
                                if (!gm.length) return null;
                                return (
                                    <div key={g.group} className="obs-dict-group">
                                        <div className="obs-dict-group-title">
                                            {g.group} <span className="obs-panel-note">定义于 {g.source}</span>
                                        </div>
                                        <table className="obs-ops-table obs-dict-table">
                                            <thead>
                                                <tr><th>指标 / Prometheus 序列</th><th>类型 · 单位</th><th>属性信息</th></tr>
                                            </thead>
                                            <tbody>
                                                {gm.map((m) => (
                                                    <tr key={m.name}>
                                                        <td>
                                                            <div className="obs-dict-name">{m.name}</div>
                                                            <div className="obs-dict-prom">
                                                                {m.prom}{m.type === 'histogram' ? '（_bucket / _sum / _count）' : ''}
                                                            </div>
                                                            {m.desc && <div className="obs-dict-desc">含义：{m.desc}</div>}
                                                        </td>
                                                        <td>
                                                            <span className="obs-type-tag">{m.type === 'histogram' ? '直方图' : '计数器'}</span>
                                                            <span className="obs-dict-unit">{m.unit || '—'}</span>
                                                        </td>
                                                        <td>
                                                            <div className="obs-attrs">
                                                                {m.attributes.map((a) => (
                                                                    <div key={a.key} className="obs-attr">
                                                                        <div className="obs-attr-key">
                                                                            <span className="obs-attr-key-name">{a.key}</span>
                                                                            {a.required ? <span className="obs-attr-req">必填</span> : <span className="obs-attr-opt">可选</span>}
                                                                        </div>
                                                                        <div className="obs-attr-otel">
                                                                            {a.otel} · {a.type}{a.values ? ` · 取值：${a.values.join(' / ')}` : ''}
                                                                        </div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                );
                            })}
                        </div>
                    </DimensionBlock>
                );
            })}
        </>
    );
}

function TaskListView({ loading, error, dataset, onOpen, onReload }) {
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const tasks = (dataset?.tasks || []).slice();
    const filtered = tasks.filter((t) => {
        if (statusFilter === 'ok' && t.status === 'error') return false;
        if (statusFilter === 'error' && t.status !== 'error') return false;
        if (!query.trim()) return true;
        const q = query.trim().toLowerCase();
        return [t.title, t.runId, t.taskId, t.taskType, ...(t.agents || [])]
            .some((v) => String(v).toLowerCase().includes(q));
    });
    return (
        <div className="obs-body">
            {loading && !dataset && (
                <div className="obs-list-empty"><div className="obs-spinner" /><p>正在加载协作任务轨迹…</p></div>
            )}
            {error && !dataset && (
                <div className="obs-list-empty">
                    <p className="obs-error-title">协作任务数据加载失败（{error}）</p>
                    <button type="button" className="obs-btn obs-btn-primary" onClick={onReload}><IconRefresh /><span>重试</span></button>
                </div>
            )}
            {dataset && (
                <>
                    <SummaryChips tasks={tasks} />
                    <div className="obs-list-tools">
                        <label className="obs-search">
                            <IconSearch />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="搜索任务 / runId / 智能体"
                            />
                        </label>
                        <div className="obs-filter">
                            {[['all', `全部 ${tasks.length}`], ['ok', `成功 ${tasks.filter((t) => t.status !== 'error').length}`], ['error', `失败 ${tasks.filter((t) => t.status === 'error').length}`]].map(([k, label]) => (
                                <button
                                    key={k}
                                    type="button"
                                    className={`obs-filter-btn ${statusFilter === k ? 'obs-filter-btn-active' : ''}`}
                                    onClick={() => setStatusFilter(k)}
                                >{label}</button>
                            ))}
                        </div>
                        <span className="obs-list-hint">
                            数据源：{dataset.source || 'simulated'} · {dataset.shape || ''}
                        </span>
                    </div>
                    <div className="obs-task-scroll">
                        <div className="obs-task-list">
                            <div className="obs-task-row obs-task-head">
                                <span>协作任务</span><span>类型</span><span>参与智能体</span><span>开始时间</span><span>耗时</span><span>Span</span><span>状态</span><span />
                            </div>
                            {filtered.map((t) => (
                                <div key={t.taskId} className="obs-task-row" onClick={() => onOpen(t)} role="button" tabIndex={0}
                                    onKeyDown={(e) => { if (e.key === 'Enter') onOpen(t); }}>
                                    <div className="obs-task-title">
                                        <span className="obs-task-name">{t.title}</span>
                                        <span className="obs-task-run">{t.runId}</span>
                                    </div>
                                    <span className="obs-type-tag">{TASK_TYPE_LABELS[t.taskType] || t.taskType}</span>
                                    <span className="obs-task-agents">{(t.agents || []).map((a) => AGENT_LABELS[a] || a).join(' · ')}</span>
                                    <span className="obs-task-time">{fmtTime(t.startedAt)}<em>{fmtAgo(t.startedAt)}</em></span>
                                    <span className="obs-task-dur">{fmtMs(t.durationMs)}</span>
                                    <span className="obs-task-spans">{t.spanCount}</span>
                                    <StatusPill status={t.status} />
                                    <span className="obs-task-go"><IconChevronRight /></span>
                                </div>
                            ))}
                            {filtered.length === 0 && <div className="obs-list-empty"><p>没有匹配的任务</p></div>}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

/** 按智能体聚合 Span 统计（Agent 维度）。 */
function agentStats(task) {
    const map = new Map();
    for (const s of task.trace?.spans || []) {
        const e = map.get(s.service) || { service: s.service, spans: 0, messages: 0, totalMs: 0, errors: 0, first: s.startOffsetMs, last: 0 };
        e.spans += 1;
        if (s.kind === 'SERVER') e.messages += 1;
        e.totalMs += s.durationMs;
        if (s.status === 'error') e.errors += 1;
        e.first = Math.min(e.first, s.startOffsetMs);
        e.last = Math.max(e.last, s.startOffsetMs + s.durationMs);
        map.set(s.service, e);
    }
    const totalMs = [...map.values()].reduce((a, e) => a + e.totalMs, 0) || 1;
    return [...map.values()]
        .map((e) => ({ ...e, avgMs: Math.round(e.totalMs / e.spans), share: Math.round((e.totalMs / totalMs) * 100) }))
        .sort((a, b) => b.totalMs - a.totalMs);
}

const COORDINATOR = 'coordinator-agent';

/** 协作拓扑图：协调端 → 参与智能体，边按 span 聚合（消息/流式回传）。 */
function TopologyGraph({ task }) {
    const spans = task.trace?.spans || [];
    const services = [];
    for (const s of spans) if (!services.includes(s.service)) services.push(s.service);
    const agents = services.filter((s) => s !== COORDINATOR);
    if (!services.includes(COORDINATOR) && agents.length > 0) services.unshift(COORDINATOR);

    const W = 460;
    const H = agents.length > 3 ? 250 : 224;
    const coordPos = { x: W / 2, y: 56 };
    const pos = new Map();
    agents.forEach((svc, i) => {
        pos.set(svc, { x: (W / (agents.length + 1)) * (i + 1), y: 176 });
    });

    const serverAgg = new Map();
    const streamAgg = new Map();
    let polls = 0;
    for (const s of spans) {
        if (s.kind === 'SERVER') {
            const e = serverAgg.get(s.service) || { count: 0, totalMs: 0, errors: 0 };
            e.count += 1;
            e.totalMs += s.durationMs;
            if (s.status === 'error') e.errors += 1;
            serverAgg.set(s.service, e);
        } else if (s.operationName === 'SendStreamingMessage-event') {
            streamAgg.set(s.service, (streamAgg.get(s.service) || 0) + 1);
        } else if (s.operationName === 'GetTask') {
            polls += 1;
        }
    }

    const agentLabel = (svc) => AGENT_LABELS[svc] || svc;
    const hasErrorNode = (svc) => (serverAgg.get(svc)?.errors || 0) > 0
        || spans.some((s) => s.service === svc && s.status === 'error');

    return (
        <div className="obs-topo-svg-wrap">
            <svg viewBox={`0 0 ${W} ${H}`} className="obs-topo-svg" role="img" aria-label="协作拓扑图">
                <defs>
                    <marker id="obs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                        <path d="M0 0L10 5L0 10z" fill="#2563eb" />
                    </marker>
                    <marker id="obs-arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                        <path d="M0 0L10 5L0 10z" fill="#94a3b8" />
                    </marker>
                </defs>
                {agents.map((svc) => {
                    const p = pos.get(svc);
                    const agg = serverAgg.get(svc);
                    const err = hasErrorNode(svc);
                    const midX = (coordPos.x + p.x) / 2;
                    const midY = (coordPos.y + p.y) / 2;
                    const label = agg
                        ? `SendMessage ×${agg.count} · ${fmtMs(Math.round(agg.totalMs / agg.count))}`
                        : '';
                    return (
                        <g key={`e-${svc}`}>
                            <line
                                x1={coordPos.x} y1={coordPos.y + 22} x2={p.x} y2={p.y - 24}
                                stroke={err ? '#dc2626' : '#2563eb'} strokeWidth={err ? 2 : 1.6}
                                markerEnd={err ? 'url(#obs-arrow-back)' : 'url(#obs-arrow)'}
                                opacity="0.85"
                            />
                            {label && (
                                <text x={midX} y={midY - 6} textAnchor="middle" className="obs-topo-edge-label" fill={err ? '#dc2626' : 'currentColor'}>
                                    {label}
                                </text>
                            )}
                            {(streamAgg.get(svc) || 0) > 0 && (
                                <g>
                                    <path
                                        d={`M ${p.x + 26} ${p.y - 26} C ${p.x + 60} ${p.y - 80}, ${coordPos.x + 60} ${coordPos.y + 44}, ${coordPos.x + 40} ${coordPos.y + 22}`}
                                        fill="none" stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="4 3"
                                        markerEnd="url(#obs-arrow-back)" opacity="0.8"
                                    />
                                    <text x={(p.x + coordPos.x) / 2 + 58} y={(p.y + coordPos.y) / 2 - 44} textAnchor="middle" className="obs-topo-edge-label" fill="currentColor" opacity="0.7">
                                        流式 ×{streamAgg.get(svc)}
                                    </text>
                                </g>
                            )}
                        </g>
                    );
                })}
                {/* 协调端节点 */}
                <g>
                    <rect x={coordPos.x - 64} y={coordPos.y - 22} width="128" height="44" rx="11" fill="rgba(37,99,235,0.14)" stroke="#2563eb" strokeWidth="1.6" />
                    <text x={coordPos.x} y={coordPos.y - 3} textAnchor="middle" className="obs-topo-node-name">{agentLabel(COORDINATOR)}</text>
                    <text x={coordPos.x} y={coordPos.y + 13} textAnchor="middle" className="obs-topo-node-sub">{COORDINATOR}</text>
                </g>
                {/* 智能体节点 */}
                {agents.map((svc) => {
                    const p = pos.get(svc);
                    const err = hasErrorNode(svc);
                    return (
                        <g key={svc}>
                            <rect
                                x={p.x - 64} y={p.y - 22} width="128" height="44" rx="11"
                                fill={err ? 'rgba(220,38,38,0.12)' : 'rgba(124,58,237,0.12)'}
                                stroke={err ? '#dc2626' : '#7c3aed'} strokeWidth="1.6"
                            />
                            <text x={p.x} y={p.y - 3} textAnchor="middle" className="obs-topo-node-name">{agentLabel(svc)}</text>
                            <text x={p.x} y={p.y + 13} textAnchor="middle" className="obs-topo-node-sub">{svc}</text>
                        </g>
                    );
                })}
            </svg>
            <div className="obs-topo-legend">
                <span><i className="obs-topo-dot" style={{ background: '#2563eb' }} /> 消息流（SendMessage）</span>
                <span><i className="obs-topo-dot" style={{ background: '#94a3b8' }} /> 流式回传 / 轮询{polls > 0 ? `（GetTask ×${polls}）` : ''}</span>
                <span><i className="obs-topo-dot" style={{ background: '#dc2626' }} /> 异常</span>
            </div>
        </div>
    );
}

/** 顶层信号页签：Metric → Trace → Log → 数据信号字典。 */
const SIGNAL_TABS = [
    { key: 'metric', label: 'Metric' },
    { key: 'trace', label: 'Trace' },
    { key: 'log', label: 'Log' },
    { key: 'dict', label: '数据信号字典' },
];

/** 维度子页签：A2A-T 消息 / 协作工作流 / Agent。 */
const DIM_TABS = [
    { key: 'message', label: 'A2A-T 消息' },
    { key: 'workflow', label: '协作工作流' },
    { key: 'agent', label: 'Agent' },
];

/** 按 parentSpanID 构建 Span 挂接树（父 → 子，同级按开始时间排序）。 */
function buildSpanTree(spans) {
    const byId = new Map(spans.map((s) => [s.spanID, s]));
    const children = new Map();
    const roots = [];
    for (const s of spans) {
        const parent = s.parentSpanID && byId.get(s.parentSpanID);
        if (parent) {
            if (!children.has(parent.spanID)) children.set(parent.spanID, []);
            children.get(parent.spanID).push(s);
        } else {
            roots.push(s);
        }
    }
    for (const list of children.values()) list.sort((a, b) => a.startOffsetMs - b.startOffsetMs);
    roots.sort((a, b) => a.startOffsetMs - b.startOffsetMs);
    return { roots, children };
}

/** 可复制的高亮 ID 徽章（TraceID / spanID）。点击复制 ID；冒泡不拦截——
 * 在 Trace 树行内点击时同时触发行选中（复制 + 查看属性两全）。 */
function IdChip({ id, prefix, tone = 'blue' }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        try { navigator.clipboard?.writeText(id); } catch { /* ignore */ }
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    };
    return (
        <span
            className={`obs-idchip obs-idchip-${tone} ${copied ? 'obs-idchip-copied' : ''}`}
            onClick={copy}
            title={`点击复制 ${prefix || 'ID'}：${id}`}
            role="button"
        >
            {prefix ? <span className="obs-idchip-prefix">{prefix}</span> : null}
            <span className="obs-idchip-text">{id}</span>
            {copied && <span className="obs-idchip-copied">已复制</span>}
        </span>
    );
}

/** 单条日志行：点击整行或「属性」按钮，在右侧属性查看器查看该日志属性；
 * selected=true 时行保持选中高亮。
 */
function LogRow({ log, onSelect, selected }) {
    const attrs = log.attributes || {};
    const hasAttrs = Object.keys(attrs).length > 0;
    const rowClick = (e) => {
        e.stopPropagation();
        onSelect?.(log);
    };
    return (
        <div
            className={`obs-logline ${selected ? 'obs-logline-sel' : ''}`}
            onClick={rowClick}
            role="button"
            tabIndex={0}
            title={hasAttrs ? '点击行查看该日志的属性' : undefined}
            onKeyDown={(e) => { if (e.key === 'Enter' && hasAttrs) { e.stopPropagation(); onSelect?.(log); } }}
        >
            <span className={`obs-logline-text ${log.severity === 'ERROR' ? 'obs-log-err' : ''}`}>
                [+{pad2(Math.floor((log.offsetMs || 0) / 60000))}:{pad2(Math.floor(((log.offsetMs || 0) % 60000) / 1000))}] {log.severity} {log.name} — {log.body}（{AGENT_LABELS[log.service] || log.service}）
            </span>
            {hasAttrs && onSelect && (
                <button
                    type="button"
                    className="obs-log-attrbtn"
                    onClick={(e) => { e.stopPropagation(); onSelect(log); }}
                    title="在右侧查看该日志的属性"
                >
                    属性
                </button>
            )}
        </div>
    );
}

/** Trace 视图：按 Span 挂接关系（父子嵌套）展示，每个节点带内联时间条；
 * 节点可展开「关联日志」（log.spanID ↔ span.spanID 的上下文关联）；
 * 「属性」按钮把 Span/日志送入右侧属性查看器（onSelectSpan / onSelectLog）。
 */
function SpanTree({ task, onSelectSpan, onSelectLog, sel }) {
    const logs = task.logs || [];
    const spans = task.trace?.spans || [];
    const total = Math.max(task.durationMs, 1);
    const logsBySpan = new Map();
    for (const l of logs) {
        if (!l.spanID) continue;
        if (!logsBySpan.has(l.spanID)) logsBySpan.set(l.spanID, []);
        logsBySpan.get(l.spanID).push(l);
    }
    const [openSpans, setOpenSpans] = useState({});
    const { roots, children } = buildSpanTree(spans);

    // 统计条 + 日志一键收展（瀑布图上方）
    const logSpans = spans.filter((s) => (logsBySpan.get(s.spanID) || []).length > 0);
    const allOpen = logSpans.length > 0 && logSpans.every((s) => openSpans[s.spanID] ?? true);
    const errCount = spans.filter((s) => s.status === 'error').length;
    const svcCount = new Set(spans.map((s) => s.service)).size;
    const toggleAllLogs = () => setOpenSpans(allOpen ? Object.fromEntries(logSpans.map((s) => [s.spanID, false])) : {});

    const renderRow = (s, depth) => {
        const kids = children.get(s.spanID) || [];
        const logsFor = logsBySpan.get(s.spanID) || [];
        const tagKeys = Object.keys(s.tags || {});
        // 关联日志默认展开（未手动切换过时 open=true）
        const open = openSpans[s.spanID] ?? true;
        // 选中态：当前查看的 Span 行高亮
        const isSel = sel?.kind === 'span' && sel.spanRef === s;
        return (
            <div key={s.spanID}>
                <div
                    className={`obs-tree-row ${s.status === 'error' ? 'obs-tree-row-err' : ''} ${isSel ? 'obs-tree-row-sel' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onSelectSpan?.(s); }}
                    role="button"
                    tabIndex={0}
                    title="点击行在右侧查看该 Span 的属性"
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onSelectSpan?.(s); } }}
                >
                <div className="obs-tree-row-inner">
                    <div className="obs-tree-main" style={{ marginLeft: depth * 16 }}>
                        <KindBadge kind={s.kind} />
                        <span className="obs-tree-op">{s.operationName}</span>
                        <span className="obs-wf-service">{AGENT_LABELS[s.service] || s.service}</span>
                        {s.status === 'error' && s.tags?.['error.type'] && (
                            <span className="obs-pill obs-pill-err">{s.tags['error.type']}</span>
                        )}
                    </div>
                    <IdChip id={s.spanID} prefix="spanID" tone="indigo" />
                    <div className="obs-tree-bar-wrap">
                        <span className="obs-tree-bar-track">
                            <span
                                className={`obs-wf-bar obs-wf-bar-${(s.kind || 'INTERNAL').toLowerCase()} ${s.status === 'error' ? 'obs-wf-bar-err' : ''}`}
                                style={{ left: `${(s.startOffsetMs / total) * 100}%`, width: `${Math.max((s.durationMs / total) * 100, 1.5)}%` }}
                            />
                        </span>
                    </div>
                    <span className="obs-wf-dur">{fmtMs(s.durationMs)}</span>
                    <div className="obs-tree-logcol">
                        {tagKeys.length > 0 && onSelectSpan && (
                            <button
                                type="button"
                                className="obs-btn obs-tree-logbtn"
                                onClick={(e) => { e.stopPropagation(); onSelectSpan(s); }}
                                title="在右侧属性查看器中显示该 Span 的属性"
                            >
                                属性 {tagKeys.length}
                            </button>
                        )}
                        {logsFor.length > 0 && (
                            <button
                                type="button"
                                className={`obs-btn obs-tree-logbtn ${open ? 'obs-tree-logbtn-open' : ''}`}
                                onClick={(e) => { e.stopPropagation(); setOpenSpans((v) => ({ ...v, [s.spanID]: !open })); }}
                                title={open ? '收起该 Span 挂接的日志' : '展开该 Span 挂接的日志'}
                            >
                                {open ? '收起日志' : '关联日志'} {logsFor.length}
                            </button>
                        )}
                    </div>
                </div>
                </div>
                {open && logsFor.length > 0 && (
                    <div className="obs-tree-logs" style={{ marginLeft: depth * 16 + 20 }}>
                        {logsFor.map((l, i) => (
                            <LogRow key={i} log={l} onSelect={onSelectLog} selected={sel?.kind === 'log' && sel.logRef === l} />
                        ))}
                    </div>
                )}
                {kids.length > 0 && (
                    <div className="obs-tree-children">
                        {kids.map((k) => renderRow(k, depth + 1))}
                    </div>
                )}
            </div>
        );
    };

    const statsRow = (
        <div className="obs-chips obs-trace-stats">
            <div className="obs-chip">
                <span className="obs-chip-value">{spans.length}</span>
                <span className="obs-chip-label">Span 总数</span>
            </div>
            <div className="obs-chip">
                <span className="obs-chip-value" style={errCount > 0 ? { color: '#dc2626' } : undefined}>{errCount}</span>
                <span className="obs-chip-label">错误 Span</span>
            </div>
            <div className="obs-chip">
                <span className="obs-chip-value">{svcCount}</span>
                <span className="obs-chip-label">协作智能体</span>
            </div>
            {logs.length > 0 && (
                <button
                    type="button"
                    className="obs-btn obs-trace-logtoggle"
                    onClick={toggleAllLogs}
                    title={allOpen ? '一键收起所有 Span 挂接的日志' : '一键展开所有 Span 挂接的日志'}
                    style={{ marginLeft: 'auto', alignSelf: 'center' }}
                >
                    {allOpen ? '全部收起日志' : '全部展开日志'}
                </button>
            )}
        </div>
    );
    return (
        <>
            {statsRow}
            {roots.length
                ? <div className="obs-tree">{roots.map((r) => renderRow(r, 0))}</div>
                : <span className="obs-sig-none">本任务无 Span 数据</span>}
        </>
    );
}

/** 日志列表（按信号类别过滤：message / workflow / agent）。 */
function LogList({ logs, category, onSelect, sel }) {
    // 分类映射：workflow 组收编 step、agent 组收编 substep，未知类别兜底进 workflow 组，保证每条日志必归一组
    const rows = (logs || []).filter((l) => {
        const cat = l.category || 'message';
        if (category === 'message') return cat === 'message';
        if (category === 'agent') return cat === 'agent' || cat === 'substep';
        return cat === 'workflow' || cat === 'step' || !(cat === 'message' || cat === 'agent' || cat === 'substep');
    });
    return (
        <div className="obs-logs">
            {rows.length ? rows.map((log, i) => (
                <LogRow key={i} log={log} onSelect={onSelect} selected={sel?.kind === 'log' && sel.logRef === log} />
            )) : <span className="obs-sig-none">本任务无该类日志</span>}
        </div>
    );
}

/** Metric 顶层页签内容：按维度子页签展示该维度的指标采样值、采集周期图表与字典。 */
function MetricContent({ dim, task, charts }) {
    const band = Number.isNaN(Date.parse(task.startedAt))
        ? null
        : { from: Date.parse(task.startedAt), to: Date.parse(task.startedAt) + task.durationMs };
    if (dim === 'workflow') {
        const m = task.metrics || {};
        const dur = m.taskDuration || {};
        return (
            <>
                <div className="obs-metric-grid">
                    <div className="obs-chip"><span className="obs-chip-value">{m.taskCount ?? '—'}</span><span className="obs-chip-label">任务计数 · task.count</span></div>
                    <div className="obs-chip"><span className="obs-chip-value">{fmtMs(dur.avg)}</span><span className="obs-chip-label">任务时长均值 · task.duration</span></div>
                    <div className="obs-chip"><span className="obs-chip-value">{fmtMs(dur.p95)}</span><span className="obs-chip-label">P95 任务时长</span></div>
                    <div className="obs-chip"><span className="obs-chip-value">{task.spanCount}</span><span className="obs-chip-label">Span 数</span></div>
                </div>
                <div className="obs-attr-row obs-attr-row-note">
                    <span className="obs-attr-row-label">task.duration / task.count 维度属性：</span>
                    <AttrChip k="extension.name" v="task-t" />
                    <AttrChip k="task.type" v={task.taskType} />
                    <AttrChip k="task.object" v={task.runId} />
                </div>
                {m.promql && (
                    <div className="obs-panel">
                        <div className="obs-panel-title"><span>PromQL（真实栈查询）</span></div>
                        <div className="obs-promql">
                            {m.promql.duration}<br />
                            {m.promql.count}
                        </div>
                    </div>
                )}
                <SignalValueList dim="workflow" task={task} charts={charts} band={band} />
            </>
        );
    }
    if (dim === 'agent') {
        const stats = agentStats(task);
        const total = Math.max(task.durationMs, 1);
        return (
            <>
                <div className="obs-metric-grid">
                    <div className="obs-chip"><span className="obs-chip-value">{stats.length}</span><span className="obs-chip-label">参与智能体</span></div>
                    <div className="obs-chip"><span className="obs-chip-value">{stats.filter((e) => e.errors > 0).length}</span><span className="obs-chip-label">异常智能体</span></div>
                    <div className="obs-chip"><span className="obs-chip-value">{stats.reduce((a, e) => a + e.messages, 0)}</span><span className="obs-chip-label">处理消息总数</span></div>
                </div>
                <div className="obs-panel">
                    <div className="obs-panel-title">
                        <span>智能体负载 · 按 Span 耗时占比</span>
                        <span className="obs-panel-note">总观测窗口 {fmtMs(total)}</span>
                    </div>
                    <table className="obs-ops-table">
                        <thead><tr><th>智能体</th><th>Span</th><th>处理消息</th><th>累计耗时</th><th>平均耗时</th><th>负载占比</th><th>异常</th></tr></thead>
                        <tbody>
                            {stats.map((e) => (
                                <tr key={e.service}>
                                    <td>
                                        <div className="obs-agent-cell">
                                            <span>{AGENT_LABELS[e.service] || e.service}</span>
                                            <AttrChip k="gen_ai.agent.name" v={e.service} />
                                        </div>
                                    </td>
                                    <td>{e.spans}</td>
                                    <td>{e.messages}</td>
                                    <td>{fmtMs(e.totalMs)}</td>
                                    <td>{fmtMs(e.avgMs)}</td>
                                    <td>
                                        <div className="obs-load">
                                            <div className="obs-load-bar"><span style={{ width: `${e.share}%` }} /></div>
                                            <span className="obs-load-num">{e.share}%</span>
                                        </div>
                                    </td>
                                    <td>{e.errors > 0 ? <span className="obs-pill obs-pill-err">{e.errors}</span> : '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <SignalValueList dim="agent" task={task} charts={charts} band={band} />
            </>
        );
    }
    // A2A-T 消息（默认）
    const spans = task.trace?.spans || [];
    const m = task.metrics || {};
    const handled = spans.filter((s) => s.kind === 'SERVER');
    const sent = spans.filter((s) => s.kind === 'CLIENT' && s.operationName === 'SendMessage');
    const streamEvents = spans.filter((s) => s.operationName === 'SendStreamingMessage-event').length;
    const errCount = spans.filter((s) => s.status === 'error').length;
    const handledAvg = handled.length ? Math.round(handled.reduce((a, s) => a + s.durationMs, 0) / handled.length) : 0;
    return (
        <>
            <div className="obs-metric-grid">
                <div className="obs-chip"><span className="obs-chip-value">{handled.length}</span><span className="obs-chip-label">处理消息 · SendMessage(S)</span></div>
                <div className="obs-chip"><span className="obs-chip-value">{sent.length}</span><span className="obs-chip-label">发起消息 · SendMessage(C)</span></div>
                <div className="obs-chip"><span className="obs-chip-value">{fmtMs(handledAvg)}</span><span className="obs-chip-label">平均消息处理耗时</span></div>
                <div className="obs-chip"><span className="obs-chip-value">{streamEvents}</span><span className="obs-chip-label">流式事件 · streaming</span></div>
                <div className="obs-chip"><span className="obs-chip-value">{errCount}</span><span className="obs-chip-label">异常 span · error.type</span></div>
            </div>
            <div className="obs-panel">
                <div className="obs-panel-title">
                    <span>A2A 协议操作指标 · gen_ai.client.operation.duration</span>
                    <span className="obs-panel-note">单位 s</span>
                </div>
                <table className="obs-ops-table">
                    <thead><tr><th>操作</th><th>维度属性</th><th>次数</th><th>平均耗时</th></tr></thead>
                    <tbody>
                        {(m.operations || []).map((op) => (
                            <tr key={op.operation}>
                                <td>{op.operation}</td>
                                <td>
                                    <div className="obs-attr-row">
                                        <AttrChip k="operation.name" v={op.operation} />
                                        <AttrChip k="gen_ai.system" v="A2A" />
                                    </div>
                                </td>
                                <td>{op.count}</td>
                                <td>{op.avgDurationS} s</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <SignalValueList dim="message" task={task} charts={charts} band={band} />
        </>
    );
}

const DIM_NOTES = {
    message: '消息收发与协议操作（SendMessage / GetTask / 流式事件）',
    workflow: '协作任务与工作流步骤（task / workflow / negotiation）',
    agent: '智能体子步骤、Token 用量与授权',
};

const LOG_TITLES = {
    message: '消息日志 · gen_ai.agent.a2at.message',
    workflow: '工作流日志 · gen_ai.agent.a2at.workflow / gen_ai.agent.a2at.step',
    agent: '智能体日志 · gen_ai.agent.a2at.agent / gen_ai.agent.a2at.substep',
};

/** 右侧属性查看器：统一显示 Span / 日志的属性（属性名 + 值 表格）。 */
function AttrInspector({ sel }) {
    const attrs = sel?.attrs || {};
    const keys = Object.keys(attrs).sort();
    // Span 公共字段摘要（SigNoz 式）：仅当选中的是 Span 时显示
    const spanRef = sel?.kind === 'span' ? sel.spanRef : null;
    const kindLabel = spanRef
        ? ({ INTERNAL: 'Internal', CLIENT: 'Client', SERVER: 'Server', PRODUCER: 'Provider', CONSUMER: 'Consumer' })[spanRef.kind] || spanRef.kind || 'Internal'
        : null;
    const startAbs = spanRef && sel.traceStartISO ? new Date(Date.parse(sel.traceStartISO) + (spanRef.startOffsetMs || 0)) : null;
    return (
        <div className="obs-panel obs-attrinspector">
            <div className="obs-prom-panel-head">
                <div className="obs-prom-panel-title">
                    <span className="obs-prom-expr">{sel?.title || '属性查看器'}</span>
                    <span className="obs-prom-panel-sub">
                        {sel ? '属性明细（属性名 / 值）' : '点击左侧 Span 行或日志行的「属性」在此查看属性明细'}
                    </span>
                </div>
                {sel?.id && <IdChip id={sel.id} prefix={sel.kind === 'span' ? 'spanID' : 'log'} tone={sel.kind === 'span' ? 'indigo' : 'blue'} />}
            </div>
            {spanRef && (
                <div className="obs-spanmeta">
                    <div className="obs-spanmeta-item">
                        <span className="obs-spanmeta-k">本span用时</span>
                        <span className="obs-spanmeta-v">{fmtMs(spanRef.durationMs)}</span>
                    </div>
                    <div className="obs-spanmeta-item">
                        <span className="obs-spanmeta-k">总用时占比</span>
                        <span className="obs-spanmeta-v">
                            {spanRef.durationMs == null ? '—' : `${Math.round((spanRef.durationMs / (sel.totalMs || 1)) * 100)}%`}
                        </span>
                    </div>
                    <div className="obs-spanmeta-item">
                        <span className="obs-spanmeta-k">执行时刻</span>
                        <span className="obs-spanmeta-v">
                            {startAbs ? `${fmtTime(startAbs)}（+${spanRef.startOffsetMs || 0} ms）` : `+${spanRef.startOffsetMs || 0} ms`}
                        </span>
                    </div>
                    <div className="obs-spanmeta-item">
                        <span className="obs-spanmeta-k">类型</span>
                        <span className="obs-spanmeta-v"><KindBadge kind={spanRef.kind} />{kindLabel}</span>
                    </div>
                    <div className="obs-spanmeta-item">
                        <span className="obs-spanmeta-k">状态</span>
                        <span className="obs-spanmeta-v"><StatusPill status={spanRef.status} /></span>
                    </div>
                </div>
            )}
            {sel && keys.length > 0 && (
                <table className="obs-ops-table obs-span-attrtable">
                    <thead><tr><th>属性</th><th>值</th></tr></thead>
                    <tbody>
                        {keys.map((k) => (
                            <tr key={k}>
                                <td className="obs-prom-mono">{k}</td>
                                <td>{String(attrs[k])}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {sel && keys.length === 0 && <span className="obs-sig-none">该记录无属性</span>}
            {!sel && <span className="obs-sig-none">未选择属性对象</span>}
        </div>
    );
}

/** Trace 顶层页签内容：Span 挂接树（父子嵌套 + 关联日志）。 */
function TraceContent({ task }) {
    const [sel, setSel] = useState(null);
    const selSpan = (s) => setSel({
        kind: 'span',
        title: `Span 属性 · ${s.operationName}（${AGENT_LABELS[s.service] || s.service}）`,
        id: s.spanID,
        attrs: s.tags || {},
        spanRef: s,
        totalMs: Math.max(task.durationMs, 1),
        traceStartISO: task.startedAt,
    });
    const selLog = (l) => setSel({
        kind: 'log',
        title: `日志属性 · ${l.name}`,
        id: l.spanID || l.name,
        attrs: l.attributes || {},
        logRef: l,
    });
    return (
        <div className="obs-split">
            <div className="obs-panel obs-split-left">
                <div className="obs-prom-panel-head">
                    <div className="obs-prom-panel-title">
                        <span className="obs-prom-expr">协作任务 Trace · 观测信号挂接关系</span>
                        <span className="obs-prom-panel-sub">按 Span 挂接关系（父子嵌套）展示 · 点「收起日志」折叠 · Jaeger v2 → OpenSearch jaeger-*</span>
                    </div>
                    {task.trace?.traceID && <IdChip id={task.trace.traceID} prefix="TraceID" tone="blue" />}
                </div>
                <SpanTree task={task} onSelectSpan={selSpan} onSelectLog={selLog} sel={sel} />
            </div>
            <AttrInspector sel={sel} />
        </div>
    );
}

/** Log 顶层页签：三个维度区块共享右侧唯一一个属性查看器。 */
function LogTab({ task }) {
    const [sel, setSel] = useState(null);
    const selLog = (l) => setSel({
        kind: 'log',
        title: `日志属性 · ${l.name}`,
        id: l.spanID || l.name,
        attrs: l.attributes || {},
        logRef: l,
    });
    return (
        <div className="obs-split">
            <div className="obs-split-left">
                {DIM_TABS.map((t) => (
                    <DimensionBlock key={t.key} label={t.label} note={DIM_NOTES[t.key]}>
                        <div className="obs-panel">
                            <div className="obs-prom-panel-head">
                                <div className="obs-prom-panel-title">
                                    <span className="obs-prom-expr">{LOG_TITLES[t.key] || t.key}</span>
                                    <span className="obs-prom-panel-sub">索引 a2at-logs-v2 · Data Prepper → OpenSearch</span>
                                </div>
                            </div>
                            <LogList logs={task.logs} category={t.key} onSelect={selLog} sel={sel} />
                        </div>
                    </DimensionBlock>
                ))}
            </div>
            <AttrInspector sel={sel} />
        </div>
    );
}

/* ======================= Metric 页签（Prometheus 式信息架构，系统现有样式） ======================= */

/** Prometheus 式折线：x 轴三刻度 + 当前任务时间带（样式与系统一致）。 */
function PromGraph({ line, band }) {
    const series = line.series;
    const all = series.flatMap((s) => s.points);
    const t0 = Math.min(...all.map((p) => p.t));
    const t1 = Math.max(...all.map((p) => p.t));
    const vMax = Math.max(...all.map((p) => p.v), 1) * 1.15;
    const w = 440;
    const h = 120;
    const padL = 46;
    const padR = 10;
    const padT = 12;
    const padB = 20;
    const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (w - padL - padR);
    const Y = (v) => padT + (1 - v / vMax) * (h - padT - padB);
    const bandRect = band ? { x1: X(Math.max(band.from, t0)), x2: X(Math.min(band.to, t1)) } : null;
    const fmtT = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
    return (
        <>
            <svg viewBox={`0 0 ${w} ${h}`} className="obs-chart-svg obs-prom-chartsvg" role="img" aria-label={line.label}>
                {bandRect && bandRect.x2 > bandRect.x1 && (
                    <rect x={bandRect.x1} y={padT} width={Math.max(bandRect.x2 - bandRect.x1, 2)} height={h - padT - padB} fill="rgba(37, 99, 235, 0.08)" />
                )}
                {[0.25, 0.5, 0.75, 1].map((f, i) => {
                    const v = vMax * f;
                    return (
                        <g key={i}>
                            <line x1={padL} y1={Y(v)} x2={w - padR} y2={Y(v)} stroke="rgba(127, 127, 127, 0.18)" strokeWidth="1" />
                            <text x={padL - 6} y={Y(v) + 3} textAnchor="end" className="obs-chart-ylabel">{fmtChartNum(v, line.unit)}</text>
                        </g>
                    );
                })}
                <line x1={padL} y1={Y(0)} x2={w - padR} y2={Y(0)} stroke="rgba(127, 127, 127, 0.4)" strokeWidth="1" />
                {series.map((s) => (
                    <g key={s.prom || s.name}>
                        <path
                            d={s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')}
                            fill="none" stroke={s.color} strokeWidth="1.8" strokeLinejoin="round"
                        />
                    </g>
                ))}
                <text x={padL} y={h - 8} className="obs-chart-xlabel">{fmtT(t0)}</text>
                <text x={w / 2} y={h - 8} textAnchor="middle" className="obs-chart-xlabel">{fmtT((t0 + t1) / 2)}</text>
                <text x={w - padR} y={h - 8} textAnchor="end" className="obs-chart-xlabel">{fmtT(t1)}</text>
            </svg>
        </>
    );
}

/** legend 表：series（Prom 序列名）+ avg/max/last 统计。 */
function PromLegend({ line }) {
    return (
        <table className="obs-ops-table obs-prom-legend">
            <thead><tr><th /> <th>series</th><th>avg</th><th>max</th><th>last</th></tr></thead>
            <tbody>
                {line.series.map((s) => {
                    const vs = s.points.map((p) => p.v);
                    const st = { avg: vs.reduce((a, b) => a + b, 0) / vs.length, max: Math.max(...vs), last: vs[vs.length - 1] };
                    return (
                        <tr key={s.prom || s.name}>
                            <td><i className="obs-prom-swatch" style={{ background: s.color }} /></td>
                            <td className="obs-prom-mono">{s.prom || s.name}</td>
                            <td>{fmtChartNum(st.avg, line.unit)}</td>
                            <td>{fmtChartNum(st.max, line.unit)}</td>
                            <td>{fmtChartNum(st.last, line.unit)}</td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

/** 直方图（le 桶柱状，系统蓝；绘图区与折线图同边界，X 轴对齐）。 */
function PromHistogram({ hist }) {
    const buckets = hist.buckets;
    const max = Math.max(...buckets.map((b) => b.count), 1);
    const w = 440;
    const h = 120;
    const padL = 46;
    const padR = 10;
    const padT = 14;
    const padB = 20;
    const n = buckets.length;
    const slot = (w - padL - padR) / n;
    const barW = Math.min(slot * 0.62, 44);
    const prevLe = buckets.length >= 2 ? buckets[n - 2].le : null;
    return (
        <div className="obs-prom-histwrap">
            <svg viewBox={`0 0 ${w} ${h}`} className="obs-chart-svg obs-prom-chartsvg" role="img" aria-label={hist.label}>
                {buckets.map((b, i) => {
                    const bh = (b.count / max) * (h - padT - padB);
                    const x = padL + slot * i + (slot - barW) / 2;
                    const y = h - padB - bh;
                    return (
                        <g key={i}>
                            {bh > 0 && <rect x={x} y={y} width={barW} height={bh} rx="3" fill="#2563eb" opacity="0.85" />}
                            <text x={x + barW / 2} y={y - 5} textAnchor="middle" className="obs-chart-barlabel">{b.count}</text>
                            <text x={x + barW / 2} y={h - 8} textAnchor="middle" className="obs-chart-xlabel">
                                {b.inf ? `>${prevLe != null ? fmtChartNum(prevLe, hist.unit) : '∞'}` : `≤${fmtChartNum(b.le, hist.unit)}`}
                            </text>
                        </g>
                    );
                })}
                <line x1={padL} y1={h - padB} x2={w - padR} y2={h - padB} stroke="rgba(127, 127, 127, 0.4)" strokeWidth="1" />
            </svg>
        </div>
    );
}

/** Metric 顶层页签：Prometheus 式信息架构 —— 观测信号选择 + Graph/Table 面板 + 指标浏览表。 */
function MetricPromTab({ task, dataset }) {
    const charts = dataset?.charts;
    const collection = dataset?.collection;
    const allMetrics = METRIC_GROUPS.flatMap((g) => g.metrics);
    const [expr, setExpr] = useState('gen_ai.agent.a2at.task.duration');
    const [view, setView] = useState('graph'); // graph | table
    const [dimFilter, setDimFilter] = useState('all');
    const metric = allMetrics.find((m) => m.name === expr) || allMetrics[0];
    const line = charts?.lines?.[metric?.name];
    const hist = charts?.histograms?.[metric?.name];
    const band = Number.isNaN(Date.parse(task.startedAt))
        ? null
        : { from: Date.parse(task.startedAt), to: Date.parse(task.startedAt) + task.durationMs };
    const sampled = (task.signals || []).filter((s) => s.metric === metric?.name).flatMap((s) => s.samples || []);
    const dimName = { message: 'A2A-T 消息', workflow: '协作工作流', agent: 'Agent' };
    const filtered = allMetrics.filter((m) => dimFilter === 'all' || m.dim === dimFilter);
    const allTaskSamples = (dataset?.tasks || []).flatMap((tk) => (tk.signals || [])
        .filter((s) => s.metric === metric?.name)
        .flatMap((s) => s.samples.map((sm) => ({ runId: tk.runId, value: sm.value, attributes: sm.attributes }))));
    const rangeLabel = collection ? (collection.windowMin >= 60 ? `${collection.windowMin / 60}h` : `${collection.windowMin}m`) : '2h';

    return (
        <>
            <div className="obs-panel obs-prom-toolbar">
                <div className="obs-prom-toolbar-row">
                    <span className="obs-attr-row-label">观测信号选择：</span>
                    <select
                        className="obs-prom-input"
                        value={expr}
                        onChange={(e) => setExpr(e.target.value)}
                        aria-label="观测信号选择"
                        title="选择观测信号，图表即时刷新"
                    >
                        {DIM_TABS.map((t) => (
                            <optgroup key={t.key} label={t.label}>
                                {allMetrics.filter((m) => m.dim === t.key).map((m) => (
                                    <option key={m.name} value={m.name}>{m.name}</option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                    <div className="obs-prom-meta">
                        <AttrChip k="采集周期" v={`${collection?.intervalSec}s`} />
                        <AttrChip k="范围" v={rangeLabel} />
                        <span className="obs-panel-note">{collection?.storage || 'Prometheus / Thanos'}</span>
                    </div>
                </div>
            </div>

            <div className="obs-panel">
                <div className="obs-prom-panel-head">
                    <div className="obs-prom-panel-title">
                        <span className="obs-prom-expr">{expr}</span>
                        <span className="obs-prom-panel-sub">
                            {metric?.type === 'histogram' ? '直方图' : '计数器'} · 单位 {metric?.unit || '—'} · {line?.label}
                        </span>
                    </div>
                    <div className="obs-filter">
                        {[['graph', '图表'], ['table', '表格']].map(([v, label]) => (
                            <button
                                key={v}
                                type="button"
                                className={`obs-filter-btn ${view === v ? 'obs-filter-btn-active' : ''}`}
                                onClick={() => setView(v)}
                            >{label}</button>
                        ))}
                    </div>
                </div>
                {metric?.desc && <div className="obs-prom-desc">含义：{metric.desc}</div>}
                {view === 'graph' && line && (
                    <>
                        <div className="obs-prom-charts-grid">
                            <div className="obs-chart-cell">
                                <div className="obs-chart-cell-title">折线图 · {line.label}</div>
                                <PromGraph line={line} band={band} />
                            </div>
                            {hist && (
                                <div className="obs-chart-cell">
                                    <div className="obs-chart-cell-title">直方图 · {hist.label}</div>
                                    <PromHistogram hist={hist} />
                                </div>
                            )}
                        </div>
                        <PromLegend line={line} />
                    </>
                )}
                {view === 'table' && (
                    <table className="obs-ops-table obs-prom-table">
                        <thead><tr><th>任务</th><th>维度属性</th><th>值</th></tr></thead>
                        <tbody>
                            {allTaskSamples.map((r, i) => (
                                <tr key={i}>
                                    <td className="obs-prom-mono">{r.runId}</td>
                                    <td>
                                        <div className="obs-attr-row">
                                            {Object.entries(r.attributes || {}).map(([k, v]) => (
                                                <AttrChip key={k} k={shortAttrKey(k)} v={v} />
                                            ))}
                                        </div>
                                    </td>
                                    <td><span className="obs-sig-val">{fmtValue(metric?.unit, r.value)}</span></td>
                                </tr>
                            ))}
                            {!allTaskSamples.length && (
                                <tr><td colSpan="3" className="obs-sig-none">—（本任务未触发该信号）</td></tr>
                            )}
                        </tbody>
                    </table>
                )}
            </div>

            <div className="obs-panel">
                <div className="obs-prom-panel-head">
                    <div className="obs-prom-panel-title">
                        <span className="obs-prom-expr">查询结果 · {allMetrics.length} 个信号</span>
                        <span className="obs-prom-panel-sub">点击行切换上方图表；按维度过滤</span>
                    </div>
                    <div className="obs-filter">
                        {[['all', '全部'], ...DIM_TABS.map((t) => [t.key, t.label])].map(([k, label]) => (
                            <button
                                key={k}
                                type="button"
                                className={`obs-filter-btn ${dimFilter === k ? 'obs-filter-btn-active' : ''}`}
                                onClick={() => setDimFilter(k)}
                            >{label}</button>
                        ))}
                    </div>
                </div>
                <table className="obs-ops-table obs-prom-table">
                    <thead><tr><th>维度</th><th>指标</th><th>类型</th><th>单位</th><th>当前值（本任务）</th></tr></thead>
                    <tbody>
                        {filtered.map((m) => {
                            const vals = (task.signals || []).filter((s) => s.metric === m.name).flatMap((s) => s.samples || []);
                            const isSel = m.name === metric?.name;
                            return (
                                <tr
                                    key={m.name}
                                    className={`obs-prom-row ${isSel ? 'obs-prom-row-sel' : ''}`}
                                    onClick={() => setExpr(m.name)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => { if (e.key === 'Enter') setExpr(m.name); }}
                                >
                                    <td>{dimName[m.dim] || m.dim}</td>
                                    <td className="obs-prom-mono obs-prom-mname">{m.name}</td>
                                    <td>{m.type === 'histogram' ? '直方图' : '计数器'}</td>
                                    <td>{m.unit || '—'}</td>
                                    <td>
                                        {vals.length
                                            ? vals.map((s, i) => <span key={i} className="obs-sig-val" style={{ marginRight: 10 }}>{fmtValue(m.unit, s.value)}</span>)
                                            : <span className="obs-sig-none">未触发</span>}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </>
    );
}

/** 维度区块头（同一页签内纵向排布的维度分区）。 */
function DimensionBlock({ label, note, children }) {
    return (
        <div className="obs-dimblock">
            <div className="obs-dimblock-head">
                <span className="obs-dimblock-name">{label}</span>
                {note && <span className="obs-panel-note">{note}</span>}
            </div>
            {children}
        </div>
    );
}

function TaskDetailView({ task, dataset, onBack }) {
    const [signal, setSignal] = useState('metric'); // 顶层：metric | trace | log
    const [topoOpen, setTopoOpen] = useState(false); // 默认折叠为左侧窄条
    const collection = dataset?.collection;
    return (
        <div className="obs-body">
            <div className="obs-detail-head">
                <button type="button" className="obs-btn" onClick={onBack}><IconChevronLeft /><span>返回列表</span></button>
                <div className="obs-detail-title">
                    <span className="obs-task-name">{task.title}</span>
                    <span className="obs-task-meta">
                        {task.runId} · {task.taskId} · 开始 {fmtTime(task.startedAt)}（{fmtAgo(task.startedAt)}）· 总耗时 {fmtMs(task.durationMs)}
                    </span>
                </div>
                <StatusPill status={task.status} />
            </div>

            <div className={`obs-detail-layout ${topoOpen ? '' : 'obs-detail-layout-collapsed'}`}>
                {topoOpen ? (
                    <div className="obs-topo">
                        <div className="obs-panel-title">
                            <span>协作拓扑图</span>
                            <span className="obs-panel-note">按 Trace Span 聚合</span>
                            <button
                                type="button"
                                className="obs-btn obs-topo-toggle"
                                onClick={() => setTopoOpen(false)}
                                title="收起协作拓扑图（收起到左侧窄条）"
                            >
                                收起 ‹
                            </button>
                        </div>
                        <TopologyGraph task={task} />
                    </div>
                ) : (
                    <div className="obs-topo obs-topo-rail">
                        <button
                            type="button"
                            className="obs-btn obs-topo-rail-expand"
                            onClick={() => setTopoOpen(true)}
                            title="展开协作拓扑图"
                        >
                            »
                        </button>
                        <span className="obs-topo-rail-label">协作拓扑图</span>
                    </div>
                )}
                <div className="obs-dim">
                    <div className="obs-dim-tabs">
                        {SIGNAL_TABS.map((t) => (
                            <button
                                key={t.key}
                                type="button"
                                className={`obs-dim-tab ${signal === t.key ? 'obs-dim-tab-active' : ''}`}
                                onClick={() => setSignal(t.key)}
                            >{t.label}</button>
                        ))}
                    </div>
                    {signal === 'metric' && collection && (
                        <div className="obs-attr-row obs-attr-row-note obs-collection-row">
                            <span className="obs-attr-row-label">采集周期：</span>
                            <AttrChip k="interval" v={`${collection.intervalSec}s`} />
                            <AttrChip k="折线窗口" v={`最近 ${collection.windowMin >= 60 ? `${collection.windowMin / 60} 小时` : `${collection.windowMin} 分钟`}`} />
                            <AttrChip k="保留" v={`${collection.retentionHours}h`} />
                            <span className="obs-panel-note">{collection.note}</span>
                        </div>
                    )}
                    {signal === 'metric' && <MetricPromTab task={task} dataset={dataset} />}
                    {signal === 'trace' && (
                        <DimensionBlock label="协作任务 Trace" note="同一 Trace 贯穿消息 / 工作流 / Agent 三个维度">
                            <TraceContent task={task} />
                        </DimensionBlock>
                    )}
                    {signal === 'log' && <LogTab task={task} />}
                    {signal === 'dict' && <DictContent />}
                </div>
            </div>
        </div>
    );
}

export default function ObservationCenterPlugin() {
    const tasks = useCollabTasks();
    const [selected, setSelected] = useState(null);
    return (
        <div className="obs-plugin-root">
            <div className="obs-toolbar">
                <div className="obs-toolbar-left">
                    <div className="obs-heading">
                        <span className="obs-title">观测中心</span>
                        <span className="obs-subtitle">Collaboration Task Traces · Observation Center</span>
                    </div>
                </div>
                <div className="obs-toolbar-actions">
                    <span className="obs-source-badge" title="默认为 consumer-smoke 方式构建的模拟数据（SDK 存储形态）；存储栈上线后自动切换真实 API">
                        模拟数据 · SDK 存储形态
                    </span>
                    <button type="button" className="obs-btn" onClick={tasks.reload} title="重新拉取协作任务数据">
                        <IconRefresh />
                        <span>刷新数据</span>
                    </button>
                </div>
            </div>

            {selected ? (
                <TaskDetailView task={selected} dataset={tasks.dataset} onBack={() => setSelected(null)} />
            ) : (
                <TaskListView
                    loading={tasks.loading}
                    error={tasks.error}
                    dataset={tasks.dataset}
                    onOpen={setSelected}
                    onReload={tasks.reload}
                />
            )}
        </div>
    );
}

/* ==========================================================================
 * Route 2 — /observation/third-party 三方可观测
 *
 * 三张组件大卡片（开源组件名称）。菜单点击为门户内正常跳转；**点击卡片在
 * 新标签页打开对应组件页面**：
 *   · Langfuse     — 已接入：新页面打开门户自部署 Langfuse 站点（9012）。
 *   · Grafana      — 待接入：先前往 grafana.com 官网；部署完成后把 target
 *                    换成控制台地址即可。
 *   · Prometheus   — 待接入：先前往 prometheus.io 官网；同上。
 * ======================================================================== */

/** Langfuse 卡片图标：火焰轮廓（Lucide "flame" 路径，ISC License），渐变描边。 */
function LangfuseMark({ size = 26 }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <defs>
                <linearGradient id="tobs-langfuse-grad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#6366f1" />
                    <stop offset="55%" stopColor="#a855f7" />
                    <stop offset="100%" stopColor="#ec4899" />
                </linearGradient>
            </defs>
            <path
                stroke="url(#tobs-langfuse-grad)"
                d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
            />
        </svg>
    );
}

function BrandMark({ path, hex, size = 26 }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
            <path fill={hex} d={path} />
        </svg>
    );
}

function IconArrowRight() {
    return (
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
        </svg>
    );
}

const THIRD_PARTY_CARDS = [
    {
        key: 'langfuse',
        name: 'Langfuse',
        component: 'Langfuse',
        latin: 'langfuse.com · 开源 LLM 可观测平台',
        status: 'ready',
        statusLabel: '已接入',
        accent: '#6366f1',
        icon: <LangfuseMark />,
        desc: '开源 LLM 应用可观测平台：Trace 追踪、评测、指标观测。门户已自部署 Langfuse v2。',
        linked: '已接入 · 自部署站点',
        openHint: '在新页面打开自部署 Langfuse',
        site: 'https://langfuse.com',
    },
    {
        key: 'grafana',
        name: 'Grafana',
        component: 'Grafana',
        latin: 'grafana.com · 开源可视化看板',
        status: 'pending',
        statusLabel: '待接入',
        accent: '#f46800',
        desc: '开源指标可视化与监控看板（Grafana Labs），支持 Prometheus、Loki 等多种数据源。',
        linked: '开源组件：Grafana',
        openHint: '在新页面打开 Grafana 官网（组件待接入）',
        site: 'https://grafana.com',
    },
    {
        key: 'prometheus',
        name: 'Prometheus（普罗米修斯）',
        component: 'Prometheus',
        latin: 'prometheus.io · 开源指标与告警',
        status: 'pending',
        statusLabel: '待接入',
        accent: '#e6522c',
        desc: '开源指标采集、时序数据库与告警引擎（CNCF 毕业项目），通常与 Grafana 配套使用。',
        linked: '开源组件：Prometheus',
        openHint: '在新页面打开 Prometheus 官网（组件待接入）',
        site: 'https://prometheus.io',
    },
];

export function ThirdPartyObservability() {
    const langfuseUrl = resolveLangfuseUrl();

    // 点击卡片 → 新标签页打开对应组件页面：
    // Langfuse 打开门户自部署站点；Grafana / Prometheus 待接入，先前往官网。
    const openCard = (card) => {
        const target = card.key === 'langfuse' ? langfuseUrl : card.site;
        if (typeof window !== 'undefined' && target) {
            window.open(target, '_blank', 'noopener');
        }
    };

    return (
        <div className="obs-plugin-root">
            <div className="obs-toolbar">
                <div className="obs-toolbar-left">
                    <div className="obs-heading">
                        <span className="obs-title">三方可观测</span>
                        <span className="obs-subtitle">Third-party Observability · 开源组件接入</span>
                    </div>
                </div>
                <div className="obs-toolbar-actions">
                    <span className="tobs-hint">点击卡片在新页面打开对应组件；组件部署完成后在此挂接控制台入口</span>
                </div>
            </div>
            <div className="tobs-body">
                <p className="tobs-intro">
                    三方可观测能力基于业界主流开源组件构建：可观测 = <b>Langfuse</b>（LLM 追踪与评测）、
                    <b>Grafana</b>（可视化看板）与 <b>Prometheus</b>（普罗米修斯，指标采集与告警）。
                </p>
                <div className="tobs-grid">
                    {THIRD_PARTY_CARDS.map((card) => {
                        const ready = card.status === 'ready';
                        const Icon = card.key === 'langfuse'
                            ? card.icon
                            : <BrandMark path={card.key === 'grafana' ? GRAFANA_ICON_PATH : PROMETHEUS_ICON_PATH} hex={card.accent} />;
                        return (
                            <div
                                key={card.key}
                                className={`tobs-card ${ready ? 'tobs-card-ready' : 'tobs-card-pending'}`}
                                style={{ '--tobs-accent': card.accent }}
                                onClick={() => openCard(card)}
                                role="button"
                                tabIndex={0}
                                title={card.openHint}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(card); } }}
                            >
                                <div className="tobs-card-top">
                                    <span className="tobs-icon" style={{ color: card.accent }}>{Icon}</span>
                                    <div className="tobs-name-wrap">
                                        <span className="tobs-name">{card.name}</span>
                                        <span className="tobs-latin">{card.latin}</span>
                                    </div>
                                    <span className={`tobs-pill tobs-pill-${card.status}`}>{card.statusLabel}</span>
                                </div>
                                <p className="tobs-desc">{card.desc}</p>
                                <div className="tobs-card-actions">
                                    {ready ? (
                                        <button
                                            type="button"
                                            className="obs-btn obs-btn-primary"
                                            onClick={(e) => { e.stopPropagation(); openCard(card); }}
                                            title={card.openHint}
                                        >
                                            <IconExternal />
                                            <span>打开 Langfuse</span>
                                        </button>
                                    ) : (
                                        <span className="tobs-pending-note">组件待接入 · 点击卡片先前往官网；部署完成后在此挂接控制台</span>
                                    )}
                                </div>
                                <div className="tobs-card-foot">
                                    <span>{card.linked}</span>
                                    <a href={card.site} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className="tobs-site-link">
                                        了解组件 ↗
                                    </a>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
