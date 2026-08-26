// SPDX-License-Identifier: Apache-2.0
/**
 * Resolve the MongoDB URI, refusing to guess one inside a cluster.
 *
 * Written after a production outage in the source deployment. One service set
 * no MONGODB_URI in its manifest and fell back to a credential-less
 * `mongodb://mongodb:27017` default. When SCRAM auth was enabled on the
 * database that day, the service kept reporting healthy with zero restarts
 * and answered every request with a 500 — "Command find requires
 * authentication" — for hours, until a human opened the product.
 *
 * Two properties of the default made that possible, and both are worth naming
 * because neither is about MongoDB:
 *
 *   1. It made the service INVISIBLE TO CONFIGURATION SEARCH. The cutover
 *      survey grepped manifests for MONGODB_URI and found every service that
 *      configured itself explicitly. The one relying on a default did not
 *      appear precisely because it was relying on a default — the services
 *      that configure themselves explicitly are the ones a config search can
 *      find.
 *   2. It moved the failure from startup to first query. A wrong value that
 *      crashes the process is discovered in seconds by anyone watching a
 *      rollout. A wrong value that connects and then fails per-request is
 *      discovered by a user.
 *
 * So: in-cluster, an unset MONGODB_URI is a configuration error and this
 * throws. Off-cluster it keeps the convenient local default, because there
 * the feedback loop is a developer looking at a terminal.
 *
 * KUBERNETES_SERVICE_HOST is the discriminator — the kubelet injects it into
 * every pod and nothing sets it on a laptop.
 */

const LOCAL_DEFAULT = 'mongodb://mongodb:27017';

export function resolveMongoUri(serviceName: string): string {
  const uri = process.env.MONGODB_URI?.trim();
  if (uri) return uri;

  if (process.env.KUBERNETES_SERVICE_HOST) {
    throw new Error(
      `${serviceName}: MONGODB_URI is not set. Refusing to fall back to ` +
        `${LOCAL_DEFAULT}, which carries no credentials and would connect ` +
        `only to fail on the first authenticated query. Set MONGODB_URI in ` +
        `this service's manifest.`
    );
  }

  return LOCAL_DEFAULT;
}
