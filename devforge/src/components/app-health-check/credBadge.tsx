import { C } from './styles';

type Props = {
  status: 'checking' | 'ok' | 'error';
  error: string | null;
};

export function CredBadge({ status, error }: Props) {
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
