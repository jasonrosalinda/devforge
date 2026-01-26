import { Toast } from "@/components/ui";
import type { MeduCacheEntry, MeduCacheEnv, MeduCacheHook, MeduCacheResponse } from "@/types/meduCache.types";
import { COUNTRY_LIST } from "@/utils/constants";
import { useState } from "react";

export const useMeduCache = (): MeduCacheHook => {
    const [env, setEnv] = useState<MeduCacheEnv>("SIT");
    const [data] = useState<MeduCacheEntry[]>([
        {
            key: "course-listing:countryCode-{0}",
            description: "Course listing",
            paramType: "countrycode",
            param: "",
        },
        {
            key: "course-index:{0}",
            description: "Course",
            paramType: "index",
            param: "",
        },
        {
            key: "webinar-listing:countryCode-{0}",
            description: "Webinar listing",
            paramType: "countrycode",
            param: "",
        },
        {
            key: "enrollmentcontroller.getenrolledcoursesasync-{0}",
            description: "User Enrollment",
            paramType: "index",
            param: "",
        },
        {
            key: "translationcontroller.translations",
            description: "Translation",
            paramType: "none",
            param: "",
        },
        {
            key: "translationcontroller.countryLocales",
            description: "Country Locales",
            paramType: "none",
            param: "",
        },
        {
            key: "translationcontroller.languages",
            description: "Languages",
            paramType: "none",
            param: "",
        },
        {
            key: "page.configurations",
            description: "Page Configurations",
            paramType: "none",
            param: "",
        },
    ]);
    const toast = Toast();

    const clearCache = async (row: MeduCacheEntry) => {
        let fullKey = row.key;

        if (row.paramType !== "none" && row.param) {
            if (row.paramType === "countrycode") {
                if (row.param === "*") {
                    const promises = COUNTRY_LIST.map(country => {
                        const replacedKey = fullKey.replace(
                            "{0}",
                            country.code.toLowerCase(),
                        );
                        return onClearCache(replacedKey);
                    });

                    await Promise.all(promises);
                    return;
                }

                const exists = COUNTRY_LIST.some(
                    (c) => c.code === row.param?.toUpperCase(),
                );

                if (exists) {
                    fullKey = fullKey.replace("{0}", row.param?.toLowerCase());
                } else {
                    onToast(`Invalid country code: ${row.param}`, "error");
                    return;
                }
            } else {
                fullKey = fullKey.replace("{0}", row.param);
            }
        }

        await onClearCache(fullKey);
    };

    const onClearCache = async (key: string): Promise<void> => {
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
                throw new Error(text || `HTTP error! status: ${res.status}`);
            }

            onToast(`Successfully cleared ${key} cache.`, "success");
        } catch (error) {
            let message = "Unknown error";

            if (error instanceof TypeError) {
                message = "Network or CORS error occurred";
            } else if (error instanceof Error) {
                message = error.message;
            }

            onToast(`Failed to clear ${key} cache: \n${message}`, "error");
        }
    };

    const onToast = (message: string, state: "success" | "error") => {
        if (state === "success") {
            toast.success(message);
        } else {
            toast.error(message);
        }
    };
    return {
        env,
        setEnv,
        data,
        clearCache,
    };
};