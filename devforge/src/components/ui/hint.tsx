import * as React from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface HintProps {
    /** What the control does. Keep it to a phrase — a sentence at most. */
    label: React.ReactNode;
    side?: React.ComponentPropsWithoutRef<typeof TooltipContent>["side"];
    align?: React.ComponentPropsWithoutRef<typeof TooltipContent>["align"];
    /** Milliseconds of hover before the tip opens. */
    delayDuration?: number;
    /** Applied to the wrapper span — pass layout classes the child needs (e.g. `w-full`). */
    className?: string;
    children: React.ReactNode;
}

/**
 * Tooltip wrapper for action controls.
 *
 * The child is wrapped in a span rather than being the trigger itself: a `disabled`
 * button dispatches no pointer events, so `asChild` on the button would silently drop
 * the tooltip in exactly the state where the hint matters most ("why can't I click
 * this?"). shadcn's Button sets `disabled:pointer-events-none`, so hover falls through
 * to this span and the tip still opens.
 */
export function Hint({ label, side = "bottom", align, delayDuration = 300, className, children }: HintProps) {
    if (!label) return <>{children}</>;
    return (
        <Tooltip delayDuration={delayDuration}>
            <TooltipTrigger asChild>
                <span className={cn("inline-flex", className)}>{children}</span>
            </TooltipTrigger>
            <TooltipContent side={side} {...(align ? { align } : {})} className="max-w-xs text-center">
                {label}
            </TooltipContent>
        </Tooltip>
    );
}
