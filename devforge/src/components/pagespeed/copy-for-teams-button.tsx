import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '../ui';
import { Hint } from '../ui/hint';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { useCopyIncludeRuns } from '@/lib/pagespeed-copy-prefs';

interface CopyForTeamsButtonProps {
    /** Called with the current "Include individual runs" choice. */
    onCopy: (includeRuns: boolean) => void;
    disabled?: boolean;
    hint: string;
    icon: ReactNode;
}

/** Copy for Teams as a split button: copy on the left, copy options (▾) on the right. */
export function CopyForTeamsButton({ onCopy, disabled, hint, icon }: CopyForTeamsButtonProps) {
    const [includeRuns, setIncludeRuns] = useCopyIncludeRuns();
    return (
        <div className="inline-flex">
            <Hint label={`${hint}${includeRuns ? ', including each individual run' : ', averages only'}`}>
                <Button variant="outline" className="rounded-r-none" onClick={() => onCopy(includeRuns)} disabled={disabled}>
                    {icon}
                    Copy for Teams
                </Button>
            </Hint>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="rounded-l-none border-l-0" disabled={disabled} aria-label="Copy for Teams options">
                        <ChevronDown className="h-4 w-4" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">Copy for Teams</DropdownMenuLabel>
                    <DropdownMenuCheckboxItem checked={includeRuns} onCheckedChange={v => setIncludeRuns(v === true)} onSelect={e => e.preventDefault()}>
                        Include individual runs
                    </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
