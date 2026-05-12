import { useState, useCallback, useMemo, useEffect } from 'react';
import { useAzureMetrics } from '@/hooks/useAzureMetrics';
import { useSettings } from '@/context/settings-context';
import { AzureAppCard } from '@/components/azure/azureAppCard';

const GRANULARITIES: { label: string; value: string; maxSpanHours: number }[] = [
  { label: '1m',  value: 'PT1M',  maxSpanHours: 24 },
  { label: '5m',  value: 'PT5M',  maxSpanHours: 120 },
  { label: '15m', value: 'PT15M', maxSpanHours: 360 },
  { label: '1h',  value: 'PT1H',  maxSpanHours: 1440 },
  { label: '6h',  value: 'PT6H',  maxSpanHours: Infinity },
];

function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const INGESTION_DELAY_MS = 5 * 60 * 1000;

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function maxEndDt(): string {
  return toDatetimeLocal(new Date(Date.now() - INGESTION_DELAY_MS));
}

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

function AppDropdown({ selected, allKeys, onChange }: { selected: string[]; allKeys: string[]; onChange: (keys: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const allSelected = selected.length === allKeys.length;
  const label = allSelected
    ? 'All apps'
    : selected.length === 0
    ? 'No apps'
    : `${selected.length} of ${allKeys.length} apps`;

  function toggle(key: string) {
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
          <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setOpen(false)} />
          <div style={{
            position: 'absolute', top: '110%', left: 0, zIndex: 100,
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: '6px 0', minWidth: 160,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 12px 8px', borderBottom: `1px solid ${C.border}` }}>
              <button onClick={() => onChange([...allKeys])} style={{ fontSize: 11, color: C.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Select all</button>
              <button onClick={() => onChange([])} style={{ fontSize: 11, color: C.textSub, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Deselect all</button>
            </div>
            {allKeys.map(key => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer', color: C.text, fontSize: 13 }}>
                <input type="checkbox" checked={selected.includes(key)} onChange={() => toggle(key)} style={{ accentColor: C.accent }} />
                {key}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: 6,
  border: `1px solid ${C.border}`,
  background: C.btnBg,
  color: C.text,
  fontSize: 12,
  colorScheme: 'dark',
};

export default function AzureDashboardPage() {
  const { settings, loading: settingsLoading } = useSettings();
  const { credStatus, credError, metrics, loading, fetchMetrics } = useAzureMetrics();
  const allAppKeys = settings.azure.apps.map(a => a.name);
  const [selectedApps, setSelectedApps] = useState<string[]>([]);
  const [startDt, setStartDt] = useState(() => toDatetimeLocal(todayMidnight()));
  const [endDt,   setEndDt]   = useState(() => maxEndDt());
  const [granularity, setGranularity] = useState('PT5M');
  const [committedStart, setCommittedStart] = useState<string | null>(null);
  const [committedEnd,   setCommittedEnd]   = useState<string | null>(null);

  const effectiveSelected = selectedApps.length > 0
    ? selectedApps.filter(k => allAppKeys.includes(k))
    : allAppKeys;

  const spanHours = useMemo(() => {
    if (!startDt || !endDt) return 0;
    return (new Date(endDt).getTime() - new Date(startDt).getTime()) / 3_600_000;
  }, [startDt, endDt]);

  // Auto-coarsen granularity if span grows past current option's max
  useEffect(() => {
    const currentGranOpt = GRANULARITIES.find(g => g.value === granularity);
    if (currentGranOpt && spanHours > currentGranOpt.maxSpanHours) {
      const coarser = GRANULARITIES.find(g => spanHours <= g.maxSpanHours);
      if (coarser) setGranularity(coarser.value);
    }
  }, [spanHours, granularity]);

  const handleFetch = useCallback(() => {
    const isoStart = new Date(startDt).toISOString();
    const isoEnd   = new Date(endDt).toISOString();
    setCommittedStart(isoStart);
    setCommittedEnd(isoEnd);
    fetchMetrics(effectiveSelected, 'custom', settings.azure, isoStart, isoEnd, granularity);
  }, [fetchMetrics, effectiveSelected, startDt, endDt, settings.azure, granularity]);

  const notConfigured = !settingsLoading && (!settings.azure.subscriptionId || allAppKeys.length === 0);
  const fetchDisabled = loading || credStatus === 'error' || effectiveSelected.length === 0 || notConfigured || !startDt || !endDt;

  return (
    <div className="flex flex-col gap-4">

      {/* Not configured banner */}
      {notConfigured && (
        <div style={{
          padding: '12px 16px',
          background: '#0d1117',
          border: '1px solid #21262d',
          borderRadius: 8,
          fontSize: 13,
          color: C.textSub,
        }}>
          No Azure configuration found. Click the ⚙ Settings icon in the header to add your subscription ID and apps.
        </div>
      )}

      {/* Credential error banner */}
      {credStatus === 'error' && (
        <div style={{
          padding: '12px 16px',
          background: '#1c0a0a',
          border: '1px solid #3d1f1f',
          borderRadius: 8,
          display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <span style={{ fontSize: 14, color: C.red, marginTop: 1 }}>✖</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: C.red, fontWeight: 600 }}>Azure CLI not authenticated</div>
            <div style={{ fontSize: 12, color: C.textSub, marginTop: 3 }}>
              Run the command below in your terminal, then relaunch DevForge:
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <code style={{ fontSize: 12, color: '#79c0ff', background: '#0d1117', padding: '3px 8px', borderRadius: 4, border: `1px solid ${C.border}` }}>
                az login
              </code>
              <button
                onClick={() => navigator.clipboard.writeText('az login')}
                style={{ fontSize: 11, color: C.textSub, background: C.btnBg, border: `1px solid ${C.border}`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer' }}
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Control bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {!notConfigured && (
          <AppDropdown selected={effectiveSelected} allKeys={allAppKeys} onChange={setSelectedApps} />
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: C.textSub }}>From:</span>
          <input
            type="datetime-local"
            value={startDt}
            onChange={e => setStartDt(e.target.value)}
            style={inputStyle}
          />
          <span style={{ fontSize: 12, color: C.textSub }}>To:</span>
          <input
            type="datetime-local"
            value={endDt}
            max={maxEndDt()}
            onChange={e => {
              const max = maxEndDt();
              setEndDt(e.target.value > max ? max : e.target.value);
            }}
            style={inputStyle}
          />
          <button
            onClick={() => setEndDt(maxEndDt())}
            title="Set end to now (−5 min ingestion delay)"
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              border: `1px solid ${C.border}`,
              background: C.btnBg,
              color: C.textSub,
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            Now
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 11, color: C.textMuted }}>Interval:</span>
            {GRANULARITIES.map(g => {
              const disabled = spanHours > g.maxSpanHours;
              return (
                <button
                  key={g.value}
                  disabled={disabled}
                  onClick={() => !disabled && setGranularity(g.value)}
                  title={disabled ? `Max span ${g.maxSpanHours}h` : undefined}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 5,
                    border: `1px solid ${granularity === g.value && !disabled ? C.btnActive : C.border}`,
                    background: granularity === g.value && !disabled ? `${C.btnActive}22` : 'none',
                    color: disabled ? C.textMuted : granularity === g.value ? C.accent : C.textSub,
                    fontSize: 11,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.4 : 1,
                  }}
                >
                  {g.label}
                </button>
              );
            })}
          </div>

          <button
            onClick={handleFetch}
            disabled={fetchDisabled}
            title="Fetch Metrics"
            style={{
              padding: '5px 8px',
              borderRadius: 6,
              border: 'none',
              background: 'none',
              color: fetchDisabled ? C.textMuted : C.textSub,
              fontSize: 16,
              cursor: fetchDisabled ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center',
              opacity: credStatus === 'error' || effectiveSelected.length === 0 ? 0.4 : 1,
            }}
          >
            {loading ? (
              <span style={{
                display: 'inline-block', width: 14, height: 14,
                border: `2px solid ${C.textMuted}`, borderTopColor: C.accent,
                borderRadius: '50%', animation: 'spin 0.8s linear infinite',
              }} />
            ) : '↻'}
          </button>
        </div>

        <div style={{ marginLeft: 'auto' }}>
          <CredBadge status={credStatus} error={credError} />
        </div>
      </div>

      {/* Empty state */}
      {!metrics && !loading && !notConfigured && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: C.textSub, fontSize: 14 }}>
          Select apps and time range, then click ↻ to fetch metrics.
        </div>
      )}

      {/* Card grid */}
      {(metrics || loading) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }}>
          {effectiveSelected.map(key => {
            const m = metrics?.[key];
            const appDef = settings.azure.apps.find(a => a.name === key);
            if (!m && !loading) return null;
            return (
              <AzureAppCard
                key={key}
                appKey={key}
                azureSettings={settings.azure}
                metrics={m ?? {
                  label: appDef?.name ?? key,
                  type: appDef?.type ?? 'appservice',
                  cpu: { avg: 0, max: 0, series: [] },
                  memory: { avg: 0, max: 0, series: [] },
                  cpuUnit: '%',
                  memUnit: '%',
                }}
                loading={loading}
                uptimeRobotApiKey={settings.apiKeys.uptimeRobotApiKey}
                uptimeRobotMonitorIds={appDef?.uptimeRobotMonitorIds}
                rangeStart={committedStart ?? undefined}
                rangeEnd={committedEnd ?? undefined}
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
        input[type="datetime-local"]::-webkit-calendar-picker-indicator {
          filter: invert(0.6);
          cursor: pointer;
        }
      `}</style>
    </div>
  );
}
