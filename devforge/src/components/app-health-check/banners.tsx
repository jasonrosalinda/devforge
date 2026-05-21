import { C } from './styles';

export function NotConfiguredBanner() {
  return (
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
  );
}

export function CredErrorBanner() {
  return (
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
  );
}

export function StatusLegend() {
  return (
    <div style={{
      marginTop: 24,
      padding: '10px 16px',
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      display: 'flex', gap: 20, fontSize: 11, color: C.textSub, flexWrap: 'wrap',
    }}>
      <span><span style={{ color: C.green  }}>● Healthy</span>  — CPU p99 ≤70% / Mem p99 ≤80%</span>
      <span><span style={{ color: C.yellow }}>● Warning</span>  — CPU p99 &gt;70% / Mem p99 &gt;80%</span>
      <span><span style={{ color: C.red    }}>● Critical</span> — CPU p99 &gt;90% / Mem p99 &gt;95%</span>
    </div>
  );
}
