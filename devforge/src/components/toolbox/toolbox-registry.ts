import { Binary, Braces, CalendarClock, GitCompareArrows, KeyRound, Regex } from "lucide-react";
import type { ToolboxTool } from "@/types/toolbox.types";

import JwtDecoder from "./jwt-decoder";
import RegexTester from "./regex-tester";
import CronExplainer from "./cron-explainer";
import DataFormatTool from "./data-format";
import EncodersTool from "./encoders-tool";
import TextDiff from "./text-diff";

/**
 * Every Toolbox tab. Adding a utility is an import plus one entry here — the
 * tab strip, the keyboard order and the remembered tab all follow from it.
 */
export const TOOLBOX_TOOLS: ToolboxTool[] = [
    {
        id: "jwt",
        label: "JWT",
        icon: KeyRound,
        description: "Decode a token and read its claims in local and UTC time.",
        component: JwtDecoder,
    },
    {
        id: "regex",
        label: "Regex",
        icon: Regex,
        description: "Test a pattern, with warnings where .NET's engine differs.",
        component: RegexTester,
    },
    {
        id: "cron",
        label: "Cron",
        icon: CalendarClock,
        description: "Explain a cron or NCRONTAB expression and preview its next runs.",
        component: CronExplainer,
    },
    {
        id: "data",
        label: "JSON / YAML / XML",
        icon: Braces,
        description: "Format, validate and convert between the three config formats.",
        component: DataFormatTool,
    },
    {
        id: "encode",
        label: "Encode",
        icon: Binary,
        description: "Base64, URL and HTML encoding, hashes and UUIDs.",
        component: EncodersTool,
    },
    {
        id: "diff",
        label: "Diff",
        icon: GitCompareArrows,
        description: "Compare two blocks of text line by line.",
        component: TextDiff,
    },
];

/** Search terms that should surface the Toolbox from the launcher's search box. */
export const TOOLBOX_KEYWORDS = [
    "jwt", "token", "claims",
    "regex", "regular expression", "pattern",
    "cron", "ncrontab", "schedule",
    "json", "yaml", "xml", "format", "convert",
    "base64", "url encode", "html escape", "hash", "sha", "uuid", "guid",
    "diff", "compare",
];
