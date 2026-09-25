import type { ElementType, ReactNode } from "react";

interface PageHeaderProps {
    icon: ElementType;
    title: string;
    subtitle?: string;
    actions?: ReactNode;
    iconClassName?: string;
}

export function PageHeader({ icon: Icon, title, subtitle, actions, iconClassName }: PageHeaderProps) {
    return (
        <div className="flex items-center gap-3 border-b pb-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand ring-1 ring-inset ring-brand/20">
                <Icon className={`h-[18px] w-[18px] ${iconClassName ?? ''}`} strokeWidth={1.75} />
            </div>
            <div className="flex-1 min-w-0">
                <h1 className="text-xl font-semibold leading-tight tracking-tight">{title}</h1>
                {subtitle && (
                    <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
                )}
            </div>
            {actions}
        </div>
    );
}
