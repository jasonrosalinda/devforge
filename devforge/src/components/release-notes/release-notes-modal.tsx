import { useEffect, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2 } from 'lucide-react';

interface Release {
    tag_name: string;
    name: string;
    published_at: string;
    body: string;
    html_url: string;
}

interface Props {
    open: boolean;
    onClose: () => void;
}

const REPO = 'jasonrosalinda/devforge';

function renderInline(text: string): ReactNode {
    const parts: ReactNode[] = [];
    const regex = /(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)/g;
    let lastIdx = 0;
    let match;
    let i = 0;
    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));
        if (match[1]) parts.push(<strong key={i++}>{match[2]}</strong>);
        else if (match[3]) parts.push(
            <a key={i++} href={match[5]} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">{match[4]}</a>
        );
        else if (match[6]) parts.push(
            <code key={i++} className="bg-muted px-1 py-0.5 rounded text-xs font-mono">{match[7]}</code>
        );
        lastIdx = match.index + match[0].length;
    }
    if (lastIdx < text.length) parts.push(text.slice(lastIdx));
    return parts;
}

function renderMarkdown(md: string): ReactNode[] {
    const lines = md.split('\n');
    const nodes: ReactNode[] = [];
    let listItems: ReactNode[] = [];
    let key = 0;

    const flushList = () => {
        if (listItems.length) {
            nodes.push(<ul key={`ul-${key++}`} className="ml-5 list-disc space-y-1 my-2">{listItems}</ul>);
            listItems = [];
        }
    };

    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (line.startsWith('### ')) {
            flushList();
            nodes.push(<h4 key={key++} className="font-semibold text-sm mt-4 mb-1 text-foreground">{renderInline(line.slice(4))}</h4>);
        } else if (line.startsWith('## ')) {
            flushList();
            nodes.push(<h3 key={key++} className="font-bold text-base mt-4 mb-1 text-foreground">{renderInline(line.slice(3))}</h3>);
        } else if (line.startsWith('# ')) {
            flushList();
            nodes.push(<h2 key={key++} className="font-bold text-lg mt-4 mb-1 text-foreground">{renderInline(line.slice(2))}</h2>);
        } else if (/^[*-] /.test(line)) {
            listItems.push(<li key={key++} className="text-sm text-muted-foreground">{renderInline(line.slice(2))}</li>);
        } else if (line.trim() === '') {
            flushList();
        } else {
            flushList();
            nodes.push(<p key={key++} className="text-sm my-1 text-muted-foreground">{renderInline(line)}</p>);
        }
    }
    flushList();
    return nodes;
}

export function ReleaseNotesModal({ open, onClose }: Props) {
    const [releases, setReleases] = useState<Release[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        fetch(`https://api.github.com/repos/${REPO}/releases`, { signal: controller.signal })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then((data: Release[]) => setReleases(data.filter(r => !r.tag_name.includes('-draft'))))
            .catch(e => { if (e.name !== 'AbortError') setError(e.message); })
            .finally(() => setLoading(false));
        return () => controller.abort();
    }, [open]);

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
                <DialogHeader className="flex-shrink-0">
                    <DialogTitle>Release Notes</DialogTitle>
                </DialogHeader>
                <ScrollArea className="flex-1 min-h-0 pr-4 -mr-4">
                    {loading && (
                        <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading releases...
                        </div>
                    )}
                    {error && (
                        <div className="text-sm text-destructive py-2">
                            Failed to load releases: {error}
                        </div>
                    )}
                    {!loading && !error && releases.length === 0 && (
                        <div className="text-sm text-muted-foreground py-12 text-center">
                            No releases published yet.
                        </div>
                    )}
                    {!loading && !error && releases.map(r => (
                        <div key={r.tag_name} className="border-b border-border last:border-0 py-4">
                            <div className="flex items-baseline justify-between gap-2 mb-2">
                                <h2 className="text-lg font-semibold text-foreground">{r.name || r.tag_name}</h2>
                                <span className="text-xs text-muted-foreground tabular-nums">
                                    {new Date(r.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                </span>
                            </div>
                            <div className="leading-relaxed">{renderMarkdown(r.body || '_No notes provided._')}</div>
                            <a
                                href={r.html_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline mt-3 inline-block"
                            >
                                View on GitHub →
                            </a>
                        </div>
                    ))}
                </ScrollArea>
            </DialogContent>
        </Dialog>
    );
}
