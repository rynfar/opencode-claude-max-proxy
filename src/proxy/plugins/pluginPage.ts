/**
 * Plugins management page.
 * Shows all discovered plugins with their status, hooks, adapters, and errors.
 * Fetches /plugins/list client-side for live data; supports reload via POST /plugins/reload.
 */

import { profileBarCss, profileBarHtml, profileBarJs, themeCss } from "../../telemetry/profileBar"

export const pluginPageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian \u2014 Plugins</title>
<style>
  ${themeCss}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--text); line-height: 1.6; min-height: 100vh; }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 24px; }

  .back-link { display: inline-flex; align-items: center; gap: 6px; color: var(--muted);
    text-decoration: none; font-size: 13px; margin-bottom: 24px; transition: color 0.15s; }
  .back-link:hover { color: var(--text); }

  .page-header { display: flex; align-items: flex-start; justify-content: space-between;
    gap: 16px; margin-bottom: 6px; flex-wrap: wrap; }
  .page-header h1 { font-size: 24px; font-weight: 700; letter-spacing: 0.5px; }
  .tagline { color: var(--muted); font-size: 14px; margin-bottom: 28px; }

  .reload-btn { padding: 8px 18px; font-size: 13px; font-weight: 500;
    background: var(--surface2); color: var(--accent); border: 1px solid var(--accent);
    border-radius: 8px; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
  .reload-btn:hover { background: rgba(139,92,246,0.15); }
  .reload-btn:disabled { opacity: 0.5; cursor: default; }
  .reload-btn.loading { opacity: 0.7; }

  .reload-status { font-size: 12px; color: var(--green); opacity: 0; transition: opacity 0.3s;
    margin-left: 8px; }
  .reload-status.show { opacity: 1; }
  .reload-status.error { color: var(--red); }

  .header-actions { display: flex; align-items: center; gap: 0; }

  .plugin-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 20px; margin-bottom: 12px; transition: border-color 0.2s; }
  .plugin-card.status-error { border-color: rgba(248,81,73,0.4); }

  .plugin-card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
    flex-wrap: wrap; }
  .plugin-name { font-size: 16px; font-weight: 600; }
  .plugin-version { font-size: 11px; color: var(--muted);
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; }

  .status-badge { font-size: 10px; padding: 2px 9px; border-radius: 4px;
    text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .badge-active { background: rgba(63,185,80,0.15); color: var(--green);
    border: 1px solid rgba(63,185,80,0.3); }
  .badge-disabled { background: var(--surface2); color: var(--muted);
    border: 1px solid var(--border); }
  .badge-error { background: rgba(248,81,73,0.12); color: var(--red);
    border: 1px solid rgba(248,81,73,0.3); }

  .plugin-description { font-size: 13px; color: var(--muted); margin-bottom: 12px; }

  .plugin-meta { display: flex; gap: 20px; flex-wrap: wrap; font-size: 12px; }
  .meta-item { display: flex; align-items: center; gap: 6px; }
  .meta-label { color: var(--muted); text-transform: uppercase; font-size: 10px;
    letter-spacing: 0.5px; font-weight: 500; }
  .meta-value { color: var(--text);
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 11px; }

  .plugin-error-box { margin-top: 12px; padding: 10px 14px;
    background: rgba(248,81,73,0.08); border: 1px solid rgba(248,81,73,0.3);
    border-radius: 8px; font-size: 12px; color: var(--red);
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; word-break: break-word; }

  .empty-state { text-align: center; padding: 56px 24px; color: var(--muted);
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
  .empty-state h2 { font-size: 16px; font-weight: 600; margin-bottom: 10px; color: var(--text); }
  .empty-state p { font-size: 13px; line-height: 1.7; }
  .empty-state code { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
    font-size: 12px; background: var(--surface2); padding: 2px 7px;
    border-radius: 4px; color: #a78bfa; }

  /* ── Hero panel: aggregate stats at a glance ── */
  .hero-panel { background: linear-gradient(135deg, var(--surface) 0%, var(--surface2) 100%);
    border: 1px solid var(--border); border-radius: 14px;
    padding: 20px 24px; margin-bottom: 24px; }
  .hero-row { display: flex; align-items: center; }
  .hero-row-top { gap: 28px; flex-wrap: wrap; padding-bottom: 16px;
    border-bottom: 1px solid var(--border); margin-bottom: 14px; }
  .hero-metric { flex: 1 1 0; min-width: 110px; }
  .hero-num { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
    font-size: 28px; font-weight: 600; color: var(--text);
    line-height: 1.1; font-variant-numeric: tabular-nums; }
  .hero-num.hero-err { color: var(--red); }
  .hero-sub { font-size: 15px; font-weight: 400; color: var(--muted); margin-left: 4px; }
  .hero-unit { font-size: 13px; font-weight: 400; color: var(--muted); margin-left: 3px; }
  .hero-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px;
    color: var(--muted); margin-top: 6px; font-weight: 500; }
  .hero-row-bottom { gap: 18px; justify-content: space-between; flex-wrap: wrap;
    font-size: 12px; color: var(--muted); }
  .hero-status { display: flex; align-items: center; gap: 6px; }
  .hero-status strong { color: var(--text); font-weight: 600; }
  .chip-sep { width: 1px; height: 14px; background: var(--border); margin: 0 6px; }
  .status-chip { font-size: 10px; line-height: 1; }
  .status-chip-active { color: var(--green); }
  .status-chip-disabled { color: var(--muted); }
  .status-chip-error { color: var(--red); }
  .hero-busiest { color: var(--muted); font-size: 12px; }
  .hero-busiest strong { color: var(--accent); font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; }
  .hero-busiest-count { color: var(--muted); font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 11px; }

  .plugin-stats { margin-top: 14px; padding-top: 14px;
    border-top: 1px solid var(--border); }
  .plugin-stats-empty { margin-top: 14px; padding: 10px 14px;
    background: var(--surface2); border-radius: 6px; font-size: 12px;
    color: var(--muted); font-style: italic; }
  .stats-header { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--muted); font-weight: 500; margin-bottom: 8px; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
    margin-bottom: 12px; }
  .stat-cell { background: var(--surface2); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px 12px; }
  .stat-num { font-size: 18px; font-weight: 600; color: var(--text);
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
    font-variant-numeric: tabular-nums; line-height: 1.2; }
  .stat-num.stat-err { color: var(--red); }
  .stat-unit { font-size: 11px; color: var(--muted); font-weight: 400; margin-left: 2px; }
  .stat-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px;
    color: var(--muted); margin-top: 4px; }
  .stats-breakdown { display: flex; gap: 8px; flex-wrap: wrap; }
  .hook-pill { font-size: 11px; padding: 3px 8px; border-radius: 4px;
    background: var(--surface2); color: var(--muted);
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; }
  .hook-pill strong { color: var(--text); font-weight: 600; }
  .hook-err { color: var(--red); font-weight: 500; }
