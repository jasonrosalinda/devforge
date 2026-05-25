import { AiOutlineTranslation } from "react-icons/ai";
import LocalizationTable from "@/components/localization/localization-table";
import { PageHeader } from "@/components/layout/page-header";

export default function LocalizationEntry() {
    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                icon={AiOutlineTranslation}
                title="Translation"
                subtitle="Browse and edit localization keys across all supported languages in a searchable table."
            />
            <LocalizationTable />
        </div>
    )
}
