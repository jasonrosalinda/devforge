import { ScanSearch } from "lucide-react";
import UnusedAssetsScan from "@/components/unusedassets/unused-assets-scan";
import { PageHeader } from "@/components/layout/page-header";

export default function UnusedAssetsPage() {
    return (
        <div className="flex flex-col gap-4 h-full min-h-0">
            <PageHeader
                icon={ScanSearch}
                title="Unused Assets"
                subtitle="Scan a project folder for unused CSS classes/ids and unused JS functions."
            />
            <UnusedAssetsScan />
        </div>
    )
}
