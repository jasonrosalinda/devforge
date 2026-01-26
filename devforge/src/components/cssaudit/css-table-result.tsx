import type { CssInstance } from "@/types/cssAudits.type";
import { Table, TableBody, TableCell, TableRow } from "../ui/table";

export default function CssTableResult({ css, badgeContent }: {
    css: CssInstance,
    badgeContent?: (className: string, count: number) => React.ReactNode
}) {
    return (
        <div className="h-full overflow-y-auto">
            <Table>
                <TableBody>
                    {Object.entries(css.classes).map(([className, count]) => {
                        return (
                            <TableRow key={className} className="border">
                                <TableCell className="border sticky left-0 bg-background z-10">
                                    {className}
                                </TableCell>
                                {badgeContent && (
                                    <TableCell className="border">
                                        {badgeContent(className, count)}
                                    </TableCell>
                                )}
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    )
}