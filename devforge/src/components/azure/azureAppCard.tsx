import type { AppMetrics } from '@shared/types/azureMetrics.types';
import { CombinedChart } from './azureMetricChart';

type Status = 'healthy' | 'warning' | 'critical';

export function getStatus(cpuAvg: number, memAvg: number): Status {
  if (cpuAvg > 90 || memAvg > 95) return 'critical';
  if (cpuAvg > 70 || memAvg > 80)  return 'warning';
  return 'healthy';
}

const STATUS_COLORS: Record<Status, string> = {
  healthy:  '#3fb950',
  warning:  '#d29922',
  critical: '#f85149',
};

const STATUS_BORDER: Record<Status, string> = {
  healthy:  '#21262d',
  warning:  '#9e6a03',
  critical: '#6e2a28',
};

interface AzureAppCardProps {
  appKey: string;
  metrics: AppMetrics;
  loading: boolean;
}

function StatBadge({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 60 }}>
      <span style={{ fontSize: 10, color: '#8b9ab3', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, color: color || '#e6edf3', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function cpuColor(val: number): string {
  if (val > 90) return '#f85149';
  if (val > 70) return '#d29922';
  return '#3fb950';
}

function memColor(val: number): string {
  if (val > 95) return '#f85149';
  if (val > 80) return '#d29922';
  return '#3fb950';
}

function InstanceDot({ healthStatus }: { healthStatus: string }) {
  const lower = healthStatus.toLowerCase();
  const color = lower === 'healthy' || lower === 'running'
    ? '#3fb950'
    : lower === 'unknown'
    ? '#8b9ab3'
    : '#f85149';
  return (
    <span style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color,
      marginRight: 4,
    }} />
  );
}

export function AzureAppCard({ appKey: _appKey, metrics, loading }: AzureAppCardProps) {
  const status = getStatus(metrics.cpu.avg, metrics.memory.avg);
  const borderColor = STATUS_BORDER[status];
  const statusColor = STATUS_COLORS[status];
  const downtimeIntervals = metrics.availability?.downtimeIntervals ?? [];

  return (
    <div style={{
      background: '#0d1117',
      border: `1px solid ${borderColor}`,
      borderRadius: 10,
      padding: '16px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#e6edf3' }}>{metrics.label}</div>
          <div style={{ fontSize: 11, color: '#8b9ab3', marginTop: 2 }}>
            {metrics.type === 'appservice' ? 'App Service' : 'Container App'}
            {metrics.plan && ` · ${metrics.plan.sku}`}
          </div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '3px 10px',
          borderRadius: 20,
          background: `${statusColor}22`,
          border: `1px solid ${statusColor}55`,
          fontSize: 12,
          color: statusColor,
          fontWeight: 600,
          textTransform: 'capitalize',
        }}>
          <span style={{ fontSize: 8 }}>●</span>
          {status}
        </div>
      </div>

      {/* Error state */}
      {metrics.error && (
        <div style={{
          padding: '8px 12px',
          background: '#1c0a0a',
          border: '1px solid #3d1f1f',
          borderRadius: 6,
          fontSize: 12,
          color: '#f85149',
        }}>
          {metrics.error}
        </div>
      )}

      {/* Chart */}
      <CombinedChart
        cpu={metrics.cpu}
        memory={metrics.memory}
        downtimeIntervals={downtimeIntervals}
        loading={loading}
      />

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <StatBadge label="CPU Avg"  value={`${metrics.cpu.avg}%`}    color={cpuColor(metrics.cpu.avg)} />
        <StatBadge label="CPU Max"  value={`${metrics.cpu.max}%`}    color={cpuColor(metrics.cpu.max)} />
        <StatBadge label="Mem Avg"  value={`${metrics.memory.avg}%`} color={memColor(metrics.memory.avg)} />
        <StatBadge label="Mem Max"  value={`${metrics.memory.max}%`} color={memColor(metrics.memory.max)} />
      </div>

      {/* Secondary row */}
      {(metrics.responseTime != null || metrics.availability != null) && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', paddingTop: 4, borderTop: '1px solid #21262d' }}>
          {metrics.responseTime != null && (
            <StatBadge label="Response Avg" value={`${metrics.responseTime.avg}s`} />
          )}
          {metrics.availability != null && (
            <>
              <StatBadge
                label="Availability"
                value={`${metrics.availability.pct}%`}
                color={metrics.availability.pct >= 99 ? '#3fb950' : metrics.availability.pct >= 95 ? '#d29922' : '#f85149'}
              />
              <StatBadge label="Downtime"  value={`${metrics.availability.downtimeMins}m`} />
              <StatBadge label="Incidents" value={String(metrics.availability.incidents)} />
            </>
          )}
        </div>
      )}

      {/* Instances row */}
      {metrics.instances && metrics.instances.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 4, borderTop: '1px solid #21262d' }}>
          {metrics.instances.map((inst) => (
            <div key={inst.name} style={{
              display: 'flex', alignItems: 'center',
              fontSize: 11, color: '#8b9ab3',
              background: '#161b22', padding: '2px 8px',
              borderRadius: 4, border: '1px solid #21262d',
            }}>
              <InstanceDot healthStatus={inst.healthStatus} />
              {inst.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
