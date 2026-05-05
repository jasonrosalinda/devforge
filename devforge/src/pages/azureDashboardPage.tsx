import { useState, useCallback } from 'react';
import { useAzureMetrics } from '@/hooks/useAzureMetrics';
import { AzureAppCard } from '@/components/azure/azureAppCard';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_APP_KEYS = ['MEDU', 'MSP', 'MSP API'] as const;
type AppKey = typeof ALL_APP_KEYS[number];
type Range = '1h' | '6h' | '24h' | '7d';
const RANGES: Range[] = ['1h', '6h', '24h', '7d'];

// ─── Color tokens (dark theme, matches devforge convention) ──────────────────

const C = {
  bg:         '#07090f',
  surface:    '#0d1117',
  border:     '#21262d',
  text:       '#e6edf3',
  textSub:    '#8b9ab3',
  textMuted:  '#484f58',
  accent:     '#58a6ff',
  green:      '#3fb950',
  yellow:     '#d29922',
  red:        '#f85149',
  btnBg:      '#21262d',
  btnActive:  '#1f6feb',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function CredBadge({ status, error }: { status: 'checking' | 'ok' | 'error'; error: string | null }) {
  const cfg = status === 'checking'
    ? { color: C.textSub, dot: '○', label: 'Checking...' }
    : status === 'ok'
    ? { color: C.green,   dot: '●', label: 'Authenticated' }
    : { color: C.red,     dot: '●', label: 'Not authenticated' };

  return (
    <div
      title={error ?? undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '4px 12px',
        borderRadius: 20,
        background: `${cfg.color}18`,
        border: `1px solid ${cfg.color}44`,
        fontSize: 12,
        color: cfg.color,
        fontWeight: 500,
        cursor: error ? 'help' : 'default',
      }}
    >
      <span style={{ fontSize: 8 }}>{cfg.dot}</span>
      {cfg.label}
    </div>
  );
}

function RangeButton({ range, active, onClick }: { range: Range; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px',
        borderRadius: 6,
        border: `1px solid ${active ? C.btnActive : C.border}`,
        background: active ? `${C.btnActive}22` : C.btnBg,
        color: active ? C.accent : C.textSub,
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {range}
    </button>
  );
}

