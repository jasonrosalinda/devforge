import type { Env } from "./common.types";

export type MeduCacheEnv = Env;

export type MeduCacheEntry = {
    key: string;
    description: string;
    paramType: ParamType;
    param: string | undefined;
}

export type ParamType = 'countrycode' | 'index' | 'none';

export type MeduCacheResponse = {
    key: string;
    message: string;
    state: "success" | "error";
}


export type MeduCacheHook = {
    env: MeduCacheEnv;
    setEnv: (env: MeduCacheEnv) => void;
    data: MeduCacheEntry[];
    clearCache: (row: MeduCacheEntry) => Promise<void>;
}