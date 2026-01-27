export type LocalizationEntry = {
    key: string;
    en: string;
    vn: string;
    id: string;
    state: "new" | "updated" | "uploaded";
}

export type LocalizationEntryHooks = {
    data: LocalizationEntry[];
    upload: (file: File | undefined) => Promise<LocalizationEntry[]>;
    download: () => Promise<void>;
    update: (entry: LocalizationEntry) => void;
    add: (entry: LocalizationEntry) => void;
    remove: (entry: LocalizationEntry) => void;
}