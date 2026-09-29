// Preloaded into every test process (see package.json "test"): a developer's own
// SUUNTO_* settings — notably SUUNTO_TOKEN_STORAGE=keychain, which would make the
// tests overwrite their real keychain token — must never reach the tests.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("SUUNTO_") || key === "PORT") delete process.env[key];
}
