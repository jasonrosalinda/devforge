export type LocalizationEntry = {
    key: string;
    en: string;
    vn: string;
    id: string;
}

export type LocalizationEntryHooks = {
    data: LocalizationEntry[];
    setData: React.Dispatch<React.SetStateAction<LocalizationEntry[]>>;
    upload: (file: File | undefined) => Promise<LocalizationEntry[]>;
    download: () => Promise<void>;
}