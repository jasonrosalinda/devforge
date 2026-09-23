import type { IconType } from "react-icons/lib";

export type Page = {
    title: string;
    url?: string;
    icon: IconType;
    component: React.FC;
    /** Extra terms the launcher search matches, for pages whose title alone is not findable. */
    keywords?: string[];
}
