import { Marked, type Tokens } from "marked";

/**
 * Markdown → HTML for Claude-written reports that are injected with innerHTML.
 *
 * The text is not trusted: App Investigation quotes telemetry (request URLs and
 * exception messages sent by anyone on the internet) and repository files, and the
 * renderer that shows it holds `window.electronAPI`. So raw HTML in the markdown is
 * shown as text, links keep only http(s) and mailto targets, and images render as
 * their alt text (no remote fetches).
 */

const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const SAFE_HREF = /^(https?:|mailto:)/i;

// `src/Orders/OrderService.cs:142` (optionally `:142-150`) — repository-relative only.
const CITATION_RE = /^(?![\\/])(?![A-Za-z]:)([\w.@/-]+\.[A-Za-z0-9]{1,10}):(\d{1,6})(?:-\d{1,6})?$/;

/** A `path:line` code citation, or null. The host still checks the path stays inside the repo. */
export function parseCitation(text: string): { file: string; line: number } | null {
    const m = CITATION_RE.exec(text.trim());
    if (!m || m[1]!.split("/").includes("..")) return null;
    return { file: m[1]!, line: Number(m[2]) };
}

const safe = new Marked({
    renderer: {
        codespan({ text }: Tokens.Codespan) {
            // marked v18 hands codespan text over raw — escaping here is what keeps it inert.
            return `<code${parseCitation(text) ? " data-cite" : ""}>${escapeHtml(text)}</code>`;
        },
        html({ text }: Tokens.HTML | Tokens.Tag) {
            return escapeHtml(text);
        },
        link({ href, title, tokens }: Tokens.Link) {
            const label = this.parser.parseInline(tokens);
            if (!SAFE_HREF.test(href.trim())) return label;
            const t = title ? ` title="${escapeHtml(title)}"` : "";
            return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener noreferrer">${label}</a>`;
        },
        image({ text }: Tokens.Image) {
            return escapeHtml(text);
        },
    },
});

export function renderSafeMarkdown(markdown: string): string {
    return safe.parse(markdown ?? "", { async: false }) as string;
}
