import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { isElectron } from '@/lib/environment';

export type UpdateState = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateInfo {
    state: UpdateState;
    version: string | null;
    percent: number;
    transferred: number;
    total: number;
    errorMsg: string | null;
}

const INITIAL: UpdateInfo = {
    state: 'idle',
    version: null,
    percent: 0,
    transferred: 0,
    total: 0,
    errorMsg: null,
};

export function useAppUpdater() {
    const [info, setInfo] = useState<UpdateInfo>(INITIAL);

    useEffect(() => {
        if (!isElectron()) return;

        const unsubAvailable = window.electronAPI.update.onAvailable(({ version }) => {
            setInfo((prev) => ({ ...prev, state: 'available', version, percent: 0, errorMsg: null }));
            toast.info(`Update v${version} available`, {
                description: 'Downloading in the background…',
                duration: 5000,
            });
        });

        const unsubProgress = window.electronAPI.update.onProgress(({ percent, transferred, total }) => {
            setInfo((prev) => ({ ...prev, state: 'downloading', percent, transferred, total }));
        });

        const unsubDownloaded = window.electronAPI.update.onDownloaded(({ version }) => {
            setInfo((prev) => ({ ...prev, state: 'downloaded', version, percent: 100 }));
        });

        const unsubError = window.electronAPI.update.onError((msg) => {
            console.warn('[updater] error:', msg);
            setInfo((prev) => ({ ...prev, state: 'error', errorMsg: msg }));
        });

        return () => {
            unsubAvailable();
            unsubProgress();
            unsubDownloaded();
            unsubError();
        };
    }, []);

    const install = useCallback(() => {
        if (isElectron()) window.electronAPI.update.install();
    }, []);

    return { info, install };
}