` + profileBarCss + `
</style>
</head>
<body>
` + profileBarHtml + `
<div class="container">
  <a href="/" class="back-link">&#8592; Back to Meridian</a>

  <div class="page-header">
    <div>
      <h1>Plugins</h1>
    </div>
    <div class="header-actions">
      <button class="reload-btn" id="reloadBtn" onclick="reloadPlugins()">Reload Plugins</button>
      <span class="reload-status" id="reloadStatus"></span>
    </div>
  </div>
  <div class="tagline">Transform request and response behavior with composable plugins</div>

  <div id="content"><div style="color:var(--muted);padding:40px;text-align:center">Loading\u2026</div></div>
</div>

<script>
function esc(s) {
  if (s == null) return '';
  var d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

async function loadPlugins() {
  try {
    var res = await fetch('/plugins/list');
    var data = await res.json();
    render(data.plugins || []);
  } catch {
    document.getElementById('content').innerHTML =
      '<div class="empty-state"><h2>Could not load plugins</h2><p>Is Meridian running?</p></div>';
  }
}

async function reloadPlugins() {
  var btn = document.getElementById('reloadBtn');
  var status = document.getElementById('reloadStatus');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Reloading\u2026';
  status.className = 'reload-status';
  status.textContent = '';
  try {
    var res = await fetch('/plugins/reload', { method: 'POST' });
    var data = await res.json();
    if (data.success) {
      status.textContent = '\u2713 Reloaded';
      status.className = 'reload-status show';
    } else {
      status.textContent = data.error || 'Reload failed';
      status.className = 'reload-status show error';
    }
    await loadPlugins();
  } catch {
    status.textContent = 'Reload failed';
    status.className = 'reload-status show error';
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = 'Reload Plugins';
    setTimeout(function() { status.className = 'reload-status'; }, 3000);
  }
}

function render(plugins) {
  if (!plugins.length) {
    document.getElementById('content').innerHTML =
      '<div class="empty-state">'
      + '<h2>No plugins found</h2>'
      + '<p>Drop <code>.ts</code> or <code>.js</code> files in <code>~/.config/meridian/plugins/</code> and reload.</p>'
      + '</div>';
    return;
  }

  var active = plugins.filter(function(p) { return p.status === 'active'; }).length;
  var disabled = plugins.filter(function(p) { return p.status === 'disabled'; }).length;
  var errors = plugins.filter(function(p) { return p.status === 'error'; }).length;

  // ── Aggregate stats across all active plugins ──
  var totalCalls = 0, totalErrors = 0, totalMs = 0, lastSeen = 0;
  var busiestName = null, busiestCount = 0;
  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    if (p.status !== 'active' || !p.stats) continue;
    var pluginCalls = 0, pluginErrors = 0, pluginMs = 0;
    var hookNames = Object.keys(p.stats.hooks || {});
    for (var j = 0; j < hookNames.length; j++) {
      var h = p.stats.hooks[hookNames[j]];
      pluginCalls += h.invocations || 0;
      pluginErrors += h.errors || 0;
      pluginMs += h.totalMs || 0;
    }
    totalCalls += pluginCalls;
    totalErrors += pluginErrors;
    totalMs += pluginMs;
    if (p.stats.lastInvokedAt && p.stats.lastInvokedAt > lastSeen) {
      lastSeen = p.stats.lastInvokedAt;
    }
    if (pluginCalls > busiestCount) {
      busiestCount = pluginCalls;
      busiestName = p.name;
    }
  }
  var aggAvg = totalCalls > 0 ? (totalMs / totalCalls).toFixed(2) : '0.00';

  var html = '<div class="hero-panel">';
  html += '<div class="hero-row hero-row-top">';
  html += '<div class="hero-metric">'
    + '<div class="hero-num">' + active + '<span class="hero-sub">/ ' + plugins.length + '</span></div>'
    + '<div class="hero-lbl">Active plugins</div>'
    + '</div>';
  html += '<div class="hero-metric">'
    + '<div class="hero-num">' + totalCalls.toLocaleString() + '</div>'
    + '<div class="hero-lbl">Total invocations</div>'
    + '</div>';
  html += '<div class="hero-metric">'
    + '<div class="hero-num ' + (totalErrors > 0 ? 'hero-err' : '') + '">' + totalErrors.toLocaleString() + '</div>'
    + '<div class="hero-lbl">Errors</div>'
    + '</div>';
  html += '<div class="hero-metric">'
    + '<div class="hero-num">' + aggAvg + '<span class="hero-unit">ms</span></div>'
    + '<div class="hero-lbl">Avg latency</div>'
    + '</div>';
  html += '<div class="hero-metric">'
    + '<div class="hero-num">' + (lastSeen ? formatRelative(lastSeen) : '—') + '</div>'
    + '<div class="hero-lbl">Last request</div>'
    + '</div>';
  html += '</div>';

  // Status breakdown + busiest plugin row
  html += '<div class="hero-row hero-row-bottom">';
  html += '<div class="hero-status">';
  html += '<span class="status-chip status-chip-active">●</span> <strong>' + active + '</strong> active';
  if (disabled) html += '<span class="chip-sep"></span><span class="status-chip status-chip-disabled">●</span> <strong>' + disabled + '</strong> disabled';
  if (errors) html += '<span class="chip-sep"></span><span class="status-chip status-chip-error">●</span> <strong>' + errors + '</strong> error' + (errors !== 1 ? 's' : '');
  html += '</div>';
  if (busiestName) {
    html += '<div class="hero-busiest">Busiest: <strong>' + esc(busiestName) + '</strong> <span class="hero-busiest-count">(' + busiestCount.toLocaleString() + ' calls)</span></div>';
  }
  html += '</div>';
  html += '</div>';

  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    var statusClass = p.status === 'active' ? 'badge-active' : p.status === 'error' ? 'badge-error' : 'badge-disabled';
    html += '<div class="plugin-card' + (p.status === 'error' ? ' status-error' : '') + '">';

    html += '<div class="plugin-card-header">';
    html += '<span class="plugin-name">' + esc(p.name) + '</span>';
    if (p.version) html += '<span class="plugin-version">v' + esc(p.version) + '</span>';
    html += '<span class="status-badge ' + statusClass + '">' + esc(p.status) + '</span>';
    html += '</div>';

    if (p.description) {
      html += '<div class="plugin-description">' + esc(p.description) + '</div>';
    }

    html += '<div class="plugin-meta">';
    var hooks = (p.hooks && p.hooks.length) ? p.hooks.join(', ') : '\u2014';
    html += '<div class="meta-item"><span class="meta-label">Hooks</span><span class="meta-value">' + esc(hooks) + '</span></div>';
    var adapters = (p.adapters && p.adapters.length) ? p.adapters.join(', ') : 'All adapters';
    html += '<div class="meta-item"><span class="meta-label">Adapters</span><span class="meta-value">' + esc(adapters) + '</span></div>';
    html += '</div>';

    if (p.status === 'active' && p.stats) {
      html += renderStats(p.stats);
    }

    if (p.status === 'error' && p.error) {
      html += '<div class="plugin-error-box">' + esc(p.error) + '</div>';
    }

    html += '</div>';
  }

  document.getElementById('content').innerHTML = html;
}

