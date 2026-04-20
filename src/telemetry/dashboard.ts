/**
 * Inline HTML dashboard for telemetry.
 * No framework, no build step, no CDN. Single self-contained page.
 */

import { profileBarCss, profileBarHtml, profileBarJs, themeCss } from "./profileBar"

export const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian — Telemetry</title>
<link rel="icon" type="image/svg+xml" href="/telemetry/icon.svg">
<style>
  ${themeCss}
  :root { --total: var(--accent); }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--text); padding: 0; line-height: 1.5; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .card-value { font-size: 28px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .card-detail { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .section { margin-bottom: 24px; }
  .section-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: var(--muted);
                   text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface);
          border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-size: 13px; }
  th { text-align: left; padding: 10px 12px; background: var(--bg); color: var(--muted);
       font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px 12px; border-top: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  tr:hover td { background: rgba(88,166,255,0.04); }
  .waterfall { display: flex; align-items: center; height: 18px; min-width: 200px; position: relative; }
  .waterfall-seg { height: 100%; border-radius: 2px; min-width: 2px; }
  .waterfall-seg.queue { background: var(--queue); }
  .waterfall-seg.overhead { background: var(--yellow); }
  .waterfall-seg.ttfb { background: var(--ttfb); }
  .waterfall-seg.response { background: var(--upstream); }
  .legend { display: flex; gap: 16px; margin-bottom: 12px; font-size: 12px; color: var(--muted); }
  .legend-dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; margin-right: 4px; vertical-align: middle; }
  .status-ok { color: var(--green); }
  .status-err { color: var(--red); }
  .pct-table td:first-child { font-weight: 500; }
  .pct-table .phase-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; }
  .mono { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px; }
  .refresh-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .refresh-bar select, .refresh-bar button {
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .refresh-bar button:hover { border-color: var(--accent); }
  .refresh-indicator { font-size: 11px; color: var(--muted); }
  .empty { text-align: center; padding: 48px; color: var(--muted); }

  /* Tabs */
  .tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
  .tab { padding: 10px 20px; font-size: 13px; font-weight: 500; color: var(--muted); cursor: pointer;
         border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s, border-color 0.15s;
         user-select: none; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-badge { font-size: 10px; padding: 1px 6px; border-radius: 10px; margin-left: 6px;
               background: var(--border); color: var(--muted); font-variant-numeric: tabular-nums; }
  .tab.active .tab-badge { background: rgba(88,166,255,0.15); color: var(--accent); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* Log filters */
  .log-filters { display: flex; gap: 8px; margin-bottom: 12px; }
  .log-filter { font-size: 11px; padding: 3px 10px; border-radius: 12px; cursor: pointer;
                border: 1px solid var(--border); background: var(--surface); color: var(--muted);
                transition: all 0.15s; }
  .log-filter:hover { border-color: var(--accent); color: var(--text); }
  .log-filter.active { background: rgba(88,166,255,0.1); border-color: var(--accent); color: var(--accent); }
` + profileBarCss + `
</style>
</head>
<body>
` + profileBarHtml + `
<div style="padding:24px">
<h1>Meridian</h1>
<div class="subtitle">Request Performance Telemetry</div>

<div class="refresh-bar">
  <select id="window">
    <option value="300000">Last 5 min</option>
    <option value="900000">Last 15 min</option>
    <option value="3600000" selected>Last 1 hour</option>
    <option value="86400000">Last 24 hours</option>
  </select>
  <button onclick="refresh()">Refresh</button>
  <label><input type="checkbox" id="autoRefresh" checked> Auto (5s)</label>
  <span class="refresh-indicator" id="lastUpdate"></span>
</div>

<div id="content"><div class="empty">Loading…</div></div>

<script>
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let timer;
let activeTab = 'requests';
let activeLogFilter = 'all';



function ms(v) {
  if (v == null) return '—';
  if (v < 1000) return v + 'ms';
  return (v / 1000).toFixed(1) + 's';
}

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  return Math.floor(s/3600) + 'h ago';
}

function pctRow(label, color, phase) {
  return '<tr>'
    + '<td><span class="phase-dot" style="background:' + color + '"></span>' + label + '</td>'
    + '<td class="mono">' + ms(phase.p50) + '</td>'
    + '<td class="mono">' + ms(phase.p95) + '</td>'
    + '<td class="mono">' + ms(phase.p99) + '</td>'
    + '<td class="mono">' + ms(phase.min) + '</td>'
    + '<td class="mono">' + ms(phase.max) + '</td>'
    + '<td class="mono">' + ms(phase.avg) + '</td>'
    + '</tr>';
}

function switchTab(tab) {
  activeTab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
}

function setLogFilter(filter) {
  activeLogFilter = filter;
  $$('.log-filter').forEach(f => f.classList.toggle('active', f.dataset.filter === filter));
  $$('.log-row').forEach(r => {
    r.style.display = (filter === 'all' || r.dataset.category === filter) ? '' : 'none';
  });
}

async function refresh() {
  const w = $('#window').value;
  try {
    const [summary, reqs, logs] = await Promise.all([
      fetch('/telemetry/summary?window=' + w).then(r => r.json()),
      fetch('/telemetry/requests?limit=50&since=' + (Date.now() - Number(w))).then(r => r.json()),
      fetch('/telemetry/logs?limit=200&since=' + (Date.now() - Number(w))).then(r => r.json()),
    ]);
    render(summary, reqs, logs);
    $('#lastUpdate').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    $('#content').innerHTML = '<div class="empty">Failed to load telemetry</div>';
  }
}

function render(s, reqs, logs) {
  if (s.totalRequests === 0 && (!logs || logs.length === 0)) {
    $('#content').innerHTML = '<div class="empty">No requests recorded yet. Send a request through the proxy to see telemetry.</div>';
    return;
  }

  // Count lineage types for badges
  const lineageCounts = {};
  for (const r of reqs) { const t = r.lineageType || 'unknown'; lineageCounts[t] = (lineageCounts[t] || 0) + 1; }
  const logCounts = { session: 0, lineage: 0, error: 0, token: 0 };
  for (const l of logs) { if (logCounts[l.category] !== undefined) logCounts[l.category]++; }

  // Tabs
  let html = '<div class="tabs">'
    + '<div class="tab' + (activeTab === 'overview' ? ' active' : '') + '" data-tab="overview" onclick="switchTab(&apos;overview&apos;)">Overview</div>'
    + '<div class="tab' + (activeTab === 'requests' ? ' active' : '') + '" data-tab="requests" onclick="switchTab(&apos;requests&apos;)">'
    +   'Requests<span class="tab-badge">' + reqs.length + '</span></div>'
    + '<div class="tab' + (activeTab === 'logs' ? ' active' : '') + '" data-tab="logs" onclick="switchTab(&apos;logs&apos;)">'
    +   'Logs<span class="tab-badge">' + logs.length + '</span></div>'
    + '</div>';

  // ==================== Overview tab ====================
  html += '<div id="panel-overview" class="tab-panel' + (activeTab === 'overview' ? ' active' : '') + '">';

  // Summary cards
  html += '<div class="cards">'
    + card('Requests', s.totalRequests, s.requestsPerMinute.toFixed(1) + ' req/min')
    + card('Errors', s.errorCount, s.totalRequests > 0 ? ((s.errorCount/s.totalRequests)*100).toFixed(1) + '% error rate' : '')
    + card('Median Total', ms(s.totalDuration.p50), 'p95: ' + ms(s.totalDuration.p95))
    + card('Median TTFB', ms(s.ttfb.p50), 'p95: ' + ms(s.ttfb.p95))
    + card('Proxy Overhead', ms(s.proxyOverhead.p50), 'p95: ' + ms(s.proxyOverhead.p95))
    + card('Queue Wait', ms(s.queueWait.p50), 'p95: ' + ms(s.queueWait.p95))
    + '</div>';

  // Token usage cards
  if (s.tokenUsage) {
    const t = s.tokenUsage;
    const fmtTok = n => n > 1000000 ? (n/1000000).toFixed(1) + 'M' : n > 1000 ? Math.round(n/1000) + 'k' : String(n);
    html += '<div class="section"><div class="section-title">Token Usage</div></div>';
    html += '<div class="cards">'
      + card('Input Tokens', fmtTok(t.totalInputTokens), '')
      + card('Output Tokens', fmtTok(t.totalOutputTokens), '')
      + card('Cache Read', fmtTok(t.totalCacheReadTokens), '')
      + card('Cache Write', fmtTok(t.totalCacheCreationTokens), '')
      + card('Avg Cache Hit', (t.avgCacheHitRate * 100).toFixed(0) + '%', t.cacheMissOnResumeCount > 0 ? t.cacheMissOnResumeCount + ' cache miss on resume' : '')
      + '</div>';
  }

  // Model breakdown
  const models = Object.entries(s.byModel);
  if (models.length > 0) {
    html += '<div class="cards">';
    for (const [name, data] of models) {
      html += card(name, data.count + ' reqs', 'avg ' + ms(data.avgTotalMs));
    }
    html += '</div>';
  }

  // Lineage breakdown
  if (Object.keys(lineageCounts).length > 0) {
    html += '<div class="cards">';
    const lineageColors = {continuation:'var(--green)',compaction:'var(--yellow)',undo:'var(--purple)',diverged:'var(--red)',new:'var(--muted)'};
    for (const [type, count] of Object.entries(lineageCounts)) {
      html += '<div class="card"><div class="card-label">Lineage: ' + type + '</div>'
        + '<div class="card-value" style="color:' + (lineageColors[type] || 'var(--text)') + '">' + count + '</div></div>';
    }
    html += '</div>';
  }

  // Percentile table
  html += '<div class="section"><div class="section-title">Percentiles</div>'
    + '<table class="pct-table"><thead><tr><th>Phase</th><th>p50</th><th>p95</th><th>p99</th><th>Min</th><th>Max</th><th>Avg</th></tr></thead><tbody>'
    + pctRow('Queue Wait', 'var(--queue)', s.queueWait)
    + pctRow('Proxy Overhead', 'var(--yellow)', s.proxyOverhead)
    + pctRow('TTFB', 'var(--ttfb)', s.ttfb)
    + pctRow('Upstream', 'var(--upstream)', s.upstreamDuration)
    + pctRow('Total', 'var(--purple)', s.totalDuration)
    + '</tbody></table></div>';

  html += '</div>'; // end overview panel

  // ==================== Requests tab ====================
  html += '<div id="panel-requests" class="tab-panel' + (activeTab === 'requests' ? ' active' : '') + '">';

  html += '<div class="legend">'
    + '<span><span class="legend-dot" style="background:var(--queue)"></span>Queue</span>'
    + '<span><span class="legend-dot" style="background:var(--yellow)"></span>Proxy</span>'
    + '<span><span class="legend-dot" style="background:var(--ttfb)"></span>TTFB</span>'
    + '<span><span class="legend-dot" style="background:var(--upstream)"></span>Response</span>'
    + '</div>'
    + '<table><thead><tr><th>Time</th><th>Adapter</th><th>Model</th><th>Mode</th><th>Session</th><th>Status</th>'
    + '<th>Queue</th><th>Proxy</th><th>TTFB</th><th>Total</th><th>Tokens</th><th>Cache</th><th>Waterfall</th></tr></thead><tbody>';

  const maxTotal = Math.max(...reqs.map(r => r.totalDurationMs), 1);

  for (const r of reqs) {
    const statusClass = r.error ? 'status-err' : 'status-ok';
    const statusText = r.error ? r.error : r.status;
    const scale = 280 / maxTotal;
    const qW = Math.max(r.queueWaitMs * scale, 2);
    const ohW = Math.max((r.proxyOverheadMs || 0) * scale, 0);
    const ttfbW = Math.max((r.ttfbMs || 0) * scale, 0);
    const respW = Math.max((r.upstreamDurationMs - (r.ttfbMs || 0)) * scale, 2);

    const lineageBadge = r.lineageType ? '<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:' + ({continuation:'var(--green)',compaction:'var(--yellow)',undo:'var(--purple)',diverged:'var(--red)',new:'var(--muted)'}[r.lineageType] || 'var(--muted)') + ';color:var(--bg)">' + r.lineageType + '</span>' : '';
    const sessionShort = r.sdkSessionId ? r.sdkSessionId.slice(0, 8) : '—';
    const msgCount = r.messageCount != null ? r.messageCount : '?';

    const sourceBadge = r.requestSource ? '<br><span class="mono" style="font-size:9px;color:var(--violet)">' + r.requestSource + '</span>' : '';

    html += '<tr>'
      + '<td class="mono">' + ago(r.timestamp) + '</td>'
      + '<td>' + (r.adapter || '—') + sourceBadge + '</td>'
      + '<td>' + (r.requestModel || r.model) + '<br><span style="font-size:10px;color:var(--muted)">' + r.model + '</span></td>'
      + '<td>' + r.mode + (r.hasDeferredTools ? (function() { var sessDisc = r.sessionDiscoveredCount || 0; var loaded = ((r.toolCount || 0) - (r.deferredToolCount || 0)) + sessDisc; var deferred = Math.max(0, (r.deferredToolCount || 0) - sessDisc); var newDisc = r.discoveredTools || []; return '<br><span style="font-size:10px;color:var(--purple)">loaded=' + loaded + ' deferred=' + deferred + '</span>' + (newDisc.length > 0 ? '<br><span style="font-size:10px;color:var(--green)">+' + newDisc.join(', +') + '</span>' : ''); })() : '') + '</td>'
      + '<td class="mono">' + sessionShort + ' ' + lineageBadge + '<br><span style="font-size:10px;color:var(--muted)">' + msgCount + ' msgs</span></td>'
      + '<td class="' + statusClass + '">' + statusText + '</td>'
      + '<td class="mono">' + ms(r.queueWaitMs) + '</td>'
      + '<td class="mono">' + ms(r.proxyOverheadMs) + '</td>'
      + '<td class="mono">' + ms(r.ttfbMs) + '</td>'
      + '<td class="mono">' + ms(r.totalDurationMs) + '</td>'
      + '<td class="mono">' + (r.inputTokens != null ? (r.inputTokens > 1000 ? Math.round(r.inputTokens/1000) + 'k' : r.inputTokens) + ' in<br>' + (r.outputTokens > 1000 ? Math.round(r.outputTokens/1000) + 'k' : r.outputTokens || 0) + ' out' : '—') + '</td>'
      + '<td class="mono">' + (r.cacheHitRate != null ? '<span style="color:' + (r.cacheHitRate > 0.5 ? 'var(--green)' : r.cacheHitRate > 0 ? 'var(--yellow)' : 'var(--red)') + '">' + Math.round(r.cacheHitRate * 100) + '%</span>' : '—') + '</td>'
      + '<td><div class="waterfall">'
      + '<div class="waterfall-seg queue" style="width:' + qW + 'px"></div>'
      + '<div class="waterfall-seg overhead" style="width:' + ohW + 'px"></div>'
      + '<div class="waterfall-seg ttfb" style="width:' + ttfbW + 'px"></div>'
      + '<div class="waterfall-seg response" style="width:' + respW + 'px"></div>'
      + '</div></td>'
      + '</tr>';
  }
  html += '</tbody></table>';
  html += '</div>'; // end requests panel

  // ==================== Logs tab ====================
  html += '<div id="panel-logs" class="tab-panel' + (activeTab === 'logs' ? ' active' : '') + '">';

  // Filter buttons
  html += '<div class="log-filters">'
    + '<span class="log-filter' + (activeLogFilter === 'all' ? ' active' : '') + '" data-filter="all" onclick="setLogFilter(&apos;all&apos;)">All<span class="tab-badge">' + logs.length + '</span></span>'
    + '<span class="log-filter' + (activeLogFilter === 'session' ? ' active' : '') + '" data-filter="session" onclick="setLogFilter(&apos;session&apos;)" style="--accent:var(--blue)">Session<span class="tab-badge">' + logCounts.session + '</span></span>'
    + '<span class="log-filter' + (activeLogFilter === 'lineage' ? ' active' : '') + '" data-filter="lineage" onclick="setLogFilter(&apos;lineage&apos;)" style="--accent:var(--purple)">Lineage<span class="tab-badge">' + logCounts.lineage + '</span></span>'
    + '<span class="log-filter' + (activeLogFilter === 'error' ? ' active' : '') + '" data-filter="error" onclick="setLogFilter(&apos;error&apos;)" style="--accent:var(--red)">Error<span class="tab-badge">' + logCounts.error + '</span></span>'
    + '<span class="log-filter' + (activeLogFilter === 'token' ? ' active' : '') + '" data-filter="token" onclick="setLogFilter(&apos;token&apos;)" style="--accent:var(--yellow)">Token<span class="tab-badge">' + logCounts.token + '</span></span>'
    + '</div>';

  if (logs.length === 0) {
    html += '<div class="empty">No diagnostic logs in this time window.</div>';
  } else {
    html += '<table><thead><tr>'
      + '<th style="width:80px">Time</th><th style="width:55px">Level</th><th style="width:70px">Category</th><th>Message</th>'
      + '</tr></thead><tbody>';

    for (const log of logs) {
      const levelColor = {info:'var(--green)',warn:'var(--yellow)',error:'var(--red)'}[log.level] || 'var(--muted)';
      const catColor = {session:'var(--blue)',lineage:'var(--purple)',error:'var(--red)',lifecycle:'var(--muted)',token:'var(--yellow)'}[log.category] || 'var(--muted)';
      const display = (activeLogFilter === 'all' || log.category === activeLogFilter) ? '' : 'display:none';
      html += '<tr class="log-row" data-category="' + log.category + '" style="' + display + '">'
        + '<td class="mono">' + ago(log.timestamp) + '</td>'
        + '<td><span style="color:' + levelColor + '">' + log.level + '</span></td>'
        + '<td><span style="color:' + catColor + '">' + log.category + '</span></td>'
        + '<td class="mono" style="word-break:break-all">' + log.message + '</td>'
        + '</tr>';
    }
    html += '</tbody></table>';
  }
  html += '</div>'; // end logs panel

  $('#content').innerHTML = html;
}

function card(label, value, detail) {
  return '<div class="card"><div class="card-label">' + label + '</div>'
    + '<div class="card-value">' + value + '</div>'
    + (detail ? '<div class="card-detail">' + detail + '</div>' : '')
    + '</div>';
}

$('#autoRefresh').addEventListener('change', function() {
  clearInterval(timer);
  if (this.checked) timer = setInterval(refresh, 5000);
});
$('#window').addEventListener('change', refresh);

refresh();
timer = setInterval(refresh, 5000);
` + profileBarJs + `
</script>
</body>
</html>`
