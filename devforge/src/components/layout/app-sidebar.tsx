import { DatabaseZap, BarChart, Languages, Anvil } from "lucide-react"

import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar"

// Menu items.
const items = [
    {
        title: "Translation",
        url: "#",
        icon: Languages,
    },
    {
        title: "PageSpeed",
        url: "#",
        icon: BarChart,
    },
    {
        title: "MEDU Cache",
        icon: DatabaseZap,
    }
]

export function AppSidebar({ activePage, setActivePage }: { activePage: string, setActivePage: (page: string) => void }) {
    return (
        <Sidebar collapsible="offcanvas" variant="inset">
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:!p-1.5">
                            <a href="#">
                                <Anvil className="!size-5" />
                                <span className="text-base font-semibold">DevForge</span>
                            </a>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {items.map((item) => (
                                <SidebarMenuItem key={item.title}>
                                    <SidebarMenuButton isActive={item.title === activePage} tooltip={item.title} onClick={() => setActivePage(item.title)}>
                                        {item.icon &&
                                            <item.icon />
                                        }
                                        <span>{item.title}</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
        </Sidebar >
    )
}