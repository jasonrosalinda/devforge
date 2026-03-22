export function isNullOrEmpty(text: string | null | undefined): boolean {
    return (!text || text.trim().length === 0);
}