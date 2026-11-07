import { SearchCode } from "lucide-react";
import AppInvestigation from "@/components/app-investigation/app-investigation";
import { PageHeader } from "@/components/layout/page-header";

export default function AppInvestigationPage() {
    return (
        <div className="flex flex-col gap-4 h-full min-h-0">
            <PageHeader
                icon={SearchCode}
                title="App Investigation"
                subtitle="Describe an incident in plain English. Claude pulls the app's Azure telemetry, reads its source code and git history (read-only), and reports the likely root cause."
            />
            <AppInvestigation />
        </div>
    )
}
