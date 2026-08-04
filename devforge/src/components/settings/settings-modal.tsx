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
import { DEFAULT_SLO_MS } from '@/types/settings.types';
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

type Tab = 'azure' | 'apikeys' | 'atlassian';

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { settings, updateSettings } = useSettings();
  const [tab, setTab] = useState<Tab>('azure');
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [editingApp, setEditingApp] = useState<AzureAppEntry | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPagespeed, setShowPagespeed] = useState(false);
  const [showUptimeRobot, setShowUptimeRobot] = useState(false);
  const [showAtlassianToken, setShowAtlassianToken] = useState(false);
const [newMonitorId, setNewMonitorId] = useState('');
  const [newPlatformUrl, setNewPlatformUrl] = useState('');

  function addPlatformUrl() {
    const url = newPlatformUrl.trim();
    if (!url) return;
    setEditingApp(a => (a ? { ...a, platformUrls: [...(a.platformUrls ?? []), url] } : null));
    setNewPlatformUrl('');
  }

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
    setNewPlatformUrl('');
    setNewMonitorId('');
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
    setNewPlatformUrl('');
    setNewMonitorId('');
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
          <button style={tabStyle('atlassian')} onClick={() => setTab('atlassian')}>Atlassian</button>
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
              <span className="text-sm font-medium">Services</span>
              <Button size="sm" variant="outline" onClick={startAddApp} className="h-7 text-xs gap-1">
                <Plus className="w-3 h-3" /> Add Service
              </Button>
            </div>

            {/* App form (add/edit) */}
            {editingApp && (
              <div className="border rounded-lg p-3 flex flex-col gap-3 bg-muted/30">

                {/* Platform name — what the service is called to a reader. Left blank
                    it falls back to the resource group everywhere it is displayed, so
                    settings written by an older build keep working untouched. */}
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">Name</Label>
                  <Input
                    value={editingApp.platformName ?? ''}
                    onChange={e => { const v = e.target.value; setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v) n.platformName = v; else delete n.platformName; return n; }); }}
                    placeholder={editingApp.resourceGroup || 'my-rg'}
                    className="text-xs"
                  />
                  <span className="text-[10px] text-muted-foreground">Platform name shown on cards and reports. Defaults to the resource group.</span>
                </div>

                {/* Platform URLs */}
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">Urls <span className="text-muted-foreground">(optional)</span></Label>
                  {(editingApp.platformUrls ?? []).map((url, idx) => (
                    <div key={idx} className="flex items-center gap-1">
                      <span className="text-xs font-mono flex-1 px-2 py-1 rounded border border-border bg-muted/30 truncate" title={url}>{url}</span>
                      <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive hover:text-destructive flex-shrink-0"
                        onClick={() => setEditingApp(a => { if (!a) return null; const urls = (a.platformUrls ?? []).filter((_, i) => i !== idx); const n = { ...a }; if (urls.length) n.platformUrls = urls; else delete n.platformUrls; return n; })}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                  <div className="flex gap-1">
                    <Input
                      value={newPlatformUrl}
                      onChange={e => setNewPlatformUrl(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPlatformUrl(); } }}
                      placeholder="https://mims-cpd.com"
                      className="text-xs font-mono h-7"
                    />
                    <Button size="sm" variant="outline" className="h-7 text-xs px-2 flex-shrink-0"
                      disabled={!newPlatformUrl.trim()}
                      onClick={addPlatformUrl}>
                      <Plus className="w-3 h-3" />
                    </Button>
                  </div>
                  <span className="text-[10px] text-muted-foreground">Public URLs for this platform — used as "Services Affected" in the RCA report.</span>
                </div>

                <Separator />

                {/* Shared: Resource Group */}
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">Resource Group</Label>
                  <Input
                    value={editingApp.resourceGroup}
                    onChange={e => setEditingApp(a => a && ({ ...a, resourceGroup: e.target.value }))}
                    placeholder="my-rg"
                    className="text-xs"
                  />
                </div>

                <Separator />

                {/* Frontend */}
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Frontend</span>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Type</Label>
                      <Select
                        value={editingApp.type}
                        onValueChange={v => setEditingApp(a => a && ({ ...a, type: v as AzureAppEntry['type'] }))}
                      >
                        <SelectTrigger className="text-xs h-8"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="appservice">App Service</SelectItem>
                          <SelectItem value="containerapp">Container App</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Name</Label>
                      <Input
                        value={editingApp.name}
                        onChange={e => setEditingApp(a => a && ({ ...a, name: e.target.value }))}
                        placeholder="myapp"
                        className="text-xs"
                      />
                      <span className="text-[10px] text-muted-foreground">Application Name</span>
                    </div>
                    <div className="flex flex-col gap-1 col-span-2">
                      <Label className="text-xs">App Insights Application ID <span className="text-muted-foreground">(optional)</span></Label>
                      <Input
                        value={editingApp.appInsightsAppId ?? ''}
                        onChange={e => { const v = e.target.value; setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v) n.appInsightsAppId = v; else delete n.appInsightsAppId; return n; }); }}
                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                        className="text-xs font-mono"
                      />
                      <span className="text-[10px] text-muted-foreground">Azure Portal → App Insights → Overview → Connection string → Application Id</span>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* API */}
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">API <span className="normal-case font-normal">(optional)</span></span>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Type</Label>
                      <Select
                        value={editingApp.apiType ?? 'appservice'}
                        onValueChange={v => setEditingApp(a => a && ({ ...a, apiType: v as AzureAppEntry['type'] }))}
                      >
                        <SelectTrigger className="text-xs h-8"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="appservice">App Service</SelectItem>
                          <SelectItem value="containerapp">Container App</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Name</Label>
                      <Input
                        value={editingApp.apiName ?? ''}
                        onChange={e => { const v = e.target.value; setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v) n.apiName = v; else delete n.apiName; return n; }); }}
                        placeholder="myapp-api"
                        className="text-xs"
                      />
                      <span className="text-[10px] text-muted-foreground">Application Name</span>
                    </div>
                    <div className="flex flex-col gap-1 col-span-2">
                      <Label className="text-xs">App Insights Application ID</Label>
                      <Input
                        value={editingApp.apiInsightsAppId ?? ''}
                        onChange={e => { const v = e.target.value; setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v) n.apiInsightsAppId = v; else delete n.apiInsightsAppId; return n; }); }}
                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                        className="text-xs font-mono"
                      />
                      <span className="text-[10px] text-muted-foreground">Azure Portal → App Insights → Overview → Connection string → Application Id</span>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Network / Edge diagnostics */}
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Network / Edge <span className="normal-case font-normal">(optional)</span></span>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Log Analytics Workspace ID</Label>
                    <Input
                      value={editingApp.logAnalyticsWorkspaceId ?? ''}
                      onChange={e => { const v = e.target.value; setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v) n.logAnalyticsWorkspaceId = v; else delete n.logAnalyticsWorkspaceId; return n; }); }}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      className="text-xs font-mono"
                    />
                    <span className="text-[10px] text-muted-foreground">Azure Portal → Log Analytics workspace → Overview → Workspace ID (required for the edge logs below)</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Application Gateway Resource ID</Label>
                    <Input
                      value={editingApp.appGatewayResourceId ?? ''}
                      onChange={e => { const v = e.target.value; setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v) n.appGatewayResourceId = v; else delete n.appGatewayResourceId; return n; }); }}
                      placeholder="/subscriptions/.../applicationGateways/my-agw"
                      className="text-xs font-mono"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Front Door / CDN Resource ID</Label>
                    <Input
                      value={editingApp.frontDoorResourceId ?? ''}
                      onChange={e => { const v = e.target.value; setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v) n.frontDoorResourceId = v; else delete n.frontDoorResourceId; return n; }); }}
                      placeholder="/subscriptions/.../providers/Microsoft.Cdn/profiles/my-afd"
                      className="text-xs font-mono"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Load Balancer Resource ID</Label>
                    <Input
                      value={editingApp.loadBalancerResourceId ?? ''}
                      onChange={e => { const v = e.target.value; setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v) n.loadBalancerResourceId = v; else delete n.loadBalancerResourceId; return n; }); }}
                      placeholder="/subscriptions/.../loadBalancers/my-lb"
                      className="text-xs font-mono"
                    />
                    <span className="text-[10px] text-muted-foreground">Resource → Properties → Resource ID. Edge logs require diagnostic settings sending to the workspace above.</span>
                  </div>
                </div>

                <Separator />

                {/* Database */}
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Database <span className="normal-case font-normal">(optional)</span></span>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Name</Label>
                    <Input
                      value={editingApp.dbName ?? ''}
                      onChange={e => { const v = e.target.value; setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v) n.dbName = v; else delete n.dbName; return n; }); }}
                      placeholder="myapp-db"
                      className="text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Server name</Label>
                    <Input
                      value={editingApp.dbServerName ?? ''}
                      onChange={e => { const v = e.target.value; setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v) n.dbServerName = v; else delete n.dbServerName; return n; }); }}
                      placeholder="myapp-sqlserver"
                      className="text-xs"
                    />
                    <span className="text-[10px] text-muted-foreground">Azure SQL logical server (without .database.windows.net). Both fields required for DB CPU/memory metrics.</span>
                  </div>
                </div>

                <Separator />

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latency objective <span className="normal-case font-normal">(optional)</span></span>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Target (ms)</Label>
                    <Input
                      type="number"
                      min={1}
                      value={editingApp.sloMs ?? ''}
                      onChange={e => { const v = Number(e.target.value); setEditingApp(a => { if (!a) return null; const n = { ...a }; if (v > 0) n.sloMs = v; else delete n.sloMs; return n; }); }}
                      placeholder={String(DEFAULT_SLO_MS)}
                      className="text-xs"
                    />
                    <span className="text-[10px] text-muted-foreground">A successful response slower than this counts as a policy failure in the Errors signal. Defaults to {DEFAULT_SLO_MS}ms.</span>
                  </div>
                </div>

                <Separator />

                {/* UptimeRobot */}
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">UptimeRobot Monitor IDs <span className="normal-case font-normal">(optional)</span></span>
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
              <p className="text-xs text-muted-foreground text-center py-4">No services configured. Click Add Service.</p>
            )}
            {draft.azure.apps.map((app, idx) => (
              <div key={idx} className="flex items-center justify-between border rounded-md px-3 py-2 text-xs">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{app.platformName || app.resourceGroup || app.name}</span>
                  <span className="text-muted-foreground">{app.type === 'appservice' ? 'App Service' : 'Container App'} · {app.name}{app.apiName && ` · ${app.apiName}`}</span>
                  {app.dbName && (
                    <span className="text-muted-foreground">DB: {app.dbName}{app.dbServerName ? ` @ ${app.dbServerName}` : ''}</span>
                  )}
                  {(app.platformUrls?.length ?? 0) > 0 && (
                    <span className="text-muted-foreground truncate" title={app.platformUrls!.join(', ')}>{app.platformUrls!.join(', ')}</span>
                  )}
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
              <p className="text-xs text-muted-foreground">Used by PageSpeed Insights tool. Get your key at <a href="https://developers.google.com/speed/docs/insights/v5/get-started" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">Google PageSpeed Insights API</a>.</p>
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

        {/* Atlassian Tab */}
        {tab === 'atlassian' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Confluence Base URL</Label>
              <Input
                value={draft.atlassian.confluenceBaseUrl}
                onChange={e => setDraft(d => ({ ...d, atlassian: { ...d.atlassian, confluenceBaseUrl: e.target.value } }))}
                placeholder="https://your-site.atlassian.net"
                className="text-xs font-mono"
              />
              <p className="text-xs text-muted-foreground">Your Atlassian Cloud site root. The Release Pilot page appends <span className="font-mono">/wiki/rest/api</span>.</p>
            </div>

            <Separator />

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Atlassian Account Email</Label>
              <Input
                value={draft.atlassian.email}
                onChange={e => setDraft(d => ({ ...d, atlassian: { ...d.atlassian, email: e.target.value } }))}
                placeholder="you@company.com"
                className="text-xs font-mono"
              />
            </div>

            <Separator />

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Confluence API Token</Label>
              <div className="relative">
                <Input
                  type={showAtlassianToken ? 'text' : 'password'}
                  value={draft.atlassian.apiToken}
                  onChange={e => setDraft(d => ({ ...d, atlassian: { ...d.atlassian, apiToken: e.target.value } }))}
                  placeholder="ATATT3x..."
                  className="text-xs font-mono pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowAtlassianToken(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showAtlassianToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">Create at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">id.atlassian.com → API tokens</a>. Used with Basic auth to fetch runbook pages + attachments.</p>
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
