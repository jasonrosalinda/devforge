import crypto from "node:crypto";

/**
 * In-memory store for Lighthouse audit results.
 *
 * Each record is assigned a unique ID so it can be retrieved later
 * (e.g. to view the full HTML report).  The store is capped at
 * MAX_RECORDS to avoid unbounded memory growth.
 */
const MAX_RECORDS = 100;

export class AuditStore {
    constructor() {
        /** @type {Map<string, object>} */
        this._records = new Map();
    }

    /**
     * Persist an audit result, returning the stored record (with `id`).
     */
    save(audit) {
        const id = crypto.randomUUID();
        const record = { id, ...audit };
        this._records.set(id, record);

        // Evict oldest entries when we exceed the cap
        if (this._records.size > MAX_RECORDS) {
            const oldest = this._records.keys().next().value;
            this._records.delete(oldest);
        }

        return this._toSummary(record);
    }

    /**
     * Return all stored records (without the full HTML report to keep
     * the response size manageable).
     */
    getAll() {
        return [...this._records.values()]
            .map((r) => this._toSummary(r))
            .reverse(); // newest first
    }

    /**
     * Return a single record by ID (including the HTML report).
     */
    getById(id) {
        return this._records.get(id) || null;
    }

    /**
     * Remove a record by ID.
     */
    removeById(id) {
        return this._records.delete(id);
    }

    /**
     * Clear all records.
     */
    clear() {
        this._records.clear();
    }

    /**
     * Strip the (large) htmlReport from a record for list responses.
     */
    _toSummary(record) {
        const { htmlReport, ...rest } = record;
        return {
            ...rest,
            hasHtmlReport: !!htmlReport,
        };
    }
}
