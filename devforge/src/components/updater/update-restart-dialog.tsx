import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CheckCircle2 } from 'lucide-react';

interface Props {
    open: boolean;
    version: string | null;
    onRestart: () => void;
    onLater: () => void;
}

export function UpdateRestartDialog({ open, version, onRestart, onLater }: Props) {
    return (
        <AlertDialog
            open={open}
            onOpenChange={(o) => {
                if (!o) onLater();
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle className="flex items-center gap-2">
                        <CheckCircle2 className="h-5 w-5 text-success" />
                        Update {version ? `v${version} ` : ''}ready to install
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        Restart devForge now to apply the update. Any in-progress audits or unsaved work will be interrupted.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={onLater}>Later</AlertDialogCancel>
                    <AlertDialogAction onClick={onRestart}>Restart Now</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
