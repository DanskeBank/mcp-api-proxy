// The module itself exists; one of its own imports does not.
const dependency = "./does-not-exist.js";
await import(dependency);

export const EXTRA_PROFILES = {};
