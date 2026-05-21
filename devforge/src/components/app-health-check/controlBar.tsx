import { useMemo, useEffect } from 'react';
import { AppDropdown } from './appDropdown';
import { CredBadge } from './credBadge';
import { C, GRANULARITIES, inputStyle, maxEndDt } from './styles';

type Props = {
  notConfigured: boolean;
  effectiveSelected: string[];
  allAppKeys: string[];
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
    notConfigured, effectiveSelected, allAppKeys, onSelectedChange,
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
        <AppDropdown selected={effectiveSelected} allKeys={allAppKeys} onChange={onSelectedChange} />
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
          onClick={onFetch}
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
  );
}
