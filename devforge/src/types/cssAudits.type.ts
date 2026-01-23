export interface ICssFile {
    name: string;
    source: string;
    classes: string[];
}

export class CssFile implements ICssFile {
    name: string;
    source: string;
    classes: string[];

    constructor(name: string, source: string) {
        this.name = name;
        this.source = source;
        this.classes = [];
        this.parseClassNames();
    }

    parseClassNames(): void {
        const classRegex = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
        const matches = this.source.matchAll(classRegex);
        const uniqueClasses = new Set<string>();

        for (const match of matches) {
            if (match[1]) {
                uniqueClasses.add(match[1]);
            }
        }

        this.classes = Array.from(uniqueClasses).sort();
    }

}

export interface IHtmlCss {
    url: string;
    html: string;
    classes: string[];
}

export class HtmlCss implements IHtmlCss {
    url: string;
    html: string;
    classes: string[];

    constructor(url: string, html: string) {
        this.url = url;
        this.html = html;
        this.classes = [];
        this.parseClassNames();
    }

    parseClassNames(): void {
        const uniqueClasses = new Set<string>();

        let actualHtml = this.html;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = this.html;

        const textContent = tempDiv.textContent || tempDiv.innerText || '';

        if (textContent.length > 0 && textContent.includes('class=')) {
            actualHtml = textContent;
        }


        const classRegex = /class\s*=\s*["']([^"']+)["']/gi;

        for (const match of actualHtml.matchAll(classRegex)) {
            const classes = match[1]?.split(/\s+/);
            classes?.forEach(cls => {
                const trimmed = cls.trim();
                if (trimmed) {
                    uniqueClasses.add(trimmed);
                }
            });
        }

        this.classes = Array.from(uniqueClasses).sort();
    }
}