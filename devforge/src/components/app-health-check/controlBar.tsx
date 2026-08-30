import { useMemo, useEffect } from 'react';
import { AppDropdown } from './appDropdown';
import { C, GRANULARITIES, inputStyle, nowDt } from './styles';
import { Hint } from '@/components/ui/hint';

type Props = {
  notConfigured: boolean;
  effectiveSelected: string[];
  allAppKeys: string[];
  /** App key → platform name, for the picker. */
  appLabels?: Record<string, string>;
  onSelectedChange: (keys: string[]) => void;
  startDt: string;
  setStartDt: (v: string) => void;
  endDt: string;
  setEndDt: (v: string) => void;
  granularity: string;
  setGranularity: (v: string) => void;
  loading: boolean;
  fetchDisabled: boolean;
  onFetch: () => void;
  credStatus: 'checking' | 'ok' | 'error';
  credError: string | null;
};

export function ControlBar(props: Props) {
  const {
    notConfigured, effectiveSelected, allAppKeys, appLabels, onSelectedChange,
    startDt, setStartDt, endDt, setEndDt,
    granularity, setGranularity,
    loading, fetchDisabled, onFetch,
    credStatus, credError,
  } = props;

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
  }, [spanHours, granularity, setGranularity]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      {!notConfigured && (
        <AppDropdown selected={effectiveSelected} allKeys={allAppKeys} onChange={onSelectedChange} labels={appLabels ?? {}} />
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
          onChange={e => setEndDt(e.target.value)}
          style={inputStyle}
        />
        <Hint label="Set the end time to now. Telemetry lags a few minutes, so the last bucket may be thin or empty.">
        <button
          onClick={() => setEndDt(nowDt())}
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
        </Hint>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>Interval:</span>
          {GRANULARITIES.map(g => {
            const disabled = spanHours > g.maxSpanHours;
            return (
              <Hint
                key={g.value}
                label={disabled
                  ? `Unavailable above ${g.maxSpanHours}h of range - narrow the window to use ${g.label} buckets`
                  : `Bucket the metrics every ${g.label}`}
              >
              <button
                disabled={disabled}
                onClick={() => !disabled && setGranularity(g.value)}
                style={{
                  padding: '3px 8px',
                  borderRadius: 5,
                  border: `1px solid ${granularity === g.value && !disabled ? C.btnActive : C.border}`,
                  background: granularity === g.value && !disabled ? `${C.btnActive}22` : 'none',
                  color: disabled ? C.textMuted : granularity === g.value ? C.accent : C.textSub,
                  fontSize: 11,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.4 : 1,
                  pointerEvents: disabled ? 'none' : undefined,
                }}
              >
                {g.label}
              </button>
              </Hint>
            );
          })}
        </div>

        <Hint label={loading ? 'Fetching metrics from Azure Monitor…' : 'Fetch metrics for the selected apps and time range'}>
        <button
          onClick={onFetch}
          disabled={fetchDisabled}
          style={{
            padding: '5px 8px',
            borderRadius: 6,
            border: 'none',
            background: 'none',
            color: fetchDisabled ? C.textMuted : C.textSub,
            fontSize: 16,
            cursor: fetchDisabled ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center',
            opacity: fetchDisabled ? 0.4 : 1,
            pointerEvents: fetchDisabled ? 'none' : undefined,
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
        </Hint>
      </div>

    </div>
  );
}
