import { type PageSpeedConfiguration } from "@shared/types/pageSpeedInsight.types";
import { defaultPageSpeedConfiguration } from "@/lib/pageSpeedUtils";
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@/components/ui";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldTitle } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Activity, Cog, Link, Table2, Trash2, Wrench } from "lucide-react";
import { Item, ItemActions, ItemContent, ItemTitle, } from "@/components/ui/item"
import { Switch } from "../ui/switch";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion";

export default function PageSpeedConfig({ configHasChanged, isAuditing, value, restoreToken }: { configHasChanged: (config: PageSpeedConfiguration) => void, isAuditing: boolean, value?: PageSpeedConfiguration | undefined, restoreToken?: number | undefined }) {
    const [config, setConfig] = useState(defaultPageSpeedConfiguration());
    const [url, setUrl] = useState('');
    const [isInvalidUrl, setIsInvalidUrl] = useState(false);
    const webUrlsInputUpload = useRef<HTMLInputElement>(null);

    // Sync drawer to a restored config snapshot. Keyed on restoreToken (not value
    // identity) so it fires only on an explicit restore, never clobbering live edits.
    useEffect(() => {
        if (restoreToken && value) setConfig(value);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [restoreToken]);

    // #region Event Handlers

    const onSetConfigState = (state: PageSpeedConfiguration) => {
        setConfig(state);
        configHasChanged(state);
    };

    const onRunModeChange = (e: boolean) => {
        onSetConfigState({
            ...config,
            runMode: e ? "average" : "single",
        });
    };

    const onConcurrencyChange = (value: string) => {
        onSetConfigState({ ...config, concurrency: Number(value) as 1 | 2 | 3 });
    };

    const onAddUrl = () => {
        const isValid = isValidUrl(url);
        setIsInvalidUrl(!isValid);
        if (isValid) {
            onSetConfigState({
                ...config,
                urls: [...config.urls, url],
            });
            setUrl('');
        }
    };

    const isValidUrl = (url: string): boolean => {
        const isValid = url.startsWith("https://") && URL.canParse(url);
        if (isValid) {
            const exists = config.urls.includes(url);
            if (exists) return false;
        }
        return isValid;
    };

    const onRemoveUrl = (url: string) => {
        const newUrls = config.urls.filter((u) => u !== url);
        onSetConfigState({
            ...config,
            urls: newUrls,
        });
    };

    const onComparisonModeChange = (e: boolean) => {
        onSetConfigState({
            ...config,
            comparisonMode: e,
        });
    };

    const onBeforeLabelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        onSetConfigState({
            ...config,
            beforeLabel: e.target.value,
        });
    };

    const onAfterLabelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        onSetConfigState({
            ...config,
            afterLabel: e.target.value,
        });
    };

    const onImprovementThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        onSetConfigState({
            ...config,
            improvementThreshold: Number(e.target.value),
        });
    };

    const onShowImprovementChange = (e: boolean) => {
        onSetConfigState({
            ...config,
            showImprovement: e,
        });
    };

    const onShowSIChange = (e: boolean) => {
        onSetConfigState({
            ...config,
            showSI: e,
        });
    };

    const onShowLCPChange = (e: boolean) => {
        onSetConfigState({
            ...config,
            showLCP: e,
        });
    };

    const onShowCLSChange = (e: boolean) => {
        onSetConfigState({
            ...config,
            showCLS: e,
        });
    };

    const onShowTBTChange = (e: boolean) => {
        onSetConfigState({
            ...config,
            showTBT: e,
        });
    };

    const onShowFCPChange = (e: boolean) => {
        onSetConfigState({
            ...config,
            showFCP: e,
        });
    };

    const onShowWarningsChange = (e: boolean) => {
        onSetConfigState({
            ...config,
            showWarnings: e,
        });
    };

    const onWebUrlsUploadClick = () => {
        webUrlsInputUpload.current?.click();
    };

    const handleWebUrlsUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                const content = event.target?.result as string;
                const parsedUrls = content.split('\n').map(url => url.trim()).filter(url => url.length > 0);
                const newUrls = parsedUrls.filter(url => isValidUrl(url));
                if (newUrls.length > 0) {
                    onSetConfigState({
                        ...config,
                        urls: [...config.urls, ...newUrls],
                    });
                }
            };
            reader.readAsText(file);
        }
    };

    // #endregion

    return (
        <div>
            <Drawer direction="right">
                <DrawerTrigger asChild>
                    <div className="flex justify-end">
                        <Button className="capitalize" variant="outline" disabled={isAuditing}>
                            <Cog className="mr-1 h-4 w-4" />Configuration
                        </Button>
                    </div>
                </DrawerTrigger>
                <DrawerContent className="right-0 left-auto top-0 mt-0 h-full w-[400px] rounded-none flex flex-col">
                    <DrawerHeader>
                        <DrawerTitle>Configuration</DrawerTitle>
                    </DrawerHeader>
                    <div className="overflow-y-auto scrollable-content px-4 flex-1">

                        <Accordion type="multiple" className="max-w-lg rounded-lg border" defaultValue={['api-key', 'web-page-urls']}>

                            <AccordionItem key="api-key" value="api-key" className="border-b px-4 last:border-b-0">
                                <AccordionTrigger>
                                    <div className="flex items-center gap-2"><Wrench className="mr-1 h-4 w-4" />Mode</div>
                                </AccordionTrigger>
                                <AccordionContent>
                                    <FieldLabel htmlFor="switch-runMode-mode" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Accuracy mode</FieldTitle>
                                                <FieldDescription className="text-xs text-muted-foreground">
                                                    Average mode runs audit 3 times and averages the results.
                                                </FieldDescription>
                                            </FieldContent>
                                            <Switch id="switch-runMode-mode" checked={config.runMode === "average"} onCheckedChange={(e) => onRunModeChange(e)} />
                                        </Field>
                                    </FieldLabel>
                                    <FieldLabel htmlFor="select-concurrency" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Parallel URLs</FieldTitle>
                                                <FieldDescription className="text-xs text-muted-foreground">
                                                    Audit multiple URLs simultaneously.
                                                </FieldDescription>
                                            </FieldContent>
                                            <select
                                                id="select-concurrency"
                                                value={config.concurrency}
                                                onChange={(e) => onConcurrencyChange(e.target.value)}
                                                className="rounded border border-input bg-background px-2 py-1 text-sm"
                                            >
                                                <option value={1}>1 (safe)</option>
                                                <option value={2}>2</option>
                                                <option value={3}>3 (fastest)</option>
                                            </select>
                                        </Field>
                                    </FieldLabel>
                                </AccordionContent>
                            </AccordionItem>

                            <AccordionItem key="web-page-urls" value="web-page-urls" className="border-b px-4 last:border-b-0">
                                <AccordionTrigger>
                                    <div className="flex items-center gap-2"><Link className="mr-1 h-4 w-4 text-red-500" />Web page URL's </div>
                                </AccordionTrigger>
                                <AccordionContent>
                                    <FieldGroup>
                                        <FieldSet>
                                            <Field>
                                                <FieldLabel>URL</FieldLabel>
                                                <Input value={url} onChange={(e) => setUrl(e.target.value)} className={isInvalidUrl ? 'border-red-500' : ''} />
                                                <FieldError>{isInvalidUrl ? '* Enter a valid URL.' : ''}</FieldError>
                                            </Field>
                                        </FieldSet>
                                        <Field>
                                            <Button onClick={onAddUrl} className="w-full" variant="outline">Add</Button>
                                            <Button onClick={onWebUrlsUploadClick} className="w-full" variant="outline">Upload</Button>
                                            <input ref={webUrlsInputUpload} type="file" accept=".txt" onChange={handleWebUrlsUpload} className="hidden" />
                                        </Field>
                                    </FieldGroup>
                                    <Separator
                                        orientation="horizontal"
                                        className="my-5 data-[orientation=horizontal]:w-full"
                                    />
                                    {config.urls.length === 0 ? (
                                        <div>
                                            <p className="text-xs text-muted-foreground">No URLs added.</p>
                                        </div>
                                    ) : (
                                        <div className="flex max-h-[300px] flex-col overflow-y-auto scrollable-content">
                                            {config.urls.map((url, index) => (
                                                <Item key={index} variant="outline" size="sm">
                                                    <ItemContent>
                                                        <ItemTitle className="text-sm break-all">{url}</ItemTitle>
                                                    </ItemContent>
                                                    <ItemActions>
                                                        <Button size="sm" variant="ghost" onClick={() => onRemoveUrl(url)}>
                                                            <Trash2 className="mr-1 h-4 w-4" />
                                                        </Button>
                                                    </ItemActions>
                                                </Item>
                                            ))}
                                        </div>
                                    )}
                                </AccordionContent>
                            </AccordionItem>

                            <AccordionItem key="audits" value="audits" className="border-b px-4 last:border-b-0">
                                <AccordionTrigger>
                                    <div className="flex items-center gap-2"><Activity className="mr-1 h-4 w-4" />Audits</div>
                                </AccordionTrigger>
                                <AccordionContent>
                                    <FieldGroup>
                                        <FieldLabel htmlFor="switch-comparison-mode">
                                            <Field orientation="horizontal">
                                                <FieldContent>
                                                    <FieldTitle>Comparison Mode</FieldTitle>
                                                    <FieldDescription className="text-xs text-muted-foreground">
                                                        Enable comparison mode to compare the before and after results.
                                                    </FieldDescription>
                                                </FieldContent>
                                                <Switch id="switch-comparison-mode" checked={config.comparisonMode} onCheckedChange={onComparisonModeChange} />
                                            </Field>
                                            {config.comparisonMode && (
                                                <>
                                                    <Field>
                                                        <FieldContent>
                                                            <FieldTitle>Before Label</FieldTitle>
                                                            <FieldDescription className="text-xs text-muted-foreground">
                                                                Label for the before results.
                                                            </FieldDescription>
                                                        </FieldContent>
                                                        <Input id="before-label" value={config.beforeLabel} onChange={onBeforeLabelChange} />
                                                    </Field>
                                                    <Field>
                                                        <FieldContent>
                                                            <FieldTitle>After Label</FieldTitle>
                                                            <FieldDescription className="text-xs text-muted-foreground">
                                                                Label for the after results.
                                                            </FieldDescription>
                                                        </FieldContent>
                                                        <Input id="after-label" value={config.afterLabel} onChange={onAfterLabelChange} />
                                                    </Field>
                                                </>
                                            )}
                                        </FieldLabel>

                                    </FieldGroup>
                                </AccordionContent>
                            </AccordionItem>

                            <AccordionItem key="results" value="results" className="border-b px-4 last:border-b-0">
                                <AccordionTrigger>
                                    <div className="flex items-center gap-2"><Table2 className="mr-1 h-4 w-4" />Results</div>
                                </AccordionTrigger>
                                <AccordionContent>
                                    <FieldLabel htmlFor="switch-show-speed-index" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Speed Index</FieldTitle>
                                            </FieldContent>
                                            <Switch id="switch-show-speed-index" checked={config.showSI} onCheckedChange={onShowSIChange} />
                                        </Field>
                                    </FieldLabel>
                                    <FieldLabel htmlFor="switch-show-largest-contentful-paint" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Largest Contentful Paint</FieldTitle>
                                            </FieldContent>
                                            <Switch id="switch-show-largest-contentful-paint" checked={config.showLCP} onCheckedChange={onShowLCPChange} />
                                        </Field>
                                    </FieldLabel>
                                    <FieldLabel htmlFor="switch-show-cumulative-layout-shift" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Cumulative Layout Shift</FieldTitle>
                                            </FieldContent>
                                            <Switch id="switch-show-cumulative-layout-shift" checked={config.showCLS} onCheckedChange={onShowCLSChange} />
                                        </Field>
                                    </FieldLabel>
                                    <FieldLabel htmlFor="switch-show-total-blocking-time" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Total Blocking Time</FieldTitle>
                                            </FieldContent>
                                            <Switch id="switch-show-total-blocking-time" checked={config.showTBT} onCheckedChange={onShowTBTChange} />
                                        </Field>
                                    </FieldLabel>
                                    <FieldLabel htmlFor="switch-show-first-contentful-paint" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>First Contentful Paint</FieldTitle>
                                            </FieldContent>
                                            <Switch id="switch-show-first-contentful-paint" checked={config.showFCP} onCheckedChange={onShowFCPChange} />
                                        </Field>
                                    </FieldLabel>
                                    <FieldLabel htmlFor="switch-show-warnings" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Show Warnings &amp; Errors</FieldTitle>
                                            </FieldContent>
                                            <Switch id="switch-show-warnings" checked={config.showWarnings} onCheckedChange={onShowWarningsChange} />
                                        </Field>
                                    </FieldLabel>
                                    {config.comparisonMode && (
                                        <FieldLabel htmlFor="switch-show-improvement" className="my-3">
                                            <Field orientation="horizontal">
                                                <FieldContent>
                                                    <FieldTitle>Improvement</FieldTitle>
                                                </FieldContent>
                                                <Switch id="switch-show-improvement" checked={config.showImprovement} onCheckedChange={onShowImprovementChange} />
                                            </Field>
                                            {config.showImprovement && (
                                                <>
                                                    <Field>
                                                        <FieldContent>
                                                            <FieldTitle>Threshold (%)</FieldTitle>
                                                        </FieldContent>
                                                        <Input id="improvement-threshold" value={config.improvementThreshold} onChange={onImprovementThresholdChange} />
                                                    </Field>
                                                </>
                                            )}
                                        </FieldLabel>

                                    )}
                                </AccordionContent>
                            </AccordionItem>

                        </Accordion>
                    </div>
                </DrawerContent>
            </Drawer>
        </div >
    );
}