import { CssFile, CssInstance, HtmlCss } from "@/types/cssAudits.type";
import { useMemo, useRef, useState, type SetStateAction } from "react";

export const useCssAudit = () => {
    const [cssContent, setCssContent] = useState<CssFile>(new CssFile("", ""));
    const [htmlFiles, setHtmlFiles] = useState<HtmlCss[]>([]);

    const htmlCssClasses = useMemo(() => CssInstance.merge(htmlFiles.flatMap(file => file.classes)), [htmlFiles]);

    const unusedCssClasses = useMemo(() => {
        if (!cssContent?.classes) return new CssInstance();
        return cssContent.getUnusedClasses([htmlCssClasses]);
    }, [cssContent, htmlCssClasses]);

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

        const htmls = Array.from(files).filter(file =>
            file.name.endsWith(".html") &&
            !htmlFiles.some(existing => existing.url === file.name)
        );

        const filePromises = htmls.map(file => {
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

    const clearHtmlFiles = () => {
        setHtmlFiles([]);
    };

    return {
        cssContent,
        htmlFiles,
        htmlCssClasses,
        unusedCssClasses,
        handleCSSUpload,
        handleHTMLUpload,
        removeHtmlFile,
        clearHtmlFiles
    };

}
