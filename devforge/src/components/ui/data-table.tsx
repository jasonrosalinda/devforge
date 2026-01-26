import {
    type ColumnDef, type SortingState, flexRender, getCoreRowModel,
    getPaginationRowModel, getFilteredRowModel, getSortedRowModel, useReactTable
} from "@tanstack/react-table"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, } from "@/components/ui/table"
import { DataTablePagination } from "./data-table-pagination"
import { useState } from "react"
import { Separator } from "./separator"
import React from "react"
import { ScrollArea } from "./scroll-area"

interface DataTableProps<TData, TValue> {
    header?: (table: ReturnType<typeof useReactTable<TData>>) => React.ReactNode,
    columns: ColumnDef<TData, TValue>[]
    data: TData[],
}

export function DataTable<TData, TValue>({
    header,
    columns,
    data,
}: DataTableProps<TData, TValue>) {
    const [globalFilter, setGlobalFilter] = useState("");
    const [sorting, setSorting] = React.useState<SortingState>([])
    const table = useReactTable({
        data,
        columns,
        getFilteredRowModel: getFilteredRowModel(),
        state: {
            globalFilter,
            sorting
        },
        onGlobalFilterChange: setGlobalFilter,
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        onSortingChange: setSorting,
        getSortedRowModel: getSortedRowModel(),
        globalFilterFn: "includesString"
    })

    return (
        <div className="flex flex-col h-full">
            {/* Header Section */}
            <div className="flex justify-between mb-4">
                {header?.(table)}
            </div>

            {/* Table Container with Fixed Layout */}
            <div className="flex flex-col overflow-hidden rounded-md border flex-1">
                {/* Fixed Header */}
                <div className="overflow-hidden">
                    <Table>
                        <TableHeader>
                            {table.getHeaderGroups().map((headerGroup) => (
                                <TableRow key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => {
                                        return (
                                            <TableHead key={header.id}>
                                                {header.isPlaceholder
                                                    ? null
                                                    : flexRender(
                                                        header.column.columnDef.header,
                                                        header.getContext()
                                                    )}
                                            </TableHead>
                                        )
                                    })}
                                </TableRow>
                            ))}
                        </TableHeader>
                    </Table>
                </div>

                {/* Scrollable Body */}
                <ScrollArea className="flex-1">
                    <TableBody>
                        {table.getRowModel().rows?.length ? (
                            table.getRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    data-state={row.getIsSelected() && "selected"}
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id}>
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow className="hover:bg-transparent">
                                <TableCell colSpan={columns.length} className="h-24 text-center">
                                    No results.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </ScrollArea>

                {/* Pagination Section */}
                <div className="border-t">
                    <div className="px-2 py-5">
                        <DataTablePagination table={table} />
                    </div>
                </div>
            </div>
        </div>
    )
}