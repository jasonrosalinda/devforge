import type { ForwardRefExoticComponent, RefAttributes } from "react";
import type { LucideProps } from "lucide-react";
import type { IconType } from "react-icons/lib";

export type Page = {
    title: string;
    url?: string;
    icon: IconType;
    component: React.FC
}
