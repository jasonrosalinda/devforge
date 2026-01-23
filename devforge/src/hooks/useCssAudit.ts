import { CssFile, HtmlCss } from "@/types/cssAudits.type";
import { useRef, useState } from "react";

export const useCssAudit = () => {
    const [cssContent, setCssContent] = useState<CssFile>();
    const [htmlFiles, setHtmlFiles] = useState<HtmlCss[]>([]);

    const handleCSSUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                const content = event.target?.result as string;
                const handler = new CssFile(file.name, content);
                setCssContent(handler);
            };
            reader.readAsText(file);
        }
    };

    const handleHTMLUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;

        const filePromises = Array.from(files).map(file => {
            return new Promise<HtmlCss>((resolve) => {
                const reader = new FileReader();
                reader.onload = (event) => {
                    const content = event.target?.result as string;
                    const handler = new HtmlCss(file.name, content);
                    resolve(handler);
                };
                reader.readAsText(file);
            });
        });

        Promise.all(filePromises).then(parsedFiles => {
            setHtmlFiles(prev => [...prev, ...parsedFiles]);
        });
    };

    const removeHtmlFile = (index: number) => {
        setHtmlFiles(prev => prev.filter((_, i) => i !== index));
    };

    const getAllHtmlClasses = () => {
        const allClasses = new Set<string>();
        htmlFiles.forEach(file => {
            file.classes.forEach(cls => allClasses.add(cls));
        });
        return Array.from(allClasses).sort();
    };

    const getUnusedCssClasses = () => {
        const htmlClasses = getAllHtmlClasses();
        return cssContent?.classes.filter(cssClass => !htmlClasses.includes(cssClass));
    };

    const getMissingCssClasses = () => {
        const htmlClasses = getAllHtmlClasses();
        return htmlClasses.filter(htmlClass => !cssContent?.classes.includes(htmlClass));
    };

    const getClassUsageByFile = (className: string) => {
        return htmlFiles.filter(file => file.classes.includes(className));
    };

    return {
        cssContent,
        htmlFiles,
        handleCSSUpload,
        handleHTMLUpload,
        removeHtmlFile,
        getAllHtmlClasses,
        getUnusedCssClasses,
        getMissingCssClasses,
        getClassUsageByFile,
    };

}
