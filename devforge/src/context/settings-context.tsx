import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '@/lib/settings-store';
import type { AppSettings } from '@/types/settings.types';

interface SettingsContextValue {
  settings: AppSettings;
  updateSettings: (s: AppSettings) => Promise<void>;
  loading: boolean;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  updateSettings: async () => {},
  loading: true,
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSettings().then(s => {
      setSettings(s);
      setLoading(false);
      window.electronAPI?.commands?.sync({
        subscriptionId: s.azure.subscriptionId,
        apps: s.azure.apps,
      });
    });
  }, []);

  async function updateSettings(s: AppSettings) {
    await saveSettings(s);
    setSettings(s);
    window.electronAPI?.commands?.sync({
      subscriptionId: s.azure.subscriptionId,
      apps: s.azure.apps,
    });
  }

  return (
    <SettingsContext.Provider value={{ settings, updateSettings, loading }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
