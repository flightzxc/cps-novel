#!/usr/bin/env node

// Permanently retired by SEC-CREDENTIAL-KEY-ROTATION-2026-09-01. This former
// helper bypassed addOrReplaceCredential with raw SQL and hard-coded key
// version 1, so it must never participate in a versioned key rotation.
process.stderr.write(
  "ERROR: retired credential importer; use /channel-accounts add/replace\n",
);
process.exitCode = 64;
