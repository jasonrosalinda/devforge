export class CssInstance {
    classes: Record<string, number>;

    constructor() {
        this.classes = {};
    }

    add(className: string) {
        this.classes[className] = (this.classes[className] || 0) + 1;
    }

    static merge(instances: CssInstance[]): CssInstance {
        const merged = new CssInstance();
        for (const instance of instances) {
            for (const [className, count] of Object.entries(instance.classes)) {
                merged.classes[className] = (merged.classes[className] || 0) + count;
            }
        }
        return merged;
    }

    compare(instances: CssInstance[]): CssInstance {
        const compare = new CssInstance();
        const merged = CssInstance.merge(instances);
        for (const [className] of Object.entries(this.classes)) {
            const exists = merged.classes[className];
            if (exists) {
                compare.classes[className] = exists;
            } else {
                compare.classes[className] = 0;
            }
        }

        return compare;
    }

    isNotEmpty(): boolean {
        return Object.values(this.classes).length > 0;
    }

    count(): number {
        return Object.values(this.classes).length ?? 0;
    }

    getClassNames(): Set<string> {
        return new Set(Object.keys(this.classes));
    }

    getSortedByCount(): Array<[string, number]> {
        return Object.entries(this.classes).sort((a, b) => b[1] - a[1]);
    }

    uniqueTo(other: CssInstance): string[] {
        const otherClasses = other.getClassNames();
        return Object.keys(this.classes).filter(cls => !otherClasses.has(cls));
    }

    commonWith(other: CssInstance): string[] {
        const otherClasses = other.getClassNames();
        return Object.keys(this.classes).filter(cls => otherClasses.has(cls));
    }

    missingIn(other: CssInstance): string[] {
        const otherClasses = other.getClassNames();
        return Object.keys(this.classes).filter(cls => !otherClasses.has(cls));
    }

    unused(): CssInstance {
        const unused = new CssInstance();
        for (const [className] of Object.entries(this.classes)) {
            if (this.classes[className] === 0) {
                unused.classes[className] = 0;
            }
        }
        return unused;
    }
}

export interface ICssFile {
    name: string;
    source: string;
    classes: CssInstance;
}

export class CssFile implements ICssFile {
    name: string;
    source: string;
    classes: CssInstance;

    constructor(name: string, source: string) {
        this.name = name;
        this.source = source;
        this.classes = new CssInstance();
        this.parseClassNames();
    }

    parseClassNames(): void {
        const classRegex = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
        const matches = this.source.matchAll(classRegex);
        const uniqueClasses = new Set<string>();

        for (const match of matches) {
            if (match[1]) {
                uniqueClasses.add(match[1]);
                this.classes.add(match[1]);
            }
        }
    }
}

export interface IHtmlCss {
    url: string;
    html: string;
    classes: CssInstance;
}

export class HtmlCss implements IHtmlCss {
    url: string;
    html: string;
    classes: CssInstance;

    constructor(url: string, html: string) {
        this.url = url;
        this.html = html;
        this.classes = new CssInstance();
        this.parseClassNames();
    }

    parseClassNames(): void {
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
                    this.classes.add(trimmed);
                }
            });
        }
    }
}