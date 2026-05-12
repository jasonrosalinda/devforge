import { useState, useEffect } from 'react';
import { Trash2, Plus, Pencil, Check, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useSettings } from '@/context/settings-context';
import type { AppSettings, AzureAppEntry } from '@/types/settings.types';
import { Eye, EyeOff } from 'lucide-react';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const EMPTY_APP: AzureAppEntry = {
  type: 'appservice',
  resourceGroup: '',
  name: '',
};

type Tab = 'azure' | 'apikeys';

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { settings, updateSettings } = useSettings();
  const [tab, setTab] = useState<Tab>('azure');
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [editingApp, setEditingApp] = useState<AzureAppEntry | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPagespeed, setShowPagespeed] = useState(false);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [showUptimeRobot, setShowUptimeRobot] = useState(false);
  const [newMonitorId, setNewMonitorId] = useState('');

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  async function handleSave() {
    setSaving(true);
    try {
      await updateSettings(draft);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  function startAddApp() {
    setEditingApp({ ...EMPTY_APP });
    setEditingIndex(null);
  }

  function startEditApp(app: AzureAppEntry, idx: number) {
    setEditingApp({ ...app });
    setEditingIndex(idx);
  }

  function cancelEditApp() {
    setEditingApp(null);
    setEditingIndex(null);
  }

  function commitApp() {
    if (!editingApp) return;
    const apps = [...draft.azure.apps];
    if (editingIndex === null) {
      apps.push(editingApp);
    } else {
      apps[editingIndex] = editingApp;
    }
    setDraft(d => ({ ...d, azure: { ...d.azure, apps } }));
    setEditingApp(null);
    setEditingIndex(null);
  }

  function removeApp(idx: number) {
    const apps = draft.azure.apps.filter((_, i) => i !== idx);
    setDraft(d => ({ ...d, azure: { ...d.azure, apps } }));
  }

  const tabStyle = (t: Tab) => ({
    padding: '6px 14px',
    borderRadius: 6,
    border: 'none',
    background: tab === t ? 'hsl(var(--accent))' : 'transparent',
    color: tab === t ? 'hsl(var(--accent-foreground))' : 'hsl(var(--muted-foreground))',
    fontSize: 13,
    fontWeight: tab === t ? 600 : 400,
    cursor: 'pointer',
  });

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto scrollable-content">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 border-b pb-2 mb-4">
          <button style={tabStyle('azure')} onClick={() => setTab('azure')}>Azure</button>
          <button style={tabStyle('apikeys')} onClick={() => setTab('apikeys')}>API Keys</button>
        </div>

        {/* Azure Tab */}
        {tab === 'azure' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Subscription ID</Label>
              <Input
                value={draft.azure.subscriptionId}
                onChange={e => setDraft(d => ({ ...d, azure: { ...d.azure, subscriptionId: e.target.value } }))}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="text-xs font-mono"
              />
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Apps</span>
              <Button size="sm" variant="outline" onClick={startAddApp} className="h-7 text-xs gap-1">
                <Plus className="w-3 h-3" /> Add App
              </Button>
            </div>

            {/* App form (add/edit) */}
            {editingApp && (
              <div className="border rounded-lg p-3 flex flex-col gap-3 bg-muted/30">
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Type</Label>
                    <Select
                      value={editingApp.type}
                      onValueChange={v => setEditingApp(a => a && ({ ...a, type: v as AzureAppEntry['type'] }))}
                    >
                      <SelectTrigger className="text-xs h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="appservice">App Service</SelectItem>
                        <SelectItem value="containerapp">Container App</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Resource Group</Label>
                    <Input
                      value={editingApp.resourceGroup}
                      onChange={e => setEditingApp(a => a && ({ ...a, resourceGroup: e.target.value }))}
                      placeholder="my-rg"
                      className="text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-1 col-span-2">
                    <Label className="text-xs">App Name</Label>
                    <Input
                      value={editingApp.name}
                      onChange={e => setEditingApp(a => a && ({ ...a, name: e.target.value }))}
                      placeholder="myapp"
                      className="text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-1 col-span-2">
                    <Label className="text-xs">App Insights Application ID <span className="text-muted-foreground">(optional)</span></Label>
                    <Input
                      value={editingApp.appInsightsAppId ?? ''}
                      onChange={e => { const v = e.target.value; setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v) n.appInsightsAppId = v; else delete n.appInsightsAppId; return n; }); }}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      className="text-xs font-mono"
                    />
                    <span className="text-[10px] text-muted-foreground">Azure Portal → App Insights → Overview → Application ID</span>
                  </div>
                  <div className="flex flex-col gap-1 col-span-2">
                    <Label className="text-xs">UptimeRobot Monitor IDs <span className="text-muted-foreground">(optional)</span></Label>
                    {(editingApp.uptimeRobotMonitorIds ?? []).map((id, idx) => (
                      <div key={idx} className="flex items-center gap-1">
                        <span className="text-xs font-mono flex-1 px-2 py-1 rounded border border-border bg-muted/30">{id}</span>
                        <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive hover:text-destructive flex-shrink-0"
                          onClick={() => setEditingApp(a => { if (!a) return null; const ids = (a.uptimeRobotMonitorIds ?? []).filter((_, i) => i !== idx); const n = { ...a }; if (ids.length) n.uptimeRobotMonitorIds = ids; else delete n.uptimeRobotMonitorIds; return n; })}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex gap-1">
                      <Input
                        value={newMonitorId}
                        onChange={e => setNewMonitorId(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && newMonitorId.trim()) { setEditingApp(a => { if (!a) return null; return { ...a, uptimeRobotMonitorIds: [...(a.uptimeRobotMonitorIds ?? []), newMonitorId.trim()] }; }); setNewMonitorId(''); } }}
                        placeholder="799912345"
                        className="text-xs font-mono h-7"
                      />
                      <Button size="sm" variant="outline" className="h-7 text-xs px-2 flex-shrink-0"
                        disabled={!newMonitorId.trim()}
                        onClick={() => { setEditingApp(a => { if (!a) return null; return { ...a, uptimeRobotMonitorIds: [...(a.uptimeRobotMonitorIds ?? []), newMonitorId.trim()] }; }); setNewMonitorId(''); }}>
                        <Plus className="w-3 h-3" />
                      </Button>
                    </div>
                    <span className="text-[10px] text-muted-foreground">UptimeRobot → My Monitors → select monitor → ID in URL</span>
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="ghost" onClick={cancelEditApp} className="h-7 text-xs gap-1">
                    <X className="w-3 h-3" /> Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={commitApp}
                    disabled={!editingApp.name || !editingApp.resourceGroup}
                    className="h-7 text-xs gap-1"
                  >
                    <Check className="w-3 h-3" /> {editingIndex === null ? 'Add' : 'Save'}
                  </Button>
                </div>
              </div>
            )}

            {/* App list */}
            {draft.azure.apps.length === 0 && !editingApp && (
              <p className="text-xs text-muted-foreground text-center py-4">No apps configured. Click Add App.</p>
            )}
            {draft.azure.apps.map((app, idx) => (
              <div key={idx} className="flex items-center justify-between border rounded-md px-3 py-2 text-xs">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{app.name}</span>
                  <span className="text-muted-foreground">{app.type === 'appservice' ? 'App Service' : 'Container App'} · {app.resourceGroup}</span>
                </div>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => startEditApp(app, idx)}>
                    <Pencil className="w-3 h-3" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => removeApp(idx)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}


        {/* API Keys Tab */}
        {tab === 'apikeys' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">PageSpeed Insights API Key</Label>
              <div className="relative">
                <Input
                  type={showPagespeed ? 'text' : 'password'}
                  value={draft.apiKeys.pagespeedApiKey}
                  onChange={e => setDraft(d => ({ ...d, apiKeys: { ...d.apiKeys, pagespeedApiKey: e.target.value } }))}
                  placeholder="AIza..."
                  className="text-xs font-mono pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowPagespeed(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPagespeed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">Used by PageSpeed Insights tool. Get key at Google Cloud Console.</p>
            </div>

            <Separator />

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Anthropic API Key</Label>
              <div className="relative">
                <Input
                  type={showAnthropic ? 'text' : 'password'}
                  value={draft.apiKeys.anthropicApiKey}
                  onChange={e => setDraft(d => ({ ...d, apiKeys: { ...d.apiKeys, anthropicApiKey: e.target.value } }))}
                  placeholder="sk-ant-oat01-..."
                  className="text-xs font-mono pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowAnthropic(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showAnthropic ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">Used by AI-powered tools. Get key at "claude setup-token".</p>
            </div>

            <Separator />

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">UptimeRobot API Key</Label>
              <div className="relative">
                <Input
                  type={showUptimeRobot ? 'text' : 'password'}
                  value={draft.apiKeys.uptimeRobotApiKey}
                  onChange={e => setDraft(d => ({ ...d, apiKeys: { ...d.apiKeys, uptimeRobotApiKey: e.target.value } }))}
                  placeholder="ur1234567-xxxxxxxxxxxxxxxxxxxxxxxx"
                  className="text-xs font-mono pr-8"
                />
                <button type="button" onClick={() => setShowUptimeRobot(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showUptimeRobot ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">Used to fetch monitor status and downtime logs per app. UptimeRobot → Integration & API → Main API Keys → Read-only API key</p>
            </div>

          </div>
        )}

        <div className="flex justify-end gap-2 mt-4 pt-4 border-t">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
