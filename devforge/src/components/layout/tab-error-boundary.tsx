import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCw, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TabErrorBoundaryProps {
    title: string;
    onClose?: () => void;
    children: ReactNode;
}

interface TabErrorBoundaryState {
    error: Error | null;
    /** Bumped by "Reload tab" to remount the page from scratch. */
    attempt: number;
}

/**
 * Contains a crash to its own tab. Every open tab stays mounted and the tab
 * session is restored on launch, so without this one throwing page would blank
 * the whole app — on every start.
 */
export class TabErrorBoundary extends Component<TabErrorBoundaryProps, TabErrorBoundaryState> {
    state: TabErrorBoundaryState = { error: null, attempt: 0 };

    static getDerivedStateFromError(error: Error): Partial<TabErrorBoundaryState> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error(`[${this.props.title}] page crashed`, error, info.componentStack);
    }

    render() {
        const { error, attempt } = this.state;
        if (!error) return <div key={attempt} className="contents">{this.props.children}</div>;

        return (
            <div role="alert" className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 text-center">
                <div className="flex size-10 items-center justify-center rounded-lg bg-error/10 text-error">
                    <TriangleAlert className="size-5" />
                </div>
                <h2 className="text-base font-semibold">{this.props.title} ran into a problem</h2>
                <p className="text-sm text-muted-foreground break-words">{error.message}</p>
                <div className="mt-1 flex gap-2">
                    <Button size="sm" onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}>
                        <RotateCw className="mr-1.5 size-3.5" />
                        Reload tab
                    </Button>
                    {this.props.onClose && (
                        <Button size="sm" variant="outline" onClick={this.props.onClose}>
                            <X className="mr-1.5 size-3.5" />
                            Close tab
                        </Button>
                    )}
                </div>
            </div>
        );
    }
}
