import { SiCss3 } from "react-icons/si";
import CSSAuditUpload from "@/components/cssaudit/css-audit-upload";
import { PageHeader } from "@/components/layout/page-header";

export default function CSSAuditPage() {
    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                icon={SiCss3}
                title="CSS Audit"
                subtitle="Upload a stylesheet to analyze selectors, detect unused rules, and flag duplicates."
            />
            <CSSAuditUpload />
        </div>
    )
}
