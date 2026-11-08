import { describe, it, expect } from "vitest"
import { atlassianBadge, azureBadge, claudeBadge, formatPlan } from "./auth-badges"

describe("formatPlan", () => {
    it("capitalises the plan and blanks a missing one", () => {
        expect(formatPlan("team")).toBe("Team")
        expect(formatPlan(null)).toBe("")
    })
})

describe("azureBadge", () => {
    it("maps each credential state", () => {
        expect(azureBadge("checking", null).tone).toBe("checking")
        expect(azureBadge("ok", null)).toMatchObject({ tone: "ok", text: "Signed in" })
        expect(azureBadge("error", "AADSTS70043")).toMatchObject({ tone: "bad", text: "Not signed in" })
    })

    it("tells the user to run az login and keeps the CLI error", () => {
        expect(azureBadge("error", "AADSTS70043").hint).toContain("AADSTS70043")
        expect(azureBadge("error", null).hint).toContain("az login")
    })
})

describe("atlassianBadge", () => {
    it.each([
        ["checking", "checking"],
        ["no-base", "idle"],
        ["missing", "bad"],
        ["valid", "ok"],
        ["expired", "bad"],
        ["forbidden", "bad"],
        ["error", "warn"],
    ] as const)("%s → %s", (state, tone) => {
        expect(atlassianBadge({ state }).tone).toBe(tone)
    })

    it("names the account on a valid token and surfaces a probe failure", () => {
        expect(atlassianBadge({ state: "valid", displayName: "Jason" }, { connected: true, connecting: false }).hint).toContain("Jason")
        expect(atlassianBadge({ state: "error", detail: "ENOTFOUND" }).hint).toBe("ENOTFOUND")
    })
})

describe("atlassianBadge session", () => {
    const valid = { state: "valid" } as const

    it("is green only when the token is valid and the session is connected", () => {
        expect(atlassianBadge(valid, { connected: true, connecting: false })).toMatchObject({ tone: "ok", text: "Connected" })
    })

    it("is amber, not green, when the token works but the session is not connected", () => {
        const b = atlassianBadge(valid, { connected: false, connecting: false })
        expect(b).toMatchObject({ tone: "warn", text: "Not connected" })
        expect(b.hint).toContain("Connect Confluence")
    })

    it("shows connecting while the login window is open", () => {
        expect(atlassianBadge(valid, { connected: false, connecting: true }).tone).toBe("checking")
    })

    it("does not let a connected session hide a dead token", () => {
        expect(atlassianBadge({ state: "expired" }, { connected: true, connecting: false }).tone).toBe("bad")
    })
})

describe("claudeBadge", () => {
    const ok: Parameters<typeof claudeBadge>[0] = { success: true, plan: "team", limits: [], fetchedAt: "2026-11-07T00:00:00Z" }

    it("is checking until the first result", () => {
        expect(claudeBadge(null).tone).toBe("checking")
    })

    it("is signed in with the plan in the hint", () => {
        expect(claudeBadge(ok)).toMatchObject({ tone: "ok", text: "Signed in" })
        expect(claudeBadge(ok).hint).toContain("Team")
    })

    it("prefixes session / weekly usage, rounded, with a dash for a missing window", () => {
        const limit = (id: string, percent: number) => ({ id, label: id, percent, resetsAt: null })
        expect(claudeBadge({ ...ok, limits: [limit("session", 12.4), limit("weekly", 33.6), limit("weekly_opus", 90)] }).prefix).toBe("12% / 34%")
        expect(claudeBadge({ ...ok, limits: [limit("weekly", 5)] }).prefix).toBe("– / 5%")
        expect(claudeBadge(ok).prefix).toBeUndefined()
        expect(claudeBadge({ success: false, code: "NETWORK", error: "x" }).prefix).toBeUndefined()
    })

    it("separates not-signed-in from expired", () => {
        expect(claudeBadge({ success: false, code: "NOT_SIGNED_IN", error: "x" })).toMatchObject({ tone: "bad", text: "Not signed in" })
        expect(claudeBadge({ success: false, code: "EXPIRED", error: "x" })).toMatchObject({ tone: "bad", text: "Login expired" })
    })

    it("stays signed in when only the usage endpoint fails (rate limit, outage, offline)", () => {
        for (const code of ["HTTP_ERROR", "BAD_RESPONSE", "NETWORK"] as const) {
            const b = claudeBadge({ success: false, code, error: "Usage request failed (HTTP 429)." })
            expect(b).toMatchObject({ tone: "ok", text: "Signed in" })
            expect(b.hint).toContain("HTTP 429")
        }
    })
})
