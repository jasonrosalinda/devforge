import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
    value: string;
    label?: string;
    disabled?: boolean;
}

/** Copies text and flips to a tick briefly, so the click is acknowledged twice. */
export function CopyButton({ value, label = "Copy to clipboard", disabled }: CopyButtonProps) {
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
            Toast().success("Copied to clipboard");
        } catch {
            Toast().error("Could not access the clipboard");
        }
    };

    return (
        <Hint label={label}>
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={copy}
                disabled={disabled || !value}
            >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
        </Hint>
    );
}

interface ToolPanelProps {
    title: string;
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
}

export function ToolPanel({ title, actions, children, className }: ToolPanelProps) {
    return (
        <div className={cn("flex flex-col gap-2 min-h-0", className)}>
            <div className="flex items-center justify-between gap-2 min-h-7">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    {title}
                </span>
                {actions}
            </div>
            {children}
        </div>
    );
}

/** Inline problem report. Nothing in the Toolbox throws at the user. */
export function ErrorNote({ children }: { children: ReactNode }) {
    return (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {children}
        </p>
    );
}

export function WarningNote({ children }: { children: ReactNode }) {
    return (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {children}
        </p>
    );
}

/** Monospace read-only output block used by most tabs. */
export function OutputBox({ value, placeholder, className }: { value: string; placeholder?: string; className?: string }) {
    return (
        <pre
            className={cn(
                "flex-1 min-h-0 overflow-auto rounded-md border bg-muted/40 p-3 text-xs font-mono whitespace-pre-wrap break-all",
                !value && "text-muted-foreground",
                className,
            )}
        >
            {value || placeholder || "—"}
        </pre>
    );
}
