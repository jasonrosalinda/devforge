import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { contrastRatio, parseColor, toHex, toHslString, toRgbString, wcag, type Rgb } from "@/lib/toolbox/color";
import { CopyButton, ErrorNote, ToolPanel } from "./toolbox-shared";

function ColorField({ label, value, onChange, color }: { label: string; value: string; onChange: (v: string) => void; color: Rgb | null }) {
    return (
        <ToolPanel title={label}>
            <div className="flex items-center gap-2">
                <input
                    type="color"
                    aria-label={`${label} picker`}
                    value={color ? toHex(color) : "#000000"}
                    onChange={(e) => onChange(e.target.value)}
                    className="h-9 w-12 shrink-0 cursor-pointer rounded border bg-transparent"
                />
                <Input value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} value`} className="font-mono text-xs" spellCheck={false} />
            </div>
            {color ? (
                <div className="rounded-md border divide-y text-xs">
                    {[toHex(color), toRgbString(color), toHslString(color)].map((v) => (
                        <div key={v} className="flex items-center gap-2 px-3 py-1 font-mono">
                            <span className="flex-1">{v}</span>
                            <CopyButton value={v} label={`Copy ${v}`} />
                        </div>
                    ))}
                </div>
            ) : (
                value.trim() && <ErrorNote>Not a colour. Use #hex, rgb() or hsl().</ErrorNote>
            )}
        </ToolPanel>
    );
}

const CHECKS = [
    { key: "aaNormal", label: "AA normal text", min: "4.5:1" },
    { key: "aaLarge", label: "AA large text", min: "3:1" },
    { key: "aaaNormal", label: "AAA normal text", min: "7:1" },
    { key: "aaaLarge", label: "AAA large text", min: "4.5:1" },
    { key: "uiComponents", label: "UI components & icons", min: "3:1" },
] as const;

/** Colour converter and WCAG contrast checker. Offline. */
export default function ColorContrast() {
    const [fg, setFg] = useState("#1f2937");
    const [bg, setBg] = useState("#ffffff");
    const fgColor = useMemo(() => parseColor(fg), [fg]);
    const bgColor = useMemo(() => parseColor(bg), [bg]);
    const ratio = fgColor && bgColor ? contrastRatio(fgColor, bgColor) : null;
    const pass = ratio !== null ? wcag(ratio) : null;

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <div className="grid gap-3 md:grid-cols-2">
                <ColorField label="Text (foreground)" value={fg} onChange={setFg} color={fgColor} />
                <ColorField label="Background" value={bg} onChange={setBg} color={bgColor} />
            </div>
            {fgColor && bgColor && ratio !== null && pass && (
                <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
                    <div
                        className="rounded-md border p-4 flex flex-col gap-1 self-start"
                        style={{ color: toHex(fgColor), backgroundColor: toHex(bgColor) }}
                    >
                        <span className="text-2xl font-semibold">Large text 24px</span>
                        <span className="text-sm">Normal text at 14px — the quick brown fox jumps over the lazy dog.</span>
                    </div>
                    <div className="rounded-md border divide-y text-xs">
                        <div className="flex items-center justify-between px-3 py-2">
                            <span className="font-medium">Contrast ratio</span>
                            <span className="font-mono text-base tabular-nums">{ratio.toFixed(2)}:1</span>
                        </div>
                        {CHECKS.map((c) => (
                            <div key={c.key} className="flex items-center gap-2 px-3 py-1.5">
                                {pass[c.key] ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <X className="h-3.5 w-3.5 text-destructive" aria-hidden />}
                                <span className="flex-1">{c.label}</span>
                                <span className="text-muted-foreground">{c.min}</span>
                                <Badge variant={pass[c.key] ? "secondary" : "destructive"} className="font-normal">{pass[c.key] ? "Pass" : "Fail"}</Badge>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
