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
        <div className="flex items-center gap-2">
            <Icon className={`h-5 w-5 text-primary ${iconClassName ?? ''}`} />
            <div className="flex-1 min-w-0">
                <h1 className="text-lg font-semibold leading-tight">{title}</h1>
                {subtitle && (
                    <p className="text-xs text-muted-foreground">{subtitle}</p>
                )}
            </div>
            {actions}
        </div>
    );
}
