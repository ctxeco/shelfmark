// SPDX-License-Identifier: Apache-2.0
// Side-effect module, imported FIRST: the graph package captures its OAuth
// client configuration at module load, so the env must exist before any
// import chain reaches it.
process.env.CONNECTOR_MS_CLIENT_ID = 'client-id';
process.env.CONNECTOR_MS_CLIENT_SECRET = 'client-secret';
process.env.CONNECTOR_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
