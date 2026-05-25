export function domToPlain(html: string): string {
    if (!html) return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.innerText || '').trim().replace(/\n{3,}/g, '\n\n');
}
