export class CssInfo {
    name: string;
    instances: number;
    selectors: string[];

    constructor(name: string, selector?: string) {
        this.name = name;
        this.instances = 0;
        this.selectors = [];
        if (selector) this.addSelector(selector)
    }

    addSelector(selector: string) {
        this.instances++;
        if (!this.selectors.includes(selector)) {
            this.selectors.push(selector);
        }
    }
}

export class CssInstance {
    classes: CssInfo[];

    constructor() {
        this.classes = [];
    }

    add(className: string, selector?: string) {
        const existingClass = this.classes.find(cls => cls.name === className);

        if (!existingClass) {
            this.classes.push(new CssInfo(className, selector));
        } else if (selector) {
            existingClass.addSelector(selector);
        }
    }

    static merge(instances: CssInstance[]): CssInstance {
        const merged = new CssInstance();
        for (const instance of instances) {
            for (const cls of instance.classes) {
                const existingClass = merged.classes.find(c => c.name === cls.name);

                if (!existingClass) {
                    // Deep copy the class
                    const newClass = new CssInfo(cls.name);
                    newClass.instances = cls.instances;
                    newClass.selectors = [...cls.selectors];
                    merged.classes.push(newClass);
                } else {
                    // Merge selectors and update instances
                    existingClass.instances += cls.instances;
                    for (const selector of cls.selectors) {
                        if (!existingClass.selectors.includes(selector)) {
                            existingClass.selectors.push(selector);
                        }
                    }
                }
            }
        }
        return merged;
    }

    isNotEmpty(): boolean {
        return this.classes.length > 0;
    }

    count(): number {
        return this.classes.length;
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
        const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
        const rules = this.source.matchAll(ruleRegex);

        for (const rule of rules) {
            const selector = rule[1]?.trim();

            if (!selector) continue;

            const classRegex = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
            const matches = selector.matchAll(classRegex);

            for (const match of matches) {
                if (match[1]) {
                    this.classes.add(match[1], selector);
                }
            }
        }
    }

    getUnusedClasses(instances: CssInstance[]): CssInstance {
        const compare = new CssInstance();
        const merged = CssInstance.merge(instances);

        for (const cls of this.classes.classes) {
            const exists = merged.classes.find(c => c.name === cls.name);
            if (!exists) {
                const combinedClass = new CssInfo(cls.name);
                combinedClass.instances = cls.instances;
                combinedClass.selectors = [...cls.selectors];
                compare.classes.push(combinedClass);
            }
        }
        return compare;
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
            const elementContext = this.extractElementContext(match.index!, actualHtml);

            classes?.forEach(cls => {
                const trimmed = cls.trim();
                if (trimmed) {
                    this.classes.add(trimmed, elementContext);
                }
            });
        }
        console.log(this.classes);
    }

    private extractElementContext(classAttrIndex: number, html: string): string {
        const beforeClass = html.substring(0, classAttrIndex);
        const tagStart = beforeClass.lastIndexOf('<');
        const afterClass = html.substring(classAttrIndex);
        const tagEnd = afterClass.indexOf('>');

        if (tagStart !== -1 && tagEnd !== -1) {
            const fullTag = html.substring(tagStart, classAttrIndex + tagEnd + 1);
            return fullTag.trim();
        }

        return '';
    }
}