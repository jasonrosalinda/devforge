import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { SettingsModal, type SettingsTab } from '@/components/settings/settings-modal';

interface SettingsUiContextValue {
  /** Opens the Settings dialog, optionally landing on a specific tab. */
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
}

const SettingsUiContext = createContext<SettingsUiContextValue>({
  openSettings: () => {},
  closeSettings: () => {},
});

/**
 * Owns the Settings dialog so any page can send the user straight to the setting
 * it needs - e.g. PageSpeed pointing at the missing API key - without threading
 * callbacks down through the page tree.
 */
export function SettingsUiProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab | undefined>(undefined);

  const openSettings = useCallback((next?: SettingsTab) => {
    setTab(next);
    setOpen(true);
  }, []);
  const closeSettings = useCallback(() => setOpen(false), []);

  const value = useMemo(() => ({ openSettings, closeSettings }), [openSettings, closeSettings]);

  return (
    <SettingsUiContext.Provider value={value}>
      {children}
      <SettingsModal open={open} onClose={closeSettings} initialTab={tab} />
    </SettingsUiContext.Provider>
  );
}

export function useSettingsUi() {
  return useContext(SettingsUiContext);
}
