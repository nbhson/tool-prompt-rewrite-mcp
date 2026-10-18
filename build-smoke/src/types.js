/**
 * Shared domain types for the Universal Prompt Gate MCP Server.
 */
/** Distinct protocol-level errors the client must handle explicitly. */
export class GateError extends Error {
    kind;
    details;
    constructor(kind, message, details) {
        super(message);
        this.kind = kind;
        this.details = details;
        this.name = 'GateError';
    }
}
