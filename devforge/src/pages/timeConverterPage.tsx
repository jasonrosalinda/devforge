import { Clock } from "lucide-react";
import TimeConverter from "@/components/converters/time-converter";
import { PageHeader } from "@/components/layout/page-header";

export default function TimeConverterPage() {
    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                icon={Clock}
                title="Time Converter"
                subtitle="Convert between timezones at a glance with live clocks for the regions you work with."
            />
            <TimeConverter />
        </div>
    )
}
