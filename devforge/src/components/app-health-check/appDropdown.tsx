import { useState } from 'react';
import { C } from './styles';

type Props = {
  selected: string[];
  allKeys: string[];
  onChange: (keys: string[]) => void;
  /** App key → platform name. Missing entries fall back to the key itself. */
  labels?: Record<string, string>;
};

export function AppDropdown({ selected, allKeys, onChange, labels = {} }: Props) {
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
            {allKeys.map(key => {
              const name = labels[key] || key;
              return (
                <label key={key} title={name === key ? key : `${name} · ${key}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer', color: C.text, fontSize: 13 }}>
                  <input type="checkbox" checked={selected.includes(key)} onChange={() => toggle(key)} style={{ accentColor: C.accent }} />
                  {name}
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
