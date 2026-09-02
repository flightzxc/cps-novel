import { assertCredentialKeyringReady } from "../src/lib/credentials/keyring";

assertCredentialKeyringReady(process.env);
process.stdout.write("CREDENTIAL_SECRET_PREFLIGHT=PASS\n");
