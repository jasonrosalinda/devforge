import { SiReact } from "react-icons/si";
import ReactCheatsheet from "@/components/cheatsheets/react-cheatsheet";
import { PageHeader } from "@/components/layout/page-header";

export default function ReactCheatsheetPage() {
    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                icon={SiReact}
                title="React Cheatsheet"
                subtitle="Quick reference for hooks, patterns, lifecycle, and common React snippets."
            />
            <ReactCheatsheet />
        </div>
    )
}
