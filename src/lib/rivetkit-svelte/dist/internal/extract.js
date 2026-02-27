export function extract(value, defaultValue) {
    const resolved = typeof value === "function" ? value() : value;
    return resolved === undefined ? defaultValue : resolved;
}
