import { Binary, Braces, CalendarClock, Clock, Contrast, FileCog, GitCompareArrows, Image as ImageIcon, KeyRound, PlugZap, Regex } from "lucide-react";
import type { ToolboxTool } from "@/types/toolbox.types";

import JwtDecoder from "./jwt-decoder";
import RegexTester from "./regex-tester";
import CronExplainer from "./cron-explainer";
import DataFormatTool from "./data-format";
import EncodersTool from "./encoders-tool";
import TextDiff from "./text-diff";
import DateTimeConverter from "./datetime-converter";
import ImageConverter from "./image-converter";
import AppSettingsConverter from "./appsettings-converter";
import ConnStringParser from "./connstring-parser";
import ColorContrast from "./color-contrast";

/**
 * Every Toolbox utility. Each entry becomes its own page under the sidebar's
 * Toolbox group (see page-routes), so adding one is an import plus an entry here.
 */
export const TOOLBOX_TOOLS: ToolboxTool[] = [
    {
        id: "datetime",
        title: "DateTime Converter",
        icon: Clock,
        description: "Convert between local time, UTC, other time zones, ISO 8601 and Unix timestamps.",
        component: DateTimeConverter,
        keywords: ["time", "date", "datetime", "timezone", "time zone", "utc", "gmt", "unix", "epoch", "timestamp", "iso"],
    },
    {
        id: "jwt",
        title: "JWT Decoder",
        icon: KeyRound,
        description: "Decode a token and read its claims in local and UTC time.",
        component: JwtDecoder,
        keywords: ["jwt", "token", "claims"],
    },
    {
        id: "regex",
        title: "Regex Tester",
        icon: Regex,
        description: "Test a pattern, with warnings where .NET's engine differs.",
        component: RegexTester,
        keywords: ["regex", "regular expression", "pattern"],
    },
    {
        id: "cron",
        title: "Cron Explainer & Creator",
        icon: CalendarClock,
        description: "Explain or build a cron / NCRONTAB expression and preview its next runs.",
        component: CronExplainer,
        keywords: ["cron", "ncrontab", "schedule", "builder", "creator", "generator"],
    },
    {
        id: "data",
        title: "JSON / YAML / XML",
        icon: Braces,
        description: "Format, validate and convert between the three config formats.",
        component: DataFormatTool,
        keywords: ["json", "yaml", "xml", "format", "convert"],
    },
    {
        id: "encode",
        title: "Encoders",
        icon: Binary,
        description: "Base64, URL and HTML encoding, hashes and UUIDs.",
        component: EncodersTool,
        keywords: ["encode", "decode", "base64", "url encode", "html escape", "hash", "sha", "uuid", "guid"],
    },
    {
        id: "diff",
        title: "Text Diff",
        icon: GitCompareArrows,
        description: "Compare two blocks of text line by line.",
        component: TextDiff,
        keywords: ["diff", "compare"],
    },
    {
        id: "image",
        title: "Image Converter",
        icon: ImageIcon,
        description: "Convert images between PNG, JPEG, WebP, ICO and SVG — traced or embedded — offline.",
        component: ImageConverter,
        keywords: ["image", "convert", "png", "jpg", "jpeg", "webp", "ico", "favicon", "svg", "vector", "trace", "resize"],
    },
    {
        id: "appsettings",
        title: "App Settings Converter",
        icon: FileCog,
        description: "Turn appsettings.json into Azure App Service settings (Section__Key) and back.",
        component: AppSettingsConverter,
        keywords: ["appsettings", "app settings", "azure", "app service", "environment", "env", "configuration", "advanced edit", "dotnet"],
    },
    {
        id: "connstring",
        title: "Connection String Parser",
        icon: PlugZap,
        description: "Split a SQL, Storage, Service Bus, Cosmos or Redis connection string into fields, secrets masked.",
        component: ConnStringParser,
        keywords: ["connection string", "connstring", "sql", "storage", "service bus", "event hubs", "cosmos", "redis", "password"],
    },
    {
        id: "color",
        title: "Color & Contrast",
        icon: Contrast,
        description: "Convert colours between HEX, RGB and HSL and check WCAG contrast.",
        component: ColorContrast,
        keywords: ["color", "colour", "contrast", "wcag", "accessibility", "a11y", "hex", "rgb", "hsl"],
    },
];
