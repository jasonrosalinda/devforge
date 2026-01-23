import { Table, TableBody, TableCell, TableRow } from "../ui/table";

export default function CssTableResult({ css }: { css: string[] }) {
    return (
        <div className="h-full overflow-y-auto">
            <Table>
                <TableBody>
                    {css.map((css, index) => {
                        return (
                            <TableRow key={index} className="border">
                                <TableCell className="border sticky left-0 bg-background z-10">
                                    {css}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    )
}