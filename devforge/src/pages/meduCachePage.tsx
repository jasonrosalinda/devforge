import { Button, Input } from "@/components/ui";
import { DataTable } from "@/components/ui/data-table";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMeduCache } from "@/hooks/useMeduCache";
import { Envs } from "@/types/common.types";
import type { MeduCacheEntry } from "@/types/meduCache.types";
import { COUNTRY_LIST } from "@/utils/constants";
import type { ColumnDef } from "@tanstack/react-table";
import { DatabaseZap } from "lucide-react";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";

// Separate component for the input to maintain focus
const ParamInput = ({
    rowKey,
    initialValue,
    onChange
}: {
    rowKey: string;
    initialValue: string;
    onChange: (key: string, value: string) => void;
}) => {
    const [localValue, setLocalValue] = useState(initialValue);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setLocalValue(initialValue);
    }, [initialValue]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        setLocalValue(newValue);
        onChange(rowKey, newValue);
    };

    return (
        <Input
            ref={inputRef}
            type="text"
            value={localValue}
            onChange={handleChange}
            placeholder="Enter index"
        />
    );
};

export default function MeduCachePage() {
    const { env, setEnv, results, data, clearCache } = useMeduCache();
    const [updatedParams, setUpdatedParams] = useState<Record<string, string>>({});

    const handleParamChange = useCallback((key: string, value: string) => {
        setUpdatedParams(prev => ({
            ...prev,
            [key]: value
        }));
    }, []);

    const getChangedEntries = useCallback(() => {
        return Object.keys(updatedParams).map(key => {
            const original = data.find(d => d.key === key);
            return original ? { ...original, param: updatedParams[key] } : null;
        }).filter((entry): entry is MeduCacheEntry => entry !== null);
    }, [data, updatedParams]);

    const columns: ColumnDef<MeduCacheEntry>[] = useMemo(() => [
        { accessorKey: "key", header: "Cache Key" },
        { accessorKey: "description", header: "Description" },
        {
            accessorKey: "param",
            header: "Parameter",
            cell: ({ row }) => {
                const currentValue = updatedParams[row.original.key] ?? row.original.param ?? "";

                return row.original.paramType === "countrycode" ? (
                    <Select
                        value={currentValue}
                        onValueChange={(value) => handleParamChange(row.original.key, value)}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="Select Country" />
                        </SelectTrigger>
                        <SelectContent position="popper">
                            <SelectGroup>
                                <SelectItem value="*">All Country</SelectItem>
                                {COUNTRY_LIST.map((country) => (
                                    <SelectItem key={country.code} value={country.code}>
                                        {country.name}
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                        </SelectContent>
                    </Select>
                ) : row.original.paramType === "index" ? (
                    <ParamInput
                        rowKey={row.original.key}
                        initialValue={currentValue}
                        onChange={handleParamChange}
                    />
                ) : "";
            },
        },
        {
            id: "actions",
            cell: ({ row }) => {
                const hasUpdate = updatedParams[row.original.key] !== undefined;
                return (
                    <div className="flex justify-end items-center gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            title={`Clear ${row.original.key}`}
                            onClick={() => {
                                const updatedEntry = hasUpdate
                                    ? { ...row.original, param: updatedParams[row.original.key] }
                                    : row.original;
                                clearCache(updatedEntry);
                            }}
                        >
                            <DatabaseZap />
                        </Button>
                    </div>
                );
            },
        },
    ], [handleParamChange, clearCache]); // Removed updatedParams from dependencies

    return (
        <div>
            <DataTable header={
                (table) => (
                    <div className="flex w-full justify-between mb-5">
                        <div className="flex gap-2 items-center">
                            <Select defaultValue={env} onValueChange={setEnv} >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent position="popper">
                                    <SelectGroup>
                                        {Envs.map((env) => (
                                            <SelectItem key={env} value={env}>
                                                {env}
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                )
            } columns={columns} data={data} />
        </div>
    )
}