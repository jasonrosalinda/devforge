import { describe, it, expect } from "vitest";
import { parseCitation, renderSafeMarkdown } from "./safe-markdown";

describe("parseCitation", () => {
    it.each([
        ["src/App.cs:12", { file: "src/App.cs", line: 12 }],
        ["Orders/OrderService.cs:142-150", { file: "Orders/OrderService.cs", line: 142 }],
        [" web.config:3 ", { file: "web.config", line: 3 }],
    ])("reads %j", (text, expected) => {
        expect(parseCitation(text)).toEqual(expected);
    });

    it.each(["/etc/passwd:1", "C:/x.cs:1", "..\\x.cs:1", "../x.cs:1", "src/../../x.cs:1", "OrderService", "a.cs", "a.cs:x", "SqlException: timeout"])("rejects %j", (text) => {
        expect(parseCitation(text)).toBeNull();
    });
});

describe("renderSafeMarkdown", () => {
    it("renders ordinary report markdown", () => {
        const html = renderSafeMarkdown("## Summary\n\n- **bold** and `src/App.cs:12`\n\n| a | b |\n|---|---|\n| 1 | 2 |");
        expect(html).toContain("<h2>Summary</h2>");
        expect(html).toContain("<strong>bold</strong>");
        expect(html).toContain("<code data-cite>src/App.cs:12</code>");
        expect(html).toContain("<table>");
    });

    it("shows raw HTML as text, block and inline", () => {
        const html = renderSafeMarkdown('<img src=x onerror="alert(1)">\n\nText <script>alert(2)</script> more');
        expect(html).not.toMatch(/<img|<script/i);
        expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
        expect(html).toContain("&lt;script&gt;");
    });

    it("drops javascript: and data: links but keeps their text", () => {
        const html = renderSafeMarkdown("[click](javascript:alert(1)) and [d](data:text/html,x) and [ok](https://example.com)");
        expect(html).not.toMatch(/javascript:|data:text/);
        expect(html).toContain("click");
        expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>');
    });

    it("renders images as alt text without fetching", () => {
        const html = renderSafeMarkdown("![tracking pixel](https://evil.example/p.png)");
        expect(html).not.toContain("<img");
        expect(html).toContain("tracking pixel");
    });

    it("escapes quotes in link titles", () => {
        expect(renderSafeMarkdown('[a](https://x.example "t\\" onmouseover=\\"x")')).not.toMatch(/" onmouseover/);
    });

    it("marks code citations and nothing else", () => {
        expect(renderSafeMarkdown("see `src/App.cs:12` and `SqlException`")).toContain("<code data-cite>src/App.cs:12</code> and <code>SqlException</code>");
    });

    it("keeps inline code escaped exactly once", () => {
        expect(renderSafeMarkdown("`<b>&x</b>`")).toContain("<code>&lt;b&gt;&amp;x&lt;/b&gt;</code>");
    });

    it("keeps code blocks escaped", () => {
        expect(renderSafeMarkdown("```\n<b>x</b>\n```")).toContain("&lt;b&gt;x&lt;/b&gt;");
    });
});
