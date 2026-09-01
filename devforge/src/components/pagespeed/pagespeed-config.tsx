import { type PageSpeedConfiguration } from "@shared/types/pageSpeedInsight.types";
import { defaultPageSpeedConfiguration } from "@/lib/pageSpeedUtils";
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@/components/ui";
import { Hint } from "@/components/ui/hint";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldTitle } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Activity, Cog, Link, Minus, Plus, Table2, Trash2, Wrench } from "lucide-react";
import { Item, ItemActions, ItemContent, ItemTitle, } from "@/components/ui/item"
import { Switch } from "../ui/switch";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MIN_RUNS = 1;
const MAX_RUNS = 10;

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

    const onRunsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const parsed = Number(e.target.value);
        const runs = Number.isFinite(parsed) ? Math.min(MAX_RUNS, Math.max(MIN_RUNS, Math.round(parsed))) : MIN_RUNS;
        onSetConfigState({ ...config, runs });
    };

    const onRunsStep = (delta: number) => {
        const runs = Math.min(MAX_RUNS, Math.max(MIN_RUNS, config.runs + delta));
        if (runs !== config.runs) onSetConfigState({ ...config, runs });
    };

    const onAggregationChange = (value: string) => {
        onSetConfigState({ ...config, aggregation: value as PageSpeedConfiguration['aggregation'] });
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
                        <Hint label="URLs, run count, comparison mode and which metrics the table shows">
                        <Button className="capitalize" variant="outline" disabled={isAuditing}>
                            <Cog className="mr-1 h-4 w-4" />Configuration
                        </Button>
                        </Hint>
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
                                    <FieldLabel htmlFor="input-runs" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Runs per URL</FieldTitle>
                                                <FieldDescription className="text-xs text-muted-foreground">
                                                    Audit each URL {MIN_RUNS}-{MAX_RUNS} times. A 3s pause separates runs.
                                                </FieldDescription>
                                            </FieldContent>
                                            <div className="flex items-center rounded-md border border-input bg-background shadow-sm">
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label="Decrease runs per URL"
                                                    className="h-8 w-8 rounded-r-none [&_svg]:size-3.5"
                                                    disabled={config.runs <= MIN_RUNS}
                                                    onClick={() => onRunsStep(-1)}
                                                >
                                                    <Minus />
                                                </Button>
                                                <Input
                                                    id="input-runs"
                                                    type="number"
                                                    min={MIN_RUNS}
                                                    max={MAX_RUNS}
                                                    step={1}
                                                    value={config.runs}
                                                    onChange={onRunsChange}
                                                    className="h-8 w-10 rounded-none border-0 px-0 text-center shadow-none focus-visible:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                                />
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label="Increase runs per URL"
                                                    className="h-8 w-8 rounded-l-none [&_svg]:size-3.5"
                                                    disabled={config.runs >= MAX_RUNS}
                                                    onClick={() => onRunsStep(1)}
                                                >
                                                    <Plus />
                                                </Button>
                                            </div>
                                        </Field>
                                    </FieldLabel>
                                    {config.runs > 1 && (
                                        <FieldLabel htmlFor="select-aggregation" className="my-3">
                                            <Field orientation="horizontal">
                                                <FieldContent>
                                                    <FieldTitle>Aggregation</FieldTitle>
                                                    <FieldDescription className="text-xs text-muted-foreground">
                                                        How the runs collapse into one result. Median discards outliers.
                                                    </FieldDescription>
                                                </FieldContent>
                                                <Select value={config.aggregation} onValueChange={onAggregationChange}>
                                                    <SelectTrigger id="select-aggregation" className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="average">Average</SelectItem>
                                                        <SelectItem value="median">Median</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </Field>
                                        </FieldLabel>
                                    )}
                                </AccordionContent>
                            </AccordionItem>

                            <AccordionItem key="web-page-urls" value="web-page-urls" className="border-b px-4 last:border-b-0">
                                <AccordionTrigger>
                                    <div className="flex items-center gap-2"><Link className="mr-1 h-4 w-4 text-error" />Web page URL's </div>
                                </AccordionTrigger>
                                <AccordionContent>
                                    <FieldGroup>
                                        <FieldSet>
                                            <Field>
                                                <FieldLabel>URL</FieldLabel>
                                                <Input value={url} onChange={(e) => setUrl(e.target.value)} className={isInvalidUrl ? 'border-error' : ''} />
                                                <FieldError>{isInvalidUrl ? '* Enter a valid URL.' : ''}</FieldError>
                                            </Field>
                                        </FieldSet>
                                        <Field>
                                            <Hint label="Add the URL above to the audit list" className="w-full">
                                                <Button onClick={onAddUrl} className="w-full" variant="outline">Add</Button>
                                            </Hint>
                                            <Hint label="Load a .txt file with one URL per line - invalid lines are skipped" className="w-full">
                                                <Button onClick={onWebUrlsUploadClick} className="w-full" variant="outline">Upload</Button>
                                            </Hint>
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
                                                        <Hint label="Remove this URL from the audit list">
                                                            <Button size="sm" variant="ghost" onClick={() => onRemoveUrl(url)}>
                                                                <Trash2 className="mr-1 h-4 w-4" />
                                                            </Button>
                                                        </Hint>
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
                                            <Hint label="Speed Index - how quickly the page paints its content. Lower is better.">
                                                <Switch id="switch-show-speed-index" checked={config.showSI} onCheckedChange={onShowSIChange} />
                                            </Hint>
                                        </Field>
                                    </FieldLabel>
                                    <FieldLabel htmlFor="switch-show-largest-contentful-paint" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Largest Contentful Paint</FieldTitle>
                                            </FieldContent>
                                            <Hint label="Largest Contentful Paint - when the biggest element finishes rendering. Google's target is under 2.5s.">
                                                <Switch id="switch-show-largest-contentful-paint" checked={config.showLCP} onCheckedChange={onShowLCPChange} />
                                            </Hint>
                                        </Field>
                                    </FieldLabel>
                                    <FieldLabel htmlFor="switch-show-cumulative-layout-shift" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Cumulative Layout Shift</FieldTitle>
                                            </FieldContent>
                                            <Hint label="Cumulative Layout Shift - how much the page jumps around while loading. Target is under 0.1.">
                                                <Switch id="switch-show-cumulative-layout-shift" checked={config.showCLS} onCheckedChange={onShowCLSChange} />
                                            </Hint>
                                        </Field>
                                    </FieldLabel>
                                    <FieldLabel htmlFor="switch-show-total-blocking-time" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Total Blocking Time</FieldTitle>
                                            </FieldContent>
                                            <Hint label="Total Blocking Time - how long the main thread was blocked and the page unresponsive to input.">
                                                <Switch id="switch-show-total-blocking-time" checked={config.showTBT} onCheckedChange={onShowTBTChange} />
                                            </Hint>
                                        </Field>
                                    </FieldLabel>
                                    <FieldLabel htmlFor="switch-show-first-contentful-paint" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>First Contentful Paint</FieldTitle>
                                            </FieldContent>
                                            <Hint label="First Contentful Paint - when the first text or image appears.">
                                                <Switch id="switch-show-first-contentful-paint" checked={config.showFCP} onCheckedChange={onShowFCPChange} />
                                            </Hint>
                                        </Field>
                                    </FieldLabel>
                                    <FieldLabel htmlFor="switch-show-warnings" className="my-3">
                                        <Field orientation="horizontal">
                                            <FieldContent>
                                                <FieldTitle>Show Warnings &amp; Errors</FieldTitle>
                                            </FieldContent>
                                            <Hint label="Show Lighthouse errors and warnings under each URL in the results table">
                                                <Switch id="switch-show-warnings" checked={config.showWarnings} onCheckedChange={onShowWarningsChange} />
                                            </Hint>
                                        </Field>
                                    </FieldLabel>
                                    {config.comparisonMode && (
                                        <FieldLabel htmlFor="switch-show-improvement" className="my-3">
                                            <Field orientation="horizontal">
                                                <FieldContent>
                                                    <FieldTitle>Improvement</FieldTitle>
                                                </FieldContent>
                                                <Hint label="Add a percentage-change column per metric, green for a gain and red past the regression threshold">
                                                    <Switch id="switch-show-improvement" checked={config.showImprovement} onCheckedChange={onShowImprovementChange} />
                                                </Hint>
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