function renderStats(s) {
  var hooks = s.hooks || {};
  var hookNames = Object.keys(hooks);
  if (hookNames.length === 0 && !s.lastInvokedAt && !s.lastError) {
    return '<div class="plugin-stats-empty">No invocations yet \u2014 send a request to see counters.</div>';
  }

  var totalInvocations = 0, totalErrors = 0, totalMs = 0;
  for (var i = 0; i < hookNames.length; i++) {
    var h = hooks[hookNames[i]];
    totalInvocations += h.invocations || 0;
    totalErrors += h.errors || 0;
    totalMs += h.totalMs || 0;
  }

  var html = '<div class="plugin-stats">';
  html += '<div class="stats-header">Invocations</div>';
  html += '<div class="stats-grid">';
  html += '<div class="stat-cell"><div class="stat-num">' + totalInvocations + '</div><div class="stat-lbl">calls</div></div>';
  html += '<div class="stat-cell"><div class="stat-num ' + (totalErrors > 0 ? 'stat-err' : '') + '">' + totalErrors + '</div><div class="stat-lbl">errors</div></div>';
  var avgMs = totalInvocations > 0 ? (totalMs / totalInvocations).toFixed(2) : '0.00';
  html += '<div class="stat-cell"><div class="stat-num">' + avgMs + '<span class="stat-unit">ms</span></div><div class="stat-lbl">avg</div></div>';
  if (s.lastInvokedAt) {
    html += '<div class="stat-cell"><div class="stat-num">' + formatRelative(s.lastInvokedAt) + '</div><div class="stat-lbl">last seen</div></div>';
  }
  html += '</div>';

  if (hookNames.length > 0) {
    html += '<div class="stats-breakdown">';
    for (var j = 0; j < hookNames.length; j++) {
      var name = hookNames[j];
      var hd = hooks[name];
      html += '<span class="hook-pill">'
        + esc(name) + ': <strong>' + (hd.invocations || 0) + '</strong>'
        + (hd.errors > 0 ? ' <span class="hook-err">(' + hd.errors + ' err)</span>' : '')
        + '</span>';
    }
    html += '</div>';
  }

  if (s.lastError) {
    html += '<div class="plugin-error-box">'
      + 'Last error in <strong>' + esc(s.lastError.hook) + '</strong> '
      + formatRelative(s.lastError.at)
      + ': ' + esc(s.lastError.message)
      + '</div>';
  }

  html += '</div>';
  return html;
}

function formatRelative(ts) {
  var diffMs = Date.now() - ts;
  if (diffMs < 0) return 'just now';
  var s = Math.floor(diffMs / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// Periodic refresh so you can watch invocation counters climb while
// you drive traffic through the proxy. Stops when the tab is hidden.
setInterval(function() {
  if (document.visibilityState === 'visible') loadPlugins();
}, 3000);

loadPlugins();
` + profileBarJs + `
</script>
</body>
</html>`
