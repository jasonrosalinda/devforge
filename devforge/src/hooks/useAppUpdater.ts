import { useEffect } from 'react';
import { toast } from 'sonner';
import { isElectron } from '@/lib/environment';

export function useAppUpdater() {
    useEffect(() => {
        if (!isElectron()) return;

        const unsubAvailable = window.electronAPI.update.onAvailable(({ version }) => {
            toast.info(`Update v${version} available`, {
                description: 'Downloading in the background…',
                duration: 6000,
            });
        });

        let progressToastId: string | number | undefined;
        const unsubProgress = window.electronAPI.update.onProgress(({ percent }) => {
            if (progressToastId == null) {
                progressToastId = toast.loading(`Downloading update… ${percent}%`);
            } else {
                toast.loading(`Downloading update… ${percent}%`, { id: progressToastId });
            }
            if (percent >= 100 && progressToastId != null) {
                toast.dismiss(progressToastId);
                progressToastId = undefined;
            }
        });

        const unsubDownloaded = window.electronAPI.update.onDownloaded(({ version }) => {
            if (progressToastId != null) {
                toast.dismiss(progressToastId);
                progressToastId = undefined;
            }
            toast.success(`Update v${version} ready to install`, {
                description: 'Restart devForge to apply the update.',
                duration: Infinity,
                action: {
                    label: 'Restart Now',
                    onClick: () => window.electronAPI.update.install(),
                },
            });
        });

        const unsubError = window.electronAPI.update.onError((msg) => {
            console.warn('[updater] error:', msg);
        });

        return () => {
            unsubAvailable();
            unsubProgress();
            unsubDownloaded();
            unsubError();
        };
    }, []);
}
