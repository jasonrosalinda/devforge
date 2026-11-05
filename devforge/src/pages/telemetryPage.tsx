import { Telescope } from "lucide-react";
import TelemetryAsk from "@/components/telemetry/telemetry-ask";
import { PageHeader } from "@/components/layout/page-header";
import { AzureStatusPill } from "@/components/azure/azureStatusPill";
import { useAzureMetrics } from "@/hooks/useAzureMetrics";

export default function TelemetryPage() {
    const { credStatus, credError, recheckCredential } = useAzureMetrics();
    return (
        <div className="flex flex-col gap-4 h-full min-h-0">
            <PageHeader
                icon={Telescope}
                title="Ask Telemetry"
                subtitle="Ask about an app's Application Insights in plain English. Claude writes the KQL; devForge runs it and charts the answer."
                actions={<AzureStatusPill credStatus={credStatus} credError={credError} onRecheck={() => void recheckCredential()} />}
            />
            <TelemetryAsk />
        </div>
    )
}
