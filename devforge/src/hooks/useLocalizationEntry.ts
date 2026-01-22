import type { LocalizationEntry, LocalizationEntryHooks } from "@/types/localization.types";
import { useState } from "react";

export const useLocalizationEntry = (): LocalizationEntryHooks => {
    const [data, setData] = useState<LocalizationEntry[]>([]);

    const sqlConfig = {
        storedProcedure: 'sp_InsertUpdateTranslation',
        parameterMapping: {
            'TranslationKey': 'key' as keyof LocalizationEntry,
            'Value_EN': 'en' as keyof LocalizationEntry,
            'Value_ID': 'id' as keyof LocalizationEntry,
            'Value_VN': 'vn' as keyof LocalizationEntry
        },
        formatValue: (key: string, value: any) => value
    };

    const parseSqlFile = (sqlContent: string): LocalizationEntry[] => {
        const entries: LocalizationEntry[] = [];

        const execStatements = sqlContent.split(/EXEC\s+\[dbo\]\.\[sp_InsertUpdateTranslation\]/gi);

        for (let i = 1; i < execStatements.length; i++) {
            const paramBlock = execStatements[i];

            const extractValue = (paramName: string): string => {
                if (!paramBlock) return '';
                const nullMatch = paramBlock.match(new RegExp(`@${paramName}\\s*=\\s*NULL`, 'i'));
                if (nullMatch) return '';

                const valueMatch = paramBlock.match(new RegExp(`@${paramName}\\s*=\\s*N?'((?:[^']|'')*)'`, 'i'));
                if (valueMatch && valueMatch[1] !== undefined) {
                    return valueMatch[1].replace(/''/g, "'");
                }

                return '';
            };

            const translationKey = extractValue('TranslationKey');
            const valueEn = extractValue('Value_EN');
            const valueId = extractValue('Value_ID');
            const valueVn = extractValue('Value_VN');

            if (translationKey) {
                entries.push({
                    key: translationKey,
                    en: valueEn,
                    id: valueId,
                    vn: valueVn
                });
            }
        }

        return entries;
    };

    const upload = async (file: File | undefined): Promise<LocalizationEntry[]> => {
        if (!file) {
            throw new Error("No file selected");
        }

        if (!file.name.toLowerCase().endsWith('.sql')) {
            throw new Error("Please upload a valid SQL file");
        }

        const fileContent = await file.text();
        const parsedData = parseSqlFile(fileContent);

        if (parsedData.length === 0) {
            throw new Error("No valid translation entries found in the SQL file");
        }

        setData(parsedData);
        return parsedData;
    }

    const generateSqlScript = () => {
        if (!sqlConfig) return '';

        const {
            storedProcedure,
            parameterMapping,
            formatValue
        } = sqlConfig;

        let script = '';

        data.forEach((row) => {
            script += `EXEC [dbo].[${storedProcedure}]\n`;

            Object.entries(parameterMapping).forEach(([paramName, columnKey], idx) => {
                const value = row[columnKey];
                const formattedValue = formatValue(columnKey, value);

                let sqlValue: string;
                if (formattedValue === null || formattedValue === undefined || formattedValue === '') {
                    sqlValue = 'NULL';
                } else if (typeof formattedValue === 'string') {
                    sqlValue = `N'${formattedValue.replace(/'/g, "''")}'`;
                } else if (typeof formattedValue === 'number') {
                    sqlValue = String(formattedValue);
                } else {
                    sqlValue = `N'${String(formattedValue).replace(/'/g, "''")}'`;
                }

                const isLast = idx === Object.entries(parameterMapping).length - 1;
                script += `    @${paramName} = ${sqlValue}${isLast ? ';' : ','}\n`;
            });

            script += '\n';
        });

        return script;
    };

    const download = async (): Promise<void> => {
        return new Promise((resolve, reject) => {
            try {
                const script = generateSqlScript();
                const blob = new Blob([script], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `Translations.sql`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    };

    return {
        data,
        setData,
        upload,
        download
    };
}
