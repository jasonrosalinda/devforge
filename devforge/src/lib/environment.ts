export const isElectron = (): boolean => {
    return typeof window !== 'undefined' && 'electronAPI' in window;
}