import type { MeduCacheEntry, MeduCacheEnv, MeduCacheHook, MeduCacheResponse } from "@/types/meduCache.types";
import { COUNTRY_LIST } from "@/utils/constants";
import { useState } from "react";

export const useMeduCache = (): MeduCacheHook => {
    const [env, setEnv] = useState<MeduCacheEnv>("SIT");
    const [results, setResults] = useState<MeduCacheResponse[]>([]);
    const [data] = useState<MeduCacheEntry[]>([
        {
            key: "course-listing:countryCode-{0}",
            description: "Cache for Course listing",
            paramType: "countrycode",
            param: "",
        },
        {
            key: "course-index:{0}",
            description: "Cache for Course",
            paramType: "index",
            param: "",
        },
        {
            key: "webinar-listing:countryCode-{0}",
            description: "Cache for Webinar listing",
            paramType: "countrycode",
            param: "",
        },
        {
            key: "enrollmentcontroller.getenrolledcoursesasync-{0}",
            description: "Cache for User Enrollment",
            paramType: "index",
            param: "",
        },
        {
            key: "page.configurations",
            description: "Cache for Page Configurations",
            paramType: "none",
            param: "",
        },
    ]);


    const clearCache = async (row: MeduCacheEntry) => {
        let fullKey = row.key;
        if (row.paramType !== "none" && row.param) {
            if (row.paramType === "countrycode") {
                if (row.param === "*") {
                    for (const country of COUNTRY_LIST) {
                        let replacedKey = fullKey.replace(
                            "{0}",
                            country.code.toLowerCase(),
                        );
                        let result = await onClearCache(replacedKey);
                        setResults((prev) => [...prev, result]);
                    }
                    return;
                }
                const exists = COUNTRY_LIST.some(
                    (c) => c.code === row.param.toUpperCase(),
                );
                if (exists) {
                    fullKey = fullKey.replace("{0}", row.param.toLowerCase());
                } else {
                    setResults((prev) => [...prev, {
                        key: row.key,
                        message: `Invalid country code: ${row.param}`,
                        state: "error"
                    }]);
                }
            } else {
                fullKey = fullKey.replace("{0}", row.param);
            }
        }

        let result = await onClearCache(fullKey);
        setResults((prev) => [...prev, result]);
    };

    const onClearCache = async (key: string): Promise<MeduCacheResponse> => {
        const domainPrefix = env !== "PRD" ? `${env.toLowerCase()}-` : ``;

        const url = `https://${domainPrefix}meduapi.mims.com/api/cacheentry/${key}`;

        try {
            const res = await fetch(url, {
                method: "DELETE",
                headers: {
                    "Content-Type": "application/json",
                },
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(text);
            }
        } catch (error) {
            return {
                key,
                message: error instanceof Error ? error.message : "Unknown error",
                state: "error"
            }
        }

        return {
            key,
            message: "Successfully cleared cache",
            state: "success"
        }
    };

    return {
        env,
        setEnv,
        results,
        data,
        clearCache,
    }
}
