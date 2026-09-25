import { Binary, Braces, CalendarClock, Clock, GitCompareArrows, KeyRound, Regex } from "lucide-react";
import type { ToolboxTool } from "@/types/toolbox.types";

import JwtDecoder from "./jwt-decoder";
import RegexTester from "./regex-tester";
import CronExplainer from "./cron-explainer";
import DataFormatTool from "./data-format";
import EncodersTool from "./encoders-tool";
import TextDiff from "./text-diff";
import DateTimeConverter from "./datetime-converter";

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
        title: "Cron Explainer",
        icon: CalendarClock,
        description: "Explain a cron or NCRONTAB expression and preview its next runs.",
        component: CronExplainer,
        keywords: ["cron", "ncrontab", "schedule"],
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
];