function AppDropdown({ selected, onChange }: { selected: AppKey[]; onChange: (keys: AppKey[]) => void }) {
  const [open, setOpen] = useState(false);
  const allSelected = selected.length === ALL_APP_KEYS.length;
  const label = allSelected
    ? 'All apps'
    : selected.length === 0
    ? 'No apps'
    : `${selected.length} of ${ALL_APP_KEYS.length} apps`;

  function toggle(key: AppKey) {
    onChange(selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key]);
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '5px 14px',
          borderRadius: 6,
          border: `1px solid ${C.border}`,
          background: C.btnBg,
          color: C.text,
          fontSize: 13,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        {label}
        <span style={{ fontSize: 10, color: C.textSub }}>▾</span>
      </button>
      {open && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            onClick={() => setOpen(false)}
          />
          <div style={{
            position: 'absolute', top: '110%', left: 0, zIndex: 100,
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: '6px 0', minWidth: 160,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 12px 8px', borderBottom: `1px solid ${C.border}` }}>
              <button
                onClick={() => onChange([...ALL_APP_KEYS])}
                style={{ fontSize: 11, color: C.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                Select all
              </button>
              <button
                onClick={() => onChange([])}
                style={{ fontSize: 11, color: C.textSub, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                Deselect all
              </button>
            </div>
            {ALL_APP_KEYS.map(key => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer', color: C.text, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={selected.includes(key)}
                  onChange={() => toggle(key)}
                  style={{ accentColor: C.accent }}
                />
                {key}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AzureDashboardPage() {
  const { credStatus, credError, metrics, loading, fetchMetrics } = useAzureMetrics();
  const [selectedApps, setSelectedApps] = useState<AppKey[]>([...ALL_APP_KEYS]);
  const [range, setRange] = useState<Range>('24h');

  const handleFetch = useCallback(() => {
    fetchMetrics([...selectedApps], range);
  }, [fetchMetrics, selectedApps, range]);

  const handleRangeChange = useCallback((r: Range) => {
    setRange(r);
    if (metrics) fetchMetrics([...selectedApps], r);
  }, [fetchMetrics, metrics, selectedApps]);

  const fetchDisabled = loading || credStatus === 'error' || selectedApps.length === 0;

  return (
    <div style={{ background: C.bg, minHeight: '100vh', padding: '24px 28px', fontFamily: 'inherit' }}>

      {/* Page header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.text, letterSpacing: '-0.01em' }}>
            ⚡ Azure Health
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: C.textSub }}>
            Live metrics from Azure Monitor
          </p>
        </div>
        <CredBadge status={credStatus} error={credError} />
      </div>

      {/* Credential error banner */}
      {credStatus === 'error' && (
        <div style={{
          margin: '16px 0',
          padding: '12px 16px',
          background: '#1c0a0a',
          border: '1px solid #3d1f1f',
          borderRadius: 8,
          display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <span style={{ fontSize: 14, color: C.red, marginTop: 1 }}>✖</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: C.red, fontWeight: 600 }}>Not authenticated with Azure</div>
            <div style={{ fontSize: 12, color: C.textSub, marginTop: 3 }}>
              Run the command below in your terminal, then relaunch DevForge:
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <code style={{
                fontSize: 12, color: '#79c0ff', background: '#0d1117',
                padding: '3px 8px', borderRadius: 4, border: `1px solid ${C.border}`,
              }}>
                az login
              </code>
              <button
                onClick={() => navigator.clipboard.writeText('az login')}
                style={{
                  fontSize: 11, color: C.textSub, background: C.btnBg,
                  border: `1px solid ${C.border}`, borderRadius: 4,
                  padding: '3px 8px', cursor: 'pointer',
                }}
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Control bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0', flexWrap: 'wrap' }}>
        <AppDropdown selected={selectedApps} onChange={setSelectedApps} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12, color: C.textSub, marginRight: 4 }}>Range:</span>
          {RANGES.map(r => (
            <RangeButton key={r} range={r} active={range === r} onClick={() => handleRangeChange(r)} />
          ))}
        </div>

        <button
          onClick={handleFetch}
          disabled={fetchDisabled}
          style={{
            marginLeft: 'auto',
            padding: '6px 18px',
            borderRadius: 6,
            border: `1px solid ${fetchDisabled ? C.border : C.btnActive}`,
            background: fetchDisabled ? C.btnBg : `${C.btnActive}22`,
            color: fetchDisabled ? C.textMuted : C.accent,
            fontSize: 13,
            fontWeight: 600,
            cursor: fetchDisabled ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', gap: 6,
            opacity: credStatus === 'error' || selectedApps.length === 0 ? 0.5 : 1,
          }}
        >
          {loading ? (
            <>
              <span style={{
                display: 'inline-block', width: 10, height: 10,
                border: `2px solid ${C.textMuted}`, borderTopColor: C.accent,
                borderRadius: '50%', animation: 'spin 0.8s linear infinite',
              }} />
              Fetching...
            </>
          ) : '↻ Fetch Metrics'}
        </button>
      </div>

      {/* Empty state */}
      {!metrics && !loading && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: C.textSub, fontSize: 14 }}>
          Select apps and time range, then click Fetch Metrics.
        </div>
      )}

      {/* Card grid */}
      {(metrics || loading) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
          {selectedApps.map(key => {
            const m = metrics?.[key];
            if (!m && !loading) return null;
            return (
              <AzureAppCard
                key={key}
                appKey={key}
                metrics={m ?? {
                  label: key,
                  type: key === 'MEDU' ? 'appservice' : 'containerapp',
                  cpu: { avg: 0, max: 0, series: [] },
                  memory: { avg: 0, max: 0, series: [] },
                  cpuUnit: '%',
                  memUnit: '%',
                }}
                loading={loading && !m}
              />
            );
          })}
        </div>
      )}

      {/* Status legend */}
      <div style={{
        marginTop: 24,
        padding: '10px 16px',
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        display: 'flex', gap: 20, fontSize: 11, color: C.textSub, flexWrap: 'wrap',
      }}>
        <span><span style={{ color: C.green  }}>● Healthy</span>  — CPU ≤70% / Mem ≤80%</span>
        <span><span style={{ color: C.yellow }}>● Warning</span>  — CPU &gt;70% / Mem &gt;80%</span>
        <span><span style={{ color: C.red    }}>● Critical</span> — CPU &gt;90% / Mem &gt;95%</span>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// ─── Kept for backward compatibility (azureCharts.tsx imports this) ───────────

export const DASHBOARDS = [
  {
    label: 'MEDU',
    url: 'https://portal.azure.com/#@mims.com/dashboard/arm/subscriptions/044d478b-62ae-4658-a14b-ac179f55b057/resourcegroups/mpfalerts-rg/providers/microsoft.portal/dashboards/c1ab52ee-0554-4d0f-9178-68619af06c08',
  },
  {
    label: 'MSP',
    url: 'https://portal.azure.com/#@mims.com/dashboard/arm/subscriptions/044d478b-62ae-4658-a14b-ac179f55b057/resourcegroups/prdmsp-rg/providers/microsoft.portal/dashboards/c1a1ebb9-6655-4c55-a952-69e27379a693',
  },
] as const;
